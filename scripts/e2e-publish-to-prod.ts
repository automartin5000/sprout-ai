/**
 * E2E smoke test for "Publish to prod" — drives ProdDeployClient against a
 * real GitHub account using `gh`. Creates a real (throwaway) repo, opens a
 * real PR, then tears down.
 *
 *   1. Build a temp project with package.json + a trivial index.html
 *   2. git init, commit so the orchestrator has something to push
 *   3. Run ProdDeployClient with the staged sprout-cicd-github provider
 *   4. Verify: repo exists, PR exists, expected workflow files in the repo
 *   5. Clean up: gh repo delete <name>
 *
 * Requires:
 *   - `gh auth status` (any user with repo:create scope)
 *   - The staged plugin at app/resources/plugins/sprout-cicd-github/
 *
 * Usage:
 *   bun scripts/e2e-publish-to-prod.ts
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { ProdDeployClient } from '../app/main/deploy/prod-client.js';
import { discoverPlugins, loadCicdProviders } from '../app/main/plugins/loader.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  // ── Verify gh availability ──────────────────────────────────
  const ghReady = await runOk('gh', ['auth', 'status']);
  if (!ghReady) {
    throw new Error('gh not installed or not logged in. Run `gh auth login` first.');
  }
  const ghUser = (await runCapture('gh', ['api', 'user', '-q', '.login'])).trim();
  console.log(`gh authenticated as: ${ghUser}`);

  // ── Load the bundled cicd-github provider ───────────────────
  const plugins = await discoverPlugins({
    bundledDir: path.join(ROOT, 'app', 'resources', 'plugins'),
  });
  const providers = loadCicdProviders(plugins);
  const gh = providers.find((p) => p.pluginName === 'sprout-cicd-github');
  if (!gh) {
    throw new Error('sprout-cicd-github plugin not staged. Run `pj build` first.');
  }
  console.log(`Provider: ${gh.pluginName} (${gh.manifest.label})`);

  // ── Build a throwaway test project ──────────────────────────
  const ts = Date.now().toString(36);
  const projectName = `sprout-e2e-${ts}`;
  const repoName = projectName;
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-e2e-prod-'));
  console.log(`\nProject root: ${tmpRoot}`);
  console.log(`Will create GitHub repo: ${ghUser}/${repoName}`);

  await fs.writeFile(
    path.join(tmpRoot, 'package.json'),
    JSON.stringify({
      name: projectName,
      version: '0.0.1',
      private: true,
      scripts: { build: 'echo "built"' },
    }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(tmpRoot, 'index.html'),
    '<!doctype html><h1>sprout e2e</h1>',
    'utf8',
  );

  // git init + first commit so orchestrator has a clean tree
  await runOrThrow('git', ['init', '-b', 'main'], { cwd: tmpRoot });
  await runOrThrow('git', ['config', 'user.email', `${ghUser}@example.com`], { cwd: tmpRoot });
  await runOrThrow('git', ['config', 'user.name', ghUser], { cwd: tmpRoot });
  await runOrThrow('git', ['add', '-A'], { cwd: tmpRoot });
  await runOrThrow('git', ['commit', '-m', 'initial'], { cwd: tmpRoot });

  // ── Run the deploy ──────────────────────────────────────────
  console.log('\n────────── ProdDeployClient ──────────');
  const client = new ProdDeployClient();
  let repoUrl = '';
  let prUrl = '';
  let failed: unknown;
  try {
    const result = await client.deployToProd({
      projectRoot: tmpRoot,
      // Synthetic projectId for the e2e smoke — matches Crockford shape so
      // the standalone CDK stack's SPROUT_PROJECT_ID looks production-real.
      projectId: 'E2E12345',
      projectName,
      provider: gh,
      onProgress: (e) => console.log(`  phase: ${e.phase}` + ('error' in e && e.error ? ` — ${e.error}` : '')),
    });
    repoUrl = result.repoUrl;
    prUrl = result.prUrl;
    console.log('\n✓ Deploy succeeded');
    console.log('  repo:', repoUrl);
    console.log('  PR:', prUrl);
  } catch (err) {
    failed = err;
    console.error('\n✗ Deploy failed:', err instanceof Error ? err.message : err);
  }

  // ── Verify (if deploy succeeded) ───────────────────────────
  if (!failed) {
    console.log('\n────────── Verification ──────────');
    // Verify the workflow files exist in the pushed branch
    const branches = await runCapture('gh', ['api', `repos/${ghUser}/${repoName}/branches`, '-q', '.[].name']);
    console.log('  branches:', branches.split('\n').filter(Boolean).join(', '));
    const wantBranches = ['main', 'sprout/cicd'];
    for (const w of wantBranches) {
      if (!branches.includes(w)) {
        console.warn(`  ⚠ branch "${w}" missing`);
      } else {
        console.log(`  ✓ branch "${w}" present`);
      }
    }

    // Verify the PR exists — list PRs by repo, find ours.
    const prs = await runCapture('gh', ['pr', 'list', '--repo', `${ghUser}/${repoName}`, '--state', 'open', '--json', 'number,title,headRefName,baseRefName']);
    console.log('  PRs:', prs.trim());
    const prList = JSON.parse(prs || '[]') as Array<{ headRefName: string; baseRefName: string }>;
    const ours = prList.find((p) => p.headRefName === 'sprout/cicd' && p.baseRefName === 'main');
    if (ours) console.log('  ✓ PR present: head=sprout/cicd, base=main');
    else console.warn('  ⚠ expected PR head=sprout/cicd → base=main, not found');

    // Verify the workflow files on the sprout/cicd branch
    const tree = await runCapture('gh', [
      'api',
      `repos/${ghUser}/${repoName}/git/trees/sprout/cicd?recursive=1`,
      '-q', '.tree[].path',
    ]).catch(() => '');
    const workflows = tree.split('\n').filter((p) => p.startsWith('.github/workflows/'));
    console.log(`  workflows on branch: ${workflows.length}`);
    workflows.forEach((w) => console.log(`    - ${w}`));
    if (workflows.length < 4) {
      console.warn(`  ⚠ expected ≥4 workflows, got ${workflows.length}`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────
  console.log('\n────────── Cleanup ──────────');
  // Best-effort delete. Requires `gh auth refresh -s delete_repo` to have
  // been run on this machine; if not, the repo lingers and the user cleans
  // up via the GitHub web UI. We don't fail the test on cleanup failure.
  console.log(`  Deleting GitHub repo ${ghUser}/${repoName}…`);
  const deleted = await runOk('gh', ['repo', 'delete', `${ghUser}/${repoName}`, '--yes']);
  if (deleted) {
    console.log('  ✓ repo deleted');
  } else {
    console.warn(`  ⚠ repo delete failed — manually delete at https://github.com/${ghUser}/${repoName}/settings`);
    console.warn('    (or run `gh auth refresh -h github.com -s delete_repo` once)');
  }
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  console.log('  ✓ temp project removed');

  if (failed) {
    throw failed;
  }
}

/* ── helpers ───────────────────────────────────────────────── */

function runOk(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function runCapture(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} failed (${code}): ${stderr || stdout}`));
    });
    child.on('error', reject);
  });
}

function runOrThrow(cmd: string, args: string[], opts: { cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr}`));
    });
    child.on('error', reject);
  });
}

void main().catch((err) => {
  console.error('\nE2E publish-to-prod FAILED:', err);
  process.exit(1);
});
