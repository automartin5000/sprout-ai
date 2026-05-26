import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

export interface DevServerStartOpts {
  projectRoot: string;
  /** Detected from package.json scripts if omitted. */
  command?: string;
  args?: string[];
  /** Sprout project id — propagated to the spawned process as
   *  `SPROUT_PROJECT_ID` so AI-written server code can prefix DDB keys
   *  with `PROJECT#<id>#…` per the tenancy convention. */
  projectId?: string;
}

/**
 * Thrown by DevServer.start() when the project has nothing to run yet (no
 * package.json or no dev/start script). Callers should catch this and treat
 * it as "preview not available yet" — not as a real failure.
 */
export class NoDevServerError extends Error {
  readonly code = 'NO_DEV_SERVER';
  constructor(message: string) {
    super(message);
    this.name = 'NoDevServerError';
  }
}

export interface DevServerError {
  source: 'stderr' | 'overlay';
  text: string;
}

const URL_PATTERNS = [
  /Local:\s+(http:\/\/[^\s]+)/i,
  /ready at\s+(http:\/\/[^\s]+)/i,
  /listening on\s+(http:\/\/[^\s]+)/i,
  // Our built-in static-HTML fallback prints this exact line.
  /static server:\s+(http:\/\/[^\s]+)/i,
];

const ERROR_PATTERNS = [
  /error TS\d+/i,
  /SyntaxError:/i,
  /Failed to compile/i,
  /\[vite\] Internal server error/i,
  /Module not found/i,
];

/**
 * Spawns the project's dev server, parses its startup banner for a URL, and
 * scrapes its stderr for build/runtime errors. Errors are emitted on the
 * 'error-detected' channel so the self-healing loop can inject them back into
 * the harness conversation.
 */
export class DevServer extends EventEmitter {
  private proc?: ChildProcess;
  private _url?: string;

  get url(): string | undefined {
    return this._url;
  }

  async start(opts: DevServerStartOpts): Promise<string> {
    const resolved = await resolveDevCommand(opts);
    if (!resolved) {
      // No package.json or no runnable script — common for a freshly-created
      // project that hasn't been scaffolded yet. Throw a tagged error so the
      // caller (services.ts) can swallow it without logging a confusing trace.
      throw new NoDevServerError(
        'no package.json or dev script in this project yet — preview will appear after the first build',
      );
    }
    const { command, args } = resolved;

    // PORT injection is ONLY safe for our own internal static-server
    // fallback (`node -e <inline>` — needs a known port for the URL we
    // return). For user `npm run …` scripts, leaving PORT unset lets the
    // project's own vite.config / server code use their conventional ports
    // (5174 for vite, 5175 for the API server). Injecting PORT into a
    // multi-process `concurrently` setup made BOTH child processes try to
    // claim the same port, and broke Vite's hardcoded /api proxy target.
    const isInternalStaticServer = command === 'node' && args[0] === '-e';
    const port = isInternalStaticServer ? await pickFreePort() : undefined;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BROWSER: 'none',
      HOST: '127.0.0.1',
      // Workaround for the Node 22 corepack signature-verification bug
      // ("Cannot find matching keyid"). Affects any project with a
      // `packageManager` field in package.json. Setting this to 0 skips
      // corepack's integrity check so `bun/pnpm/yarn` commands proxied
      // through corepack actually run. Safe locally; the user's package
      // manager itself still verifies its own downloads.
      COREPACK_INTEGRITY_KEYS: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    };
    if (port !== undefined) env.PORT = String(port);

    // ── Local DynamoDB transparency ────────────────────────────────────
    // If the main process started dynalite at boot, point every user-project
    // subprocess at it. AI-written code uses the standard AWS SDK
    // (`new DynamoDBClient({})`) which reads AWS_ENDPOINT_URL_DYNAMODB
    // automatically — so the SAME code that runs locally also runs
    // unmodified against real DDB in production Lambda.
    const dynaliteEndpoint = process.env.SPROUT_DYNALITE_ENDPOINT;
    if (dynaliteEndpoint) {
      env.AWS_ENDPOINT_URL_DYNAMODB = dynaliteEndpoint;
      env.AWS_REGION = env.AWS_REGION ?? 'us-east-1';
      // dynalite ignores credentials but the SDK demands them be present.
      env.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID ?? 'local';
      env.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY ?? 'local';
      env.SPROUT_DATA_TABLE = env.SPROUT_DATA_TABLE ?? 'sprout-local';
    }
    if (opts.projectId) env.SPROUT_PROJECT_ID = opts.projectId;

