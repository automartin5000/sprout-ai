/**
 * Stage first-party Sprout plugins into `app/resources/plugins/` so the
 * Electron bundle picks them up at runtime via the plugin loader's
 * `bundledDir` scan.
 *
 * By default, two plugins ship in the .dmg:
 *
 *   • `sprout` — the new-app starter. Has a heavy `templates/hono-react/`
 *     subdirectory we pre-install node_modules into so AI-scaffold time is
 *     fast (seconds vs minutes).
 *
 *   • `sprout-cicd-github` — the GitHub Actions deploy provider for
 *     "Promote to prod" (Phase 4). Plain file copy; the templates here are
 *     copied into the USER's project at deploy time, where their bootstrap
 *     script (not Sprout) installs the projen + cdk deps.
 *
 * Bundle selection at build time:
 *   Set `BUNDLED_PLUGINS=name1,name2,…` to change what ships in the .dmg.
 *   Defaults to `sprout,sprout-cicd-github`. Each name must match a
 *   directory under `plugins/` with a `.claude-plugin/plugin.json`.
 *
 *   Example: a work-machine build that ships Jenkins instead of GitHub:
 *     BUNDLED_PLUGINS=sprout,sprout-cicd-jenkins pj app:stage-resources
 *
 *   Plugins NOT in the requested list are removed from `app/resources/plugins/`
 *   so switching configurations doesn't leak stale providers.
 *
 * Cache control:
 *   • Skip the npm install if node_modules already exists AND package.json
 *     hasn't changed. Keeps `pj build` fast on the hot loop.
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
const PLUGINS_SRC_DIR = path.join(ROOT, 'plugins');
const PLUGINS_DEST_DIR = path.join(ROOT, 'app', 'resources', 'plugins');

/** Plugins that need special pre-install handling for a heavy template
 *  node_modules tree. Everything else is a plain file-copy. */
const STARTER_PLUGINS_WITH_TEMPLATE_NODE_MODULES = new Set(['sprout']);
/** For each starter, where the heavy template lives relative to the plugin
 *  root. Used to find the right `package.json` to install + cache. */
const STARTER_TEMPLATE_REL: Record<string, string> = {
  sprout: path.join('templates', 'hono-react'),
};

const DEFAULT_BUNDLED_PLUGINS = ['sprout', 'sprout-cicd-github'];

function parseBundledPlugins(): string[] {
  const raw = process.env.BUNDLED_PLUGINS;
  if (!raw) return DEFAULT_BUNDLED_PLUGINS;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) {
    throw new Error('BUNDLED_PLUGINS is set but parses to zero plugins — refusing to ship a no-plugin .dmg.');
  }
  for (const name of names) {
    // Catch typos that would silently no-op: must be a slug, must not be
    // a relative path.
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new Error(`BUNDLED_PLUGINS contains invalid plugin name "${name}". Use letters, digits, dot, dash, or underscore.`);
    }
  }
  return names;
}

async function main(): Promise<void> {
  const requested = parseBundledPlugins();
  console.log(`stage-sprout-plugin: bundling [${requested.join(', ')}]`);

  // Sanity-check every requested plugin exists in the source tree before
  // wiping anything. Fail loudly if BUNDLED_PLUGINS names a non-existent
  // plugin — silent fallback would ship a degraded .dmg.
  for (const name of requested) {
    const srcManifest = path.join(PLUGINS_SRC_DIR, name, '.claude-plugin', 'plugin.json');
    await fs.stat(srcManifest).catch(() => {
      throw new Error(
        `stage-sprout-plugin: plugin "${name}" not found at ${path.relative(ROOT, srcManifest)}. ` +
        `Check spelling, or remove it from BUNDLED_PLUGINS.`,
      );
    });
  }

  // Remove any plugins currently staged in app/resources/plugins/ that
  // aren't in the requested list, so switching configurations doesn't
  // leak stale providers into the .dmg.
  await removeUnlistedStagedPlugins(requested);

  for (const name of requested) {
    if (STARTER_PLUGINS_WITH_TEMPLATE_NODE_MODULES.has(name)) {
      await stageStarterPlugin(name);
    } else {
      await stagePluginPlain(name);
    }
  }
}

async function removeUnlistedStagedPlugins(keep: string[]): Promise<void> {
  let existing: string[];
  try {
    existing = await fs.readdir(PLUGINS_DEST_DIR);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return; // first build
    throw err;
  }
  const keepSet = new Set(keep);
  for (const name of existing) {
    if (name === '.gitkeep') continue;
    if (keepSet.has(name)) continue;
    const stalePath = path.join(PLUGINS_DEST_DIR, name);
    console.log(`stage-sprout-plugin: removing stale staged plugin "${name}"`);
    await fs.rm(stalePath, { recursive: true, force: true });
  }
}

