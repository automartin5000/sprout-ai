/**
 * Tests for Worktree.restore() — specifically the "rolling back doesn't
 * destroy your current work" behavior.
 *
 * Before Phase 6 follow-up, restore() did `git reset --hard <hash>` which
 * left every newer commit orphaned (still in reflog but invisible to
 * `git log` and the Sprout timeline). Users reported it as "I clicked a
 * save point and all my work disappeared." The current implementation
 * uses `git checkout <hash> -- .` to copy the target's tree into a new
 * commit at HEAD, so the previous chain stays reachable.
 *
 * The two invariants this test pins:
 *   1. After restore(), every commit that existed before is still in
 *      `git log` (still reachable from HEAD).
 *   2. The working tree contents now match the target hash.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Worktree } from '../app/main/projects/worktree.js';

describe('Worktree.restore — non-destructive', () => {
  let workspace: string;
  let wt: Worktree;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-restore-'));
    wt = await Worktree.create(workspace);
    // Identity required for `git commit` in CI environments.
    await runGit(workspace, ['config', 'user.email', 'sprout-test@example.com']);
    await runGit(workspace, ['config', 'user.name', 'sprout test']);
  });

  afterEach(async () => {
    if (process.env.SPROUT_KEEP_TMP) return;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('preserves the chain of save points when rolling back', async () => {
    // Build a linear chain: empty → A → B → C
    await fs.writeFile(path.join(workspace, 'a.txt'), 'A\n', 'utf8');
    const a = await wt.checkpoint('add A');
    expect(a).toBeDefined();

    await fs.writeFile(path.join(workspace, 'b.txt'), 'B\n', 'utf8');
    const b = await wt.checkpoint('add B');
    expect(b).toBeDefined();

    await fs.writeFile(path.join(workspace, 'c.txt'), 'C\n', 'utf8');
    const c = await wt.checkpoint('add C');
    expect(c).toBeDefined();

    // Roll back to A. With the old `git reset --hard` this would orphan B
    // and C; with the current implementation they stay in the log.
    await wt.restore(a!.hash);

    // 1. Working tree matches A: only a.txt exists.
    const dirEntries = (await fs.readdir(workspace)).filter((n) => n !== '.git');
    expect(dirEntries.sort()).toEqual(['a.txt']);

    // 2. `git log` still includes A, B, C (plus the rollback commit + init).
    const log = await wt.log(50);
    const subjects = log.map((e) => e.subject);
    expect(subjects).toContain('checkpoint: add A');
    expect(subjects).toContain('checkpoint: add B');
    expect(subjects).toContain('checkpoint: add C');
    // The rollback creates a marker commit; its subject should mention A.
    expect(subjects.some((s) => /rolled back to.*add A/.test(s))).toBe(true);
  });

  it('captures uncommitted edits as a snapshot before rolling back', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'A\n', 'utf8');
    const a = await wt.checkpoint('add A');
    expect(a).toBeDefined();

    // Make an UNCOMMITTED edit that the user hasn't checkpointed yet.
    await fs.writeFile(path.join(workspace, 'a.txt'), 'A-edited\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'scratch.txt'), 'work in progress\n', 'utf8');

    // The user clicks back to "add A" without checkpointing first.
    await wt.restore(a!.hash);

    // Working tree now matches A — the uncommitted edits are gone from
    // the live files…
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('A\n');
    await expect(fs.stat(path.join(workspace, 'scratch.txt')))
      .rejects.toThrow(/ENOENT/);

    // …but they are NOT lost. The log contains a `snapshot before going
    // back` commit that captures them, plus the rollback marker.
    const log = await wt.log(50);
    const subjects = log.map((e) => e.subject);
    expect(subjects).toContain('checkpoint: snapshot before going back');
    expect(subjects.some((s) => /rolled back to.*add A/.test(s))).toBe(true);

    // The snapshot's content is still recoverable via the snapshot hash.
    const snapshot = log.find((e) => e.subject === 'checkpoint: snapshot before going back');
    expect(snapshot).toBeDefined();
    const scratchAtSnapshot = await captureFile(workspace, snapshot!.hash, 'scratch.txt');
    expect(scratchAtSnapshot).toBe('work in progress\n');
  });
});

/* ── helpers ───────────────────────────────────────────────── */

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} → ${code}\n${stderr}`));
    });
  });
}

/** Read a file's content at a specific commit hash. */
async function captureFile(cwd: string, hash: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['show', `${hash}:${file}`], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git show ${hash}:${file} → ${code}\n${stderr}`));
    });
  });
}
