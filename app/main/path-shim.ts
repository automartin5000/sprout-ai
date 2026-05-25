import * as path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Prepend the app's bundled binaries (Node, git, AWS CLI, Podman) to PATH so
 * every child_process the main process spawns picks them up first. Must run
 * before any other import that may resolve binaries.
 */
export function applyPathShim(opts: { resourcesPath: string | undefined }): void {
  // `process.resourcesPath` is undefined outside the Electron runtime
  // (e.g. when our main-bundle smoke test imports the bundle under plain
  // Node). Treat that as "no bundled binaries to expose" and bail out
  // rather than crashing on `path.join(undefined, ...)`.
  if (!opts.resourcesPath) return;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    path.join(opts.resourcesPath, 'bin', arch),
    path.join(opts.resourcesPath, 'bin'),
  ];
  const binDir = candidates.find(existsSync);
  if (!binDir) return;

  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const awsDataDir = path.join(binDir, '..', 'aws-data');
  if (existsSync(awsDataDir)) {
    process.env.AWS_DATA_PATH = awsDataDir;
  }
}
