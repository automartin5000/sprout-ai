import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { ProdDeployProgressEvent } from '../ipc.js';
import type { LoadedCicdProvider } from '../plugins/types.js';
import { ghAuthStatus, ghPrCreate, ghRepoCreate, isGhAvailable } from './gh-cli.js';
import { copyTemplates, mergePackageJson } from './template-copy.js';

export interface ProdDeployOptions {
  /** Absolute path to the project's working-tree root. */
  projectRoot: string;
  /**
   * The Sprout-side project id (8-char Crockford or UUID). Mustache-
   * substituted into the scaffolded CDK stack as `SPROUT_PROJECT_ID` so the
   * standalone Lambda's tenancy env var matches what the sandbox runtime
   * set per-request. Preserving the same id keeps DDB key prefixes
   * (`PROJECT#${SPROUT_PROJECT_ID}#…`) identical across the promotion.
   */
  projectId: string;
  /** Display name (becomes the repo name; sanitized to a slug if needed). */
  projectName: string;
  /** Active CI/CD provider — see `provider-resolver.ts`. */
  provider: LoadedCicdProvider;
  /** Streams phase events to the renderer. */
  onProgress?: (event: ProdDeployProgressEvent) => void;
}

export interface ProdDeployResult {
  repoUrl: string;
  prUrl: string;
}

/**
 * "Publish to prod" orchestrator. Drives the user's project from "no
 * CI/CD" to "private GitHub repo with a PR open that wires AWS deployment
 * via GitHub Actions".
 *
 *   preflight → scaffolding → bootstrapping → committing →
 *   creating-repo → pushing → opening-pr → done
 *
 * The provider's `remoteKind` decides how "creating-repo" + "pushing" run:
 *
 *   - `'github'`  — shells to `gh repo create` (+ `gh pr create`)
 *   - `'jenkins'` — the provider's bootstrap script set up the corp git
 *                   remote already; we just `git push` and skip PR creation
 *                   (Jenkins doesn't have an equivalent of `gh pr create`)
 *
 * Each phase that throws becomes a `{ phase: 'failed', error }` event and
 * the promise rejects. The orchestrator does NOT roll back partial work
 * (templates already copied, git already initialized) — diagnosing + cleaning
 * up is easier in the user's project than trying to invert every step.
 */
