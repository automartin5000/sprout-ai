/**
 * Sprout shared runtime Lambda.
 *
 * One Node 24 Lambda hosts ALL user projects. The Lambda@Edge router sets the
 * `X-Sprout-Project-Id` header (which clients can't spoof — see edge-router.ts)
 * and forwards the request here. We look up the project's current version in
 * DynamoDB, fetch its `server.zip` from the code bucket, unzip into /tmp, and
 * dispatch to the project's `handler` export. Hot path is ~1ms; first hit per
 * execution context is ~100-200ms.
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
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
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

export const handler = async (event: LambdaEvent): Promise<unknown> => {
  if (event?.warmup) {
    return { warmup: 'ok' };
  }

  const projectId =
    event.headers?.['x-sprout-project-id'] ??
    event.headers?.['X-Sprout-Project-Id'];
  if (!projectId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'missing X-Sprout-Project-Id',
    };
  }

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

  // Best-effort tenancy: set the per-project env vars before invoking. These
  // are visible to the project's handler via process.env. They are NOT isolated
  // across concurrent invocations in the same execution context — but Lambda
  // serializes invocations per container, so within a single request this is
  // safe.
  process.env.SPROUT_PROJECT_ID = projectId;
  process.env.SPROUT_DATA_TABLE = process.env.TABLE_NAME ?? '';
  process.env.SPROUT_ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

  try {
    return await fn(event);
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
    const zipPath = `${dir}/server.zip`;
    await fs.writeFile(zipPath, await streamToBuffer(res.Body as Readable));
    await runUnzip(zipPath, dir);
    await fs.unlink(zipPath).catch(() => {/* swallow */});
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

function runUnzip(zipPath: string, dir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('unzip', ['-qq', '-o', zipPath, '-d', dir]);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
    proc.on('error', reject);
  });
}

async function streamToBuffer(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}
