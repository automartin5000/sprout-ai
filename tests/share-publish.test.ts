/**
 * Phase-4.0 regression test for the `/share/:code/publish` endpoint.
 *
 * The Phase-3 rollout left this endpoint returning the old Phase-2
 * `{ jobId, uploadUrl }` shape — but the desktop client was already updated
 * to expect the V3 two-bundle shape, so teammates publishing via a share code
 * silently got broken responses. This test pins the V3 contract by:
 *
 *   1. exercising the route through Hono's `.request()` API
 *   2. mocking the DDB + S3-presigner boundaries
 *   3. parsing the response with `PublishStartV3ResponseSchema` — if the route
 *      ever regresses to the old shape, the parse throws and CI fails.
 *
 * It also covers the three rejection paths (`missing`, `expired`, `view-only`)
 * because the previous implementation had them inline; we extracted them into
 * `resolveEditableShare` and don't want to lose the coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Set bucket + URL env vars BEFORE the route module imports. The route's
//    top-level code reads `process.env.STAGING_BUCKET` etc. when handlers run,
//    but `publishedUrl()` reads `APPS_BASE_URL` lazily so order doesn't matter
//    for it — we set everything up here for clarity.
process.env.STAGING_BUCKET = 'sprout-staging-test';
process.env.CODE_BUCKET = 'sprout-code-test';
process.env.ASSETS_BUCKET = 'sprout-assets-test';
process.env.APPS_BASE_URL = 'https://apps.sprout.test';
// MOCK_AUTH lets the owner-authed endpoints accept requests with no JWT —
// `readClaims` returns a synthetic local|dev-user sub. Combined with seeding
// a project whose ownerSub matches, this covers the owner-publish flow.
process.env.MOCK_AUTH = '1';

// Hoisted mocks — vi.mock is itself hoisted, but the mock factories need to
// reference fresh stub functions per test, so we capture refs after each call.
const ddbStub = vi.hoisted(() => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  updateItem: vi.fn(),
  // Helpers that just return strings — pass through to a tiny shim.
  userPk: (sub: string) => `USER#${sub}`,
  projectPk: (id: string) => `PROJECT#${id}`,
  projectSk: (id: string) => `PROJECT#${id}`,
  projectMetaSk: () => 'META',
  sharePk: (code: string) => `SHARE#${code}`,
  collabSk: (sub: string) => `COLLAB#${sub}`,
  jobPk: (id: string) => `JOB#${id}`,
}));

vi.mock('../lambda/api/db/ddb.js', () => ddbStub);

const presignerStub = vi.hoisted(() => ({
  getSignedUrl: vi.fn(async (_client: unknown, _cmd: unknown) => 'https://signed.example/PUT'),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => presignerStub);

// The start endpoint never dispatches to S3 (presigner is mocked separately),
// but `/publish/complete` does:
//   - `CopyObjectCommand` to promote the server.zip from staging into the
//     code bucket (no body needed back)
//   - `GetObjectCommand` to fetch the staged static.tar.gz, followed by
//     `PutObjectCommand` for each extracted file into the assets bucket
// Stub `send` so all three commands return something sensible; the contract
// tests assert on the audit row + updateItem call, not the S3 traffic.
const s3SendStub = vi.hoisted(() =>
  vi.fn(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetObjectCommand') {
      // Return an empty tarball body. extractStaticTarballToAssets reads this
      // stream into a Buffer and parses 0 entries — Promise.all([]) resolves
      // immediately, so /publish/complete finishes cleanly.
      const { Readable } = await import('node:stream');
      return { Body: Readable.from(Buffer.alloc(0)) };
    }
    return {};
  }),
);
vi.mock('@aws-sdk/client-s3', async () => {
  return {
    S3Client: class {
      send = s3SendStub;
    },
    PutObjectCommand: class {
      constructor(public readonly args: unknown) {}
    },
    CopyObjectCommand: class {
      constructor(public readonly args: unknown) {}
    },
    GetObjectCommand: class {
      constructor(public readonly args: unknown) {}
    },
  };
});

const { publishRoute } = await import('../lambda/api/routes/publish.js');
const { PublishStartV3ResponseSchema } = await import('../shared/api-contract.js');

afterEach(() => {
  vi.clearAllMocks();
});

describe('/share/:code/publish — V3 contract', () => {
  beforeEach(() => {
    // Default share row: valid, editable, owned by a stub user.
    ddbStub.getItem.mockImplementation(async (pk: string, sk: string) => {
      if (pk === 'SHARE#ABC123' && sk === 'META') {
        return {
          code: 'ABC123',
          token: 'ABC123',
          projectId: 'proj-abc',
          ownerSub: 'auth0|owner',
          grants: 'edit',
          createdAt: new Date().toISOString(),
        };
      }
      if (pk === 'PROJECT#proj-abc' && sk === 'META') {
        return { version: 0 };
      }
      return undefined;
    });
    presignerStub.getSignedUrl.mockResolvedValue('https://signed.example/PUT');
  });

  it('returns the V3 two-bundle shape (not the legacy {jobId, uploadUrl})', async () => {
    const res = await publishRoute.request('/share/ABC123/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    // The zod schema IS the contract — if the route regresses to Phase 2's
    // `{ jobId, uploadUrl }`, this parse fails.
    expect(() => PublishStartV3ResponseSchema.parse(body)).not.toThrow();

    // Spot-check the important fields directly so the failure message is
    // readable when something goes wrong.
    const parsed = PublishStartV3ResponseSchema.parse(body);
    expect(parsed.projectId).toBe('proj-abc');
    expect(parsed.version).toBe(1); // existing meta.version was 0 → next is 1
    expect(parsed.publishedUrl).toBe('https://apps.sprout.test/proj-abc/');
    expect(parsed.staticUploadUrl).toMatch(/^https:\/\//);
    expect(parsed.serverUploadUrl).toMatch(/^https:\/\//);

    // Audit row should be recorded under share:<code>
    const auditCall = ddbStub.putItem.mock.calls.find(
      ([item]) => (item as { sk?: string }).sk === 'COLLAB#share:ABC123',
    );
    expect(auditCall).toBeDefined();
  });

  it('rejects unknown share codes with 404', async () => {
    ddbStub.getItem.mockResolvedValue(undefined);
    const res = await publishRoute.request('/share/NOPE9999/publish', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('rejects expired shares with 410', async () => {
    ddbStub.getItem.mockResolvedValue({
      code: 'EXPIRED1',
      projectId: 'proj-abc',
      ownerSub: 'auth0|owner',
      grants: 'edit',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const res = await publishRoute.request('/share/EXPIRED1/publish', { method: 'POST', body: '{}' });
    expect(res.status).toBe(410);
  });

  it('rejects view-only shares with 403', async () => {
    ddbStub.getItem.mockResolvedValue({
      code: 'VIEWONLY',
      projectId: 'proj-abc',
      ownerSub: 'auth0|owner',
      grants: 'view',
      createdAt: new Date().toISOString(),
    });
    const res = await publishRoute.request('/share/VIEWONLY/publish', { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
  });
});

describe('/projects/:id/publish — owner V3 contract', () => {
  beforeEach(() => {
    // Owner project owned by the MOCK_AUTH synthetic user
    ddbStub.getItem.mockImplementation(async (pk: string, sk: string) => {
      if (pk === 'USER#local|dev-user' && sk === 'PROJECT#proj-abc') {
        return {
          projectId: 'proj-abc',
          ownerSub: 'local|dev-user',
          name: 'Demo',
          slug: 'demo',
          harnessId: 'claude',
        };
      }
      if (pk === 'PROJECT#proj-abc' && sk === 'META') {
        return { version: 3 };
      }
      return undefined;
    });
  });

  it('owner gets presigned PUTs + next version', async () => {
    const res = await publishRoute.request('/projects/proj-abc/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const parsed = PublishStartV3ResponseSchema.parse(body);
    expect(parsed.projectId).toBe('proj-abc');
    expect(parsed.version).toBe(4); // existing meta.version was 3 → next is 4
    expect(parsed.publishedUrl).toBe('https://apps.sprout.test/proj-abc/');
  });

  it('auto-registers an unknown project on first publish (no separate create call)', async () => {
    // The desktop creates projects locally without round-tripping to the
    // cloud API. The first /publish call IS the registration: no existing
    // row for caller, no PROJECT#<id>/META → create a fresh project row,
    // continue with normal flow, return V3 presigned PUTs.
    ddbStub.getItem.mockResolvedValue(undefined);
    const res = await publishRoute.request('/projects/freshproject1/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectName: 'Demo' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const parsed = PublishStartV3ResponseSchema.parse(body);
    expect(parsed.projectId).toBe('freshproject1');
    expect(parsed.version).toBe(1); // no prior version → starts at 1

    // The project row should have been written under the caller's sub
    const createCall = ddbStub.putItem.mock.calls.find(
      ([item]) => (item as { sk?: string }).sk === 'PROJECT#freshproject1',
    );
    expect(createCall, 'first publish should write a USER#…/PROJECT#… row').toBeDefined();
    const created = createCall![0] as { ownerSub: string; name: string };
    expect(created.ownerSub).toBe('local|dev-user');
    expect(created.name).toBe('Demo');
  });

  it('rejects auto-register when the projectId is already claimed by someone else (403)', async () => {
    // PROJECT#someone-elses/META exists (so the id is taken) but
    // USER#local|dev-user/PROJECT#someone-elses does NOT → the caller isn't
    // the owner and can't claim a projectId that's already been published.
    ddbStub.getItem.mockImplementation(async (pk: string, sk: string) => {
      if (pk === 'USER#local|dev-user' && sk === 'PROJECT#someone-elses') return undefined;
      if (pk === 'PROJECT#someone-elses' && sk === 'META') return { version: 3 };
      return undefined;
    });
    const res = await publishRoute.request('/projects/someone-elses/publish', { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
  });
});

describe('/projects/:id/publish/complete — owner V3 contract', () => {
  beforeEach(() => {
    ddbStub.getItem.mockImplementation(async (pk: string, sk: string) => {
      if (pk === 'USER#local|dev-user' && sk === 'PROJECT#proj-abc') {
        return {
          projectId: 'proj-abc',
          ownerSub: 'local|dev-user',
          name: 'Demo',
          slug: 'demo',
          harnessId: 'claude',
        };
      }
      return undefined;
    });
  });

  it('promotes staged version and stamps lastPublishedBy with the caller sub', async () => {
    const res = await publishRoute.request('/projects/proj-abc/publish/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 4, hasServer: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; publishedUrl: string };
    expect(body.version).toBe(4);

    const metaUpdate = ddbStub.updateItem.mock.calls.find(
      ([opts]) => (opts as { sk?: string }).sk === 'META',
    );
    expect(metaUpdate).toBeDefined();
    const updates = (metaUpdate![0] as { updates: { version: number; lastPublishedBy: string } }).updates;
    expect(updates.version).toBe(4);
    // Owner endpoint: actorSub is claims.sub (NOT share:<code>)
    expect(updates.lastPublishedBy).toBe('local|dev-user');
  });
});

describe('/share/:code/publish/complete — V3 contract', () => {
  beforeEach(() => {
    ddbStub.getItem.mockImplementation(async (pk: string, sk: string) => {
      if (pk === 'SHARE#ABC123' && sk === 'META') {
        return {
          code: 'ABC123',
          projectId: 'proj-abc',
          ownerSub: 'auth0|owner',
          grants: 'edit',
          createdAt: new Date().toISOString(),
        };
      }
      return undefined;
    });
  });

  it('promotes the staged version and bumps meta', async () => {
    const res = await publishRoute.request('/share/ABC123/publish/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 7, hasServer: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; publishedUrl: string };
    expect(body.version).toBe(7);
    expect(body.publishedUrl).toBe('https://apps.sprout.test/proj-abc/');

    // META row updated with the share-code actor sub
    const metaUpdate = ddbStub.updateItem.mock.calls.find(
      ([opts]) => (opts as { sk?: string }).sk === 'META',
    );
    expect(metaUpdate).toBeDefined();
    const updates = (metaUpdate![0] as { updates: { version: number; lastPublishedBy: string } }).updates;
    expect(updates.version).toBe(7);
    expect(updates.lastPublishedBy).toBe('share:ABC123');
  });
});
