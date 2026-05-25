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
import * as path from 'node:path';
import * as url from 'node:url';
import { build, context as esbuildContext } from 'esbuild';
import { mainBundleConfig, preloadBundleConfig } from './electron-bundle-config.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist-electron');

interface SpawnedUrl {
  url: string;
  proc: ChildProcess;
}

function spawnAndCaptureUrl(args: {
  label: string;
  command: string;
  commandArgs: string[];
  matcher: RegExp;
  env?: NodeJS.ProcessEnv;
}): Promise<SpawnedUrl> {
  return new Promise((resolve, reject) => {
    const proc = spawn(args.command, args.commandArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...args.env },
    });
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

async function main(): Promise<void> {
  console.log('starting sprout dev environment...');

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
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: vite.url,
      LOCAL_API_URL: api.url,
      MOCK_AUTH: process.env.MOCK_AUTH ?? '1',
    },
  });

  const cleanup = (): void => {
    api.proc.kill('SIGTERM');
    vite.proc.kill('SIGTERM');
    electron.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  electron.on('exit', cleanup);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
