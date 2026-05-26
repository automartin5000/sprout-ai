/**
 * Integration test for ProdDeployClient — drives the full "Publish to prod"
 * flow against a temp project using:
 *
 *   - real `git` (universally available, easier than mocking)
 *   - a `gh` shim injected into PATH that records its argv to a file and
 *     prints canned URLs
 *   - a tiny fake provider whose templates + bootstrap-script live in the
 *     test's own tempdir so we don't depend on the bundled
 *     sprout-cicd-github plugin being staged
 *
 * Verifies: each phase event fires in order, the templates are copied with
 * {{projectName}} substitution, gh is invoked with expected args, and the
 * orchestrator returns the canned repo + PR URLs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProdDeployClient } from '../app/main/deploy/prod-client.js';
import type { LoadedCicdProvider } from '../app/main/plugins/types.js';
import type { ProdDeployProgressEvent } from '../app/main/ipc.js';

describe('ProdDeployClient (GitHub provider)', () => {
  let workspace: string;
  let projectRoot: string;
  let pluginRoot: string;
  let ghShimDir: string;
  let ghArgvLog: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-prod-deploy-'));
    projectRoot = path.join(workspace, 'demo-app');
    pluginRoot = path.join(workspace, 'fake-plugin');
    ghShimDir = path.join(workspace, 'shim-bin');
    ghArgvLog = path.join(workspace, 'gh-argv.log');

    // ── Fake project: a minimal package.json + index.html, no git yet ─
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'user-app', version: '1.0.0', scripts: { build: 'echo build' } }),
    );
    await fs.writeFile(path.join(projectRoot, 'index.html'), '<h1>demo</h1>', 'utf8');
    // git must know who we are for `git commit` to succeed in CI envs
    await runOk(['init', '-b', 'main'], projectRoot);
    await runOk(['config', 'user.email', 'sprout-test@example.com'], projectRoot);
    await runOk(['config', 'user.name', 'sprout test'], projectRoot);
    await runOk(['add', '-A'], projectRoot);
    await runOk(['commit', '-m', 'initial'], projectRoot);

    // ── Fake plugin: templates dir + a trivial bootstrap script ──────
    await fs.mkdir(path.join(pluginRoot, 'templates', '.github', 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, 'templates', '.github', 'workflows', 'build.yml'),
      'name: build\n# project = {{projectName}}\n',
      'utf8',
    );
    // Stub of the standalone CDK stack template — mirrors how the real
    // plugins/sprout-cicd-github/templates/infra/lib/sprout-app-stack.ts
    // bakes SPROUT_PROJECT_ID via the {{projectId}} mustache. The test
    // asserts substitution happens.
    await fs.mkdir(path.join(pluginRoot, 'templates', 'infra', 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, 'templates', 'infra', 'lib', 'sprout-app-stack.ts'),
      "// SPROUT_PROJECT_ID: '{{projectId}}'\n",
      'utf8',
    );
    await fs.writeFile(
      path.join(pluginRoot, 'templates', 'package.json.patch'),
      JSON.stringify({ scripts: { synth: 'echo synth' }, devDependencies: { projen: '^0.95.0' } }),
      'utf8',
    );
    await fs.mkdir(path.join(pluginRoot, 'scripts'));
    await fs.writeFile(
      path.join(pluginRoot, 'scripts', 'bootstrap-prod.sh'),
      '#!/usr/bin/env bash\necho "bootstrap ok"\n',
      'utf8',
    );
    await fs.chmod(path.join(pluginRoot, 'scripts', 'bootstrap-prod.sh'), 0o755);

    // ── gh shim: writes argv to a log file, prints canned URLs, AND
    //    configures a real bare git remote so the orchestrator's actual
    //    `git push origin main` succeeds against the shim's "remote".
    const fakeRemote = path.join(workspace, 'fake-remote.git');
    await runOk(['init', '--bare', fakeRemote], workspace);
    await fs.mkdir(ghShimDir);
    const shimContent = `#!/usr/bin/env bash
echo "$@" >> "${ghArgvLog}"
case "$1" in
  auth)
    # gh auth status — pretend logged in
    exit 0
    ;;
  repo)
    # gh repo create … — wire a real bare repo as origin so the
    # orchestrator's subsequent \`git push origin main\` succeeds, and
    # print the canned URL that the orchestrator captures.
    cd "\$PWD" && git remote add origin "${fakeRemote}" 2>/dev/null || true
    echo "https://github.com/sprout-test/demo-app"
    exit 0
    ;;
  pr)
    # gh pr create … — print canned URL
    echo "https://github.com/sprout-test/demo-app/pull/1"
    exit 0
    ;;
esac
exit 1
`;
    await fs.writeFile(path.join(ghShimDir, 'gh'), shimContent, 'utf8');
    await fs.chmod(path.join(ghShimDir, 'gh'), 0o755);
    // `which gh` also needs the shim to be findable — adding the dir to
    // PATH covers both `gh` invocations and the `which gh` check.
    originalPath = process.env.PATH;
    process.env.PATH = `${ghShimDir}:${process.env.PATH ?? ''}`;
  });

  afterEach(async () => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('runs the full happy path and emits phase events in order', async () => {
    const provider: LoadedCicdProvider = {
      pluginName: 'sprout-cicd-github',
      manifest: {
        label: 'GitHub Actions',
        templatesDir: 'templates',
        bootstrapScript: 'scripts/bootstrap-prod.sh',
        remoteKind: 'github',
      },
      templatesDir: path.join(pluginRoot, 'templates'),
      bootstrapScript: path.join(pluginRoot, 'scripts', 'bootstrap-prod.sh'),
    };
    const events: ProdDeployProgressEvent[] = [];

    const client = new ProdDeployClient();
    const result = await client.deployToProd({
      projectRoot,
      projectId: 'DEMO0001',
      projectName: 'Demo App',
      provider,
      onProgress: (e) => events.push(e),
    });

    // 1. URLs returned from canned gh stdout
    expect(result.repoUrl).toBe('https://github.com/sprout-test/demo-app');
    expect(result.prUrl).toBe('https://github.com/sprout-test/demo-app/pull/1');

    // 2. Phase events fired in the documented order, ending with `done`
    const phases = events.map((e) => e.phase);
    expect(phases).toEqual([
      'preflight',
      'scaffolding',
      'bootstrapping',
      'committing',
      'creating-repo',
      'pushing',
      'opening-pr',
      'done',
    ]);

    // 3. Templates landed with {{projectName}} substituted to the slugified name
    const buildYml = await fs.readFile(
      path.join(projectRoot, '.github', 'workflows', 'build.yml'),
      'utf8',
    );
    expect(buildYml).toContain('# project = demo-app'); // lowercase + space → hyphen
    expect(buildYml).not.toContain('{{projectName}}');

    // 3b. {{projectId}} is also substituted — this is what makes the standalone
    //     CDK stack's SPROUT_PROJECT_ID match what the sandbox set per-request,
    //     keeping DDB key prefixes stable across promotion.
    const stackFile = await fs.readFile(
      path.join(projectRoot, 'infra', 'lib', 'sprout-app-stack.ts'),
      'utf8',
    );
    expect(stackFile).toContain("SPROUT_PROJECT_ID: 'DEMO0001'");
    expect(stackFile).not.toContain('{{projectId}}');

    // 4. package.json patched (existing scripts preserved, new ones added)
    const pkg = JSON.parse(
      await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts.build).toBe('echo build');
    expect(pkg.scripts.synth).toBe('echo synth');
    expect(pkg.devDependencies.projen).toBe('^0.95.0');

    // 5. gh was called with the expected commands (auth status, repo create, pr create)
    const ghLog = (await fs.readFile(ghArgvLog, 'utf8')).trim().split('\n');
    expect(ghLog.some((l) => l.startsWith('auth status'))).toBe(true);
    expect(ghLog.some((l) => l.startsWith('repo create demo-app'))).toBe(true);
    expect(ghLog.some((l) => l.startsWith('pr create'))).toBe(true);

    // 6. Sprout committed on the dedicated branch
    const branch = await runCapture(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot);
    expect(branch.trim()).toBe('sprout/cicd');
  }, 30_000);

  it('Jenkins variant skips gh + uses raw git push, does not call gh repo/pr create', async () => {
    // Pre-set the corp git remote so `git push -u origin sprout/cicd` has a
    // target. We use a bare repo in a tempdir as the "remote" — `git push`
    // will succeed without hitting the network.
    const bareRemote = path.join(workspace, 'corp-remote.git');
    await runOk(['init', '--bare', bareRemote], workspace);
    await runOk(['remote', 'add', 'origin', bareRemote], projectRoot);

    const provider: LoadedCicdProvider = {
      pluginName: 'sprout-cicd-jenkins',
      manifest: {
        label: 'Jenkins',
        templatesDir: 'templates',
        bootstrapScript: 'scripts/bootstrap-prod.sh',
        remoteKind: 'jenkins',
      },
      templatesDir: path.join(pluginRoot, 'templates'),
      bootstrapScript: path.join(pluginRoot, 'scripts', 'bootstrap-prod.sh'),
    };
    const events: ProdDeployProgressEvent[] = [];

    const client = new ProdDeployClient();
    const result = await client.deployToProd({
      projectRoot,
      projectId: 'DEMO0002',
      projectName: 'Demo App',
      provider,
      onProgress: (e) => events.push(e),
    });

    // Jenkins: repoUrl + prUrl are placeholders, not real URLs
    expect(result.repoUrl).toContain('plugin bootstrap');
    expect(result.prUrl).toContain('your team review tool');

    // Phase events still in order, ending with done
    expect(events.map((e) => e.phase)).toEqual([
      'preflight',
      'scaffolding',
      'bootstrapping',
      'committing',
      'creating-repo',
      'pushing',
      'opening-pr',
      'done',
    ]);

    // gh should NOT have been called at all (no auth, no repo create, no pr create)
    const ghLogExists = await fs.stat(ghArgvLog).then(() => true).catch(() => false);
    expect(ghLogExists, 'Jenkins flow should not invoke gh').toBe(false);

    // Branch was pushed to the corp remote — verify by checking the bare repo
    const refs = await runCapture(['--git-dir=' + bareRemote, 'branch'], workspace);
    expect(refs).toContain('sprout/cicd');
  }, 30_000);

  it('preflight rejects if .github/workflows already exists', async () => {
    await fs.mkdir(path.join(projectRoot, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.github', 'workflows', 'existing.yml'), '');

    const provider: LoadedCicdProvider = {
      pluginName: 'sprout-cicd-github',
      manifest: {
        label: 'GitHub Actions',
        templatesDir: 'templates',
        bootstrapScript: 'scripts/bootstrap-prod.sh',
        remoteKind: 'github',
      },
      templatesDir: path.join(pluginRoot, 'templates'),
      bootstrapScript: path.join(pluginRoot, 'scripts', 'bootstrap-prod.sh'),
    };
    const events: ProdDeployProgressEvent[] = [];

    const client = new ProdDeployClient();
    await expect(
      client.deployToProd({
        projectRoot,
        projectId: 'DEMO0003',
        projectName: 'Demo App',
        provider,
        onProgress: (e) => events.push(e),
      }),
    ).rejects.toThrow(/already has \.github\/workflows/);

    // Failure event should have been emitted
    expect(events[events.length - 1].phase).toBe('failed');
  });
});

/* ── helpers ───────────────────────────────────────────────── */

function runOk(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'pipe' });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
    });
  });
}

function runCapture(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed`));
    });
  });
}