export class ProdDeployClient {
  async deployToProd(opts: ProdDeployOptions): Promise<ProdDeployResult> {
    const emit = opts.onProgress ?? (() => undefined);
    const cwd = opts.projectRoot;
    const repoName = sanitizeRepoName(opts.projectName);

    try {
      // 1. Preflight
      emit({ phase: 'preflight' });
      await this.preflight(opts);

      // 2. Scaffolding — copy templates + apply package.json.patch
      //
      // Mustache variables visible to all template files:
      //   {{projectName}} — the sanitized GitHub repo name (human-readable)
      //   {{projectId}}   — the Sprout project id; baked into the CDK stack
      //                     as SPROUT_PROJECT_ID so the standalone Lambda
      //                     sees the SAME id the sandbox runtime did. Keeps
      //                     DDB keys (`PROJECT#${SPROUT_PROJECT_ID}#…`)
      //                     stable across the sandbox→prod promotion.
      emit({ phase: 'scaffolding' });
      await copyTemplates({
        src: opts.provider.templatesDir,
        dest: cwd,
        variables: {
          projectName: repoName,
          projectId: opts.projectId,
        },
      });
      const patchFile = path.join(opts.provider.templatesDir, 'package.json.patch');
      if (await fileExists(patchFile)) {
        await mergePackageJson({ projectRoot: cwd, patchFile });
      }

      // 3. Bootstrapping — run the plugin's `bootstrap-prod.sh`
      emit({ phase: 'bootstrapping' });
      await runScript(opts.provider.bootstrapScript, [], { cwd });

      // 4. Committing — initialize repo if needed, commit on a feature branch
      emit({ phase: 'committing' });
      await this.commitChanges(cwd);

      // 5. Creating remote (no push — we control the push order in step 6)
      emit({ phase: 'creating-repo' });
      const repoUrl =
        opts.provider.manifest.remoteKind === 'github'
          ? await ghRepoCreate({ name: repoName, cwd })
          : '(remote set up by plugin bootstrap script)';

      // 6. Push main FIRST so the remote has a default branch, then push
      //    sprout/cicd. Without this, `gh pr create` errors with
      //    "createPullRequest can't be blank" because there's no base branch
      //    on the remote to PR against.
      emit({ phase: 'pushing' });
      // `main` exists with at least the Sprout init commit (see
      // app/main/projects/worktree.ts:create — `git commit --allow-empty`).
      await runGit(['push', '-u', 'origin', 'main'], { cwd });
      await runGit(['push', '-u', 'origin', BRANCH], { cwd });

      // 7. Open a PR (GitHub only). Pin base + head explicitly so we don't
      //    inherit a stale tracking config.
      emit({ phase: 'opening-pr' });
      const prUrl =
        opts.provider.manifest.remoteKind === 'github'
          ? await ghPrCreate({
              title: 'Set up cloud deploys (Sprout)',
              body: PR_BODY,
              cwd,
              base: 'main',
              head: BRANCH,
            })
          : '(no PR — your team review tool handles this)';

      emit({ phase: 'done', repoUrl, prUrl });
      return { repoUrl, prUrl };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ phase: 'failed', error: message });
      throw err;
    }
  }

  /**
   * Preflight checks. Aim: surface the failure cheaply before any side
   * effects (template copy, git init).
   */
  private async preflight(opts: ProdDeployOptions): Promise<void> {
    // 1. Don't trample an existing .github/workflows directory — Sprout would
    //    overwrite the user's hand-written workflows.
    const workflows = path.join(opts.projectRoot, '.github', 'workflows');
    if (await dirExists(workflows)) {
      throw new Error(
        `Project already has .github/workflows — refusing to overwrite. ` +
        `Remove or rename that directory and try again.`,
      );
    }

    // 2. GitHub provider: gh CLI is installed AND logged in
    if (opts.provider.manifest.remoteKind === 'github') {
      if (!(await isGhAvailable())) {
        throw new Error(
          'The GitHub CLI (`gh`) is not installed. Install from https://cli.github.com and run `gh auth login`, then try again.',
        );
      }
      const auth = await ghAuthStatus();
      if (!auth.loggedIn) {
        throw new Error(
          'You are not signed into GitHub. Run `gh auth login` in a terminal, then try again.' +
          (auth.detail ? `\n\nDetails:\n${auth.detail.trim()}` : ''),
        );
      }
    }
  }

  private async commitChanges(cwd: string): Promise<void> {
    // Make sure we're in a git repo (createproject scaffolds one, but joining
    // by code or other flows might land us without git initialized).
    const isRepo = await dirExists(path.join(cwd, '.git'));
    if (!isRepo) {
      await runGit(['init', '-b', 'main'], { cwd });
    }

    // Use a dedicated branch so the PR review surface is just the CI/CD diff.
    await runGit(['checkout', '-b', BRANCH], { cwd }).catch(async () => {
      // Branch already existed — switch to it.
      await runGit(['checkout', BRANCH], { cwd });
    });

    await runGit(['add', '-A'], { cwd });
    // Tolerate "nothing to commit" — happens on a re-run after a failed push.
    await runGit(['commit', '-m', 'feat: set up cloud deploys via Sprout'], { cwd })
      .catch(() => undefined);
  }
}

const BRANCH = 'sprout/cicd';

const PR_BODY = `This PR adds the CI/CD scaffold that lets the app deploy to AWS automatically:

- **build.yml** runs on every push to a non-\`main\` branch: builds, runs CDK synth, uploads the cdk.out artifact for prod-deploy to consume.
- **deploy-pr-environment.yml** opens an ephemeral preview env on every PR. URL is commented on the PR. Cleaned up on close.
- **prod-deploy.yml** runs on merge to \`main\`: finds the successful build artifact for the merge commit, downloads it, and deploys via OIDC.
- **pull-request-lint.yml** validates semantic commit messages in PR titles.

### Before merging this PR — one-time setup

1. In your AWS account, create an IAM role named \`github-actions-deployer\` that GitHub Actions OIDC can assume.
2. Add these GitHub repo secrets:
   - \`NONPROD_AWS_ACCOUNT_ID\`
   - \`PROD_AWS_ACCOUNT_ID\`
3. Bootstrap CDK once per account/region: \`npx cdk bootstrap aws://<account>/us-east-1\`.

### After merging

Every future PR gets a preview URL automatically; merging to \`main\` ships to prod.

— Generated by Sprout's "Publish to prod" feature.
`;

/* ── helpers ───────────────────────────────────────────────── */

function sanitizeRepoName(name: string): string {
  // GitHub repo names: alphanumerics + `-`, `_`, `.`. Lowercase + collapse
  // whitespace. Empty result falls back to a generic name.
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cleaned || 'sprout-app';
}

async function fileExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}
async function dirExists(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

function runGit(args: string[], opts: { cwd: string }): Promise<void> {
  return run('git', args, opts);
}

function runScript(scriptPath: string, args: string[], opts: { cwd: string }): Promise<void> {
  // Use bash so the script doesn't need the executable bit on every machine.
  return run('bash', [scriptPath, ...args], opts);
}

function run(cmd: string, args: string[], opts: { cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}):\n${stderr || stdout}`));
    });
    child.on('error', (err) => reject(err));
  });
}
