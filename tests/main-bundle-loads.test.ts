/**
 * Smoke test: the Electron main bundle (`dist-electron/main/index.js`)
 * actually loads at runtime.
 *
 * Type-check + esbuild-success alone don't prove the bundle works. Real-world
 * regressions we want to catch here:
 *   • CJS-only globals (`__dirname`, `__filename`, `require`) referenced from
 *     ESM-bundled output without polyfills
 *   • Native modules bundled instead of externalized (esbuild can't ship
 *     `.node` binaries — classic-level, sharp, etc.)
 *   • Top-level await that fails synth/parse on the target Node version
 *   • Missing dependency at import time
 *
 * We can't actually `app.whenReady()` without Electron, so we stub the
 * `electron` module to no-ops via a module resolution hook and run the
 * bundle until its first async tick. If the synchronous import-evaluation
 * phase succeeds (and the asynchronous one doesn't throw within 500ms),
 * the bundle is healthy enough to ship.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const MAIN_BUNDLE = path.join(REPO_ROOT, 'dist-electron', 'main', 'index.js');

/**
 * Lock in that dev (`pj app:dev`) and prod (`pj build`) use the SAME
 * esbuild config — otherwise the bundle this test exercises (prod) won't
 * represent what `pj app:dev` actually builds. The painful regression we
 * want to prevent: a stale single-line banner in dev-electron.ts shipping
 * a bundle that crashes at `__dirname is not defined` while `pj build`
 * stayed green.
 */
describe('Electron bundle config', () => {
  it('dev and prod build scripts both import from electron-bundle-config.ts', async () => {
    const devSrc = await fs.readFile(path.join(REPO_ROOT, 'scripts', 'dev-electron.ts'), 'utf8');
    const prodSrc = await fs.readFile(path.join(REPO_ROOT, 'scripts', 'build-electron-main.ts'), 'utf8');
    for (const [label, src] of [['dev-electron.ts', devSrc], ['build-electron-main.ts', prodSrc]] as const) {
      expect(src, `${label} should import the shared bundle config`).toContain('./electron-bundle-config');
      expect(src, `${label} should call mainBundleConfig`).toContain('mainBundleConfig(');
    }
    // Neither should declare its own banner or target — those belong in the
    // shared config now. A regression that re-adds them would be a sign
    // that someone forked the dev config again.
    for (const [label, src] of [['dev-electron.ts', devSrc], ['build-electron-main.ts', prodSrc]] as const) {
      expect(src, `${label} should not have its own \`banner:\` declaration`).not.toMatch(/\bbanner:\s*\{/);
      expect(src, `${label} should not declare its own esbuild \`target:\``).not.toMatch(/\btarget:\s*['"]node\d+['"]/);
    }
  });
});

describe('main bundle', () => {
  let tmpHarness: string;
  beforeAll(async () => {
    tmpHarness = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-main-smoke-'));
  });
  afterAll(async () => {
    await fs.rm(tmpHarness, { recursive: true, force: true });
  });

  it('compiled bundle exists (pj build ran)', async () => {
    await expect(fs.stat(MAIN_BUNDLE)).resolves.toBeTruthy();
  });

  it('loads without throwing - no missing CJS globals, no native-bundle errors', async () => {
    const stub = path.join(tmpHarness, 'electron-stub.mjs');
    await fs.writeFile(stub, [
      'import os from "node:os";',
      'const noop = () => {};',
      'const noopAsync = () => Promise.resolve();',
      'const evtTarget = { on: noop, off: noop, removeListener: noop, once: noop, addListener: noop, handle: noop, removeHandler: noop, emit: noop };',
      'export const app = {',
      '  whenReady: () => Promise.resolve(),',
      '  on: noop, quit: noop, exit: noop,',
      '  getPath: () => os.tmpdir(),',
      '  getAppPath: () => process.cwd(),',
      '};',
      'export class BrowserWindow {',
      '  static getAllWindows() { return []; }',
      '  on() {} loadURL() { return Promise.resolve(); } loadFile() { return Promise.resolve(); }',
      '  webContents = evtTarget; contentView = { addChildView: noop, removeChildView: noop };',
      '  getContentBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }',
      '}',
      'export class WebContentsView {',
      '  webContents = { ...evtTarget, loadURL: noopAsync, close: noop };',
      '  setBounds() {}',
      '}',
      'export const ipcMain = evtTarget;',
      'export const dialog = { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) };',
      'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };',
      'export const shell = { openExternal: noopAsync, openPath: noopAsync, showItemInFolder: noop };',
    ].join('\n'));

    // Module resolution hook: intercept `import "electron"` and serve our
    // stub URL instead. Everything else (hono, @aws-sdk, dynalite, ...)
    // resolves normally from the repo's node_modules.
    const hooks = path.join(tmpHarness, 'hooks.mjs');
    await fs.writeFile(hooks, [
      'import { pathToFileURL } from "node:url";',
      `const STUB = pathToFileURL(${JSON.stringify(stub)}).href;`,
      'export function resolve(specifier, context, nextResolve) {',
      '  if (specifier === "electron") return { url: STUB, format: "module", shortCircuit: true };',
      '  return nextResolve(specifier, context);',
      '}',
    ].join('\n'));

    // Boot script: register the hook, then dynamic-import the main bundle.
    // The bundle starts dynalite, registers IPC handlers, etc. — we exit
    // 500ms after load to avoid leaving the process running. If anything
    // threw during synchronous evaluation OR within that 500ms async tail,
    // it shows up as a non-zero exit and we fail loudly.
    const launcher = path.join(tmpHarness, 'run.mjs');
    await fs.writeFile(launcher, [
      'import { register } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      `register("./hooks.mjs", pathToFileURL(${JSON.stringify(tmpHarness)} + "/").href);`,
      // `app.whenReady().then(createWindow)` can throw async — catch
      // unhandled rejections too, not just synchronous exceptions.
      'process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e && e.stack || e); process.exit(3); });',
      'process.on("unhandledRejection", (e) => { console.error("UNHANDLED_REJECTION:", e && e.stack || e); process.exit(4); });',
      'let loadError;',
      `try { await import(pathToFileURL(${JSON.stringify(MAIN_BUNDLE)}).href); }`,
      'catch (err) { loadError = err; }',
      'if (loadError) { console.error("LOAD_ERROR:", loadError && loadError.stack || loadError); process.exit(2); }',
      // Give the app.whenReady() then-chain time to fire before we exit,
      // so any async error in createWindow / services.init / etc. lands
      // before we declare the bundle healthy.
      'setTimeout(() => process.exit(0), 800);',
    ].join('\n'));

    const result = await runNode(launcher, {
      cwd: REPO_ROOT,  // so non-electron deps resolve from the repo's node_modules
      env: process.env as NodeJS.ProcessEnv,
    });

    if (result.code !== 0) {
      throw new Error(
        `main bundle failed to load (exit ${result.code})\n` +
        `stderr:\n${result.stderr}\n` +
        `stdout:\n${result.stdout}`,
      );
    }
  }, 15_000);
});

interface RunResult { code: number; stdout: string; stderr: string }

function runNode(
  file: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', reject);
  });
}
