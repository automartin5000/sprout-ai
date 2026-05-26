/**
 * Builds the Sprout shared runtime Lambda + Lambda@Edge router + placeholder
 * bundle. Emits everything under `runtime/dist/`:
 *   - runtime/dist/handler.zip       — shared runtime Lambda code (CJS bundle)
 *   - runtime/dist/edge-router.zip   — Lambda@Edge code (CJS bundle, AWS SDK bundled in)
 *   - runtime/dist/placeholder.zip   — `<projectId>/v0/server.zip` payload
 *
 * handler.zip also includes a `placeholder/server.js` sibling so the runtime
 * Lambda can fall back to the "starting up" page when a project has no
 * published bundle.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const runtimeDir = path.join(root, 'runtime');
const distDir = path.join(runtimeDir, 'dist');

async function main(): Promise<void> {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  await buildHandler();
  await buildEdgeRouter();
  buildPlaceholder();

  zipDir(path.join(distDir, 'handler-stage'), path.join(distDir, 'handler.zip'));
  zipDir(path.join(distDir, 'edge-router-stage'), path.join(distDir, 'edge-router.zip'));
  zipDir(path.join(distDir, 'placeholder-stage'), path.join(distDir, 'placeholder.zip'));

  // eslint-disable-next-line no-console
  console.log('runtime build complete:', fs.readdirSync(distDir).sort());
}

async function buildHandler(): Promise<void> {
  const stage = path.join(distDir, 'handler-stage');
  fs.mkdirSync(path.join(stage, 'placeholder'), { recursive: true });

  await build({
    entryPoints: [path.join(runtimeDir, 'handler.ts')],
    outfile: path.join(stage, 'index.js'),
    bundle: true,
    platform: 'node',
    // esbuild 0.28 understands node24; if a future esbuild drops it, drop one.
    target: 'node24',
    format: 'cjs',
    sourcemap: 'linked',
    // Lambda's Node runtime ships the AWS SDK v3 in /var/runtime — external.
    external: ['@aws-sdk/*'],
    minify: true,
    logLevel: 'info',
  });

  fs.copyFileSync(
    path.join(runtimeDir, 'placeholder', 'server.js'),
    path.join(stage, 'placeholder', 'server.js'),
  );

  fs.writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: 'sprout-runtime', version: '0.0.0', type: 'commonjs' }, null, 2) + '\n',
  );
}

async function buildEdgeRouter(): Promise<void> {
  const stage = path.join(distDir, 'edge-router-stage');
  fs.mkdirSync(stage, { recursive: true });

  // Lambda@Edge cannot have env vars — the edge function reads
  // `process.env.SPROUT_EDGE_TABLE_NAME` and falls back to a placeholder
  // marker that ONLY works if it's substituted at build time. Bake the real
  // table name in via esbuild's `define` so the deployed bundle has the
  // literal string. DEPLOY_ENV is set by the projen task chain at synth
  // time; default to 'dev' for local builds.
  const deployEnv = process.env.DEPLOY_ENV ?? 'dev';
  const tableName = `sprout-${deployEnv}`;

  await build({
    entryPoints: [path.join(runtimeDir, 'edge-router.ts')],
    outfile: path.join(stage, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: false,
    // Lambda@Edge: bundle EVERYTHING. No env vars, no shared layer, 1MB cap.
    minify: true,
    logLevel: 'info',
    define: {
      // Inline the table name. esbuild rewrites `process.env.SPROUT_EDGE_TABLE_NAME`
      // to the literal at every call site, so the `?? '__SPROUT_TABLE_NAME__'`
      // fallback in edge-router.ts becomes unreachable in the built bundle.
      'process.env.SPROUT_EDGE_TABLE_NAME': JSON.stringify(tableName),
    },
  });

  fs.writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: 'sprout-edge-router', version: '0.0.0', type: 'commonjs' }, null, 2) + '\n',
  );

  const sizeBytes = fs.statSync(path.join(stage, 'index.js')).size;
  if (sizeBytes > 1_000_000) {
    throw new Error(
      `edge-router bundle is ${sizeBytes} bytes — exceeds Lambda@Edge 1MB cap. ` +
      'Trim dependencies or move logic to the runtime Lambda.',
    );
  }
}

function buildPlaceholder(): void {
  const stage = path.join(distDir, 'placeholder-stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(
    path.join(runtimeDir, 'placeholder', 'server.js'),
    path.join(stage, 'server.js'),
  );
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: 'sprout-placeholder', version: '0.0.0', type: 'commonjs' }, null, 2) + '\n',
  );
}

function zipDir(srcDir: string, outZip: string): void {
  fs.rmSync(outZip, { force: true });
  const res = spawnSync('zip', ['-r', '-q', outZip, '.'], { cwd: srcDir });
  if (res.status !== 0) {
    throw new Error(`zip ${srcDir} -> ${outZip} failed: ${res.stderr?.toString() ?? ''}`);
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('runtime build failed', err);
  process.exit(1);
});
