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
 *  3. Validate projectId pattern (8-char Crockford or UUID). Bad ids -> 404.
 *  4. Lookup `PROJECT#<id>` META row in DDB (in-memory cache, 60s TTL).
 *  5. Branch by path:
 *     a. `/<id>/api/...` — leave URI alone (runtime Lambda parses the prefix
 *        and strips it). Compute SHA256 of the request body and inject
 *        `x-amz-content-sha256` so CloudFront's OAC signing matches what the
 *        Lambda Function URL verifies on receipt. Required for POST/PUT/PATCH
 *        — see the file note below.
 *     b. Path with a file extension → rewrite to `/<id>/v<version>/<rest>`,
 *        CloudFront's default behavior fetches from the assets S3 bucket.
 *     c. Anything else (SPA route) → rewrite to `/<id>/v<version>/index.html`.
 *
 *  Why we compute the body hash here:
 *  Per https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/
 *  private-content-restricting-access-to-lambda.html:
 *    > "If you use PUT or POST methods with your Lambda function URL, your
 *    >  users must compute the SHA256 of the body and include the payload
 *    >  hash value of the request body in the x-amz-content-sha256 header
 *    >  when sending the request to CloudFront. Lambda doesn't support
 *    >  unsigned payloads."
 *  We don't want to require every user-app's `fetch()` call to add that
 *  header. Instead, we compute it here at the edge with `IncludeBody: true`
 *  on the api cache behavior. CloudFront then signs the request with that
 *  hash, and the Function URL's SigV4 verifier sees a matching body hash
 *  on receipt. Tradeoff: Lambda@Edge's 40KB body cap caps the max POST
 *  size for /api/* requests; acceptable for CRUD JSON traffic.
 *
 * NOTE: The deployed bundle is patched at build/synth time with the right
 *   table name for the env (since we can't read env vars). See
 *   scripts/build-runtime.ts. The marker below has a safe fallback so unit
 *   tests of the logic remain runnable.
 */
import * as crypto from 'node:crypto';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const TABLE_NAME = process.env.SPROUT_EDGE_TABLE_NAME ?? '__SPROUT_TABLE_NAME__';
const ddb = new DynamoDBClient({ region: 'us-east-1' });

// Cheap sanity-check on the first URL segment before hitting DDB. Accepts:
//   - 8-char Crockford base32 codes (no 0/O/1/I/L) — the URL-friendly shape
//     Phase 3 intended for new projects
//   - UUIDs with hyphens (legacy projects created via ProjectManager.uuid())
// DDB is the real validation; this just blocks obvious garbage cheaply
// without the round-trip cost.
const PROJECT_ID_PATTERN = /^([0-9A-HJKMNP-TV-Z]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Matches a final path segment with a file extension. We treat anything with
// a `.` in its last segment as a static asset that S3 should serve directly,
// and anything else as a SPA route that needs to fall through to index.html.
// This is intentionally permissive — Vite emits hashed names like
// `index-DG-uOHtI.js` and arbitrary asset paths under `/assets/`, so an
// extension-allowlist would constantly miss things.
const HAS_FILE_EXTENSION = /\/[^/]+\.[^/]+$/;

// SHA256 of the empty string. Use this when no request body is present so
// CloudFront's signature canonical-request still has the header (Lambda
// Function URL expects it on every POST/PUT request, even ones with no
// body).
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
interface CFBody {
  inputTruncated?: boolean;
  action?: 'read-only' | 'replace';
  encoding?: 'base64' | 'text';
  data?: string;
}
interface CFRequest {
  uri: string;
  querystring?: string;
  method?: string;
  headers: CFHeaderBag;
  body?: CFBody;
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
  let uri = req.uri || '/';

  // SPA-fetch compatibility shim: when an AI-generated app at /<id>/ does
  // `fetch("/api/scores")`, the browser sends that as an origin-absolute path
  // — i.e. without the projectId prefix. The request still matches the
  // `[*]/api/[*]` CloudFront behavior, so it ends up here, but it's missing
  // the prefix the runtime Lambda needs to dispatch. Recover by reading the
  // projectId from the `Referer` header (the page that issued the fetch).
  //
  // Security: the runtime dispatches by projectId either way — a malicious
  // caller spoofing a Referer to point at project B from an A request would
  // just be hitting B's API, which is identical to hitting B's API directly.
  // No cross-tenant data exposure: the project handler scopes DDB by its own
  // SPROUT_PROJECT_ID, which is set from the projectId we route to.
  if (uri.startsWith('/api/') || uri === '/api') {
    const ref = req.headers['referer']?.[0]?.value ?? '';
    const refProjectId = extractProjectIdFromUrl(ref);
    if (refProjectId) {
      uri = `/${refProjectId}${uri}`;
      req.uri = uri;
    }
    // If we couldn't recover a projectId, fall through — the validation
    // below will return 404 with a useful message.
  }

  const segments = uri.split('/').filter(Boolean);
  if (segments.length === 0) {
    return notFound('missing project id');
  }
  const projectId = segments[0]!;
  // `rest` is the path remainder INCLUDING the leading slash. For `/<id>` or
  // `/<id>/` we get `/`, which we treat as the SPA root → /index.html.
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

  // 5. Branch by path.
  if (rest === '/api' || rest.startsWith('/api/')) {
    // API path — leave URI as-is so the runtime Lambda's path parser sees
    // `/<projectId>/api/...` (it strips the prefix internally). Compute the
    // body hash so CloudFront's OAC SigV4 covers the payload and the
    // Function URL's verifier accepts the request. See file header for the
    // AWS doc citation that makes this mandatory.
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      setHeader(req, 'x-amz-content-sha256', hashBody(req.body));
    }
    setHeader(req, 'x-sprout-route', 'runtime');
    return req;
  }

  // Static-vs-SPA: anything with a file extension in its last segment goes
  // to S3 verbatim at the versioned key; anything else falls back to
  // index.html so the SPA shell loads and client-side routing takes over.
  const versionPrefix = `/${projectId}/v${entry.version}`;
  if (rest === '/' || !HAS_FILE_EXTENSION.test(rest)) {
    // SPA fallback. CloudFront → S3 bucket → /<id>/v<n>/index.html.
    req.uri = `${versionPrefix}/index.html`;
  } else {
    // Static asset. CloudFront → S3 bucket → /<id>/v<n>/<rest>.
    req.uri = `${versionPrefix}${rest}`;
  }
  setHeader(req, 'x-sprout-route', 'assets');
  return req;
};

/**
 * Pulls the projectId out of a URL like `https://host/<projectId>/path`.
 * Returns `null` if the URL doesn't parse, has no path, or the first
 * segment doesn't look like a project id. Used by the Referer-based shim
 * for SPA fetches that forgot the base path.
 */
function extractProjectIdFromUrl(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg && PROJECT_ID_PATTERN.test(seg) ? seg : null;
  } catch {
    return null;
  }
}

function hashBody(body: CFBody | undefined): string {
  if (!body || !body.data) {
    return EMPTY_SHA256;
  }
  // CloudFront Lambda@Edge presents the body either base64-encoded (for
  // binary bodies) or as plain text. Hash the raw bytes either way.
  const buf = body.encoding === 'base64'
    ? Buffer.from(body.data, 'base64')
    : Buffer.from(body.data, 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

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
    // brown out the entire fleet on a DDB blip. With no version though, fall
    // back to v0 so we at least try to serve the placeholder bundle.
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