    // `detached: true` puts the child in its own process group, so we can
    // later kill the WHOLE TREE atomically via `process.kill(-pid, ...)`.
    // Without this, `bun run dev` → concurrently → (npx tsx watch, vite)
    // gets only the top `bun` SIGTERM'd, and the grandchildren keep
    // holding ports 5174/5175 forever. That orphan chain is the root
    // cause of the EADDRINUSE that breaks the NEXT `pj app:dev` launch.
    this.proc = spawn(command, args, {
      cwd: opts.projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // We only capture the FIRST URL printed by the child process. For the
    // standard hono-react template that's vite (the client) — exactly what
    // the WebContentsView wants. A later "Local: …" line from the API
    // subprocess would otherwise overwrite `_url` to the API port (which
    // doesn't serve HTML), and any subsequent `attachPreview` call would
    // point the preview at a 404.
    let urlMatched = false;
    const urlPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('dev server did not produce a URL in 60s')),
        60_000,
      );

      this.proc!.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(`[dev] ${text}`);
        if (urlMatched) return;
        for (const pattern of URL_PATTERNS) {
          const match = text.match(pattern);
          if (match) {
            urlMatched = true;
            clearTimeout(timeout);
            resolve(match[1].trim());
            return;
          }
        }
      });
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(`[dev:err] ${text}`);
      if (ERROR_PATTERNS.some((p) => p.test(text))) {
        const event: DevServerError = { source: 'stderr', text };
        this.emit('error-detected', event);
      }
    });

    this.proc.on('exit', (code) => this.emit('exit', code));

    const rawUrl = await urlPromise;
    // ── Wait for the dev stack to actually serve requests ──────────────
    // Vite prints "Local:" the instant it's listening, but if the project
    // also spawns a separate API server (via `concurrently npm:dev:server`),
    // vite's proxy target may not be bound yet. If we attach the
    // WebContentsView right now, the page's first /api call gets
    // ECONNREFUSED in vite's proxy and the app looks broken.
    //
    // We could probe vite's `/api/*` endpoint, but every failed probe
    // shows up as `[vite] http proxy error: /api/health` in the user's
    // terminal — so the probe itself becomes noise. Instead we probe the
    // API server's port directly over raw TCP, which vite never sees.
    // The port is the hono-react template's convention (5175); for
    // projects without a `dev:server` script the probe is skipped.
    await this.waitForReady(opts.projectRoot);

    this._url = rawUrl;
    this.emit('ready', rawUrl);
    return rawUrl;
  }

  /**
   * Wait for the dev stack's API port to be listening. Skipped when the
   * project doesn't declare a `dev:server` script — there's nothing to
   * race against in that case. Best-effort: if the port never opens we
   * proceed anyway so a project with a permanently-broken API still
   * surfaces in the preview pane (where the error is at least visible).
   */
  private async waitForReady(projectRoot: string): Promise<void> {
    const apiPort = await detectApiPort(projectRoot);
    if (apiPort === undefined) return;
    await pollTcp('127.0.0.1', apiPort, 20_000).catch(() => undefined);
  }

  reportOverlayError(text: string): void {
    const event: DevServerError = { source: 'overlay', text };
    this.emit('error-detected', event);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const pid = this.proc.pid;
    return new Promise((resolve) => {
      this.proc!.once('exit', () => resolve());
      // We spawned with `detached: true` so this child is its own process-
      // group leader. Signal the whole group (negative pid → pgid) so
      // every grandchild — vite, tsx watch, the bundled hono server —
      // gets the same signal at the same time. Falling back to a plain
      // proc.kill on a pid we don't have keeps us safe if spawn never
      // produced one (failed to launch).
      const killTree = (sig: NodeJS.Signals): void => {
        try {
          if (typeof pid === 'number') process.kill(-pid, sig);
          else this.proc?.kill(sig);
        } catch {
          // ESRCH: already exited. Anything else: the SIGKILL fallback
          // below will retry.
        }
      };
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 3000);
    });
  }
}

/**
 * Resolve how to spawn the project's dev server. Returns undefined when
 * there's nothing meaningful to run — completely empty worktree, no
 * `index.html`, no package.json. Callers should treat that as "no preview
 * yet" rather than an error.
 *
 * Resolution order:
 *   1. opts.command override
 *   2. package.json with `dev:server` / `dev` / `start` script → npm run …
 *   3. `index.html` at root → tiny built-in static file server (handles the
 *      common "the AI wrote a vanilla HTML page, no node toolchain" case)
 *   4. nothing → undefined
 */
