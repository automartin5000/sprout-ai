/**
 * Sprout Lambda@Edge viewer-request router.
 *
 * Constraints (CloudFront's, not ours):
 *  - No env vars. All config (table name, region, code/asset bucket prefixes)
 *    must be hard-coded or read from the request itself.
 *  - 1 MB compiled bundle limit. Keep dependencies tiny.
 *  - Node 22+ runtime is supported in CloudFront us-east-1 today, which means
 *    the AWS SDK v3 is available — we use it directly.
 *
 * Per-request flow:
 *  1. Strip any incoming `X-Sprout-*` headers (defense against spoofing).
 *  2. Parse the URL path; the first segment is the projectId.
 *  3. Validate projectId pattern (8-char Crockford). Bad ids -> 404.
 *  4. Lookup `PROJECT#<id>` META row in DDB (in-memory cache, 60s TTL).
 *  5. If the path matches a static-asset pattern OR contains `/_static/`:
 *     rewrite to the assets S3 origin path `<id>/<rest>`.
 *  6. Otherwise: set `X-Sprout-Project-Id: <id>`, strip the `/<id>` prefix
 *     from the URI, and forward to the runtime Lambda function URL origin
 *     (default origin — no rewrite needed beyond the URI).
 *
 * NOTE: The deployed bundle is patched at build/synth time with the right
 *   table name + asset key prefix for the env (since we can't read env vars).
 *   See scripts/build-runtime.ts and infra/lib/sprout-stack.ts.
 *
 *   The two markers below (`__SPROUT_TABLE_NAME__`, `__SPROUT_ENV_NAME__`)
 *   are replaced at deploy time. They have safe fallbacks so unit tests of the
 *   logic remain runnable.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const TABLE_NAME = process.env.SPROUT_EDGE_TABLE_NAME ?? '__SPROUT_TABLE_NAME__';
const ddb = new DynamoDBClient({ region: 'us-east-1' });

// Crockford base32 alphabet — 8 chars, no 0/O/1/I/L.
const PROJECT_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/i;

const STATIC_EXT = /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|wasm|json|txt|xml)$/i;

interface CacheEntry {
  exists: boolean;
  version: number;
  expiresAt: number;
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

// CloudFront viewer-request event/result types. Inlined to keep the bundle
// independent of `@types/aws-lambda` runtime overhead — the types are tiny.
interface CFHeader { key?: string; value: string }
interface CFHeaderBag { [name: string]: CFHeader[] }
interface CFRequest {
  uri: string;
  querystring?: string;
  method?: string;
  headers: CFHeaderBag;
  origin?: unknown;
}
interface CFEvent {
  Records: { cf: { request: CFRequest } }[];
}

export const handler = async (event: CFEvent): Promise<CFRequest | { status: string; statusDescription?: string; body?: string; headers?: CFHeaderBag }> => {
  const req = event.Records[0]!.cf.request;

  // 1. Strip spoofable headers BEFORE doing anything else.
  for (const name of Object.keys(req.headers)) {
    if (name.toLowerCase().startsWith('x-sprout-')) {
      delete req.headers[name];
    }
  }

  // 2. Parse URI: /<projectId>/<rest...>
  const uri = req.uri || '/';
  const segments = uri.split('/').filter(Boolean);
  if (segments.length === 0) {
    return notFound('missing project id');
  }
  const projectId = segments[0]!;
  const rest = '/' + segments.slice(1).join('/');

  // 3. Validate format.
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    return notFound('invalid project id');
  }

  // 4. Lookup project — cached.
  let entry = CACHE.get(projectId);
  if (!entry || entry.expiresAt < Date.now()) {
    entry = await lookupProject(projectId);
    CACHE.set(projectId, entry);
  }
  if (!entry.exists) {
    return notFound('project not found');
  }

  // 5. Static-asset rewrite? Treat `/_static/...` and any file extension as static.
  const isStatic = /\/_static\//.test(rest) || /\/_next\/static\//.test(rest) || STATIC_EXT.test(rest);
  if (isStatic) {
    // Rewrite URI to `<projectId>/<rest...>` (S3 origin treats the URI as the key).
    req.uri = `/${projectId}${rest}`;
    setHeader(req, 'x-sprout-route', 'static');
    return req;
  }

  // 6. Forward to runtime: strip `/<projectId>` prefix and set the trusted header.
  req.uri = rest === '' ? '/' : rest;
  setHeader(req, 'x-sprout-project-id', projectId);
  setHeader(req, 'x-sprout-route', 'runtime');
  return req;
};

async function lookupProject(projectId: string): Promise<CacheEntry> {
  try {
    const res = await ddb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `PROJECT#${projectId}` },
          sk: { S: 'META' },
        },
        ProjectionExpression: '#v',
        ExpressionAttributeNames: { '#v': 'version' },
      }),
    );
    if (!res.Item) {
      return { exists: false, version: 0, expiresAt: Date.now() + CACHE_TTL_MS };
    }
    const v = res.Item.version?.N ? Number(res.Item.version.N) : 0;
    return { exists: true, version: v, expiresAt: Date.now() + CACHE_TTL_MS };
  } catch (err) {
    // On lookup failure, fail open for 5s — return exists=true so we don't
    // brown out the entire fleet on a DDB blip. The runtime Lambda will serve
    // a placeholder if the project genuinely doesn't exist.
    console.error('edge-router DDB lookup failed', err);
    return { exists: true, version: 0, expiresAt: Date.now() + 5_000 };
  }
}

function setHeader(req: CFRequest, name: string, value: string): void {
  req.headers[name.toLowerCase()] = [{ key: name, value }];
}

function notFound(reason: string) {
  return {
    status: '404',
    statusDescription: 'Not Found',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
    body:
      `<!doctype html><html><head><title>Sprout</title></head>` +
      `<body style="font-family:system-ui;padding:40px;color:#444">` +
      `<h1>Not found</h1><p>${escapeHtml(reason)}</p></body></html>`,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;'
            : '&#39;',
  );
}
