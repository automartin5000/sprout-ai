/**
 * __APP_NAME__ — server.
 *
 * Hono backend that runs both:
 *   - locally via `bun run dev:server` (Node http listener on :5175)
 *   - on Sprout's shared runtime Lambda via the `handler` export
 *
 * Sprout injects these env vars at runtime:
 *   SPROUT_PROJECT_ID    — this app's id; ALWAYS prefix DDB keys with it
 *   SPROUT_DATA_TABLE    — the shared DynamoDB table name
 *   SPROUT_ASSETS_BUCKET — shared static assets bucket
 *   SPROUT_UPLOADS_BUCKET — shared user-uploads bucket
 *
 * Tenancy is convention-based: prefix every DDB pk with
 * `PROJECT#${SPROUT_PROJECT_ID}#`. The runtime Lambda sets these env vars
 * per invocation based on the X-Sprout-Project-Id header (which only the
 * edge router can set — clients can't spoof it).
 */
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const app = new Hono();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Build a per-project DDB key. Always go through this helper — never write
 * a raw `pk: 'user-1'` etc.
 */
function key(suffix: string): string {
  const projectId = process.env.SPROUT_PROJECT_ID ?? 'dev-local';
  return `PROJECT#${projectId}#${suffix}`;
}

function tableName(): string {
  return process.env.SPROUT_DATA_TABLE ?? 'sprout-local';
}

// ── Health ─────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ ok: true, app: '__APP_NAME__' }));

// ── Example: greeting stored per-project in DDB ────────────────
//
// GET /api/greeting → returns the saved greeting, or a default
// PUT /api/greeting → updates it
//
// Demonstrates the SPROUT_PROJECT_ID-prefixed key pattern. Delete this and
// replace with your real routes.

app.get('/api/greeting', async (c) => {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: tableName(),
      Key: { pk: key('settings'), sk: 'greeting' },
    }));
    return c.json({ message: res.Item?.message ?? 'Hello from __APP_NAME__' });
  } catch (err) {
    console.error('greeting read failed', err);
    return c.json({ message: 'Hello from __APP_NAME__' });
  }
});

app.put('/api/greeting', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = String(body?.message ?? '').slice(0, 280);
  if (!message) return c.json({ error: 'message required' }, 400);
  await ddb.send(new PutCommand({
    TableName: tableName(),
    Item: { pk: key('settings'), sk: 'greeting', message, updatedAt: new Date().toISOString() },
  }));
  return c.json({ ok: true, message });
});

// ── Lambda export (Sprout runtime) ──────────────────────────────
export const handler = handle(app);

// ── Local dev server ───────────────────────────────────────────
// Wrap in an IIFE so the dynamic import isn't a top-level await — esbuild
// can't emit top-level await into CJS output, which we need for the Lambda
// bundle target. The IIFE preserves the lazy import (so the dep stays
// out of the Lambda bundle).
if (process.env.NODE_ENV !== 'production' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  void (async () => {
    const port = Number(process.env.PORT ?? 5175);
    const { serve } = await import('@hono/node-server');
    serve({ fetch: app.fetch, port }, (info) => {
      // IMPORTANT: this banner must NOT match Sprout desktop's URL_PATTERNS
      // (Local:, ready at, listening on). The preview pane should attach to
      // vite (port 5174 — the UI), not to this API server (port 5175 —
      // serves only /api routes, no HTML). vite's own "Local:" banner is
      // the one DevServer locks onto.
      // eslint-disable-next-line no-console
      console.log(`[api] up on http://localhost:${info.port}`);
    });
  })();
}
