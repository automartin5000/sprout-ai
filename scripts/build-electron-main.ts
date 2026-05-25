/**
 * Production build of the Electron main + preload bundles.
 * Shares its esbuild config with the dev path via `electron-bundle-config.ts`
 * so dev and prod can't drift (the kind of drift that caused our most
 * painful regressions — see the comments in that file).
 */
import { build } from 'esbuild';
import * as path from 'node:path';
import * as url from 'node:url';
import { mainBundleConfig, preloadBundleConfig } from './electron-bundle-config.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist-electron');

async function main(): Promise<void> {
  await build(mainBundleConfig({ root, outDir }));
  await build(preloadBundleConfig({ root, outDir }));
}

void main();
