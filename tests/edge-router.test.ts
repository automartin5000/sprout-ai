/**
 * Edge router logic tests.
 *
 * The router runs on every CloudFront viewer-request, so a regression here is
 * a fleet-wide outage. Critical behaviors to pin:
 *
 *   1. Spoofed `X-Sprout-*` headers from the client are stripped BEFORE any
 *      lookup or routing decision.
 *   2. Invalid project IDs (anything not matching the 8-char Crockford
 *      pattern or UUID shape) → 404.
 *   3. Missing project (DDB returns no Item) → 404.
 *   4. `/<id>/api/*` paths get the `/<id>` prefix stripped, the project-id
 *      header set, and forwarded to the runtime Lambda.
 *   5. Static-asset paths (anything with a file extension) get rewritten to
 *      `/<id>/v<version>/<rest>` so CloudFront fetches them straight from S3.
 *   6. SPA routes (anything WITHOUT a file extension in the last segment)
 *      get rewritten to `/<id>/v<version>/index.html` for the SPA fallback.
 *   7. DDB failure modes: fail-open with a short cache (avoid full outage
 *      when DDB blips).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ddbSendStub = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { send = ddbSendStub; },
  GetItemCommand: class { constructor(public input: unknown) {} },
}));

// Use a known table name — the runtime's marker substitution doesn't apply
// to the test bundle (we're importing the .ts directly).
process.env.SPROUT_EDGE_TABLE_NAME = 'sprout-test-edge';

const { handler } = await import('../runtime/edge-router.js');

function makeEvent(uri: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, Array<{ key?: string; value: string }>> = {};
  for (const [k, v] of Object.entries(extraHeaders)) {
    headers[k.toLowerCase()] = [{ key: k, value: v }];
  }
  return { Records: [{ cf: { request: { uri, headers } } }] };
}

afterEach(() => {
  vi.clearAllMocks();
  // The router has a module-level cache. Bump cache-busting via the projectId
  // we use per test, so we don't need to reach into the module to clear it.
});

describe('edge-router', () => {
  beforeEach(() => {
    // Default: project exists with version 1.
    ddbSendStub.mockResolvedValue({ Item: { version: { N: '1' } } });
  });

  it('returns 404 on missing project segment', async () => {
    const res = (await handler(makeEvent('/'))) as { status?: string };
    expect(res.status).toBe('404');
  });

  it('returns 404 on invalid project-id pattern', async () => {
    const res = (await handler(makeEvent('/not-a-crockford/'))) as { status?: string };
    expect(res.status).toBe('404');
    // Should never have hit DDB
    expect(ddbSendStub).not.toHaveBeenCalled();
  });

  it('returns 404 when the project row is missing from DDB', async () => {
    ddbSendStub.mockResolvedValueOnce({ Item: undefined });
    const res = (await handler(makeEvent('/ABCDEFGH/'))) as { status?: string };
    expect(res.status).toBe('404');
  });

  it('strips client-supplied X-Sprout-* headers before routing', async () => {
    const event = makeEvent('/ABCDEFG2/about', {
      'X-Sprout-Project-Id': 'EVIL',
      'X-Sprout-Hack': 'yes',
      'User-Agent': 'test',
    });
    const res = (await handler(event)) as { uri: string; headers: Record<string, Array<{ value: string }>> };
    // /about is a SPA route → rewritten to versioned index.html
    expect(res.uri).toBe('/ABCDEFG2/v1/index.html');
    expect(res.headers['x-sprout-hack']).toBeUndefined();
    // User-Agent should pass through untouched
    expect(res.headers['user-agent'][0].value).toBe('test');
  });

  it('leaves /<id>/api/* URIs untouched (runtime Lambda parses the prefix)', async () => {
    const event = {
      Records: [{ cf: { request: {
        uri: '/ABCDEFG3/api/items',
        method: 'GET',
        headers: {},
      } } }],
    };
    const res = (await handler(event)) as { uri: string; headers: Record<string, Array<{ value: string }>> };
    expect(res.uri).toBe('/ABCDEFG3/api/items');
    expect(res.headers['x-sprout-route'][0].value).toBe('runtime');
  });

  it('computes SHA256(body) and adds x-amz-content-sha256 for POST', async () => {
    // The hash CloudFront's OAC signing needs to match the Function URL's
    // verification. Edge gets the body via IncludeBody: true.
    const event = {
      Records: [{ cf: { request: {
        uri: '/ABCDEFG4/api/items',
        method: 'POST',
        headers: {},
        body: { encoding: 'text' as const, data: '{"name":"milk"}' },
      } } }],
    };
    const res = (await handler(event)) as { headers: Record<string, Array<{ value: string }>> };
    // SHA256 of `{"name":"milk"}` in hex (verified via
    // `node -e 'crypto.createHash("sha256").update("...").digest("hex")'`)
    expect(res.headers['x-amz-content-sha256'][0].value).toBe(
      'e951c816b5177ee74931c1ba14079de8050fa116e4a813c703dc4accafbaaa65',
    );
  });

  it('uses the empty-body hash for POSTs with no body', async () => {
    const event = {
      Records: [{ cf: { request: {
        uri: '/ABCDEFG5/api/items/clear',
        method: 'POST',
        headers: {},
      } } }],
    };
    const res = (await handler(event)) as { headers: Record<string, Array<{ value: string }>> };
    expect(res.headers['x-amz-content-sha256'][0].value).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('extracts projectId from Referer when an SPA fetches /api/* without the prefix', async () => {
    // The grocery list / geoguesser templates do `fetch("/api/scores")`,
    // which the browser issues as origin-absolute. CloudFront forwards it
    // here without the projectId prefix. We recover from the Referer header
    // (the page that issued the fetch) instead of returning 404.
    const event = {
      Records: [{ cf: { request: {
        uri: '/api/scores',
        method: 'GET',
        headers: {
          referer: [{ key: 'Referer', value: 'https://example.cloudfront.net/ABCDEFGC/game-over' }],
        },
      } } }],
    };
    const res = (await handler(event)) as { uri: string; headers: Record<string, Array<{ value: string }>> };
    // Edge rewrites in-place to the prefixed URL — runtime parses it normally.
    expect(res.uri).toBe('/ABCDEFGC/api/scores');
    expect(res.headers['x-sprout-route'][0].value).toBe('runtime');
  });

  it('still 404s on apex /api/* with no usable Referer', async () => {
    const event = {
      Records: [{ cf: { request: {
        uri: '/api/scores',
        method: 'GET',
        headers: {},
      } } }],
    };
    const res = (await handler(event)) as { status?: string };
    expect(res.status).toBe('404');
  });

  it('also rewrites POST /api/* without prefix when Referer is present (body hash still set)', async () => {
    const event = {
      Records: [{ cf: { request: {
        uri: '/api/scores',
        method: 'POST',
        headers: {
          referer: [{ key: 'Referer', value: 'https://host/ABCDEFGD/play' }],
        },
        body: { encoding: 'text' as const, data: '{"name":"x","score":1}' },
      } } }],
    };
    const res = (await handler(event)) as { uri: string; headers: Record<string, Array<{ value: string }>> };
    expect(res.uri).toBe('/ABCDEFGD/api/scores');
    expect(res.headers['x-amz-content-sha256']?.[0]?.value).toBeDefined();
  });

  it('does NOT add x-amz-content-sha256 on GETs (CloudFront handles those)', async () => {
    const event = {
      Records: [{ cf: { request: {
        uri: '/ABCDEFGB/api/items',
        method: 'GET',
        headers: {},
      } } }],
    };
    const res = (await handler(event)) as { headers: Record<string, Array<{ value: string }>> };
    expect(res.headers['x-amz-content-sha256']).toBeUndefined();
  });

  it('rewrites Vite-style /<id>/assets/*.js to /<id>/v<version>/assets/*.js for S3', async () => {
    const res = (await handler(makeEvent('/ABCDEFG4/assets/index-DG-uOHtI.js'))) as { uri: string; headers: Record<string, Array<{ value: string }>> };
    // DDB returned version 1 by default in beforeEach.
    expect(res.uri).toBe('/ABCDEFG4/v1/assets/index-DG-uOHtI.js');
    expect(res.headers['x-sprout-route'][0].value).toBe('assets');
    // x-sprout-project-id is NOT required for S3 (the path is the addressing).
    // We don't assert its presence or absence either way — implementation detail.
  });

  it('rewrites image asset paths to versioned S3 keys', async () => {
    const res = (await handler(makeEvent('/ABCDEFG5/images/cat.jpg'))) as { uri: string };
    expect(res.uri).toBe('/ABCDEFG5/v1/images/cat.jpg');
  });

  it('rewrites /<id>/<spa-route> to /<id>/v<version>/index.html for SPA fallback', async () => {
    const res = (await handler(makeEvent('/ABCDEFG6/about'))) as { uri: string; headers: Record<string, Array<{ value: string }>> };
    expect(res.uri).toBe('/ABCDEFG6/v1/index.html');
    expect(res.headers['x-sprout-route'][0].value).toBe('assets');
  });

  it('rewrites the project-root path (just `/<id>/`) to the SPA index.html', async () => {
    const res = (await handler(makeEvent('/ABCDEFG7/'))) as { uri: string };
    expect(res.uri).toBe('/ABCDEFG7/v1/index.html');
  });

  it('rewrites bare /<id> (no trailing slash) to the SPA index.html', async () => {
    const res = (await handler(makeEvent('/ABCDEFGA'))) as { uri: string };
    expect(res.uri).toBe('/ABCDEFGA/v1/index.html');
  });

  it('uses the DDB-reported version when rewriting (not hard-coded v1)', async () => {
    ddbSendStub.mockResolvedValueOnce({ Item: { version: { N: '7' } } });
    // Must be a valid 8-char Crockford code (no 0/1/I/L/O); pick an id we
    // haven't seen yet so the module-level cache doesn't return the
    // previous version.
    const res = (await handler(makeEvent('/VERS9876/assets/x.css'))) as { uri: string };
    expect(res.uri).toBe('/VERS9876/v7/assets/x.css');
  });

  it('fails open (allow the request, short cache) when DDB lookup throws', async () => {
    ddbSendStub.mockRejectedValueOnce(new Error('DDB timeout'));
    const res = (await handler(makeEvent('/ABCDEFG8/about'))) as { uri: string; headers: Record<string, Array<{ value: string }>> };
    // Fail-open: should still rewrite to the SPA index.html instead of 404ing.
    // Version falls back to 0 on lookup failure → /<id>/v0/index.html.
    expect(res.uri).toBe('/ABCDEFG8/v0/index.html');
  });

  it('caches subsequent lookups for the same projectId (single DDB call)', async () => {
    // Use a unique id so we don't collide with the module's cache from prior tests.
    await handler(makeEvent('/CACHEAB1/about'));
    await handler(makeEvent('/CACHEAB1/assets/index.js'));
    await handler(makeEvent('/CACHEAB1/'));
    // 1 lookup, 3 requests → DDB called exactly once
    expect(ddbSendStub).toHaveBeenCalledTimes(1);
  });
});

/**
 * Lambda@Edge can't read env vars at runtime, so the build script
 * (scripts/build-runtime.ts) inlines the table name via esbuild's `define`.
 * If that substitution stops happening, the deployed edge function defaults
 * to the literal string `__SPROUT_TABLE_NAME__` and every DDB lookup throws
 * — which the router fail-opens, sending all traffic to the runtime Lambda
 * Function URL which then returns 403. This test guards against that.
 */
describe('built edge-router bundle', () => {
  it('bakes the table name into the bundle (no __SPROUT_TABLE_NAME__ marker left)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const bundle = path.resolve(__dirname, '..', 'runtime', 'dist', 'edge-router-stage', 'index.js');
    const exists = await fs.stat(bundle).then(() => true).catch(() => false);
    if (!exists) {
      // Bundle hasn't been built yet (fresh checkout, no `pj build` run).
      // Skip rather than fail — the test guards against drift, not against
      // a clean dev tree.
      console.warn('edge-router bundle not built yet — skipping bake check');
      return;
    }
    const content = await fs.readFile(bundle, 'utf8');
    // The placeholder marker should NOT survive the build.
    expect(content).not.toContain('__SPROUT_TABLE_NAME__');
    // A real `sprout-<env>` table name SHOULD be present.
    expect(content).toMatch(/sprout-(?:dev|prod|ephemeral)/);
  });
});
