import { Hono } from 'hono';
import { customAlphabet } from 'nanoid';
import { Readable } from 'node:stream';
import { extname } from 'node:path';
import { S3Client, PutObjectCommand, CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as tar from 'tar';
// Phase 3 publish flow: no CodeBuild, no per-project CDK. Publishes are two
// S3 uploads (static.tar.gz + server.zip) into the shared assets/code buckets.
// The runtime Lambda reads the current version from DDB on each invocation and
// lazy-loads the project's bundle from S3.
import {
  CreateProjectShareInputSchema,
  PublishCompleteInputSchema,
  type Job,
  type JoinByCodeResponse,
  type Project,
  type PublishCompleteResponse,
  type PublishStartV3Response,
  type Share,
} from '../../../shared/api-contract.js';
import { readClaims } from '../auth/claims.js';
import {
  collabSk,
  getItem,
  jobPk,
  projectMetaSk,
  projectPk,
  projectSk,
  putItem,
  sharePk,
  updateItem,
  userPk,
} from '../db/ddb.js';

interface ProjectItem extends Project {
  pk: string;
  sk: string;
}

interface JobItem extends Job {
  pk: string;
  sk: string;
}

interface ShareItem extends Share {
  pk: string;
  sk: string;
  ttl?: number;
}

interface ProjectMeta {
  version?: number;
  lastPublishedAt?: string;
  lastPublishedBy?: string;
}

const PRESIGN_PUT_EXPIRES_SECONDS = 60 * 15; // 15 min
const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateShareCode = customAlphabet(SHARE_CODE_ALPHABET, 8);

const s3 = new S3Client({});

function stagingBucket(): string {
  const bucket = process.env.STAGING_BUCKET;
  if (!bucket) {
    throw new Error('STAGING_BUCKET env var is not configured');
  }
  return bucket;
}

function codeBucket(): string {
  const bucket = process.env.CODE_BUCKET;
  if (!bucket) throw new Error('CODE_BUCKET env var is not configured');
  return bucket;
}

function assetsBucket(): string {
  const bucket = process.env.ASSETS_BUCKET;
  if (!bucket) throw new Error('ASSETS_BUCKET env var is not configured');
  return bucket;
}

/** The public URL where a project lives, e.g. https://apps.example.com/<id>/ */
function publishedUrl(projectId: string): string {
  const base = process.env.APPS_BASE_URL ?? 'https://apps.sprout.local';
  return `${base.replace(/\/$/, '')}/${projectId}/`;
}

async function loadProjectForOwner(
  ownerSub: string,
  projectId: string,
): Promise<ProjectItem | undefined> {
  return getItem<ProjectItem>(userPk(ownerSub), projectSk(projectId));
}

/**
 * Find the caller's project row, OR auto-register it on first contact.
 * Projects are created locally by the desktop's ProjectManager — there's no
 * separate "create" cloud round-trip. The first authenticated /publish OR
 * /share call IS the registration.
 *
 * Safety: if PROJECT#<id>/META exists with a different owner, refuse — the
 * projectId is claimed and we don't let a second user steal it.
 *
 * Returns either { project } on success or { error, status } to return as-is.
 */
async function loadOrAutoRegisterProject(opts: {
  callerSub: string;
  projectId: string;
  projectName?: string;
}): Promise<{ project: ProjectItem } | { error: string; status: 403 }> {
  const existing = await loadProjectForOwner(opts.callerSub, opts.projectId);
  if (existing) return { project: existing };

  const claimed = await loadProjectMeta(opts.projectId);
  if (claimed) {
    return { error: 'forbidden', status: 403 };
  }

  const name = opts.projectName?.trim() ? opts.projectName.trim() : opts.projectId;
  const newProject: ProjectItem = {
    pk: userPk(opts.callerSub),
    sk: projectSk(opts.projectId),
    projectId: opts.projectId,
    ownerSub: opts.callerSub,
    name,
    slug: opts.projectId,
    createdAt: new Date().toISOString(),
    harnessId: 'claude',
    pluginOverrides: [],
  };
  await putItem(newProject as unknown as Record<string, unknown>);
  return { project: newProject };
}

async function isCollaborator(projectId: string, sub: string): Promise<boolean> {
  const item = await getItem(projectPk(projectId), collabSk(sub));
  return !!item;
}

/** Read the project's runtime meta row — version > 0 means it's been published at least once. */
async function loadProjectMeta(projectId: string): Promise<ProjectMeta | undefined> {
  return getItem<ProjectMeta>(projectPk(projectId), projectMetaSk());
}

/**
 * Presign two PUTs into the staging bucket — one for the static tarball, one
 * for the server zip. Shared by the owner (`/projects/:id/publish`) and the
 * share-code (`/share/:code/publish`) entry points so both flows write to the
 * same key shape that `/publish/complete` later promotes into live.
 */
async function presignVersionedBundles(
  projectId: string,
  version: number,
): Promise<{ staticUploadUrl: string; serverUploadUrl: string }> {
  const staticKey = `staging/${projectId}/v${version}/static.tar.gz`;
  const serverKey = `staging/${projectId}/v${version}/server.zip`;
  const [staticUploadUrl, serverUploadUrl] = await Promise.all([
    getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: stagingBucket(), Key: staticKey, ContentType: 'application/gzip' }),
      { expiresIn: PRESIGN_PUT_EXPIRES_SECONDS },
    ),
    getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: stagingBucket(), Key: serverKey, ContentType: 'application/zip' }),
      { expiresIn: PRESIGN_PUT_EXPIRES_SECONDS },
    ),
  ]);
  return { staticUploadUrl, serverUploadUrl };
}

