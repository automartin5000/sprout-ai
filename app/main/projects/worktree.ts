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

  async restore(hash: string): Promise<void> {
    await runGit(this.root, ['reset', '--hard', hash]);
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
