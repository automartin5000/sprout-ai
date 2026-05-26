/**
 * Local development driver. Spawns three processes:
 *
 *   1. Hono API on http://localhost:3001  (mocked auth + in-memory DDB)
 *   2. Vite dev server for the renderer    (http://localhost:5173)
 *   3. Electron pointed at the Vite URL with the API URL injected
 *
 * Defaults to a "fully local" mode: no AWS, no Auth0, no Copilot. Set
 * ANTHROPIC_API_KEY for the Claude harness, or COPILOT_GITHUB_TOKEN for the
 * Copilot harness (the registry picks whichever is present).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { build, context as esbuildContext } from 'esbuild';
import { mainBundleConfig, preloadBundleConfig } from './electron-bundle-config.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist-electron');

/**
 * Tiny dotenv-style loader: read `.env` lines like KEY=value and add them to
 * process.env (without clobbering anything already set). No quoting / escape
 * support — the file format matches what raffle-winner-picker uses and what
 * the existing .env in this repo expects.
 *
 * Loading happens here (not via Bun's --env-file or a dotenv dep) so the
 * AUTH0_*, CLOUD_API_URL and other config from .env is available to BOTH the
 * dev driver itself AND the Electron main process it spawns.
 */
function loadDotenv(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotenv(path.join(root, '.env'));

interface SpawnedUrl {
  url: string;
  proc: ChildProcess;
}

/**
 * Every child spawned by this supervisor is tracked here. `installGlobalCleanup()`
 * uses it to nuke the whole tree synchronously on supervisor exit — even
 * when the supervisor crashes via `process.exit(1)` instead of a clean
 * SIGTERM. Without this, an API spawn failure (EADDRINUSE) would orphan
 * vite + electron, which would then hold ports 5173/etc. and break the
 * next `pj app:dev` launch.
 */
const trackedChildren: ChildProcess[] = [];
let cleanupInstalled = false;

function trackChild(proc: ChildProcess): void {
  trackedChildren.push(proc);
}

/**
 * Kill the whole process group of a child we spawned with `detached: true`.
 * Sends `sig` to -pid (the group). Swallows ESRCH so we don't crash the
 * supervisor when something already exited.
 */
function killGroup(proc: ChildProcess, sig: NodeJS.Signals): void {
  if (typeof proc.pid !== 'number') return;
  try {
    process.kill(-proc.pid, sig);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== 'ESRCH') {
      // Best-effort: fall back to a direct kill on the leader. Avoid
      // crashing the supervisor since cleanup is already terminal.
      try { proc.kill(sig); } catch { /* ignore */ }
    }
  }
}

function installGlobalCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  // process.on('exit') runs synchronously and is the LAST chance to do
  // anything. Async work won't complete, but `process.kill(-pid, ...)` is
  // synchronous — that's enough.
  process.on('exit', () => {
    for (const proc of trackedChildren) killGroup(proc, 'SIGTERM');
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      for (const proc of trackedChildren) killGroup(proc, 'SIGTERM');
      process.exit(0);
    });
  }
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException in dev-electron:', err);
    for (const proc of trackedChildren) killGroup(proc, 'SIGTERM');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection in dev-electron:', reason);
    for (const proc of trackedChildren) killGroup(proc, 'SIGTERM');
    process.exit(1);
  });
}

