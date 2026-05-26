/**
 * Tests for scripts/load-build-config.ts.
 *
 * Covers:
 *   • JSON file present → values come from file
 *   • env var fallback when file is absent
 *   • file overrides env when both are present
 *   • missing keys are reported
 *   • invalid JSON throws with the file path in the error
 *   • non-string values throw with the offending key
 *   • toEsbuildDefine produces JSON-quoted literals
 *   • formatBuildConfigReport doesn't leak values
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadBuildConfig,
  toEsbuildDefine,
  formatBuildConfigReport,
  BAKABLE_KEYS,
} from '../scripts/load-build-config.js';

describe('load-build-config', () => {
  let tmp: string;
  let envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sprout-build-config-'));
    // Clear all bakable keys so each test starts from a known state.
    envBackup = {};
    for (const k of BAKABLE_KEYS) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const k of BAKABLE_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });

  it('reads values from sprout.build-config.json when present', () => {
    fs.writeFileSync(
      path.join(tmp, 'sprout.build-config.json'),
      JSON.stringify({
        AUTH0_DOMAIN: 'example.us.auth0.com',
        AUTH0_AUDIENCE: 'https://api.example.com',
        AUTH0_NATIVE_CLIENT_ID: 'abc123',
        CLOUD_API_URL: 'https://api.example.com',
        APPS_BASE_URL: 'https://apps.example.com',
      }),
    );

    const { values, report } = loadBuildConfig(tmp);
    expect(values.AUTH0_DOMAIN).toBe('example.us.auth0.com');
    expect(values.AUTH0_AUDIENCE).toBe('https://api.example.com');
    expect(report.every((r) => r.source === 'config-file')).toBe(true);
  });

  it('falls back to process.env when JSON file is absent', () => {
    process.env.AUTH0_DOMAIN = 'from-env.us.auth0.com';
    process.env.CLOUD_API_URL = 'https://from-env.example.com';

    const { values, report } = loadBuildConfig(tmp);
    expect(values.AUTH0_DOMAIN).toBe('from-env.us.auth0.com');
    expect(values.CLOUD_API_URL).toBe('https://from-env.example.com');
    expect(values.APPS_BASE_URL).toBe('');

    const byKey = Object.fromEntries(report.map((r) => [r.key, r.source]));
    expect(byKey.AUTH0_DOMAIN).toBe('env');
    expect(byKey.CLOUD_API_URL).toBe('env');
    expect(byKey.APPS_BASE_URL).toBe('missing');
  });

  it('JSON file takes precedence over env vars', () => {
    process.env.AUTH0_DOMAIN = 'env-loses.example.com';
    fs.writeFileSync(
      path.join(tmp, 'sprout.build-config.json'),
      JSON.stringify({ AUTH0_DOMAIN: 'file-wins.example.com' }),
    );

    const { values } = loadBuildConfig(tmp);
    expect(values.AUTH0_DOMAIN).toBe('file-wins.example.com');
  });

  it('reports missing keys as missing with empty-string values', () => {
    // No file, no env vars set.
    const { values, report } = loadBuildConfig(tmp);
    for (const k of BAKABLE_KEYS) {
      expect(values[k]).toBe('');
    }
    expect(report.every((r) => r.source === 'missing')).toBe(true);
  });

  it('treats empty-string env vars as missing (so unset vs ="" both fall to missing)', () => {
    process.env.AUTH0_DOMAIN = '';
    const { report } = loadBuildConfig(tmp);
    const auth0Domain = report.find((r) => r.key === 'AUTH0_DOMAIN');
    expect(auth0Domain?.source).toBe('missing');
  });

  it('throws with the file path when JSON is malformed', () => {
    fs.writeFileSync(path.join(tmp, 'sprout.build-config.json'), '{ not: json }');
    expect(() => loadBuildConfig(tmp)).toThrow(/failed to parse/);
    expect(() => loadBuildConfig(tmp)).toThrow(/sprout\.build-config\.json/);
  });

  it('throws with the offending key when a value is not a string', () => {
    fs.writeFileSync(
      path.join(tmp, 'sprout.build-config.json'),
      JSON.stringify({ AUTH0_DOMAIN: 12345 }),
    );
    expect(() => loadBuildConfig(tmp)).toThrow(/AUTH0_DOMAIN/);
    expect(() => loadBuildConfig(tmp)).toThrow(/non-string/);
  });

  it('ignores unknown keys in the JSON file (forward-compat)', () => {
    fs.writeFileSync(
      path.join(tmp, 'sprout.build-config.json'),
      JSON.stringify({
        AUTH0_DOMAIN: 'example.us.auth0.com',
        // A made-up key from a future Sprout version. Shouldn't crash.
        SOME_FUTURE_KEY: 'value',
      }),
    );
    expect(() => loadBuildConfig(tmp)).not.toThrow();
  });
});

describe('toEsbuildDefine', () => {
  it('produces JSON-encoded string literals keyed by process.env.X', () => {
    const define = toEsbuildDefine({
      AUTH0_DOMAIN: 'foo.us.auth0.com',
      AUTH0_AUDIENCE: 'https://api.example.com',
      AUTH0_NATIVE_CLIENT_ID: 'client-id',
      CLOUD_API_URL: 'https://api.example.com',
      APPS_BASE_URL: 'https://apps.example.com',
    });

    // esbuild requires the value to be a JSON-encoded source string.
    // "foo.us.auth0.com" gets wrapped to: "\"foo.us.auth0.com\"".
    expect(define['process.env.AUTH0_DOMAIN']).toBe('"foo.us.auth0.com"');
    expect(define['process.env.CLOUD_API_URL']).toBe('"https://api.example.com"');
  });

  it('JSON-encodes special characters so values can contain quotes/backslashes', () => {
    const define = toEsbuildDefine({
      AUTH0_DOMAIN: 'has "quotes" and \\backslash',
      AUTH0_AUDIENCE: '',
      AUTH0_NATIVE_CLIENT_ID: '',
      CLOUD_API_URL: '',
      APPS_BASE_URL: '',
    });
    // Round-trip via JSON.parse to confirm the encoding is valid.
    expect(JSON.parse(define['process.env.AUTH0_DOMAIN']!)).toBe('has "quotes" and \\backslash');
  });

  it('produces define keys for every BAKABLE_KEY (no silent drops)', () => {
    const empty = Object.fromEntries(BAKABLE_KEYS.map((k) => [k, ''])) as Record<typeof BAKABLE_KEYS[number], string>;
    const define = toEsbuildDefine(empty);
    for (const k of BAKABLE_KEYS) {
      expect(define[`process.env.${k}`]).toBeDefined();
    }
  });
});

describe('formatBuildConfigReport', () => {
  it('lists every key with its source', () => {
    const out = formatBuildConfigReport([
      { key: 'AUTH0_DOMAIN', source: 'config-file' },
      { key: 'AUTH0_AUDIENCE', source: 'env' },
      { key: 'AUTH0_NATIVE_CLIENT_ID', source: 'missing' },
      { key: 'CLOUD_API_URL', source: 'config-file' },
      { key: 'APPS_BASE_URL', source: 'missing' },
    ]);
    expect(out).toMatch(/AUTH0_DOMAIN.*config-file/);
    expect(out).toMatch(/AUTH0_AUDIENCE.*env/);
    expect(out).toMatch(/AUTH0_NATIVE_CLIENT_ID.*missing/);
    expect(out).toMatch(/2 keys missing/);
  });

  it('does not print actual values', () => {
    // The report only takes key + source — we don't pass values in. Sanity
    // check that the formatter doesn't accidentally start logging values
    // if someone extends the input shape later.
    const out = formatBuildConfigReport([{ key: 'AUTH0_DOMAIN', source: 'config-file' }]);
    expect(out).not.toMatch(/\.auth0\.com/);
    expect(out).not.toMatch(/example\.com/);
  });
});
