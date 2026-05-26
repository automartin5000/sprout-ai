/**
 * Production build of the Electron main + preload bundles.
 * Shares its esbuild config with the dev path via `electron-bundle-config.ts`
 * so dev and prod can't drift (the kind of drift that caused our most
 * painful regressions — see the comments in that file).
 *
 * Only the production build path bakes `AUTH0_*` / `CLOUD_API_URL` /
 * `APPS_BASE_URL` into the bundle via esbuild `define:`. Dev mode reads
 * the same vars from `process.env` (populated by `.env` via
 * `scripts/dev-electron.ts`).
 */
import { build } from 'esbuild';
import * as path from 'node:path';
import * as url from 'node:url';
import { mainBundleConfig, preloadBundleConfig } from './electron-bundle-config.js';
import { loadBuildConfig, toEsbuildDefine, formatBuildConfigReport } from './load-build-config.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist-electron');

async function main(): Promise<void> {
  const { values, report } = loadBuildConfig(root);
  // Log the per-key source (config-file / env / missing) so CI logs and
  // local builds both surface what's actually baked in. We deliberately do
  // NOT print the values themselves — Auth0 audience URLs identify your
  // tenant and shouldn't go straight to stdout.
  console.log(formatBuildConfigReport(report));

  await build(mainBundleConfig({ root, outDir, defineEnv: toEsbuildDefine(values) }));
  await build(preloadBundleConfig({ root, outDir }));
}

void main();
