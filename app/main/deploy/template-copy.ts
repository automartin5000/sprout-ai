import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Helpers for the "Publish to prod" template-application step:
 *
 *   - `copyTemplates`   — recursively copy a plugin's templates/ dir into
 *                          the user's project, with a tiny `{{var}}` mustache
 *                          pass on text files
 *   - `mergePackageJson` — apply a JSON-patch file (additive merge) so the
 *                          plugin can add deps/scripts without clobbering the
 *                          user's existing fields
 *
 * Both functions are pure (no IPC, no main-process state) so they can be
 * unit-tested in isolation.
 */

/**
 * Recursively copy `src` → `dest`, performing variable substitution on text
 * files. Existing files in `dest` are overwritten — callers should preflight
 * for collisions if that matters (the prod-deploy orchestrator does).
 *
 * Variable substitution: only `{{key}}` patterns are touched. Binary files
 * (detected by extension allowlist) pass through unchanged.
 */
export async function copyTemplates(opts: {
  src: string;
  dest: string;
  variables: Record<string, string>;
}): Promise<void> {
  await fs.mkdir(opts.dest, { recursive: true });
  const entries = await fs.readdir(opts.src, { withFileTypes: true });

  for (const entry of entries) {
    const s = path.join(opts.src, entry.name);
    const d = path.join(opts.dest, entry.name);

    if (entry.isDirectory()) {
      await copyTemplates({ src: s, dest: d, variables: opts.variables });
      continue;
    }

    if (entry.isSymbolicLink()) {
      const target = await fs.readlink(s);
      await fs.symlink(target, d);
      continue;
    }

    // package.json.patch is handled by mergePackageJson — don't copy it.
    if (entry.name === 'package.json.patch') continue;

    if (isTextFile(entry.name)) {
      const raw = await fs.readFile(s, 'utf8');
      const subbed = substitute(raw, opts.variables);
      await fs.writeFile(d, subbed, 'utf8');
    } else {
      await fs.copyFile(s, d);
    }
  }
}

/**
 * Merge a JSON-patch file into the user's `package.json`. Patch wins for
 * `scripts` / `dependencies` / `devDependencies` keys (per-key shallow
 * merge); other top-level keys in the patch overwrite the user's value.
 *
 * If the user has no `package.json` yet, the patch becomes the new file
 * (with `name` defaulted to the project's directory name).
 */
export async function mergePackageJson(opts: {
  projectRoot: string;
  patchFile: string;
}): Promise<void> {
  const targetFile = path.join(opts.projectRoot, 'package.json');
  const patchRaw = await fs.readFile(opts.patchFile, 'utf8');
  const patch = JSON.parse(patchRaw) as Record<string, unknown>;

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(targetFile, 'utf8'));
  } catch {
    existing = { name: path.basename(opts.projectRoot), version: '0.1.0', private: true };
  }

  const merged = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (
      (key === 'scripts' || key === 'dependencies' || key === 'devDependencies') &&
      isPlainObject(existing[key]) &&
      isPlainObject(value)
    ) {
      merged[key] = { ...(existing[key] as object), ...(value as object) };
    } else {
      merged[key] = value;
    }
  }

  await fs.writeFile(targetFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

/* ── helpers ───────────────────────────────────────────────── */

function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (full, key: string) => {
    return key in vars ? vars[key] : full;
  });
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yml', '.yaml', '.md', '.txt', '.sh',
  '.html', '.css', '.scss', '.toml', '.xml', '.gitignore',
]);

function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (ext === '') {
    // Hidden / no-extension files commonly used in repos are text.
    return name.startsWith('.') || name === 'Dockerfile' || name === 'Makefile';
  }
  return TEXT_EXTENSIONS.has(ext);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
