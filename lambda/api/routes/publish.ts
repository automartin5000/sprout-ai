import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import { customAlphabet } from 'nanoid';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
// Phase 3 publish flow: no CodeBuild, no per-project CDK. Publishes are two
// S3 uploads (static.tar.gz + server.zip) into the shared assets/code buckets.
// The runtime Lambda reads the current version from DDB on each invocation and
// lazy-loads the project's bundle from S3.
import {
  PublishCompleteInputSchema,
  type PublishCompleteResponse,
  type PublishStartV3Response,
} from '../../../shared/api-contract.js';
import { projectMetaSk } from '../db/ddb.js';
import {
  CreateProjectShareInputSchema,
  type Job,
  type JoinByCodeResponse,
  type Project,
  type PublishStartResponse,
  type Share,
} from '../../../shared/api-contract.js';
import { readClaims } from '../auth/claims.js';
import {
  collabSk,
  getItem,
  jobPk,
  projectPk,
  projectSk,
  publishSk,
  publishSkPrefix,
  putItem,
  queryByPrefix,
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

interface PublishItem {
  pk: string;
  sk: string;
  envId: string;
  projectId: string;
  ownerSub: string;
  publishedUrl?: string;
  sourceKey?: string;
  status?: string;
  lastDeployedAt?: string;
}

const PRESIGN_PUT_EXPIRES_SECONDS = 60 * 15; // 15 min
const PRESIGN_GET_EXPIRES_SECONDS = 60 * 15; // 15 min
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

/** The public URL where a project lives, e.g. https://apps.sprout.dev/<id>/ */
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

async function presignSourcePut(jobId: string): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: stagingBucket(),
    Key: `${jobId}/source.tar.gz`,
    ContentType: 'application/gzip',
  });
  return getSignedUrl(s3, cmd, { expiresIn: PRESIGN_PUT_EXPIRES_SECONDS });
}

async function presignSourceGet(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: stagingBucket(), Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: PRESIGN_GET_EXPIRES_SECONDS });
}

async function createPublishJob(opts: {
  projectId: string;
  ownerSub: string;
}): Promise<{ job: Job; uploadUrl: string }> {
  const jobId = uuid();
  const createdAt = new Date().toISOString();
  const job: Job = {
    jobId,
    projectId: opts.projectId,
    ownerSub: opts.ownerSub,
    status: 'awaiting_source',
    createdAt,
  };

  await putItem({
    pk: jobPk(jobId),
    sk: 'META',
    ...job,
  });

  const uploadUrl = await presignSourcePut(jobId);
  return { job, uploadUrl };
}

async function isCollaborator(projectId: string, sub: string): Promise<boolean> {
  const item = await getItem(projectPk(projectId), collabSk(sub));
  return !!item;
}

