import { spawn } from 'node:child_process';

/**
 * Thin wrappers around the `gh` CLI used by the GitHub-flavoured prod deploy
 * provider. Keeping each call here means:
 *
 *   - Sprout's main process never depends on the GitHub REST API directly
 *     (the user already has gh auth state; we'd be re-implementing it).
 *   - Mocking for tests is a single `PATH`-injected shim — see
 *     `tests/deploy/prod-client.test.ts` when it lands.
 *
 * On a Jenkins-flavoured install, none of these are called — the Jenkins
 * provider's bootstrap script handles its own remote-add.
 */

export async function isGhAvailable(): Promise<boolean> {
  return runOk('which', ['gh']);
}

export interface GhAuthStatus {
  loggedIn: boolean;
  /** `gh auth status` stderr/stdout for surface to the user when not logged in. */
  detail?: string;
}

export async function ghAuthStatus(): Promise<GhAuthStatus> {
  const res = await runCapture('gh', ['auth', 'status']);
  // `gh auth status` exits 0 when logged in, non-zero when not.
  return {
    loggedIn: res.code === 0,
    detail: res.code === 0 ? undefined : (res.stderr || res.stdout || undefined),
  };
}

/**
 * Create a new repository and register it as `origin` for the working tree.
 * Does NOT push — caller controls the push order so the default branch
 * (`main`) lands on the remote before any feature branch. Equivalent to:
 *
 *   gh repo create <name> --private --source=. --remote=origin
 *
 * Without this split, `gh repo create --push` pushes only the current branch
 * — which the orchestrator has already switched to `sprout/cicd` — so the
 * remote ends up with no `main` and `gh pr create` fails with
 * "createPullRequest can't be blank" (no base branch).
 *
 * Returns the `https://github.com/<owner>/<name>` URL on success.
 */
export async function ghRepoCreate(opts: {
  name: string;
  cwd: string;
  visibility?: 'private' | 'public' | 'internal';
}): Promise<string> {
  const visibility = `--${opts.visibility ?? 'private'}`;
  const res = await runCapture(
    'gh',
    ['repo', 'create', opts.name, visibility, '--source=.', '--remote=origin'],
    { cwd: opts.cwd },
  );
  if (res.code !== 0) {
    throw new Error(`gh repo create failed (${res.code}): ${res.stderr || res.stdout}`);
  }
  // `gh repo create` prints the new repo URL to stdout.
  const url = (res.stdout || '').split('\n').find((l) => l.includes('github.com/'));
  if (!url) {
    throw new Error(`gh repo create succeeded but no repo URL in output: ${res.stdout}`);
  }
  return url.trim();
}

/**
 * Open a PR. base/head are explicit so we don't inherit a stale tracking
 * config from the local repo. Returns the PR URL on success.
 *
 *   gh pr create --title <title> --body <body> --base <base> --head <head>
 */
export async function ghPrCreate(opts: {
  title: string;
  body: string;
  cwd: string;
  base: string;
  head: string;
}): Promise<string> {
  const res = await runCapture(
    'gh',
    ['pr', 'create', '--title', opts.title, '--body', opts.body, '--base', opts.base, '--head', opts.head],
    { cwd: opts.cwd },
  );
  if (res.code !== 0) {
    throw new Error(`gh pr create failed (${res.code}): ${res.stderr || res.stdout}`);
  }
  const url = (res.stdout || '').split('\n').find((l) => l.includes('github.com/'));
  if (!url) {
    throw new Error(`gh pr create succeeded but no PR URL in output: ${res.stdout}`);
  }
  return url.trim();
}

/* ── helpers ───────────────────────────────────────────────── */

function runOk(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => reject(err));
  });
}
