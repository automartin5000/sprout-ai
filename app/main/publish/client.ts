import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApiClient } from '../cloud/api-client.js';

export interface PublishOptions {
  /** The project's local working-tree root. */
  projectRoot: string;
  /** The cloud-side projectId — addresses the row in the Sprout API. */
  projectId: string;
  /** Human-readable project name. Sent on the publish request so the API
   *  can auto-register the project on first publish with a sensible name
   *  (vs falling back to the projectId UUID). */
  projectName?: string;
  /** Optional share code for collaborator publishes (no JWT). */
  shareCode?: string;
  /**
   * Progress callback — fired as each phase begins. Used by the renderer to
   * show the modal's progress states ("building → uploading → live").
   */
  onProgress?: (event: PublishProgressEvent) => void;
}

export type PublishProgressEvent =
  | { phase: 'building' }
  | { phase: 'packaging' }
  | { phase: 'uploading'; bytes: number }
  | { phase: 'activating' }
  | { phase: 'live'; url: string }
  | { phase: 'failed'; error: string };

export interface PublishResult {
  version: number;
  publishedUrl: string;
}

/**
 * Sprout Phase 3 publish: build the user's app on this machine, package the
 * output into two bundles (static assets + server zip), upload via presigned
 * URLs, then ask the API to "complete" the publish — which copies the bundles
 * into the live buckets and bumps the project version row. The shared runtime
 * Lambda picks up the new version on its next cache miss.
 *
 *   build → package → upload → activate → live
 *
 * No CodeBuild. No per-project CDK. No CloudFormation.
 */
export class PublishClient {
  constructor(private readonly api: ApiClient) {}

  async publish(opts: PublishOptions): Promise<PublishResult> {
    const progress = opts.onProgress ?? (() => undefined);

    // 1. Build locally. The desktop sets NEXT_PUBLIC_BASE_PATH so internal
    //    links land at /<projectId> when CloudFront mounts the app there.
    progress({ phase: 'building' });
    await this.runBuild(opts.projectRoot, opts.projectId);

    // 2. Package output into two bundles.
    progress({ phase: 'packaging' });
    const { staticTar, serverZip, hasServer } = await this.packageBuildOutput(opts.projectRoot);

    let staticBuf: Buffer;
    let serverBuf: Buffer | undefined;
    try {
      staticBuf = await fs.readFile(staticTar);
      if (hasServer && serverZip) serverBuf = await fs.readFile(serverZip);
    } finally {
      void fs.unlink(staticTar).catch(() => undefined);
      if (serverZip) void fs.unlink(serverZip).catch(() => undefined);
    }

    // 3. Ask the API for presigned URLs + the target version number.
    type StartResp = {
      projectId: string;
      version: number;
      staticUploadUrl: string;
      serverUploadUrl?: string;
      publishedUrl: string;
    };
    // Pass projectName so the API can auto-register the project on first
    // publish (the desktop creates projects locally only; the cloud side
    // sees them for the first time here). Share-code publishes hit an
    // already-existing project so the name isn't needed.
    const start = opts.shareCode
      ? await this.api.post<StartResp>(`/share/${opts.shareCode}/publish`, {}, { anonymous: true })
      : await this.api.post<StartResp>(
          `/projects/${opts.projectId}/publish`,
          { projectName: opts.projectName },
        );

    // 4. Upload both bundles in parallel.
    const totalBytes = staticBuf.byteLength + (serverBuf?.byteLength ?? 0);
    progress({ phase: 'uploading', bytes: totalBytes });
    await Promise.all([
      ApiClient.putBlob(start.staticUploadUrl, staticBuf, 'application/gzip'),
      hasServer && serverBuf && start.serverUploadUrl
        ? ApiClient.putBlob(start.serverUploadUrl, serverBuf, 'application/zip')
        : Promise.resolve(),
    ]);

    // 5. Tell the API to promote the bundles + bump the version. The share-code
    //    flow has its own anonymous complete endpoint that mirrors the owner one;
    //    we just swap the URL based on whether opts.shareCode is set.
    progress({ phase: 'activating' });
    type CompleteResp = { version: number; publishedUrl: string };
    const complete = opts.shareCode
      ? await this.api.post<CompleteResp>(
          `/share/${opts.shareCode}/publish/complete`,
          { version: start.version, hasServer },
          { anonymous: true },
        )
      : await this.api.post<CompleteResp>(
          `/projects/${opts.projectId}/publish/complete`,
          { version: start.version, hasServer },
        );

    progress({ phase: 'live', url: complete.publishedUrl });
    return { version: complete.version, publishedUrl: complete.publishedUrl };
  }

