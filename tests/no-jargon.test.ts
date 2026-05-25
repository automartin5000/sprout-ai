import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the plain-English copy pass.
 *
 * Strategy: only inspect strings that are *unambiguously* user-visible —
 * JSX text content between tags, plus the value of `placeholder` /
 * `title` / `aria-label` props. Internal identifiers (variable names, IPC
 * channels, CSS class names, prop names) are intentionally NOT inspected.
 *
 * This catches regressions like a button label flipping back to "Deploy"
 * while leaving the internal `harnessId` field untouched.
 */
const BANNED_PHRASES = [
  'Deploy to AWS',
  'Checkpoints appear',
  'checkpoint ·',
  'scratch project',
  'MOCK_AUTH',
  'worktree',
  // Brand regression: every user-visible string should say "Sprout" (or
  // nothing brand-specific). Catches accidental backslides from the rebrand.
  'local-lovable',
  'LocalLovable',
];

const RENDERER_DIR = path.resolve(__dirname, '..', 'app', 'renderer');

async function walkTsx(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walkTsx(p)));
    else if (/\.tsx?$/.test(e.name)) files.push(p);
  }
  return files;
}

/**
 * Pull user-visible strings out of a TSX source: text between JSX tags
 * (e.g. `<button>Deploy to AWS</button>`) and values of placeholder /
 * title / aria-label attributes.
 */
function extractUserVisible(source: string): string[] {
  const out: string[] = [];
  // JSX text between > and < (excluding braces and tags themselves).
  // Non-greedy + allow newlines so multi-line button labels are caught.
  for (const m of source.matchAll(/>([^<>{}]{2,}?)</g)) {
    const text = m[1].trim();
    if (text) out.push(text);
  }
  // placeholder="…" / title="…" / aria-label="…"
  for (const m of source.matchAll(/\b(?:placeholder|title|aria-label)\s*=\s*["']([^"']+)["']/g)) {
    out.push(m[1]);
  }
  // String literals passed to .push(...) for suggestions, etc. — quoted lists
  // matching the suggestion-array pattern: `['…', '…', …]`
  for (const m of source.matchAll(/^\s*['"`]([^'"`]{5,})['"`]\s*,?\s*$/gm)) {
    out.push(m[1]);
  }
  return out;
}

describe('plain-English copy regression', () => {
  it('no banned phrases appear in user-visible JSX text', async () => {
    const files = await walkTsx(RENDERER_DIR);
    const offenders: Array<{ file: string; phrase: string; text: string }> = [];

    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8');
      const userText = extractUserVisible(raw);
      for (const text of userText) {
        for (const phrase of BANNED_PHRASES) {
          if (text.toLowerCase().includes(phrase.toLowerCase())) {
            offenders.push({
              file: path.relative(RENDERER_DIR, file),
              phrase,
              text: text.trim(),
            });
          }
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}: "${o.phrase}" in → ${o.text}`)
        .join('\n');
      throw new Error(`Found ${offenders.length} jargon hit(s):\n${msg}`);
    }
    expect(offenders).toEqual([]);
  });
});
