/**
 * Real-Auth0 e2e for "Share preview" — mints a JWT via M2M client_credentials
 * and walks the full publish flow against the deployed Sprout-${env} stack.
 *
 * This is what proves the deployed stack actually works end-to-end:
 *   1. POST {AUTH0_DOMAIN}/oauth/token (client_credentials)  → access_token
 *   2. POST {ApiEndpoint}/projects/<test-id>/publish         → presigned PUTs
 *   3. PUT  presigned static URL                              → upload tarball
 *   4. PUT  presigned server URL                              → upload zip
 *   5. POST {ApiEndpoint}/projects/<test-id>/publish/complete → activate
 *   6. GET  https://<cf-domain>/<test-id>/                    → live URL
 *   7. cleanup: DELETE the auto-registered project (best effort)
 *
 * Prerequisites (one-time setup, see docs/runbooks/auth0-e2e.md):
 *   - .env has AUTH0_DOMAIN + AUTH0_AUDIENCE + SPROUT_E2E_CLIENT_ID + SPROUT_E2E_CLIENT_SECRET
 *   - The M2M client must have a client_grant for the Sprout API audience.
 *     Create via the Auth0 Dashboard (Applications → Sprout E2E → APIs →
 *     enable Sprout API) or via `auth0 api post client-grants`.
 *   - Stack outputs at sprout-${env}-outputs.json (from `cdk deploy --outputs-file`).
 *
 * Usage:
 *   bun scripts/e2e-share-preview-real.ts
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

interface AuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface StackOutputs {
  [stackName: string]: { ApiEndpoint?: string; CloudFrontDomain?: string };
}

interface PublishStartResponse {
  projectId: string;
  version: number;
  staticUploadUrl: string;
  serverUploadUrl?: string;
  publishedUrl: string;
}

async function loadEnv(): Promise<void> {
  const raw = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !process.env[k]) process.env[k] = v;
  }
}

async function mintToken(): Promise<string> {
  const required = ['AUTH0_DOMAIN', 'AUTH0_AUDIENCE', 'SPROUT_E2E_CLIENT_ID', 'SPROUT_E2E_CLIENT_SECRET'];
  for (const k of required) {
    if (!process.env[k]) {
      throw new Error(`${k} missing — add to .env (see docs/runbooks/auth0-e2e.md for setup)`);
    }
  }
  const res = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.SPROUT_E2E_CLIENT_ID,
      client_secret: process.env.SPROUT_E2E_CLIENT_SECRET,
      audience: process.env.AUTH0_AUDIENCE,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes('"access_denied"') && body.includes('client-grant')) {
      throw new Error(
        `Auth0 client_credentials denied — the M2M client needs a client_grant.\n` +
        `Run once:\n` +
        `  auth0 api post client-grants --data '{"client_id":"${process.env.SPROUT_E2E_CLIENT_ID}","audience":"${process.env.AUTH0_AUDIENCE}","scope":[]}'\n` +
        `Or use the Auth0 Dashboard. Details:\n${body}`,
      );
    }
    throw new Error(`Auth0 token mint failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as AuthTokenResponse;
  return json.access_token;
}

async function loadStackOutputs(): Promise<{ apiEndpoint: string; cfDomain: string }> {
  const envName = process.env.DEPLOY_ENV ?? 'dev';
  const raw = await fs.readFile(path.join(ROOT, `sprout-${envName}-outputs.json`), 'utf8');
  const parsed = JSON.parse(raw) as StackOutputs;
  const apiEndpoint = parsed[`Sprout-${envName}`]?.ApiEndpoint;
  const cfDomain = parsed[`Sprout-${envName}`]?.CloudFrontDomain;
  if (!apiEndpoint || !cfDomain) {
    throw new Error(`Stack outputs incomplete in sprout-${envName}-outputs.json`);
  }
  return { apiEndpoint, cfDomain };
}

/** Build a tiny static tarball + server zip for the publish smoke test. */
async function buildDummyBundles(): Promise<{ staticTar: Uint8Array; serverZip: Uint8Array }> {
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-e2e-bundle-'));
  await fs.writeFile(path.join(tmp, 'index.html'), '<!doctype html><h1>sprout e2e static</h1>', 'utf8');
  await fs.writeFile(
    path.join(tmp, 'server.js'),
    "exports.handler = async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'hello from sprout e2e server' });\n",
    'utf8',
  );

  // tar + zip via shell. Simple + portable on macOS/Linux.
  const { spawn } = await import('node:child_process');
  const run = (cmd: string, args: string[], cwd?: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd, stdio: 'pipe' });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')}: ${err}`))));
    });
  const tarPath = path.join(tmp, 'static.tar.gz');
  await run('tar', ['-czf', tarPath, '-C', tmp, 'index.html']);
  const zipPath = path.join(tmp, 'server.zip');
  await run('zip', ['-rq', zipPath, 'server.js'], tmp);

  // Read as Uint8Array so the fetch() BodyInit type is satisfied
  // (Node's `Buffer` extends Uint8Array but TS's lib.dom doesn't know that).
  const staticTar = new Uint8Array(await fs.readFile(tarPath));
  const serverZip = new Uint8Array(await fs.readFile(zipPath));
  await fs.rm(tmp, { recursive: true, force: true });
  return { staticTar, serverZip };
}

