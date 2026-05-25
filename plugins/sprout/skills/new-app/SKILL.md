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
| `SPROUT_PROJECT_ID` | This project's id — **always prefix every key with it** | `pk: \`PROJECT#\${process.env.SPROUT_PROJECT_ID}#user-1\`` |
| `SPROUT_DATA_TABLE` | The shared DynamoDB table name | `new GetItemCommand({ TableName: process.env.SPROUT_DATA_TABLE, Key: { pk, sk } })` |
| `SPROUT_ASSETS_BUCKET` | The shared static assets bucket | only the runtime knows this; usually the frontend just uses relative paths |
| `SPROUT_UPLOADS_BUCKET` | Shared bucket for user uploads | issue presigned PUT URLs from the server |

**Critical**: every DynamoDB key MUST be prefixed with `PROJECT#${SPROUT_PROJECT_ID}#`. Sprout's tenancy is convention-based — if you forget the prefix, this project's data could collide with another's. The template's example code shows the pattern.

## On any error

Surface the problem in plain English ("Something broke while installing — let me try again"), retry up to twice, then ask the user only if blocked.
