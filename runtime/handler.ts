/**
 * Sprout shared runtime Lambda.
 *
 * One Node 24 Lambda hosts ALL user projects. CloudFront's `[*]/api/[*]` cache
 * behavior forwards `/<projectId>/api/<rest>` requests here. We parse the
 * projectId out of the path (first segment), look up the project's current
 * version in DynamoDB, fetch its `server.zip` from the code bucket, unzip
 * into /tmp, and dispatch to the project's `handler` export with the URL
 * stripped of the `/<projectId>` prefix (so the project's Hono app sees its
 * own routes as `/api/...`).
 *
 * Why parse from the URL and not from a Lambda@Edge-set header? Lambda@Edge
 * VIEWER_REQUEST functions break OAC SigV4 signing on POST/PUT requests to
 * Lambda Function URLs. CloudFront signs the body after the edge function
 * runs, but the Function URL recomputes a slightly different body hash on
 * receipt and returns 403 "signature does not match". Keeping the api path
 * un-rewritten by Lambda@Edge avoids the bug entirely.
 *
 * Hot path is ~1ms; first hit per execution context is ~100-200ms.
 *
 * Constraints:
 *  - No env var configuration of the project handler itself; we mutate
 *    process.env per-invocation as a best-effort tenancy hint. (Documented as
 *    a trade-off in the Phase 3 plan; will revisit with worker_threads if it
 *    bites in practice.)
 *  - /tmp is 10GB. Bounded number of cached projects per container; LRU is
 *    deferred until we actually blow the cap.
 *  - The handler must be CommonJS for the .zip we ship — Lambda's Node 24
 *    runtime supports both, but CJS keeps `require`-style project bundles
 *    simple. esbuild emits CJS via the build script.
 */
import * as fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

interface ProjectEntry {
  version: number;
  handler: (event: unknown) => Promise<unknown>;
}

const cache = new Map<string, ProjectEntry>();
const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

// Placeholder bundle is shipped inside the Lambda image at /var/task/placeholder
// (the build script copies runtime/placeholder/server.js alongside the bundle).
// We fall back to it whenever a project has no version yet or S3 returns 404.
const PLACEHOLDER_DIR = '/var/task/placeholder';

type LambdaEvent = {
  warmup?: boolean;
  headers?: Record<string, string | undefined>;
  rawPath?: string;
  requestContext?: { http?: { method?: string; path?: string } };
} & Record<string, unknown>;

// Accepts 8-char Crockford codes OR UUIDs with hyphens. Same shape as the
// edge-router's pattern (kept in sync intentionally — both layers validate).
const PROJECT_ID_PATTERN = /^([0-9A-HJKMNP-TV-Z]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const handler = async (event: LambdaEvent): Promise<unknown> => {
  if (event?.warmup) {
    return { warmup: 'ok' };
  }

  // Parse projectId out of the URL. CloudFront forwards `/<projectId>/api/...`
  // verbatim (no Lambda@Edge rewrite on the api behavior — see file header).
  // Some Lambda Function URL events also expose `rawPath`; fall back to
  // requestContext.http.path. Header form is kept as a last-resort fallback
  // for direct-invoke / test scenarios where the URL might not be in the
  // expected shape.
  const rawPath = event.rawPath ?? event.requestContext?.http?.path ?? '';
  const segments = rawPath.split('/').filter(Boolean);
  let projectId = segments[0];
  let appPath = '/' + segments.slice(1).join('/');
  if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) {
    // Allow direct-invoke flows (e.g., warmup pings, future internal RPC) to
    // pass the project id via header. Not used by the CloudFront-fronted path.
    const headerId = event.headers?.['x-sprout-project-id']
      ?? event.headers?.['X-Sprout-Project-Id'];
    if (headerId && PROJECT_ID_PATTERN.test(headerId)) {
      projectId = headerId;
      // Header-mode: trust the rawPath as-is (no prefix to strip).
      appPath = rawPath || '/';
    } else {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/plain' },
        body: 'missing or invalid projectId in URL',
      };
    }
  }

  // Best-effort tenancy: set the per-project env vars before doing anything
  // that touches the project's bundle. These are visible to the project's
  // handler via process.env. They are NOT isolated across concurrent
  // invocations in the same execution context — but Lambda serializes
  // invocations per container, so within a single request this is safe.
  // Setting these early (pre-dispatch) means any code paths that re-read
  // env vars during bundle init (e.g., aws-sdk client construction inside
  // a project's top-level scope) get the right values.
  //
  // The five SPROUT_* names below are the env-var compatibility contract
  // shared with the standalone-prod path. AI-generated user code reads these
  // names; the standalone scaffold (plugins/sprout-cicd-github/templates/
  // infra/lib/sprout-app-stack.ts) sets the same five with mode='prod' so
  // the same source code runs unchanged in both shapes.
  process.env.SPROUT_MODE = 'sandbox';
  process.env.SPROUT_PROJECT_ID = projectId;
  process.env.SPROUT_DATA_TABLE = process.env.TABLE_NAME ?? '';
  process.env.SPROUT_ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';
  process.env.SPROUT_UPLOADS_BUCKET = process.env.UPLOADS_BUCKET ?? '';

  let fn: ProjectEntry['handler'];
  try {
    fn = await getProjectHandler(projectId);
  } catch (err) {
    console.error(`[${projectId}] failed to load project handler`, err);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'text/plain' },
      body: 'project unavailable',
    };
  }

  // Rewrite the event so the project's Hono app sees its own URL space —
  // `/api/items`, not `/<projectId>/api/items`. Same shape transforms the
  // Lambda@Edge router used to do for non-api requests.
  const projectEvent: LambdaEvent = {
    ...event,
    rawPath: appPath,
    requestContext: {
      ...event.requestContext,
      http: {
        ...event.requestContext?.http,
        path: appPath,
      },
    },
  };

  try {
    return await fn(projectEvent);
  } catch (err) {
    console.error(`[${projectId}] project handler threw`, err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: 'project handler error',
    };
  }
};