function spawnAndCaptureUrl(args: {
  label: string;
  command: string;
  commandArgs: string[];
  matcher: RegExp;
  env?: NodeJS.ProcessEnv;
}): Promise<SpawnedUrl> {
  return new Promise((resolve, reject) => {
    // `detached: true` puts the child in its own process group — same
    // reasoning as DevServer in app/main/projects/dev-server.ts. Without
    // it, killing this `bunx` parent doesn't reach the `vite` or `tsx`
    // grandchildren, and ports leak.
    const proc = spawn(args.command, args.commandArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...args.env },
      detached: true,
    });
    trackChild(proc);
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(`[${args.label}] ${text}`);
      const match = text.match(args.matcher);
      if (match) resolve({ url: match[1].trim(), proc });
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[${args.label}:err] ${chunk.toString()}`);
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) reject(new Error(`${args.label} exited ${code}`));
    });
  });
}

async function buildMainAndPreload(): Promise<void> {
  // Use the SAME config the production build uses (scripts/build-electron-
  // main.ts). Dev-mode-only divergence was the root cause of the worst
  // `pj app:dev` regressions in this project's history — bundle smoke tests
  // were green against the prod bundle while dev shipped a broken one.
  await build(mainBundleConfig({ root, outDir }));
  const preloadCtx = await esbuildContext(preloadBundleConfig({ root, outDir }));
  await preloadCtx.rebuild();
}

/**
 * "Real cloud" mode: when SPROUT_USE_DEPLOYED=1, the dev driver skips the
 * local Hono server entirely and points the desktop at the deployed
 * Sprout-${env} API in AWS. Auth flips to real Auth0 PKCE — MOCK_AUTH gets
 * forced to '0' regardless of what's in .env, since the deployed API's
 * HttpJwtAuthorizer rejects unsigned/mock requests anyway.
 *
 * Stack outputs live in sprout-${env}-outputs.json (written by
 * `bunx cdk deploy --outputs-file`). If that file is missing we fail fast
 * with a clear message rather than silently fall back to mock.
 */
function loadDeployedApi(): string {
  const envName = process.env.DEPLOY_ENV ?? 'dev';
  const outputsPath = path.join(root, `sprout-${envName}-outputs.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(outputsPath, 'utf8');
  } catch {
    throw new Error(
      `SPROUT_USE_DEPLOYED=1 but ${outputsPath} is missing. Deploy first:\n` +
      `    bunx cdk deploy Sprout-${envName} --require-approval never --outputs-file sprout-${envName}-outputs.json`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, { ApiEndpoint?: string }>;
  const endpoint = parsed[`Sprout-${envName}`]?.ApiEndpoint;
  if (!endpoint) {
    throw new Error(`Stack output ApiEndpoint missing in ${outputsPath}`);
  }
  return endpoint;
}

async function main(): Promise<void> {
  // BEFORE any spawn: install the cleanup handlers so signals + crashes +
  // process.exit() paths all SIGTERM whatever we've started so far.
  // Without this, a failed API spawn would orphan vite + electron.
  installGlobalCleanup();

  const useDeployed = process.env.SPROUT_USE_DEPLOYED === '1';
  console.log(`starting sprout dev environment... ${useDeployed ? '(real Auth0 + deployed API)' : '(local mock)'}`);

  let apiUrl: string;
  let localApiProc: ChildProcess | undefined;

  if (useDeployed) {
    // Real cloud mode: skip the local Hono spawn, point Electron at the
    // deployed API endpoint, force real Auth0.
    apiUrl = loadDeployedApi();
    console.log(`  cloud API: ${apiUrl}`);
    process.env.MOCK_AUTH = '0';
    for (const required of ['AUTH0_DOMAIN', 'AUTH0_AUDIENCE', 'AUTH0_NATIVE_CLIENT_ID']) {
      if (!process.env[required]) {
        throw new Error(
          `SPROUT_USE_DEPLOYED=1 but ${required} is not set. Check .env or export it.`,
        );
      }
    }
  } else {
    // 1. Local API server (Hono on Node)
    const apiPort = process.env.LOCAL_API_PORT ?? '3001';
    const api = await spawnAndCaptureUrl({
      label: 'api',
      command: 'bunx',
      commandArgs: ['tsx', 'scripts/local-server.ts'],
      matcher: /listening on (http:\/\/[^\s]+)/i,
      env: {
        PORT: apiPort,
        MOCK_AUTH: process.env.MOCK_AUTH ?? '1',
        USE_LOCAL_DB: process.env.USE_LOCAL_DB ?? '1',
      },
    });
    apiUrl = api.url;
    localApiProc = api.proc;
  }

  // 2. Vite dev server (renderer)
  const vite = await spawnAndCaptureUrl({
    label: 'vite',
    command: 'bunx',
    commandArgs: ['vite', '--config', 'app/renderer/vite.config.ts'],
    matcher: /Local:\s+(http:\/\/[^\s]+)/,
  });

  // 3. Electron main + preload (esbuild bundle) and launch.
  await buildMainAndPreload();
  const electronBin = require.resolve('electron/cli.js');
  const electron = spawn('node', [electronBin, path.join(outDir, 'main/index.js')], {
    cwd: root,
    stdio: 'inherit',
    detached: true,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: vite.url,
      // In real-cloud mode services.ts reads CLOUD_API_URL first. In mock
      // mode it falls back to LOCAL_API_URL. Set whichever applies.
      ...(useDeployed
        ? { CLOUD_API_URL: apiUrl, MOCK_AUTH: '0' }
        : { LOCAL_API_URL: apiUrl, MOCK_AUTH: process.env.MOCK_AUTH ?? '1' }),
      // In production the bundled plugin tree is at process.resourcesPath/plugins
      // (electron-builder's `extraResources` copies app/resources/plugins → there).
      // In dev mode process.resourcesPath points at the Electron binary's own
      // resources dir — empty as far as Sprout is concerned. Point services.ts at
      // the staged source-tree copy instead. Without this, the deploy:status IPC
      // returns `resolution: 'none'` (no CI/CD plugins discovered) and the
      // "Publish to prod" top-bar button is hidden.
      SPROUT_BUNDLED_PLUGINS_DIR: path.join(root, 'app/resources/plugins'),
    },
  });
  trackChild(electron);
  // Suppress unused-var lint — localApiProc is still useful for future
  // per-process status checks; the tracked array drives cleanup.
  void localApiProc;

  // When Electron closes (user ⌘Q's it), shut down the whole dev stack
  // and exit the supervisor cleanly. The exit-handler installed by
  // installGlobalCleanup() takes care of SIGTERM'ing every tracked child
  // — we just trigger the supervisor to exit.
  electron.on('exit', () => process.exit(0));
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
