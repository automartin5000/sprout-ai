# __APP_NAME__

A Sprout-hosted app. Hono backend + React (Vite) frontend.

You don't need to know any of this — talk to Sprout in chat. But for reference:

## Local development

```bash
bun install
bun run dev:server   # backend on :5175
bun run dev          # frontend on :5174 (proxies /api to :5175)
```

## How it talks to Sprout's storage

The server reads three environment variables at runtime (Sprout injects them):

- `SPROUT_PROJECT_ID` — this app's id; **prefix every DDB key** with it
- `SPROUT_DATA_TABLE` — the shared DynamoDB table name
- `SPROUT_UPLOADS_BUCKET` — for user uploads

See `server/index.ts` for the pattern.

## Publishing

Click **Publish to cloud** in Sprout. That's it.