/**
 * Stage a starter plugin (currently only `sprout`). Includes the pre-install
 * node_modules dance for the heavy template tree.
 */
async function stageStarterPlugin(name: string): Promise<void> {
  const src = path.join(PLUGINS_SRC_DIR, name);
  const dest = path.join(PLUGINS_DEST_DIR, name);
  const templateRel = STARTER_TEMPLATE_REL[name];
  if (!templateRel) {
    throw new Error(`stage-sprout-plugin: starter plugin "${name}" registered in STARTER_PLUGINS_WITH_TEMPLATE_NODE_MODULES but no STARTER_TEMPLATE_REL entry. Add one.`);
  }

  // Sanity-check source has the expected skill.
  const manifest = path.join(src, '.claude-plugin', 'plugin.json');
  const skill = path.join(src, 'skills', 'new-app', 'SKILL.md');
  for (const p of [manifest, skill]) {
    await fs.stat(p).catch(() => {
      throw new Error(`stage-sprout-plugin: required file missing: ${p}`);
    });
  }

  // 1. Decide if we can keep an existing prebuilt node_modules. We do this
  //    BEFORE wiping the dest so we don't throw away a perfectly good cache.
  const existingTemplate = path.join(dest, templateRel);
  const cachedNodeModules = path.join(existingTemplate, 'node_modules');
  const srcPkgJson = path.join(src, templateRel, 'package.json');
  const canReuseInstall = await isCachedInstallFresh(srcPkgJson, existingTemplate);

  // 2. Wipe + copy source. If we can reuse, move node_modules aside first
  //    so it survives the wipe, then move it back after the copy.
  let stashedNm: string | undefined;
  if (canReuseInstall) {
    stashedNm = path.join(ROOT, `.sprout-stage-cache-nm-${name}`);
    await fs.rm(stashedNm, { recursive: true, force: true });
    await fs.rename(cachedNodeModules, stashedNm).catch(() => { stashedNm = undefined; });
  }
  await fs.rm(dest, { recursive: true, force: true });
  await copyDir(src, dest);

  // 3. Ensure bootstrap script is executable (idempotent).
  const bootstrap = path.join(dest, 'scripts', 'bootstrap-app.sh');
  await fs.chmod(bootstrap, 0o755).catch(() => undefined);

  // 4. Put node_modules back if we stashed it, otherwise run npm install.
  const stagedTemplate = path.join(dest, templateRel);
  if (stashedNm) {
    await fs.rename(stashedNm, path.join(stagedTemplate, 'node_modules'));
    console.log(`${name} plugin staged (reusing cached node_modules)`);
  } else if (process.env.SKIP_TEMPLATE_INSTALL === '1') {
    console.log(`${name} plugin staged (SKIP_TEMPLATE_INSTALL=1 — node_modules NOT installed; AI will run npm install at scaffold time)`);
  } else {
    console.log(`${name} plugin staged — pre-installing template node_modules (this can take a couple of minutes the first time)…`);
    await npmInstall(stagedTemplate);
    await writeInstallMarker(stagedTemplate, srcPkgJson);
    console.log(`${name} plugin staged (node_modules ready)`);
  }

  console.log(`→ ${path.relative(ROOT, dest)}`);
}

/**
 * Stage a non-starter plugin (CI/CD provider, etc.). Plain file copy. We
 * deliberately do NOT pre-install node_modules — for CI/CD providers, the
 * templates' package.json.patch declares projen + cdk as devDependencies
 * that the post-copy bootstrap script installs in the user's actual project.
 */
async function stagePluginPlain(name: string): Promise<void> {
  const src = path.join(PLUGINS_SRC_DIR, name);
  const dest = path.join(PLUGINS_DEST_DIR, name);

  await fs.stat(path.join(src, '.claude-plugin', 'plugin.json')).catch(() => {
    throw new Error(`stage-sprout-plugin (${name}): manifest missing at ${path.join(src, '.claude-plugin', 'plugin.json')}`);
  });

  await fs.rm(dest, { recursive: true, force: true });
  await copyDir(src, dest);

  // Chmod any shell scripts to 755 so the plugin's bootstrap runs in the
  // user's project. Best-effort — silent if scripts/ doesn't exist.
  try {
    const scriptsDir = path.join(dest, 'scripts');
    const entries = await fs.readdir(scriptsDir);
    for (const entry of entries) {
      if (entry.endsWith('.sh')) {
        await fs.chmod(path.join(scriptsDir, entry), 0o755).catch(() => undefined);
      }
    }
  } catch { /* no scripts/ dir; that's fine */ }

  console.log(`→ ${path.relative(ROOT, dest)}`);
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