  /**
   * Run the user's project build command. Detects from package.json: prefers
   * `bun run build`, falls back to `npm run build`. Sets NEXT_PUBLIC_BASE_PATH
   * so Next.js (or similar) builds with the correct base href for the
   * `/<projectId>/` mount point.
   */
  private async runBuild(root: string, projectId: string): Promise<void> {
    const pkgPath = path.join(root, 'package.json');
    const hasPkg = await fs.stat(pkgPath).then(() => true).catch(() => false);
    if (!hasPkg) {
      // Static-only project with no build step — nothing to do.
      return;
    }

    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    if (!pkg.scripts?.build) {
      // No build script — assume already built (e.g. handcrafted static site).
      return;
    }

    const cmd = await which('bun') ? 'bun' : 'npm';
    const args = cmd === 'bun' ? ['run', 'build'] : ['run', 'build'];

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: root,
        env: {
          ...process.env,
          NEXT_PUBLIC_BASE_PATH: `/${projectId}`,
          PUBLIC_URL: `/${projectId}/`,
          VITE_BASE_PATH: `/${projectId}/`,
        },
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`build failed (${code}): ${stderr.slice(-1000)}`));
      });
      child.on('error', reject);
    });
  }

  /**
   * Inspect the worktree's build output and split it into:
   *
   *   static.tar.gz — anything destined for the assets bucket (public/, .next/static, .next/server's static bits, dist/)
   *   server.zip    — anything destined for the runtime Lambda (.next/standalone/ + .next/server)
   *
   * Heuristic detection by inspecting which directories exist after the build.
   */
  private async packageBuildOutput(root: string): Promise<{
    staticTar: string;
    serverZip?: string;
    hasServer: boolean;
  }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-publish-'));
    const staticTar = path.join(tmpDir, 'static.tar.gz');
    const serverZip = path.join(tmpDir, 'server.zip');

    const hasNextStandalone = await dirExists(path.join(root, '.next', 'standalone'));
    const hasNextStatic = await dirExists(path.join(root, '.next', 'static'));
    const hasDist = await dirExists(path.join(root, 'dist'));
    const hasOut = await dirExists(path.join(root, 'out'));
    const hasPublic = await dirExists(path.join(root, 'public'));
    // The sprout hono-react starter compiles its Hono server to
    // `server-dist/server.js` via esbuild. If both server-dist/ and dist/
    // are present, this is the "vite + Hono" pattern and we package BOTH:
    // dist/ → static.tar.gz, server-dist/ → server.zip.
    const hasServerDist = await dirExists(path.join(root, 'server-dist'));

    // Decide layout
    if (hasNextStandalone) {
      // Next.js (output: 'standalone'). Split:
      //   server.zip <- .next/standalone/  (includes node_modules + server.js)
      //   static.tar.gz <- .next/static + public
      await tarOrZip({ kind: 'zip', cwd: path.join(root, '.next', 'standalone'), out: serverZip });
      await tarOrZip({
        kind: 'tar',
        cwd: root,
        out: staticTar,
        paths: [
          ...(hasNextStatic ? ['.next/static'] : []),
          ...(hasPublic ? ['public'] : []),
        ],
      });
      return { staticTar, serverZip, hasServer: true };
    }

    if (hasOut) {
      // Next.js `next export` (static-only) outputs to ./out/
      await tarOrZip({ kind: 'tar', cwd: path.join(root, 'out'), out: staticTar });
      return { staticTar, hasServer: false };
    }

    if (hasDist) {
      // Static side always goes from dist/. If server-dist/ exists too,
      // this is the Sprout hono-react template (vite + Hono) — bundle the
      // server bits too. Without this branch, the publish always lands as
      // static-only and any /api routes 404 in prod.
      await tarOrZip({ kind: 'tar', cwd: path.join(root, 'dist'), out: staticTar });
      if (hasServerDist) {
        await tarOrZip({ kind: 'zip', cwd: path.join(root, 'server-dist'), out: serverZip });
        return { staticTar, serverZip, hasServer: true };
      }
      return { staticTar, hasServer: false };
    }

    if (hasPublic) {
      // Hand-rolled static site — just tar `public/`
      await tarOrZip({ kind: 'tar', cwd: path.join(root, 'public'), out: staticTar });
      return { staticTar, hasServer: false };
    }

    throw new Error(
      "Couldn't find a build output (.next/standalone, dist/, out/, or public/). " +
      "Make sure your project has a build script that produces one of these.",
    );
  }
}

/* ── Helpers ────────────────────────────────────────────── */

async function dirExists(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

async function which(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', [cmd], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function tarOrZip(opts: {
  kind: 'tar' | 'zip';
  cwd: string;
  out: string;
  /** When set, tar these subpaths from cwd; otherwise the whole cwd. */
  paths?: string[];
}): Promise<void> {
  if (opts.kind === 'tar') {
    const args = ['-czf', opts.out, '-C', opts.cwd, ...(opts.paths ?? ['.'])];
    return runProcess('tar', args);
  }
  // For zip we cd into cwd so the archive's paths are relative — Lambda
  // unpacks at /var/task and expects `server.js` (or similar) at the root.
  return runProcess('zip', ['-rq', opts.out, '.'], { cwd: opts.cwd });
}

function runProcess(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (${code}): ${stderr}`));
    });
    child.on('error', reject);
  });
}