/**
 * Stream-extract a staging static.tar.gz into the assets bucket as one S3
 * object per archive entry. Keys land at `<projectId>/v<version>/<entryPath>`
 * — exactly what the edge router rewrites to. ContentType is inferred from
 * the entry's extension so CloudFront serves `.js` as `text/javascript`,
 * `.png` as `image/png`, etc. (browsers refuse to execute scripts with the
 * wrong type, so this matters for the SPA bootstrap).
 *
 * The tarballs we produce are small (Vite output is usually <1MB), so we
 * read everything into memory before uploading. If we ever publish 100MB+
 * static apps this should become streaming, but for the current scaffolds
 * the latency is unmeasurable.
 */
async function extractStaticTarballToAssets(
  projectId: string,
  version: number,
  stagingKey: string,
): Promise<void> {
  const tarRes = await s3.send(
    new GetObjectCommand({ Bucket: stagingBucket(), Key: stagingKey }),
  );
  const tarBuf = await streamToBuffer(tarRes.Body as Readable);

  const entries = await readAllTarEntries(tarBuf);
  await Promise.all(
    entries.map((e) =>
      s3.send(
        new PutObjectCommand({
          Bucket: assetsBucket(),
          Key: `${projectId}/v${version}/${e.path}`,
          Body: e.content,
          ContentType: mimeForExtension(extname(e.path)),
        }),
      ),
    ),
  );
}

