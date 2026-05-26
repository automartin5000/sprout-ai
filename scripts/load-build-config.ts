/**
 * Build-time configuration loader for the packaged Electron app.
 *
 * Reads `sprout.build-config.json` from the repo root (gitignored) and
 * returns the keys that should be baked into the production bundle via
 * esbuild's `define:`. Each key has a `process.env` fallback so CI builds
 * can pass values as env vars instead of dropping a config file.
 *
 * Once baked, the values are LITERAL strings in the compiled bundle — the
 * `.dmg` ships with one preconfigured environment per build. Users can't
 * override at runtime (by design — the alternative is a runtime-read
 * config file shipped in extraResources, which we'll add later if
 * multiple-env reuse becomes a real need).
 *
 * Dev mode does NOT call this — `scripts/dev-electron.ts` builds without
 * any `define:` so process.env stays live and `.env` continues to work.
 *
 * Why these specific keys: the runtime reads `process.env.AUTH0_DOMAIN`
 * etc. (see app/main/services.ts). For a packaged build, the .dmg has no
 * .env file, so without baking these values the user lands in guest mode
 * with cloud features disabled. Secrets (Anthropic key, Copilot token,
 * Auth0 client SECRET) are deliberately NOT in this list — those have to
 * come from the user's own machine at runtime.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Keys we expose via `define:` in production builds. Add to this list if
 * you add a new env var that the bundle needs baked. NEVER add secrets
 * (api keys, tokens, client secrets) — those must remain user-supplied.
 */
export const BAKABLE_KEYS = [
  'AUTH0_DOMAIN',
  'AUTH0_AUDIENCE',
  'AUTH0_NATIVE_CLIENT_ID',
  'CLOUD_API_URL',
  'APPS_BASE_URL',
] as const;

export type BakableKey = typeof BAKABLE_KEYS[number];
export type BuildConfig = Record<BakableKey, string>;
export type SourceTag = 'config-file' | 'env' | 'missing';

const CONFIG_FILENAME = 'sprout.build-config.json';

/**
 * Resolve the build config. Precedence per-key:
 *   1. JSON file at repo root (sprout.build-config.json)
 *   2. process.env (so CI can pass values without writing a file)
 *   3. empty string (the runtime fallbacks in services.ts handle this:
 *      Sign-in is disabled, cloud API falls back to localhost:3001)
 */
export function loadBuildConfig(root: string): {
  values: BuildConfig;
  report: Array<{ key: BakableKey; source: SourceTag }>;
} {
  const configPath = path.join(root, CONFIG_FILENAME);
  const fromFile: Partial<Record<string, string>> = {};
  if (fs.existsSync(configPath)) {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new Error(`load-build-config: failed to read ${configPath}: ${(err as Error).message}`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`load-build-config: failed to parse ${configPath} as JSON: ${(err as Error).message}`);
    }
    for (const k of BAKABLE_KEYS) {
      const v = parsed[k];
      if (typeof v === 'string') {
        fromFile[k] = v;
      } else if (v !== undefined) {
        throw new Error(
          `load-build-config: ${configPath} has non-string value for "${k}" (got ${typeof v}). All bakable keys must be strings.`,
        );
      }
    }
  }

  const values = {} as BuildConfig;
  const report: Array<{ key: BakableKey; source: SourceTag }> = [];
  for (const k of BAKABLE_KEYS) {
    if (fromFile[k] !== undefined) {
      values[k] = fromFile[k]!;
      report.push({ key: k, source: 'config-file' });
    } else if (process.env[k] !== undefined && process.env[k] !== '') {
      values[k] = process.env[k]!;
      report.push({ key: k, source: 'env' });
    } else {
      values[k] = '';
      report.push({ key: k, source: 'missing' });
    }
  }

  return { values, report };
}

/**
 * Convert the loaded values into esbuild `define:` shape. Each entry maps
 * `process.env.KEY` to a JSON-encoded string literal, so esbuild rewrites
 * the dot-property access at build time.
 *
 * esbuild only replaces literal `process.env.KEY` accesses (dot notation).
 * Bracket-access (`process.env['KEY']`) is preserved as-is. Source code
 * that needs baking must use dot notation; we lint for this in build-config.test.ts.
 */
export function toEsbuildDefine(config: BuildConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of BAKABLE_KEYS) {
    out[`process.env.${k}`] = JSON.stringify(config[k]);
  }
  return out;
}

/**
 * Render a one-line-per-key summary of where each value came from. Does NOT
 * print the values themselves — those may be secrets you don't want in CI
 * logs (Auth0 audience URLs aren't strictly secret but they identify your
 * tenant).
 */
export function formatBuildConfigReport(
  report: Array<{ key: BakableKey; source: SourceTag }>,
): string {
  const lines = ['Build config:'];
  for (const { key, source } of report) {
    lines.push(`  ${key.padEnd(24)} ${source}`);
  }
  const missingCount = report.filter((r) => r.source === 'missing').length;
  if (missingCount > 0) {
    lines.push('');
    lines.push(`  ⚠ ${missingCount} key${missingCount === 1 ? '' : 's'} missing — see PACKAGING.md § Configure build-time values.`);
    lines.push('    The bundle will still build, but features that depend on these keys will be disabled.');
  }
  return lines.join('\n');
}
