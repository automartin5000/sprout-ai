/**
 * Unit tests for the deploy template-copy primitives:
 *   - copyTemplates: recursive copy + `{{variable}}` substitution
 *   - mergePackageJson: JSON-patch additive merge
 *
 * These run in isolation from the orchestrator (no spawning, no git).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { copyTemplates, mergePackageJson } from '../app/main/deploy/template-copy.js';

describe('copyTemplates', () => {
  let src: string;
  let dest: string;

  beforeEach(async () => {
    src = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-tpl-src-'));
    dest = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-tpl-dst-'));
  });

  afterEach(async () => {
    await fs.rm(src, { recursive: true, force: true });
    await fs.rm(dest, { recursive: true, force: true });
  });

  it('copies a tree of files recursively', async () => {
    await fs.mkdir(path.join(src, 'sub'), { recursive: true });
    await fs.writeFile(path.join(src, 'root.txt'), 'root', 'utf8');
    await fs.writeFile(path.join(src, 'sub', 'nested.md'), '# nested', 'utf8');

    await copyTemplates({ src, dest, variables: {} });

    expect(await fs.readFile(path.join(dest, 'root.txt'), 'utf8')).toBe('root');
    expect(await fs.readFile(path.join(dest, 'sub', 'nested.md'), 'utf8')).toBe('# nested');
  });

  it('substitutes {{vars}} in text files only', async () => {
    await fs.writeFile(path.join(src, 'project.ts'), 'const NAME = "{{projectName}}";', 'utf8');
    await fs.writeFile(path.join(src, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await copyTemplates({ src, dest, variables: { projectName: 'demo-app' } });

    expect(await fs.readFile(path.join(dest, 'project.ts'), 'utf8'))
      .toBe('const NAME = "demo-app";');
    // Binary file (PNG) should be byte-identical, no substitution applied
    expect(await fs.readFile(path.join(dest, 'image.png'))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('leaves unknown {{vars}} alone instead of erasing them', async () => {
    await fs.writeFile(path.join(src, 'a.md'), 'hello {{unknown}} and {{known}}', 'utf8');
    await copyTemplates({ src, dest, variables: { known: 'world' } });
    expect(await fs.readFile(path.join(dest, 'a.md'), 'utf8'))
      .toBe('hello {{unknown}} and world');
  });

  it('skips package.json.patch (handled by mergePackageJson)', async () => {
    await fs.writeFile(path.join(src, 'package.json.patch'), '{"scripts":{}}', 'utf8');
    await fs.writeFile(path.join(src, 'other.txt'), 'ok', 'utf8');
    await copyTemplates({ src, dest, variables: {} });
    expect(await fs.stat(path.join(dest, 'package.json.patch')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(dest, 'other.txt'), 'utf8')).toBe('ok');
  });
});

describe('mergePackageJson', () => {
  let project: string;
  let patch: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-pkg-prj-'));
    patch = path.join(project, 'patch.json');
  });

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  it('shallow-merges scripts + devDependencies, overwrites other top-level keys', async () => {
    await fs.writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({
        name: 'user-app',
        version: '1.0.0',
        scripts: { build: 'vite build', dev: 'vite' },
        devDependencies: { vite: '^6.0.0' },
      }),
    );
    await fs.writeFile(
      patch,
      JSON.stringify({
        scripts: { synth: 'bun projen synth', deploy: 'bun projen deploy' },
        devDependencies: { 'aws-cdk-lib': '^2.180.0', projen: '^0.95.0' },
      }),
    );

    await mergePackageJson({ projectRoot: project, patchFile: patch });

    const merged = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // User fields preserved
    expect(merged.name).toBe('user-app');
    expect(merged.version).toBe('1.0.0');
    // Scripts merged (both new + existing)
    expect(merged.scripts).toEqual({
      build: 'vite build',
      dev: 'vite',
      synth: 'bun projen synth',
      deploy: 'bun projen deploy',
    });
    // devDeps merged
    expect(merged.devDependencies).toMatchObject({
      vite: '^6.0.0',
      'aws-cdk-lib': '^2.180.0',
      projen: '^0.95.0',
    });
  });

  it('creates a package.json if none exists, defaulting name to dir basename', async () => {
    // No package.json in project yet
    await fs.writeFile(
      patch,
      JSON.stringify({ scripts: { synth: 'bun projen synth' }, devDependencies: { projen: '^0.95.0' } }),
    );

    await mergePackageJson({ projectRoot: project, patchFile: patch });

    const merged = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(merged.name).toBe(path.basename(project));
    expect(merged.scripts.synth).toBe('bun projen synth');
  });
});
