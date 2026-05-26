/**
 * End-to-end smoke test for the "user creates a project, AI scaffolds, dev
 * server starts" path. Exercises the real bundled sprout plugin (via the
 * staged copy under app/resources/plugins/sprout) and the real DevServer
 * resolution + spawn logic.
 *
 * Catches the regressions we've actually hit on the human-iteration loop:
 *   • permission-deny on every tool call (5 min wait, then refusal)
 *   • CLAUDE_PLUGIN_ROOT not set → bootstrap can't find the template
 *   • dev-server preferring bun over npm
 *   • static-HTML projects with no `dev` script not getting a preview
 *   • pre-bundled node_modules missing from the staged plugin
 *
 * NOT covered (would need a fake harness): permission flow itself, IPC,
 * Auth0, cloud publish. Those are pure plumbing — the regressions we see
 * in practice are in the parts this test does cover.
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevServer, NoDevServerError } from '../app/main/projects/dev-server.js';
import { SPROUT_LOCAL_TABLE, startLocalDdb, type LocalDdb } from '../app/main/dynalite/server.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'app', 'resources', 'plugins', 'sprout');

describe('staged sprout plugin', () => {
  it('has the expected file layout', async () => {
    const required = [
      '.claude-plugin/plugin.json',
      'skills/new-app/SKILL.md',
      'scripts/bootstrap-app.sh',
      'templates/hono-react/package.json',
      'templates/hono-react/server/index.ts',
      'templates/hono-react/client/App.tsx',
    ];
    for (const rel of required) {
      await expect(
        fs.stat(path.join(PLUGIN_ROOT, rel)),
        `missing ${rel}`,
      ).resolves.toBeTruthy();
    }
  });

  it('ships pre-bundled node_modules so the AI doesn\'t have to run npm install', async () => {
    // The bootstrap script skips `npm install` when node_modules already
    // exists; that's the whole reason scaffold should be fast. If this fails,
    // a fresh scaffold will fall back to a 2–4 minute install.
    await expect(
      fs.stat(path.join(PLUGIN_ROOT, 'templates', 'hono-react', 'node_modules')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(PLUGIN_ROOT, 'templates', 'hono-react', 'node_modules', 'vite')),
    ).resolves.toBeTruthy();
  });

  it('bootstrap script uses CLAUDE_PLUGIN_ROOT and not a hardcoded path', async () => {
    const sh = await fs.readFile(
      path.join(PLUGIN_ROOT, 'scripts', 'bootstrap-app.sh'),
      'utf8',
    );
    expect(sh).toContain('CLAUDE_PLUGIN_ROOT');
    // Bootstrap should NOT do `npm install` unconditionally — only when
    // node_modules is missing. Without this guard, our prebundle is wasted.
    expect(sh).toMatch(/if \[\[ -d "\$DEST\/node_modules" \]\]/);
  });

  it('SKILL.md tells the AI not to use bun/pnpm/yarn', async () => {
    const md = await fs.readFile(
      path.join(PLUGIN_ROOT, 'skills', 'new-app', 'SKILL.md'),
      'utf8',
    );
    expect(md.toLowerCase()).toContain('npm');
    expect(md).toMatch(/don'?t try bun|use npm/i);
  });
});

describe('bootstrap → scaffold', () => {
  let tmpProject: string;
  beforeAll(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-e2e-'));
  });
  afterAll(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it('scaffolds a new app via bootstrap-app.sh with CLAUDE_PLUGIN_ROOT set', async () => {
    const bootstrap = path.join(PLUGIN_ROOT, 'scripts', 'bootstrap-app.sh');
    await runShell(
      'bash',
      [bootstrap, 'test-app', tmpProject],
      { env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } },
    );

    await expect(fs.stat(path.join(tmpProject, 'package.json'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(tmpProject, 'node_modules'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(tmpProject, '.sprout-scaffolded'))).resolves.toBeTruthy();

    const pkg = JSON.parse(await fs.readFile(path.join(tmpProject, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('test-app');
    // Placeholder substitution should have run on server source too.
    const serverSrc = await fs.readFile(path.join(tmpProject, 'server/index.ts'), 'utf8');
    expect(serverSrc).not.toContain('__APP_NAME__');
    expect(serverSrc).not.toContain('__APP_SLUG__');
  }, 90_000);

  it('the scaffolded project starts a dev server and returns a URL', async () => {
    const server = new DevServer();
    try {
      const url = await Promise.race([
        server.start({ projectRoot: tmpProject }),
        rejectAfter(45_000, 'dev server start timed out'),
      ]);
      // Template's Hono server binds to localhost; static fallback binds to
      // 127.0.0.1. Either is fine for the preview pane.
      expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
    } finally {
      await server.stop();
    }
  }, 60_000);
});

describe('DevServer static-HTML fallback', () => {
  let tmpProject: string;
  beforeAll(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-static-e2e-'));
    await fs.writeFile(
      path.join(tmpProject, 'index.html'),
      '<!doctype html><h1>sprout static fallback</h1>',
      'utf8',
    );
  });
  afterAll(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it('serves index.html when there is no package.json (AI-wrote-vanilla-html case)', async () => {
    const server = new DevServer();
    try {
      const url = await Promise.race([
        server.start({ projectRoot: tmpProject }),
        rejectAfter(20_000, 'static fallback start timed out'),
      ]);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);
      // Actually fetch it to make sure the server is responding.
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('sprout static fallback');
    } finally {
      await server.stop();
    }
  }, 30_000);

  it('throws NoDevServerError on an empty worktree', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-empty-'));
    try {
      const server = new DevServer();
      await expect(server.start({ projectRoot: empty })).rejects.toBeInstanceOf(
        NoDevServerError,
      );
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

/**
 * End-to-end DDB round trip: dynalite up → user project hits /api/greeting
 * PUT then GET → value lands in dynalite under the project-prefixed key.
 *
 * This is the test that should have existed before the DynamoDB
 * ResourceNotFoundException ever made it to the user. If it breaks, the
 * AI-written code that uses `new DynamoDBClient({})` won't work locally.
 */
