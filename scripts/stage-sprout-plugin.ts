/**
 * Stage the first-party Sprout plugin (`plugins/sprout/`) into
 * `app/resources/plugins/sprout/` so the Electron bundle picks it up at
 * runtime via the plugin loader's `bundledDir` scan.
 *
 * As part of staging, this script also pre-installs `node_modules` inside the
 * starter template — so when the AI scaffolds a new project at runtime, the
 * bootstrap script is just a file copy (a few seconds) instead of a 2–4
 * minute `npm install`. The template's deps live in the staged copy and
 * travel with the desktop bundle.
 *
 * Cache control:
 *   • Skip the npm install if node_modules already exists AND package.json
 *     hasn't changed (mtime check). Keeps `pj build` fast on the hot loop.
 *   • Set SKIP_TEMPLATE_INSTALL=1 to force-skip (useful for offline machines
 *     that don't have a populated npm cache yet).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'plugins', 'sprout');
const DEST = path.join(ROOT, 'app', 'resources', 'plugins', 'sprout');
const TEMPLATE_REL = path.join('templates', 'hono-react');

async function main(): Promise<void> {
  // Sanity-check source has the expected structure.
  const manifest = path.join(SRC, '.claude-plugin', 'plugin.json');
  const skill = path.join(SRC, 'skills', 'new-app', 'SKILL.md');
  for (const p of [manifest, skill]) {
    await fs.stat(p).catch(() => {
      throw new Error(`stage-sprout-plugin: required file missing: ${p}`);
    });
  }

  // 1. Decide if we can keep an existing prebuilt node_modules. We do this
  //    BEFORE wiping the dest so we don't throw away a perfectly good cache.
  const existingTemplate = path.join(DEST, TEMPLATE_REL);
  const cachedNodeModules = path.join(existingTemplate, 'node_modules');
  const srcPkgJson = path.join(SRC, TEMPLATE_REL, 'package.json');
  const canReuseInstall = await isCachedInstallFresh(srcPkgJson, existingTemplate);

  // 2. Wipe + copy source. If we can reuse, move node_modules aside first
  //    so it survives the wipe, then move it back after the copy.
  let stashedNm: string | undefined;
  if (canReuseInstall) {
    stashedNm = path.join(ROOT, '.sprout-stage-cache-nm');
    await fs.rm(stashedNm, { recursive: true, force: true });
    await fs.rename(cachedNodeModules, stashedNm).catch(() => { stashedNm = undefined; });
  }
  await fs.rm(DEST, { recursive: true, force: true });
  await copyDir(SRC, DEST);

  // 3. Ensure bootstrap-app.sh is executable.
  const bootstrap = path.join(DEST, 'scripts', 'bootstrap-app.sh');
  await fs.chmod(bootstrap, 0o755).catch(() => undefined);

  // 4. Put node_modules back if we stashed it, otherwise run npm install.
  const stagedTemplate = path.join(DEST, TEMPLATE_REL);
  if (stashedNm) {
    await fs.rename(stashedNm, path.join(stagedTemplate, 'node_modules'));
    console.log('sprout plugin staged (reusing cached node_modules)');
  } else if (process.env.SKIP_TEMPLATE_INSTALL === '1') {
    console.log('sprout plugin staged (SKIP_TEMPLATE_INSTALL=1 — node_modules NOT installed; AI will run npm install at scaffold time)');
  } else {
    console.log('sprout plugin staged — pre-installing template node_modules (this can take a couple of minutes the first time)…');
    await npmInstall(stagedTemplate);
    // Record what we just installed against so the next stage can compare.
    await writeInstallMarker(stagedTemplate, srcPkgJson);
    console.log('sprout plugin staged (node_modules ready)');
  }

  console.log(`→ ${path.relative(ROOT, DEST)}`);
}

/**
 * The cached install is considered fresh if:
 *   • node_modules exists
 *   • the marker file we wrote at last install time has the same package.json
 *     content hash as the current source
 */
async function isCachedInstallFresh(srcPkgJson: string, existingTemplate: string): Promise<boolean> {
  try {
    const nm = path.join(existingTemplate, 'node_modules');
    await fs.stat(nm);
    const marker = await fs.readFile(path.join(existingTemplate, '.sprout-install-marker'), 'utf8');
    const current = await fs.readFile(srcPkgJson, 'utf8');
    return marker === current;
  } catch {
    return false;
  }
}

async function writeInstallMarker(stagedTemplate: string, srcPkgJson: string): Promise<void> {
  const content = await fs.readFile(srcPkgJson, 'utf8');
  await fs.writeFile(path.join(stagedTemplate, '.sprout-install-marker'), content, 'utf8');
}

function npmInstall(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // No --prefer-offline here: the build-time install must hit the registry
    // for fresh dep metadata. The runtime bootstrap (in bootstrap-app.sh)
    // uses --prefer-offline because by then we want speed, not freshness.
    const child = spawn(
      'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd, stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install in ${cwd} exited ${code}`));
    });
    child.on('error', reject);
  });
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(s);
      await fs.symlink(target, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

void main().catch((err) => {
  console.error('stage-sprout-plugin failed:', err);
  process.exit(1);
});