async function resolveDevCommand(
  opts: DevServerStartOpts,
): Promise<{ command: string; args: string[] } | undefined> {
  if (opts.command) return { command: opts.command, args: opts.args ?? [] };

  // ── Path 2: real Node project with a recognised dev script ──────────────
  const pkgRaw = await fs
    .readFile(path.join(opts.projectRoot, 'package.json'), 'utf8')
    .catch(() => undefined);
  if (pkgRaw) {
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    } catch {
      pkg = {};
    }
    // Prefer `dev` over `dev:server` because `dev` is the user-facing entry
    // (typically Vite, which serves the actual app at `/` and proxies API
    // calls). `dev:server` is server-only — visiting `/` returns 404 because
    // Hono has no static-files handler. Fallback to `dev:server` is for
    // server-only / API-only projects.
    const scriptName = pkg.scripts?.dev
      ? 'dev'
      : pkg.scripts?.['dev:server']
        ? 'dev:server'
        : pkg.scripts?.start
          ? 'start'
          : undefined;
    if (scriptName) {
      // Prefer `npm` (always ships with Node). Avoids Node 22 corepack's
      // signature-verification bug that breaks shimmed pnpm/yarn/bun.
      for (const candidate of ['npm', 'pnpm', 'bun']) {
        if (await isOnPath(candidate)) {
          return { command: candidate, args: ['run', scriptName] };
        }
      }
      return { command: 'npm', args: ['run', scriptName] };
    }
  }

  // ── Path 3: static-HTML fallback ────────────────────────────────────────
  // When the AI writes a vanilla index.html (no package.json, or one with
  // no dev script), we still want a preview. Spin up a tiny inline Node
  // static file server pinned to the project root.
  const hasIndexHtml = await fs
    .stat(path.join(opts.projectRoot, 'index.html'))
    .then(() => true)
    .catch(() => false);
  if (hasIndexHtml) {
    return {
      command: 'node',
      args: ['-e', STATIC_SERVER_INLINE, '--', opts.projectRoot],
    };
  }

  return undefined;
}

/**
 * A small ad-hoc static file server we run via `node -e`. Self-contained so
 * we don't need to ship a separate .js file in the bundle. Reads root path
 * from argv, port from PORT env var.
 */
const STATIC_SERVER_INLINE = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const port = Number(process.env.PORT || 0);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};
http.createServer((req, res) => {
  try {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url.endsWith('/')) url += 'index.html';
    const file = path.resolve(root, '.' + url);
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) {
        // SPA fallback: missing file → serve index.html with 200 so
        // client-side routers still work for vanilla static apps.
        fs.readFile(path.join(root, 'index.html'), (err2, idx) => {
          if (err2) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': TYPES['.html'] });
          res.end(idx);
        });
        return;
      }
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) { res.writeHead(500); res.end(String(e && e.message || e)); }
}).listen(port, '127.0.0.1', () => {
  console.log('static server: http://127.0.0.1:' + (port || 'auto') + '/');
});
`;

function isOnPath(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [binary], {
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Try to open a TCP connection to `host:port`. Resolves when the socket
 * connects (and immediately closes it) or rejects on timeout. We use this
 * — rather than fetching vite's proxy — so probe attempts don't show up
 * as `[vite] http proxy error` lines in the user's terminal while the
 * upstream is still booting.
 */
async function pollTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await tryConnect(host, port, 2000);
      return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`pollTcp(${host}:${port}) timed out: ${String(lastErr)}`);
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connect timed out'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Look at the project's package.json. If there's a `dev:server` script
 * (the hono-react template convention), return the conventional API port
 * (5175). Otherwise return undefined — a project without a separate API
 * server has nothing to race against and the readiness probe is skipped.
 *
 * We could try to parse the actual port out of `server/index.ts`, but
 * 100% of our scaffolds use 5175 and the cost of guessing wrong is
 * bounded (20s timeout, then proceed).
 */
async function detectApiPort(projectRoot: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (pkg.scripts?.['dev:server']) return 5175;
  } catch {
    /* no package.json or unparseable — fall through */
  }
  return undefined;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('could not pick free port'));
      }
    });
  });
}
