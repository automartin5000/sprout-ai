import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface CheckpointInfo {
  hash: string;
  subject: string;
  ts: string;
}

/**
 * Wraps a single git working tree per project. Every harness turn ends with a
 * `checkpoint(...)` commit; the UI's "Restore" button maps to `restore(hash)`.
 */
export class Worktree {
  constructor(public readonly root: string) {}

  static async create(root: string): Promise<Worktree> {
    await fs.mkdir(root, { recursive: true });
    const gitDir = path.join(root, '.git');
    const alreadyInit = await fs.stat(gitDir).then(() => true).catch(() => false);
    if (!alreadyInit) {
      await runGit(root, ['init', '-b', 'main']);
      await runGit(root, ['commit', '--allow-empty', '-m', 'sprout: project init']);
    }
    return new Worktree(root);
  }

  static async open(root: string): Promise<Worktree> {
    const stat = await fs.stat(path.join(root, '.git')).catch(() => null);
    if (!stat) throw new Error(`not a git worktree: ${root}`);
    return new Worktree(root);
  }

  async checkpoint(subject: string): Promise<CheckpointInfo | undefined> {
    await runGit(this.root, ['add', '-A']);
    const subjectLine = subject.split('\n')[0].slice(0, 200);
    const result = await runGitCapture(this.root, [
      'commit',
      '--allow-empty',
      '-m',
      `checkpoint: ${subjectLine}`,
    ]);
    if (result.code !== 0) return undefined;

    const head = await runGitCapture(this.root, ['rev-parse', 'HEAD']);
    return {
      hash: head.stdout.trim(),
      subject: subjectLine,
      ts: new Date().toISOString(),
    };
  }

  /**
   * Roll the working tree back to a previous save point. NON-DESTRUCTIVE —
   * `git reset --hard` would orphan every commit after the target hash
   * (they'd survive in reflog for ~30 days but disappear from `git log`
   * and the Sprout timeline; users see them as "gone"). Instead we:
   *
   *   1. Stage + commit any uncommitted working-tree changes so they
   *      don't get clobbered by the upcoming `checkout`.
   *   2. `git checkout <hash> -- .` copies the target's tree into the
   *      working dir WITHOUT moving HEAD.
   *   3. Commit as a new HEAD with a `rolled back to <subject>` message
   *      so the timeline shows where the user went.
   *
   * Net result: every prior save point is still reachable from HEAD; the
   * timeline grows by 1-2 commits per round-trip (1 for the rollback
   * marker, +1 for the pre-snapshot if there were uncommitted edits).
   * `git log` from HEAD continues to show the full history.
   */
  async restore(hash: string): Promise<void> {
    // Get the target's subject up front so the rollback commit message
    // names it (the user sees "rolled back to: <thing>" in the timeline).
    const subjectRes = await runGitCapture(this.root, [
      'log', '-1', '--pretty=format:%s', hash,
    ]);
    const targetSubject = subjectRes.stdout.trim().replace(/^checkpoint:\s*/, '') || hash.slice(0, 7);

    // 1. Snapshot any uncommitted edits so they survive the checkout.
    //    `commit --allow-empty` is a no-op when the tree is clean, so it
    //    won't add noise if there's nothing to save.
    await runGit(this.root, ['add', '-A']);
    await runGitCapture(this.root, [
      'commit',
      '--allow-empty',
      '-m',
      'checkpoint: snapshot before going back',
    ]);

    // 2. Replace the index AND working tree with the target's tree, but
    //    leave HEAD where it is. `read-tree --reset -u` is the right
    //    primitive: unlike `checkout <hash> -- .`, it DELETES files that
    //    don't exist in the target (so going back from C → A removes
    //    the b.txt and c.txt the user added in between). `--reset`
    //    permits overwriting changes already in the index — the
    //    snapshot commit in step 1 captured them, so it's safe.
    await runGit(this.root, ['read-tree', '--reset', '-u', hash]);

    // 3. Commit the rollback as a new save point at the branch tip.
    //    `allow-empty` covers the case where the user clicked the
    //    already-current save point (no diff, but they still want a
    //    visible marker in the timeline).
    await runGitCapture(this.root, [
      'commit',
      '--allow-empty',
      '-m',
      `checkpoint: rolled back to "${targetSubject}"`,
    ]);
  }

  async log(limit = 50): Promise<CheckpointInfo[]> {
    const result = await runGitCapture(this.root, [
      'log',
      `-${limit}`,
      '--pretty=format:%H%x09%s%x09%cI',
    ]);
    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, ts] = line.split('\t');
        return { hash, subject, ts };
      });
  }
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const result = await runGitCapture(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  }
}

async function runGitCapture(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
  });
}