async function getProjectHandler(projectId: string): Promise<ProjectEntry['handler']> {
  const version = await currentVersion(projectId);
  const cached = cache.get(projectId);
  if (cached && cached.version === version) {
    return cached.handler;
  }

  const dir = `/tmp/projects/${projectId}/v${version}`;
  await fs.mkdir(dir, { recursive: true });
  await loadVersionInto(projectId, version, dir);

  const modPath = `${dir}/server.js`;
  // Dynamic import resolves both CJS and ESM bundles. The starter scaffolds
  // CJS via `exports.handler = ...`; we tolerate either.
  const mod = await import(modPath);
  const projectHandler = (mod.handler ?? mod.default?.handler) as ProjectEntry['handler'] | undefined;
  if (typeof projectHandler !== 'function') {
    throw new Error(`project bundle at ${modPath} has no handler export`);
  }
  cache.set(projectId, { version, handler: projectHandler });
  return projectHandler;
}

async function currentVersion(projectId: string): Promise<number> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    // Misconfigured — fall back to v0 so we serve the placeholder rather than 5xx-ing.
    console.warn(`[${projectId}] TABLE_NAME not set; defaulting to v0`);
    return 0;
  }
  try {
    const res = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          pk: { S: `PROJECT#${projectId}` },
          sk: { S: 'META' },
        },
        ProjectionExpression: '#v',
        ExpressionAttributeNames: { '#v': 'version' },
      }),
    );
    const v = res.Item?.version?.N;
    return v ? Number(v) : 0;
  } catch (err) {
    console.warn(`[${projectId}] currentVersion DDB lookup failed; defaulting to v0`, err);
    return 0;
  }
}

async function loadVersionInto(projectId: string, version: number, dir: string): Promise<void> {
  const bucket = process.env.CODE_BUCKET;
  if (!bucket) {
    console.warn(`[${projectId}] CODE_BUCKET not set; serving placeholder`);
    await copyPlaceholderInto(dir);
    return;
  }

  const key = `${projectId}/v${version}/server.zip`;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    // Use a pure-JS unzip (adm-zip) — AWS Lambda's Node 24 base image does
    // NOT ship the `unzip` binary, so the previous `spawn('unzip', ...)`
    // failed with ENOENT and the runtime returned 502 "project unavailable"
    // even when the bundle was correctly uploaded. adm-zip is ~25KB, no
    // native deps, works in the bundled CJS runtime image.
    const buf = await streamToBuffer(res.Body as Readable);
    new AdmZip(buf).extractAllTo(dir, /* overwrite */ true);
  } catch (err) {
    if (isNotFound(err)) {
      console.log(`[${projectId}] no bundle at s3://${bucket}/${key}; serving placeholder`);
      await copyPlaceholderInto(dir);
      return;
    }
    throw err;
  }
}

async function copyPlaceholderInto(dir: string): Promise<void> {
  // Copy the bundled placeholder/server.js next to the project dir so the
  // import resolves it.
  await fs.copyFile(`${PLACEHOLDER_DIR}/server.js`, `${dir}/server.js`);
}

function isNotFound(err: unknown): boolean {
  if (err instanceof NoSuchKey) return true;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey') return true;
  if (e?.$metadata?.httpStatusCode === 404) return true;
  return false;
}

async function streamToBuffer(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}
