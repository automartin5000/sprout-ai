---
name: new-app
description: Use when the user wants to start a new app/website/project — phrases like "make me a website that…", "build me an app for…", "create a new project that…", "I want to build…". Scaffolds a fresh Hono + React (Vite) project from the bundled template, installs dependencies, and runs a build to confirm it works. The app is shaped for Sprout's hosted runtime — no AWS account needed.
---

# Sprout — New App

You are creating a new app for a non-technical user. **Sprout hosts everything** — the user does NOT need an AWS account, does NOT need to install AWS CLI or run any cloud-setup tools. Anything that would have asked them to "configure AWS" or "set up your shell" is wrong here. Do not invoke `vibe-aws:onboard` or any AWS-onboarding workflow.

## Operating contract

- **Never** ask the user technical questions.
- Pick everything yourself: framework details, file structure, dependencies, port numbers.
- The user already gave you a project directory — work inside the current `cwd`. If `cwd` is empty (just a `.git`), scaffold from the bundled template into it.
- Don't ask about AWS, accounts, regions, IAM, or hosting. Sprout owns all of that.

## What you're building

A **Hono backend** (TypeScript) that runs on Sprout's shared runtime Lambda, plus a **React frontend** (Vite) served as static assets. The build produces:

  - `dist/` — static frontend (uploaded to Sprout's assets bucket)
  - `server.zip` — Hono server (loaded by Sprout's runtime Lambda)

Both happen via the Publish button — you do not deploy by hand.

## Pre-flight

Confirm the bundled template exists:

```bash
test -d "${CLAUDE_PLUGIN_ROOT}/templates/hono-react" && echo "template ok"
```

If it's missing, surface a clear error and stop.

## Scaffold

Run the bundled bootstrap script from the project's `cwd`:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap-app.sh" "<slug>" "$PWD"
```

The script:
- Copies `${CLAUDE_PLUGIN_ROOT}/templates/hono-react/` into the cwd
- Replaces `__APP_NAME__` and `__APP_SLUG__` placeholders
- Runs `npm install`
- Runs `npm run build` to confirm the toolchain works

Always use `npm`. Don't try bun, pnpm, yarn, or bunx anywhere — the user may not have them and corepack-shimmed package managers fail on Node 22 with signature errors. Surface install/build failures in plain English.

## After scaffold

Summarize for the user in plain English, ≤4 lines:

> ✅ I've set up **<friendly name>** — a starter web app you can shape from here.
> Tell me what you want it to *do*, and I'll add it. When you're ready, click **Publish to cloud** to put it online.

If the user already described what they want the app to do in their first message, start implementing those features now (edit files, run tests, etc.). Don't ask for confirmation.

## How the app talks to Sprout's storage

When the user asks for features that need persistence (login, lists, data, uploads, etc.), use these Sprout-injected environment variables in the server code:

| Env var | What it is | Use it like |
|---|---|---|
| `SPROUT_MODE` | `'sandbox'` (Share preview) or `'prod'` (Promote to prod) | branch only when behavior MUST differ between modes |
| `SPROUT_PROJECT_ID` | This project's id — **always prefix every key with it** | `pk: \`PROJECT#\${process.env.SPROUT_PROJECT_ID}#user-1\`` |
| `SPROUT_DATA_TABLE` | The DynamoDB table name to read/write from | `new GetItemCommand({ TableName: process.env.SPROUT_DATA_TABLE, Key: { pk, sk } })` |
| `SPROUT_ASSETS_BUCKET` | Static assets bucket (Vite-built `client/dist/` lives here) | usually the runtime; frontend uses base-path-relative URLs |
| `SPROUT_UPLOADS_BUCKET` | Bucket for user-uploaded content (private; presign from server) | `new PutObjectCommand({ Bucket: process.env.SPROUT_UPLOADS_BUCKET, Key: ... })` then `getSignedUrl(...)` |

**Critical**: every DynamoDB key MUST be prefixed with `PROJECT#${SPROUT_PROJECT_ID}#`. The same prefix discipline applies in sandbox AND prod — the table differs, the key shape doesn't.

### Sandbox vs prod — same code, two shapes

The five `SPROUT_*` env vars above are set identically in both modes:

- **Sandbox** (Share preview): the shared multi-tenant runtime Lambda sets them per request; multiple projects share one DynamoDB table and S3 buckets, isolated by the `PROJECT#${SPROUT_PROJECT_ID}#` prefix convention.
- **Prod** (Promote to prod): the user's own CDK stack sets them once at Lambda config time; their app gets dedicated AWS resources but the env-var names + key shape stay identical.

Result: you write the **same code** for both. Don't `if (process.env.SPROUT_MODE === 'prod') { use different table }` — both modes already point you at the right table. Only branch on `SPROUT_MODE` when there's a genuine behavioral difference (e.g. enabling a "production-only" feature, disabling a sandbox-only dev tool, or showing a "running in sandbox" indicator to the user).

When you do need to branch, use an exhaustive check:

```ts
const mode = process.env.SPROUT_MODE; // 'sandbox' | 'prod'
if (mode === 'sandbox') {
  // sandbox-only path
} else if (mode === 'prod') {
  // prod-only path
} else {
  // unknown — log a warning, treat as sandbox for safety
}
```

## How the frontend calls the backend

The published SPA is mounted at `/<projectId>/` (Sprout uses path-based multi-tenant routing — there's no per-project subdomain). Origin-absolute fetches like `fetch("/api/scores")` miss the prefix and 404 in production, even though they work in `vite dev`.

**Always use the `api()` helper from `client/lib/api.ts`** — it reads Vite's `import.meta.env.BASE_URL` and prefixes the path for you:

```ts
import { api } from './lib/api.js';

// GET — like fetch('/api/scores') but base-path-aware
const res = await api('/api/scores');

// POST — same signature as fetch's second arg
await api('/api/scores', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, score }),
});
```

Do NOT call `fetch('/api/...')` directly in any client component. The lint pass will let it through, the local dev preview will work, and then features that hit the backend will silently fail once published.

## On any error

Surface the problem in plain English ("Something broke while installing — let me try again"), retry up to twice, then ask the user only if blocked.