async function streamToBuffer(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

interface TarEntry {
  path: string;
  content: Buffer;
}

async function readAllTarEntries(buf: Buffer): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  const parser = new tar.Parser();
  parser.on('entry', (entry: tar.ReadEntry) => {
    if (entry.type !== 'File') {
      entry.resume();
      return;
    }
    const chunks: Buffer[] = [];
    entry.on('data', (c: Buffer) => chunks.push(c));
    entry.on('end', () => {
      // tar entries can be prefixed with `./` from common producers; strip.
      const path = entry.path.replace(/^\.\//, '');
      if (path) out.push({ path, content: Buffer.concat(chunks) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    Readable.from(buf)
      .pipe(parser)
      .on('finish', () => resolve())
      .on('error', reject);
  });
  return out;
}

function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': case '.map': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/**
 * Promote a staged version into live: copy the bundles into the assets+code
 * buckets and bump `PROJECT#<id>.version` so the runtime Lambda evicts its
 * cache on next request. Shared by the owner-authed and share-code complete
 * endpoints.
 */
async function promoteStagedVersion(opts: {
  projectId: string;
  version: number;
  hasServer: boolean;
  actorSub: string;
}): Promise<void> {
  const { projectId, version, hasServer, actorSub } = opts;
  const stagingStaticKey = `staging/${projectId}/v${version}/static.tar.gz`;
  const stagingServerKey = `staging/${projectId}/v${version}/server.zip`;
  const liveServerKey = `${projectId}/v${version}/server.zip`;

  if (hasServer) {
    await s3.send(
      new CopyObjectCommand({
        Bucket: codeBucket(),
        CopySource: `${stagingBucket()}/${stagingServerKey}`,
        Key: liveServerKey,
      }),
    );
  }

  // Extract the static tarball from staging into INDIVIDUAL files in the
  // assets bucket at `<projectId>/v<version>/<file>`. CloudFront's S3
  // origin then serves each file directly with edge caching — no Lambda
  // invocation, no per-request cost, much faster.
  //
  // Previously this step just copied the .tar.gz as a single blob, which
  // meant the edge router had to send static-asset traffic to the runtime
  // Lambda (which extracted on cache miss + served everything itself).
  // Architecturally regrettable — we now do the extraction once at publish
  // time, eagerly, and let CloudFront + S3 serve the hot path.
  await extractStaticTarballToAssets(projectId, version, stagingStaticKey);

  await updateItem({
    pk: projectPk(projectId),
    sk: projectMetaSk(),
    updates: {
      version,
      lastPublishedAt: new Date().toISOString(),
      lastPublishedBy: actorSub,
    },
  });
}

export const publishRoute = new Hono();

// ---- POST /projects/:projectId/publish (owner-authed) ----

/**
 * Phase 3 publish: returns a target version + presigned PUTs for two bundles.
 * The desktop builds the app locally, uploads both, then calls /publish/complete.
 *
 * Replaces the Phase 2 single-tarball + jobId + polling shape. The Phase 2
 * route below this one is preserved as a 503 stub for clients still on the
 * old contract.
 */
publishRoute.post('/projects/:projectId/publish', async (c) => {
  const claims = readClaims(c);
  const projectId = c.req.param('projectId');

  // The desktop creates projects locally; the first /publish or /share call
  // is also the cloud registration. See loadOrAutoRegisterProject for the
  // 403-if-claimed-by-someone-else safety check.
  const body = await c.req.json().catch(() => ({}));
  const resolved = await loadOrAutoRegisterProject({
    callerSub: claims.sub,
    projectId,
    projectName: typeof body?.projectName === 'string' ? body.projectName : undefined,
  });
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
  const project = resolved.project;

  const isOwner = project.ownerSub === claims.sub;
  const isCollab = !isOwner && (await isCollaborator(projectId, claims.sub));
  if (!isOwner && !isCollab) return c.json({ error: 'forbidden' }, 403);

  // Compute the next version number — current + 1. The runtime Lambda still
  // serves the previous version until /publish/complete bumps the pointer.
  const meta = await loadProjectMeta(projectId);
  const nextVersion = (meta?.version ?? 0) + 1;

  // Two presigned PUTs into the STAGING bucket. /publish/complete promotes
  // them into the assets + code buckets so a partial upload can't corrupt
  // the live version.
  const { staticUploadUrl, serverUploadUrl } = await presignVersionedBundles(projectId, nextVersion);

  const response: PublishStartV3Response = {
    projectId,
    version: nextVersion,
    staticUploadUrl,
    serverUploadUrl,
    publishedUrl: publishedUrl(projectId),
  };
  return c.json(response, 201);
});

/**
 * Phase 3 publish completion: copies the uploaded bundles from staging into
 * the live assets + code buckets and bumps `PROJECT#<id>.version` in DDB
 * (which is what the runtime Lambda checks per request to decide whether
 * to evict its in-memory cache for this project).
 */
publishRoute.post('/projects/:projectId/publish/complete', async (c) => {
  const claims = readClaims(c);
  const projectId = c.req.param('projectId');
  const body = await c.req.json();
  const input = PublishCompleteInputSchema.parse(body);

  const project = await loadProjectForOwner(claims.sub, projectId);
  if (!project) return c.json({ error: 'not found' }, 404);

  const isOwner = project.ownerSub === claims.sub;
  const isCollab = !isOwner && (await isCollaborator(projectId, claims.sub));
  if (!isOwner && !isCollab) return c.json({ error: 'forbidden' }, 403);

  try {
    await promoteStagedVersion({
      projectId,
      version: input.version,
      hasServer: input.hasServer,
      actorSub: claims.sub,
    });
  } catch (err) {
    console.error('publish/complete failed', { projectId, version: input.version, err });
    return c.json({ error: 'publish_complete_failed', details: String(err) }, 502);
  }

  const response: PublishCompleteResponse = {
    version: input.version,
    publishedUrl: publishedUrl(projectId),
  };
  return c.json(response);
});

// ---- LEGACY (Phase 2) publish endpoint, kept as a 503 stub ----
//
// Old clients hit POST /projects/:id/publish-legacy expecting `{ jobId,
// uploadUrl }`. Phase 3 replaced this with the two-bundle flow above. The
// stub returns 503 with a helpful message until clients are off the old
// contract entirely.
publishRoute.post('/projects/:projectId/publish-legacy', async (c) => {
  void c;
  return c.json(
    { error: 'gone', details: 'The single-tarball publish flow was replaced in Sprout Phase 3. Update your client.' },
    503,
  );
});

// ---- POST /jobs/:jobId/start (owner or collaborator) ----

publishRoute.post('/jobs/:jobId/start', async (c) => {
  const claims = readClaims(c);
  const jobId = c.req.param('jobId');

  const job = await getItem<JobItem>(jobPk(jobId), 'META');
  if (!job) {
    return c.json({ error: 'not found' }, 404);
  }

  const isOwner = job.ownerSub === claims.sub;
  const isCollab = !isOwner && (await isCollaborator(job.projectId, claims.sub));
  if (!isOwner && !isCollab) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Phase-2 contract is gone. Anything still calling /jobs/:jobId/start is a
  // legacy client that needs to upgrade to the two-bundle V3 flow. Mark the
  // job as failed and return 410 Gone (more honest than 503).
  await updateItem({
    pk: jobPk(jobId),
    sk: 'META',
    updates: {
      status: 'failed',
      errorMessage: 'The single-tarball publish flow was replaced in Sprout Phase 3. Update your client.',
    },
  });
  return c.json({ error: 'gone', details: 'use POST /projects/:id/publish (V3 two-bundle flow)' }, 410);
});

// ---- GET /jobs/:jobId (owner or collaborator) ----

publishRoute.get('/jobs/:jobId', async (c) => {
  const claims = readClaims(c);
  const jobId = c.req.param('jobId');
  const job = await getItem<JobItem>(jobPk(jobId), 'META');
  if (!job) return c.json({ error: 'not found' }, 404);

  const isOwner = job.ownerSub === claims.sub;
  const isCollab = !isOwner && (await isCollaborator(job.projectId, claims.sub));
  if (!isOwner && !isCollab) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const { pk: _pk, sk: _sk, ...rest } = job;
  return c.json(rest);
});

// ---- POST /projects/:projectId/share (owner-authed) ----

publishRoute.post('/projects/:projectId/share', async (c) => {
  const claims = readClaims(c);
  const projectId = c.req.param('projectId');

  const body = await c.req.json().catch(() => ({}));
  // Auto-register on first contact: a user can share a project before
  // they've published. The share-code mints a SHARE# row pointing at the
  // project; the project row needs to exist so the receiver can later
  // resolve owner + name when they paste the code.
  const resolved = await loadOrAutoRegisterProject({
    callerSub: claims.sub,
    projectId,
    projectName: typeof body?.projectName === 'string' ? body.projectName : undefined,
  });
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
  const project = resolved.project;
  if (project.ownerSub !== claims.sub) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const input = CreateProjectShareInputSchema.parse(body ?? {});

  const code = generateShareCode();
  const now = new Date();
  const expiresAt = input.expiresAt;
  const ttl = expiresAt
    ? Math.floor(new Date(expiresAt).getTime() / 1000)
    : undefined;

  const share: Share = {
    code,
    token: code,
    projectId,
    ownerSub: claims.sub,
    grants: input.grants ?? 'edit',
    createdAt: now.toISOString(),
    expiresAt,
  };

  await putItem({
    pk: sharePk(code),
    sk: 'META',
    ...share,
    ttl,
  });

  return c.json({ code }, 201);
});

// ---- Unauthenticated share-token routes ----

/**
 * Look up a share token by code; reject if missing, expired, or grants is not
 * 'edit'. Used by the share-publish entry points to validate the caller can
 * actually mutate the project.
 *
 * Returns the share item on success, or a Response on failure (which the
 * caller returns verbatim).
 */
async function resolveEditableShare(
  code: string,
): Promise<ShareItem | { error: string; status: 404 | 410 | 403 }> {
  const share = await getItem<ShareItem>(sharePk(code), 'META');
  if (!share) return { error: 'not found', status: 404 };
  if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
    return { error: 'expired', status: 410 };
  }
  if (share.grants !== 'edit') return { error: 'forbidden', status: 403 };
  return share;
}

/**
 * Record an audit row for a share-token publish. We don't know the caller's
 * identity (no JWT) so we namespace the actor by the share code itself —
 * `share:<code>`. This is also what gets written to `PROJECT#<id>.lastPublishedBy`
 * by promoteStagedVersion, giving the owner a way to see "this version came
 * from share code XYZ".
 */
async function recordShareCollabAudit(projectId: string, code: string): Promise<void> {
  const actorSub = `share:${code}`;
  try {
    await putItem({
      pk: projectPk(projectId),
      sk: collabSk(actorSub),
      projectId,
      actorSub,
      via: 'share',
      shareCode: code,
      addedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('failed to record collaborator audit row for share', code, err);
  }
}

// GET /share/:code/open
publishRoute.get('/share/:code/open', async (c) => {
  const code = c.req.param('code');
  const share = await getItem<ShareItem>(sharePk(code), 'META');
  if (!share) return c.json({ error: 'not found' }, 404);
  if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
    return c.json({ error: 'expired' }, 410);
  }

  const project = await getItem<ProjectItem>(
    userPk(share.ownerSub),
    projectSk(share.projectId),
  );
  if (!project) return c.json({ error: 'project_not_found' }, 404);

  // Phase-3 published-state lives in PROJECT#<id>/META: version > 0 means
  // it's been promoted at least once. The publishedUrl is deterministic from
  // the projectId, so we synthesize it rather than read it from a row.
  const meta = await loadProjectMeta(share.projectId);
  const isPublished = (meta?.version ?? 0) > 0;

  const response: JoinByCodeResponse = {
    projectId: share.projectId,
    projectName: project.name,
    ownerSub: share.ownerSub,
    grants: share.grants,
    publishedUrl: isPublished ? publishedUrl(share.projectId) : undefined,
  };
  return c.json(response);
});

// POST /share/:code/publish — share-token holder publishes on behalf of the owner.
// Returns the same V3 contract as the owner endpoint so the desktop client can
// use a single code path (just swapping the URL based on whether opts.shareCode
// is set).
publishRoute.post('/share/:code/publish', async (c) => {
  const code = c.req.param('code');
  const share = await resolveEditableShare(code);
  if ('status' in share) return c.json({ error: share.error }, share.status);

  const meta = await loadProjectMeta(share.projectId);
  const nextVersion = (meta?.version ?? 0) + 1;

  const { staticUploadUrl, serverUploadUrl } = await presignVersionedBundles(
    share.projectId,
    nextVersion,
  );

  await recordShareCollabAudit(share.projectId, code);

  const response: PublishStartV3Response = {
    projectId: share.projectId,
    version: nextVersion,
    staticUploadUrl,
    serverUploadUrl,
    publishedUrl: publishedUrl(share.projectId),
  };
  return c.json(response, 201);
});

// POST /share/:code/publish/complete — share-token holder completes the publish.
// Mirrors /projects/:projectId/publish/complete but auth comes from the share
// code (no JWT). The actorSub on the audit row is `share:<code>`, same as the
// start endpoint's collab row.
publishRoute.post('/share/:code/publish/complete', async (c) => {
  const code = c.req.param('code');
  const share = await resolveEditableShare(code);
  if ('status' in share) return c.json({ error: share.error }, share.status);

  const body = await c.req.json();
  const input = PublishCompleteInputSchema.parse(body);

  try {
    await promoteStagedVersion({
      projectId: share.projectId,
      version: input.version,
      hasServer: input.hasServer,
      actorSub: `share:${code}`,
    });
  } catch (err) {
    console.error('share publish/complete failed', { code, projectId: share.projectId, version: input.version, err });
    return c.json({ error: 'publish_complete_failed', details: String(err) }, 502);
  }

  const response: PublishCompleteResponse = {
    version: input.version,
    publishedUrl: publishedUrl(share.projectId),
  };
  return c.json(response);
});
