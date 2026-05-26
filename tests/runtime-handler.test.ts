/**
 * Runtime Lambda handler — URL parsing tests.
 *
 * The runtime's job is to take a request like `/<projectId>/api/items` and
 * dispatch to the right project's bundle with the URL rewritten to
 * `/api/items`. The full dispatch happens against a real bundle and is
 * covered by the deployed-stack e2e flow; these unit tests pin the URL
 * parsing & validation surface, which is the part that catches mis-routed
 * traffic before any project-side code runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ddbSendStub = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { send = ddbSendStub; },
  GetItemCommand: class { constructor(public input: unknown) {} },
}));

const s3SendStub = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = s3SendStub; },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  NoSuchKey: class extends Error {},
}));

process.env.TABLE_NAME = 'sprout-test';
// Leave CODE_BUCKET unset so the handler falls back to the placeholder path
// if it gets that far. Most tests exit at validation before dispatch.

const { handler } = await import('../runtime/handler.js');

afterEach(() => {
  vi.clearAllMocks();
});

describe('runtime handler URL parsing', () => {
  beforeEach(() => {
    ddbSendStub.mockResolvedValue({ Item: { version: { N: '1' } } });
  });

  it('returns 400 when the URL has no projectId segment', async () => {
    const res = (await handler({
      rawPath: '/',
      requestContext: { http: { method: 'GET', path: '/' } },
    })) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/projectId/i);
  });

  it('returns 400 when the first URL segment is not a valid projectId', async () => {
    const res = (await handler({
      rawPath: '/not-crockford/api/items',
      requestContext: { http: { method: 'GET', path: '/not-crockford/api/items' } },
    })) as { statusCode: number };
    expect(res.statusCode).toBe(400);
  });

  it('accepts a valid 8-char Crockford code and DOES dispatch (no early 400)', async () => {
    // We don't have a real project bundle on /tmp here, so the runtime falls
    // through to `loadVersionInto`, which without CODE_BUCKET copies the
    // placeholder. The placeholder dir is `/var/task/placeholder` (only
    // present inside Lambda). Outside Lambda the copyFile fails and the
    // handler returns 502 — but it's a 502 from the dispatch path, not a 400
    // from validation. That's what we're asserting: validation accepted the id.
    const res = (await handler({
      rawPath: '/ABCDEFG2/api/items',
      requestContext: { http: { method: 'GET', path: '/ABCDEFG2/api/items' } },
    })) as { statusCode: number };
    expect(res.statusCode).not.toBe(400);
    // Tenancy env var is set BEFORE dispatch, so even on the 502 path the
    // projectId leaked into process.env — confirming validation succeeded.
    expect(process.env.SPROUT_PROJECT_ID).toBe('ABCDEFG2');
  });

  it('accepts a UUID-shaped projectId (legacy projects created pre-Crockford)', async () => {
    const res = (await handler({
      rawPath: '/60b783d9-ab2c-43cd-a19c-6afff2dfbbae/api/items',
      requestContext: {
        http: { method: 'GET', path: '/60b783d9-ab2c-43cd-a19c-6afff2dfbbae/api/items' },
      },
    })) as { statusCode: number };
    expect(res.statusCode).not.toBe(400);
  });

  it('accepts a warmup ping', async () => {
    const res = (await handler({ warmup: true })) as { warmup: string };
    expect(res.warmup).toBe('ok');
  });

  it('falls back to header-supplied projectId when URL parsing fails (direct-invoke)', async () => {
    const res = (await handler({
      rawPath: '/',
      requestContext: { http: { method: 'GET', path: '/' } },
      headers: { 'x-sprout-project-id': 'ABCDEFG3' },
    })) as { statusCode: number };
    // Validation succeeded → handler proceeds to dispatch (which then 502s
    // without a real bundle); the important thing is no 400.
    expect(res.statusCode).not.toBe(400);
    expect(process.env.SPROUT_PROJECT_ID).toBe('ABCDEFG3');
  });

  it('sets the full SPROUT_* env-var contract before dispatching (sandbox/prod compatibility)', async () => {
    // The contract must match what the standalone prod CDK stack sets in
    // sprout-app-stack.ts. If these names drift between the two paths,
    // AI-generated user code that works in sandbox silently breaks on
    // Promote to prod. SPROUT_UPLOADS_BUCKET, in particular, was a
    // documentation-only var until Phase 5 — make sure it stays plumbed.
    //
    // projectId is a fresh Crockford-valid 8-char id (no 0/1/I/L/O/U) so we
    // know SPROUT_PROJECT_ID comes from THIS call's URL, not a previous
    // test's process.env leftover.
    process.env.UPLOADS_BUCKET = 'sprout-uploads-test';
    try {
      await handler({
        rawPath: '/PRJ23456/api/anything',
        requestContext: { http: { method: 'GET', path: '/PRJ23456/api/anything' } },
      });
      expect(process.env.SPROUT_MODE).toBe('sandbox');
      expect(process.env.SPROUT_PROJECT_ID).toBe('PRJ23456');
      expect(process.env.SPROUT_DATA_TABLE).toBe('sprout-test');
      expect(process.env.SPROUT_UPLOADS_BUCKET).toBe('sprout-uploads-test');
    } finally {
      delete process.env.UPLOADS_BUCKET;
    }
  });
});
