/**
 * Phase-4.1 unit tests for the CI/CD plugin contract:
 *
 *   - loadCicdProviders correctly filters loaded plugins by `manifest.cicd`
 *     presence and resolves template/script paths to absolute.
 *   - resolveActiveProvider applies the resolution priority:
 *       env var > config file > exactly-one > choose > none
 *   - SproutConfigStore round-trips activeCicdProvider through ~/.sprout/config.json.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverPlugins, loadCicdProviders } from '../app/main/plugins/loader.js';
import type { LoadedCicdProvider, LoadedPlugin } from '../app/main/plugins/types.js';
import { resolveActiveProvider } from '../app/main/deploy/provider-resolver.js';
import { SproutConfigStore } from '../app/main/deploy/sprout-config.js';

const REPO_ROOT = path.resolve(__dirname, '..');

function makePlugin(overrides: Partial<LoadedPlugin> & { name: string; cicd?: LoadedPlugin['manifest']['cicd'] }): LoadedPlugin {
  return {
    manifest: {
      name: overrides.name,
      description: '',
      version: '0.0.0',
      cicd: overrides.cicd,
    },
    root: overrides.root ?? `/plugins/${overrides.name}`,
    skills: overrides.skills ?? [],
    agents: overrides.agents ?? [],
    permissions: overrides.permissions ?? { allow: [] },
  };
}

describe('loadCicdProviders', () => {
  it('filters to plugins with a cicd manifest block', () => {
    const plugins: LoadedPlugin[] = [
      makePlugin({ name: 'sprout' }), // starter plugin, no cicd
      makePlugin({
        name: 'sprout-cicd-github',
        cicd: {
          label: 'GitHub Actions',
          templatesDir: 'templates',
          bootstrapScript: 'scripts/bootstrap.sh',
          remoteKind: 'github',
        },
      }),
    ];
    const providers = loadCicdProviders(plugins);
    expect(providers).toHaveLength(1);
    expect(providers[0].pluginName).toBe('sprout-cicd-github');
    expect(providers[0].manifest.label).toBe('GitHub Actions');
  });

  it('resolves template + bootstrap paths to absolute, anchored at plugin root', () => {
    const plugin = makePlugin({
      name: 'sprout-cicd-github',
      root: '/opt/sprout/plugins/sprout-cicd-github',
      cicd: {
        label: 'GitHub Actions',
        templatesDir: 'templates',
        bootstrapScript: 'scripts/bootstrap-prod.sh',
        remoteKind: 'github',
      },
    });
    const [provider] = loadCicdProviders([plugin]);
    expect(provider.templatesDir).toBe('/opt/sprout/plugins/sprout-cicd-github/templates');
    expect(provider.bootstrapScript).toBe('/opt/sprout/plugins/sprout-cicd-github/scripts/bootstrap-prod.sh');
  });

  it('returns empty when no plugins declare cicd', () => {
    expect(loadCicdProviders([makePlugin({ name: 'a' }), makePlugin({ name: 'b' })])).toEqual([]);
  });
});

describe('resolveActiveProvider', () => {
  const gh: LoadedCicdProvider = {
    pluginName: 'sprout-cicd-github',
    manifest: {
      label: 'GitHub Actions',
      templatesDir: 'templates',
      bootstrapScript: 'scripts/bootstrap.sh',
      remoteKind: 'github',
    },
    templatesDir: '/p/sprout-cicd-github/templates',
    bootstrapScript: '/p/sprout-cicd-github/scripts/bootstrap.sh',
  };
  const jenkins: LoadedCicdProvider = {
    pluginName: 'sprout-cicd-jenkins',
    manifest: {
      label: 'Jenkins',
      templatesDir: 'templates',
      bootstrapScript: 'scripts/bootstrap.sh',
      remoteKind: 'jenkins',
    },
    templatesDir: '/p/sprout-cicd-jenkins/templates',
    bootstrapScript: '/p/sprout-cicd-jenkins/scripts/bootstrap.sh',
  };

  async function emptyConfig(): Promise<SproutConfigStore> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-cfg-test-'));
    return new SproutConfigStore(path.join(tmp, 'config.json'));
  }

  it('returns `none` when no providers are installed', async () => {
    const res = await resolveActiveProvider({
      providers: [],
      config: await emptyConfig(),
      env: {},
    });
    expect(res.kind).toBe('none');
  });

  it('auto-picks when exactly one provider is installed', async () => {
    const res = await resolveActiveProvider({
      providers: [gh],
      config: await emptyConfig(),
      env: {},
    });
    expect(res.kind).toBe('active');
    if (res.kind === 'active') expect(res.provider.pluginName).toBe('sprout-cicd-github');
  });

  it('returns `choose` when multiple are installed and no preference is set', async () => {
    const res = await resolveActiveProvider({
      providers: [gh, jenkins],
      config: await emptyConfig(),
      env: {},
    });
    expect(res.kind).toBe('choose');
    if (res.kind === 'choose') expect(res.candidates.map((p) => p.pluginName)).toEqual(['sprout-cicd-github', 'sprout-cicd-jenkins']);
  });

  it('honors the SPROUT_CICD_PROVIDER env var override', async () => {
    const res = await resolveActiveProvider({
      providers: [gh, jenkins],
      config: await emptyConfig(),
      env: { SPROUT_CICD_PROVIDER: 'sprout-cicd-jenkins' },
    });
    expect(res.kind).toBe('active');
    if (res.kind === 'active') expect(res.provider.pluginName).toBe('sprout-cicd-jenkins');
  });

  it('falls back to count-based rule when env-var points at a missing provider', async () => {
    const res = await resolveActiveProvider({
      providers: [gh],
      config: await emptyConfig(),
      env: { SPROUT_CICD_PROVIDER: 'sprout-cicd-jenkins' }, // not installed
    });
    expect(res.kind).toBe('active');
    if (res.kind === 'active') expect(res.provider.pluginName).toBe('sprout-cicd-github');
  });

  it('honors the persisted config when multiple providers are installed', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-cfg-test-'));
    const config = new SproutConfigStore(path.join(tmp, 'config.json'));
    await config.save({ activeCicdProvider: 'sprout-cicd-jenkins' });
    const res = await resolveActiveProvider({ providers: [gh, jenkins], config, env: {} });
    expect(res.kind).toBe('active');
    if (res.kind === 'active') expect(res.provider.pluginName).toBe('sprout-cicd-jenkins');
  });
});

describe('bundled sprout-cicd-github plugin', () => {
  it('is discovered by discoverPlugins() with its cicd manifest', async () => {
    const plugins = await discoverPlugins({
      bundledDir: path.join(REPO_ROOT, 'app', 'resources', 'plugins'),
    });
    const cicd = plugins.find((p) => p.manifest.name === 'sprout-cicd-github');
    expect(cicd, 'sprout-cicd-github should be staged into app/resources/plugins by `pj build`').toBeDefined();
    expect(cicd!.manifest.cicd).toMatchObject({
      label: 'GitHub Actions',
      remoteKind: 'github',
    });
  });

  it('surfaces via loadCicdProviders with absolute template + bootstrap paths', async () => {
    const plugins = await discoverPlugins({
      bundledDir: path.join(REPO_ROOT, 'app', 'resources', 'plugins'),
    });
    const providers = loadCicdProviders(plugins);
    const gh = providers.find((p) => p.pluginName === 'sprout-cicd-github');
    expect(gh).toBeDefined();
    // Sanity check: the resolved paths exist on disk
    await expect(fs.stat(gh!.templatesDir)).resolves.toBeDefined();
    await expect(fs.stat(gh!.bootstrapScript)).resolves.toBeDefined();
  });

  it('ships the four core workflow YAMLs', async () => {
    const workflowsDir = path.join(
      REPO_ROOT,
      'app', 'resources', 'plugins', 'sprout-cicd-github',
      'templates', '.github', 'workflows',
    );
    for (const name of ['build.yml', 'prod-deploy.yml', 'deploy-pr-environment.yml', 'cleanup-pr-environment.yml']) {
      await expect(fs.stat(path.join(workflowsDir, name)), `${name} should be staged`).resolves.toBeDefined();
    }
  });
});

describe('SproutConfigStore', () => {
  it('round-trips activeCicdProvider through a file', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-cfg-test-'));
    const file = path.join(tmp, 'config.json');
    const store = new SproutConfigStore(file);
    await store.save({ activeCicdProvider: 'sprout-cicd-github' });

    // New instance reading the same file should see the saved value.
    const fresh = new SproutConfigStore(file);
    const loaded = await fresh.load();
    expect(loaded.activeCicdProvider).toBe('sprout-cicd-github');
  });

  it('returns empty defaults when the file is missing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-cfg-test-'));
    const store = new SproutConfigStore(path.join(tmp, 'does-not-exist.json'));
    const loaded = await store.load();
    expect(loaded.activeCicdProvider).toBeUndefined();
  });
});
