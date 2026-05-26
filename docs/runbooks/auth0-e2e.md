# RUNBOOK — Real-Auth0 e2e against a deployed Sprout stack

How to run the desktop app — and the scripted publish e2e — against a real Auth0 tenant + real deployed `SproutStack`. Use this when you're standing up your own Sprout infrastructure (corp install, fresh personal sandbox, etc.) and need to verify the whole publish path works before declaring the install done.

Two flavors covered:

1. **Interactive smoke test** — launch `pj app:dev` against the deployed AWS stack with real Auth0 PKCE login.
2. **Scripted e2e** — `scripts/e2e-share-preview-real.ts` mints a JWT via M2M client_credentials and walks the full publish flow without browser interaction.

Both share the same Auth0 + AWS infrastructure deployed under whatever `DEPLOY_ENV` you choose (`dev`, `corp`, etc.).

> **Naming convention used below**: placeholders look like `<your-tenant>.us.auth0.com`, `<AUTH0_NATIVE_CLIENT_ID>`, `<your-api-domain>`. Substitute the values from your own Auth0 tenant and CDK stack outputs.

---

## One-time setup

### Auth0 resources (you provision these)

In your Auth0 tenant, create:

- **Native app** — name it something like `Sprout (Development)`. Application type: Native. Allowed callback URL: `http://127.0.0.1/callback` (Auth0 special-cases loopback ports per RFC 8252, so the random-port runtime works regardless of which port the desktop binds). Note the client ID — refer to it below as `<AUTH0_NATIVE_CLIENT_ID>`.
- **API** — name it `Sprout API (Development)`. Identifier (audience): `https://api.<your-domain>` (or whatever maps to your CDK stack's API Gateway custom domain). The deployed stack's `HttpJwtAuthorizer` validates JWTs against this issuer + audience.
- **M2M app** — name it `Sprout E2E (Development)`. Application type: Machine-to-Machine. Note the client ID — refer to it below as `<AUTH0_M2M_CLIENT_ID>`. This is only required for Flavor 2 (the scripted e2e).

### Authorize the M2M client (one-time, for the scripted e2e only)

The M2M client needs a `client_grant` for your Sprout API. Two ways:

**Auth0 CLI** (after `auth0 login --scopes create:client_grants` once):

```bash
auth0 api post client-grants --data "{
  \"client_id\": \"<AUTH0_M2M_CLIENT_ID>\",
  \"audience\": \"https://api.<your-domain>\",
  \"scope\": []
}"
```

**Dashboard**:

1. Open `https://manage.auth0.com/dashboard/us/<your-tenant>/applications`
2. Find `Sprout E2E (Development)` → APIs tab
3. Toggle `Sprout API (Development)` → on
4. Save

### `.env` additions

Add the M2M secret to `.env` (already gitignored). Get it via:

```bash
auth0 apps show <AUTH0_M2M_CLIENT_ID> --reveal-secrets --json | jq -r .client_secret
```

Then add to `.env`:

```
AUTH0_DOMAIN=<your-tenant>.us.auth0.com
AUTH0_AUDIENCE=https://api.<your-domain>
AUTH0_NATIVE_CLIENT_ID=<AUTH0_NATIVE_CLIENT_ID>
SPROUT_E2E_CLIENT_ID=<AUTH0_M2M_CLIENT_ID>
SPROUT_E2E_CLIENT_SECRET=<paste from above>
```

The desktop reads `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, and `AUTH0_NATIVE_CLIENT_ID` directly. The scripted e2e additionally reads the `SPROUT_E2E_*` pair.

---

## Flavor 1: Interactive smoke test (desktop app)

```bash
SPROUT_USE_DEPLOYED=1 pj app:dev
```

`dev-electron.ts` recognizes the flag and:

- Skips spawning the local Hono server.
- Reads stack outputs from `sprout-<env>-outputs.json` for the API endpoint.
- Sets `CLOUD_API_URL` to that endpoint.
- Forces `MOCK_AUTH=0` so the real Auth0 PKCE flow runs.

When the app launches:

1. Onboarding wizard shows a "Sign in" button.
2. Click → system browser opens to Auth0's universal login.
3. Sign in (existing tenant user or sign up).
4. Auth0 redirects to `http://127.0.0.1:<random-port>/callback?code=…`.
5. Desktop captures the code, exchanges it for a JWT, persists the refresh token via Electron `safeStorage`.
6. Back to the app, you land on the project list.

Now create a project, scaffold something via chat, click **Share preview to sandbox**. The desktop sends an Authorization header on every cloud-API call; `HttpJwtAuthorizer` validates it; the publish flow lands real bundles in the staging bucket, promotes them, and bumps the version row in DDB.

---

## Flavor 2: Scripted e2e

```bash
bun scripts/e2e-share-preview-real.ts
```

The script:

1. Mints a JWT via `POST {AUTH0_DOMAIN}/oauth/token` (client_credentials).
2. Generates a Crockford-style 8-char projectId.
3. Calls `POST /projects/<id>/publish` → presigned PUTs.
4. Uploads a tiny static tarball + server zip.
5. Calls `POST /projects/<id>/publish/complete`.
6. GETs the published CloudFront URL.

Expected output (your distribution ID and API id will differ):

```
Stack: https://<api-id>.execute-api.<region>.amazonaws.com → https://<distribution-id>.cloudfront.net

[1] Minting Auth0 M2M token…
  ✓ token (len: 1234)

[2] Test projectId: 7Q3HRSPN

[3] POST /projects/<id>/publish
  ✓ version=1, publishedUrl=https://<distribution-id>.cloudfront.net/7Q3HRSPN/

[4] Build + upload bundles to staging S3
  ✓ static.tar.gz (… bytes)
  ✓ server.zip (… bytes)

[5] POST /projects/<id>/publish/complete
  ✓ version=1, url=https://<distribution-id>.cloudfront.net/7Q3HRSPN/

[6] GET CloudFront URL
  attempt 1: 200
  ✓ project is live

✓ E2E PASSED.
```

---

## Troubleshooting

- **`access_denied` on token mint** — M2M client grant not authorized for the API audience. See "Authorize the M2M client" above.
- **403 on `/projects/<id>/publish`** — the auto-register logic sees an existing `PROJECT#<id>/META` row owned by someone else. Use a fresh random projectId (the script does this automatically).
- **CloudFront returns 403** — edge router fell back to forwarding to the runtime Lambda but couldn't authenticate via OAC. Usually means the edge function's DDB grant or table-name baking regressed. See `tests/edge-router.test.ts` for the contract.
- **CloudFront returns 404** — project row exists but version is 0 (publish/complete failed silently). Check `aws s3 ls s3://sprout-staging-<env>/staging/<id>/v1/` and verify the bundles uploaded.
- **`SPROUT_USE_DEPLOYED=1` errors with "outputs missing"** — run `bunx cdk deploy Sprout-<env> --require-approval never --outputs-file sprout-<env>-outputs.json`.