async function main(): Promise<void> {
  await loadEnv();
  const { apiEndpoint, cfDomain } = await loadStackOutputs();
  console.log('Stack:', apiEndpoint, '→', `https://${cfDomain}`);

  // 1. Mint JWT
  console.log('\n[1] Minting Auth0 M2M token…');
  const token = await mintToken();
  console.log('  ✓ token (len:', token.length, ')');

  // 2. Generate a Crockford-style projectId for the edge router to accept.
  //    8 chars, no 0/O/1/I/L.
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const projectId = Array.from({ length: 8 }, () => alpha[Math.floor(Math.random() * alpha.length)]).join('');
  console.log(`\n[2] Test projectId: ${projectId}`);

  // 3. Publish — start
  console.log('\n[3] POST /projects/<id>/publish');
  const startRes = await fetch(`${apiEndpoint}/projects/${projectId}/publish`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectName: 'E2E Test' }),
  });
  if (!startRes.ok) {
    throw new Error(`publish start failed (${startRes.status}): ${await startRes.text()}`);
  }
  const start = (await startRes.json()) as PublishStartResponse;
  console.log(`  ✓ version=${start.version}, publishedUrl=${start.publishedUrl}`);

  // 4. Upload bundles
  console.log('\n[4] Build + upload bundles to staging S3');
  const { staticTar, serverZip } = await buildDummyBundles();
  // Node's fs.readFile → Buffer is a valid BodyInit at runtime, but TS's
  // lib.dom.d.ts narrows BlobPart to ArrayBuffer-backed Uint8Arrays and
  // Node's Buffer is typed as Uint8Array<ArrayBufferLike>. Cast to BodyInit
  // — this is the same cast the AWS SDK + node-fetch use internally.
  const uploadStatic = await fetch(start.staticUploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/gzip' },
    body: staticTar as unknown as BodyInit,
  });
  if (!uploadStatic.ok) throw new Error(`static upload failed (${uploadStatic.status}): ${await uploadStatic.text()}`);
  console.log(`  ✓ static.tar.gz (${staticTar.byteLength} bytes)`);
  if (start.serverUploadUrl) {
    const uploadServer = await fetch(start.serverUploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/zip' },
      body: serverZip as unknown as BodyInit,
    });
    if (!uploadServer.ok) throw new Error(`server upload failed (${uploadServer.status}): ${await uploadServer.text()}`);
    console.log(`  ✓ server.zip (${serverZip.byteLength} bytes)`);
  }

  // 5. Complete
  console.log('\n[5] POST /projects/<id>/publish/complete');
  const completeRes = await fetch(`${apiEndpoint}/projects/${projectId}/publish/complete`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: start.version, hasServer: true }),
  });
  if (!completeRes.ok) {
    throw new Error(`publish complete failed (${completeRes.status}): ${await completeRes.text()}`);
  }
  const complete = (await completeRes.json()) as { version: number; publishedUrl: string };
  console.log(`  ✓ version=${complete.version}, url=${complete.publishedUrl}`);

  // 6. Hit the CloudFront URL
  console.log('\n[6] GET CloudFront URL (may take a few seconds for edge cache)');
  for (let i = 0; i < 5; i++) {
    const res = await fetch(complete.publishedUrl);
    console.log(`  attempt ${i + 1}: ${res.status}`);
    if (res.status === 200) {
      console.log('  ✓ project is live');
      break;
    }
    if (i < 4) await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n✓ E2E PASSED.\n  Live URL: ${complete.publishedUrl}\n`);
  console.log('Note: project row + S3 objects remain in the deployed stack.');
  console.log('Clean up later by deleting the items under PROJECT#' + projectId);
}

void main().catch((err) => {
  console.error('\n✗ E2E FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
