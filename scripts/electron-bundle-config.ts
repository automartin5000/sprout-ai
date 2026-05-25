/**
 * Shared esbuild config for the Electron main + preload bundles.
 *
 * Imported by BOTH:
 *   • scripts/build-electron-main.ts  (production: `pj build` / `pj app:build`)
 *   • scripts/dev-electron.ts         (development: `pj app:dev`)
 *
 * Keeping a single source of truth prevents dev and prod from diverging — a
 * regression that bit us hard: dev had a stale single-line `require` banner
 * while prod had the full polyfill set, so `pj app:dev` produced a bundle
 * that crashed on `__dirname is not defined` even though `pj build` was
 * green.
 */
import type { BuildOptions } from 'esbuild';
import * as path from 'node:path';

/**
 * Banner injected at the top of every emitted ESM bundle so CJS code we
 * write (or that gets bundled in) can use `require`, `__filename`, and
 * `__dirname` — none of which are auto-defined inside ESM scope.
 */
const MAIN_BANNER = [
  "import { createRequire as __cjsRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __pathDirname } from 'node:path';",
  'const require = __cjsRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __pathDirname(__filename);',
].join('\n');

/**
 * Main-process bundle config. `packages: 'external'` keeps all npm deps
 * out of the bundle so:
 *   • native-binary packages (classic-level, sharp, …) load their `.node`
 *     binaries normally at runtime — esbuild can't ship them
 *   • CJS deps that use `__dirname`/`require()` at module scope keep
 *     working — they run as plain CJS, not inside our ESM bundle
 *
 * The `external` array is belt+suspenders for a few we always want excluded
 * even if a future change to `packages` would otherwise pull them in.
 */
export function mainBundleConfig(opts: { root: string; outDir: string }): BuildOptions {
  return {
    entryPoints: [path.join(opts.root, 'app/main/index.ts')],
    outfile: path.join(opts.outDir, 'main/index.js'),
    bundle: true,
    platform: 'node',
    // Electron 42 ships Node 24 in the main process. Targeting node24 lets
    // esbuild emit modern syntax without polyfills.
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    packages: 'external',
    external: ['electron', 'keytar', '@github/copilot-sdk', '@anthropic-ai/claude-agent-sdk'],
    banner: { js: MAIN_BANNER },
    logLevel: 'info',
  };
}

/** Preload bundle config — CJS, electron-renderer scope. */
export function preloadBundleConfig(opts: { root: string; outDir: string }): BuildOptions {
  return {
    entryPoints: [path.join(opts.root, 'app/preload/index.ts')],
    outfile: path.join(opts.outDir, 'preload/index.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: true,
    external: ['electron'],
    logLevel: 'info',
  };
}