async function loadLatestPublish(projectId: string): Promise<PublishItem | undefined> {
  const { items } = await queryByPrefix<PublishItem>({
    pk: projectPk(projectId),
    skPrefix: publishSkPrefix(),
    limit: 50,
    scanIndexForward: false, // newest first by sk
  });
  // Pick the most recent by lastDeployedAt when present, otherwise first.
  if (items.length === 0) return undefined;
  const sorted = [...items].sort((a, b) => {
    const ta = a.lastDeployedAt ?? '';
    const tb = b.lastDeployedAt ?? '';
    return tb.localeCompare(ta);
  });
  return sorted[0];
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

  const project = await loadProjectForOwner(claims.sub, projectId);
  if (!project) return c.json({ error: 'not found' }, 404);

  const isOwner = project.ownerSub === claims.sub;
  const isCollab = !isOwner && (await isCollaborator(projectId, claims.sub));
  if (!isOwner && !isCollab) return c.json({ error: 'forbidden' }, 403);

  // Compute the next version number — current + 1. The runtime Lambda still
  // serves the previous version until /publish/complete bumps the pointer.
  const meta = await getItem<{ version?: number }>(projectPk(projectId), projectMetaSk());
  const nextVersion = (meta?.version ?? 0) + 1;

  // Two presigned PUTs into the STAGING bucket. /publish/complete promotes
  // them into the assets + code buckets so a partial upload can't corrupt
  // the live version.
  const staticKey = `staging/${projectId}/v${nextVersion}/static.tar.gz`;
  const serverKey = `staging/${projectId}/v${nextVersion}/server.zip`;

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

  const stagingStaticKey = `staging/${projectId}/v${input.version}/static.tar.gz`;
  const stagingServerKey = `staging/${projectId}/v${input.version}/server.zip`;
  const liveServerKey = `${projectId}/v${input.version}/server.zip`;

  try {
    // Copy server.zip into the code bucket at the live key. The runtime Lambda
    // reads from CODE_BUCKET/<projectId>/v<n>/server.zip on cache miss.
    if (input.hasServer) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: codeBucket(),
          CopySource: `${stagingBucket()}/${stagingServerKey}`,
          Key: liveServerKey,
        }),
      );
    }

    // Static assets: we keep the tarball intact in the assets bucket under a
    // version-suffixed key. A future enhancement is to extract + put each
    // file individually (so CloudFront can serve them directly without the
    // runtime extracting at request time). Deferred.
    await s3.send(
      new CopyObjectCommand({
        Bucket: assetsBucket(),
        CopySource: `${stagingBucket()}/${stagingStaticKey}`,
        Key: `${projectId}/v${input.version}/static.tar.gz`,
      }),
    );

    // Bump the version pointer. The runtime Lambda compares its cached
    // version with this and evicts on mismatch.
    await updateItem({
      pk: projectPk(projectId),
      sk: projectMetaSk(),
      updates: {
        version: input.version,
        lastPublishedAt: new Date().toISOString(),
        lastPublishedBy: claims.sub,
      },
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

  const sourceKey = `${jobId}/source.tar.gz`;
  // Phase 3 rewrite: the runner stub is gone. Mark the job as failed with a
  // friendly message until Phase 3.4 wires the new flow (extract static into
  // assets bucket + bump project version in DDB).
  await updateItem({
    pk: jobPk(jobId),
    sk: 'META',
    updates: {
      status: 'failed',
      errorMessage: 'Publishing is being rewritten — try again after the Phase 3.4 rollout.',
    },
  });
  void sourceKey; // suppress unused-var warning; reused after the rewrite
  return c.json({ error: 'publish_temporarily_disabled' }, 503);

  await updateItem({
    pk: jobPk(jobId),
    sk: 'META',
    updates: { status: 'building' },
  });

  return c.json({ ok: true });
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

  const project = await loadProjectForOwner(claims.sub, projectId);
  if (!project) {
    return c.json({ error: 'not found' }, 404);
  }
  if (project.ownerSub !== claims.sub) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
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

  const latest = await loadLatestPublish(share.projectId);

  let sourceUrl: string | undefined;
  if (latest?.sourceKey) {
    try {
      sourceUrl = await presignSourceGet(latest.sourceKey);
    } catch (err) {
      console.error('failed to presign source for share', code, err);
    }
  }

  const response: JoinByCodeResponse = {
    projectId: share.projectId,
    projectName: project.name,
    ownerSub: share.ownerSub,
    grants: share.grants,
    publishedUrl: latest?.publishedUrl,
    sourceUrl,
  };
  return c.json(response);
});

// POST /share/:code/publish — share-token holder publishes on behalf of the owner.
publishRoute.post('/share/:code/publish', async (c) => {
  const code = c.req.param('code');
  const share = await getItem<ShareItem>(sharePk(code), 'META');
  if (!share) return c.json({ error: 'not found' }, 404);
  if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
    return c.json({ error: 'expired' }, 410);
  }
  if (share.grants !== 'edit') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const { job, uploadUrl } = await createPublishJob({
    projectId: share.projectId,
    ownerSub: share.ownerSub,
  });

  // Audit trail: record this share holder as a collaborator. We don't know the
  // caller's identity (no JWT) so namespace by the share code.
  const actorSub = `share:${code}`;
  try {
    await putItem({
      pk: projectPk(share.projectId),
      sk: collabSk(actorSub),
      projectId: share.projectId,
      actorSub,
      via: 'share',
      shareCode: code,
      addedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('failed to record collaborator audit row for share', code, err);
  }

  const response: PublishStartResponse = { jobId: job.jobId, uploadUrl };
  return c.json(response, 201);
});
