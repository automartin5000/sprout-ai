/**
 * Download Node, git, AWS CLI, and Podman per-arch into app/resources/bin/
 * for inclusion in the Electron app bundle.
 *
 * The actual fetch URLs and unpack steps are kept declarative below so this
 * file stays readable. For local development you can run this once and check
 * in nothing — the binaries are gitignored.
 *
 * Skips work for any binary already present.
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const BIN_ROOT = path.join(ROOT, 'app/resources/bin');

type Arch = 'arm64' | 'x64';

interface BinarySpec {
  name: string;
  url: (arch: Arch) => string;
  /** Path inside the downloaded archive that should land at <binDir>/<name>. */
  archivePath?: (arch: Arch) => string;
  /** Optional sha256 to verify after download. */
  sha256?: (arch: Arch) => string | undefined;
  archive: 'tar.gz' | 'zip' | 'pkg' | 'raw';
}

const NODE_VERSION = '22.12.0';
const PODMAN_VERSION = '5.2.4';
const AWS_CLI_VERSION = '2.17.50';

const BINARIES: BinarySpec[] = [
  {
    name: 'node',
    archive: 'tar.gz',
    url: (arch) =>
      `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${arch}.tar.gz`,
    archivePath: (arch) => `node-v${NODE_VERSION}-darwin-${arch}/bin/node`,
  },
  {
    name: 'podman',
    archive: 'zip',
    url: (arch) =>
      `https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-remote-release-darwin_${arch}.zip`,
    archivePath: (arch) => `podman-${PODMAN_VERSION}/usr/bin/podman`,
  },
  {
    name: 'aws',
    archive: 'pkg',
    url: () =>
      `https://awscli.amazonaws.com/AWSCLIV2-${AWS_CLI_VERSION}.pkg`,
  },
  {
    name: 'git',
    archive: 'raw',
    // System git on macOS is preinstalled via Xcode CLT; we don't bundle.
    // Placeholder spec so the future maintainer sees the slot.
    url: () => 'about:placeholder',
  },
];

async function main(): Promise<void> {
  const arch: Arch = (process.env.TARGET_ARCH as Arch) ?? (process.arch as Arch);
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`unsupported target arch: ${arch}`);
  }

  const archDir = path.join(BIN_ROOT, arch);
  await fs.mkdir(archDir, { recursive: true });

  for (const spec of BINARIES) {
    const dest = path.join(archDir, spec.name);
    if (await exists(dest)) {
      console.log(`✓ ${spec.name} (${arch}) already present`);
      continue;
    }
    if (spec.archive === 'raw' && spec.url(arch) === 'about:placeholder') {
      console.log(`- skipping ${spec.name}: bundled via system path`);
      continue;
    }
    console.log(`↓ downloading ${spec.name} (${arch})`);
    await downloadAndExtract(spec, arch, archDir);
  }

  console.log(`done. binaries staged at ${archDir}`);
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function downloadAndExtract(spec: BinarySpec, arch: Arch, dest: string): Promise<void> {
  const url = spec.url(arch);
  const tmp = path.join(os.tmpdir(), `sprout-${spec.name}-${crypto.randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });

  const archiveFile = path.join(tmp, `download.${spec.archive}`);
  await downloadTo(url, archiveFile);

  if (spec.sha256) {
    const expected = spec.sha256(arch);
    if (expected) await verifySha256(archiveFile, expected);
  }

  switch (spec.archive) {
    case 'tar.gz':
      await run('tar', ['-xzf', archiveFile, '-C', tmp]);
      if (spec.archivePath) {
        await fs.copyFile(path.join(tmp, spec.archivePath(arch)), path.join(dest, spec.name));
        await fs.chmod(path.join(dest, spec.name), 0o755);
      }
      break;
    case 'zip':
      await run('unzip', ['-q', archiveFile, '-d', tmp]);
      if (spec.archivePath) {
        await fs.copyFile(path.join(tmp, spec.archivePath(arch)), path.join(dest, spec.name));
        await fs.chmod(path.join(dest, spec.name), 0o755);
      }
      break;
    case 'pkg':
      // AWS CLI ships as a .pkg installer. `pkgutil --expand-full` extracts it
      // without running the installer.
      await run('pkgutil', ['--expand-full', archiveFile, path.join(tmp, 'expanded')]);
      await fs.cp(path.join(tmp, 'expanded'), path.join(dest, `${spec.name}-pkg`), {
        recursive: true,
      });
      // The unpacked aws binary lives at expanded/aws-cli.pkg/Payload/aws-cli/aws
      // Locate it heuristically and symlink the entrypoint.
      try {
        const payloadDir = path.join(dest, `${spec.name}-pkg`);
        const found = await findFile(payloadDir, 'aws');
        if (found) {
          await fs.symlink(path.relative(dest, found), path.join(dest, spec.name));
        }
      } catch (err) {
        console.warn(`could not symlink aws binary:`, err);
      }
      break;
    case 'raw':
      await fs.copyFile(archiveFile, path.join(dest, spec.name));
      await fs.chmod(path.join(dest, spec.name), 0o755);
      break;
  }

  await fs.rm(tmp, { recursive: true, force: true });
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${url} (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

async function verifySha256(file: string, expected: string): Promise<void> {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  const got = hash.digest('hex');
  if (got !== expected) {
    throw new Error(`sha256 mismatch for ${file}: expected ${expected}, got ${got}`);
  }
}

async function findFile(root: string, name: string): Promise<string | undefined> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as fsSync.Dirent[]);
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) {
      const inner = await findFile(p, name);
      if (inner) return inner;
    }
  }
  return undefined;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