describe('dynalite ↔ user-project round trip', () => {
  let tmpProject: string;
  let dynaliteData: string;
  let ddb: LocalDdb | undefined;

  beforeAll(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-ddb-e2e-'));
    dynaliteData = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-dynalite-'));

    // Boot dynalite once for the whole describe block. Setting the env var
    // mirrors what main/index.ts does — DevServer reads it from process.env
    // when building the spawned child's environment.
    ddb = await startLocalDdb({ dataPath: dynaliteData });
    process.env.SPROUT_DYNALITE_ENDPOINT = ddb.endpoint;

    // Scaffold the template into the tmp project.
    await runShell(
      'bash',
      [path.join(PLUGIN_ROOT, 'scripts', 'bootstrap-app.sh'), 'ddb-test', tmpProject],
      { env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } },
    );
  }, 90_000);

  afterAll(async () => {
    delete process.env.SPROUT_DYNALITE_ENDPOINT;
    if (ddb) await ddb.stop().catch(() => undefined);
    await fs.rm(tmpProject, { recursive: true, force: true });
    await fs.rm(dynaliteData, { recursive: true, force: true });
  });

  it('dynalite started and the sprout-local table is reachable', async () => {
    expect(ddb).toBeDefined();
    expect(ddb!.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(SPROUT_LOCAL_TABLE).toBe('sprout-local');
  });

  it('user-project server reads + writes through /api/greeting and the value lands in dynalite', async () => {
    // The hono-react template hardcodes the API on 5175 + the vite UI on 5174.
    // If a parallel dev session is holding EITHER port, the test's vite
    // will pick the next free port and may end up colliding with the API
    // port (or vice versa). The downstream API calls then fail for purely
    // environmental reasons. Skip cleanly when either is bound; CI never
    // has the conflict.
    if (await isPortInUse(5174) || await isPortInUse(5175)) {
      console.warn('port 5174 or 5175 in use (likely a parallel dev session); skipping dev-server round-trip test');
      return;
    }

    const server = new DevServer();
    try {
      const url = await Promise.race([
        server.start({ projectRoot: tmpProject, projectId: 'test-proj' }),
        rejectAfter(60_000, 'dev server start timed out'),
      ]);

      // DevServer must lock onto VITE (the UI), not Hono (the API). If it
      // picks up the API's banner first, the preview pane ends up pointing at
      // the API port — which only serves /api/* and 404s on /, so the user
      // sees a blank page. We tolerate vite picking up a non-default port
      // (5174 may be in use by a parallel dev session) but the URL MUST NOT
      // be the API port (5175 in the template).
      expect(url).not.toMatch(/:5175\/?$/);
      expect(url).toMatch(/:51\d\d\/?$/);

      // Once the dev server emits its URL, the entire dev stack must be
      // usable — including the /api proxy. Previously dev:client (vite) ran
      // in parallel with dev:server (tsx), so vite's "ready" beat Hono to
      // the punch and the very first browser /api call got ECONNREFUSED.
      // The template now gates `vite` behind `wait-on tcp:5175`, so this
      // first /api/health fetch should succeed on attempt #1.
      const apiBase = url.replace(/\/$/, '');
      await waitForApi(`${apiBase}/api/health`, 30_000);

      // PUT a value, then GET it back.
      const putRes = await fetch(`${apiBase}/api/greeting`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello from the e2e test' }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await fetch(`${apiBase}/api/greeting`);
      expect(getRes.status).toBe(200);
      const body = await getRes.json() as { message: string };
      expect(body.message).toBe('hello from the e2e test');
    } finally {
      await server.stop();
    }
  }, 90_000);
});

/** Poll an endpoint until it returns any 2xx. Used to wait for the user
 *  project's Hono server (running in the second concurrently slot) to come
 *  up before we hammer it with test requests. */
async function waitForApi(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForApi(${url}) timed out after ${timeoutMs}ms: ${lastErr}`);
}

/* ── helpers ───────────────────────────────────────────────── */

function runShell(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: 'pipe' });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${stderr}`));
    });
    child.on('error', reject);
  });
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

/** Returns true if `port` is currently bound on any interface (IPv4 OR IPv6).
 *  Used to detect when a parallel dev session is holding the template's
 *  hardcoded API port. We probe by attempting a TCP CONNECT to both v4 and
 *  v6 localhost — a successful connect = something is listening = in use.
 *  net.createServer().listen() is unreliable here because the existing
 *  process may be on `*:port` (IPv6 dual-stack) while createServer binds to
 *  v4 only, returning a false negative. */
async function isPortInUse(port: number): Promise<boolean> {
  const net = await import('node:net');
  const tryConnect = (host: string) =>
    new Promise<boolean>((resolve) => {
      const sock = new net.Socket();
      const cleanup = () => sock.destroy();
      sock.once('connect', () => { cleanup(); resolve(true); });
      sock.once('error', () => { cleanup(); resolve(false); });
      sock.setTimeout(500, () => { cleanup(); resolve(false); });
      sock.connect(port, host);
    });
  const [v4, v6] = await Promise.all([tryConnect('127.0.0.1'), tryConnect('::1')]);
  return v4 || v6;
}
