/**
 * Provision Auth0 applications used by sprout.
 *
 *   - Native (desktop app) — Authorization Code Flow with PKCE + loopback.
 *   - SPA    (future web dashboard) — placeholder, not used in v1.
 *
 * Reads tenant + audience config from environment variables only — no
 * hardcoded personal/tenant identifiers in this file.
 *
 * Usage:
 *   AUTH0_DOMAIN=... AUTH0_CLIENT_ID=... AUTH0_CLIENT_SECRET=... \
 *     DEPLOY_ENV=dev NONPROD_HOSTED_ZONE=example.com \
 *     bunx tsx scripts/manage-auth0-client.ts ensure-all-env-clients
 *
 * The M2M client (AUTH0_CLIENT_ID/SECRET) must have Auth0 Management API
 * scopes: read:clients, create:clients, update:clients, read:resource_servers,
 * create:resource_servers, update:resource_servers.
 */
import { buildAuth0Audience, resolveEnvironment, type EnvName } from '../shared/environments.js';

type ClientType = 'native' | 'spa';

interface ManagementToken {
  access_token: string;
  expires_in: number;
}

interface Auth0Client {
  client_id: string;
  client_secret?: string;
  name: string;
  app_type: 'native' | 'spa' | 'non_interactive';
  callbacks?: string[];
  allowed_logout_urls?: string[];
  grant_types?: string[];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command) {
    console.error('usage: manage-auth0-client.ts <command>');
    process.exit(1);
  }

  const ctx = buildContext();

  switch (command) {
    case 'ensure-all-env-clients':
      await ensureClient(ctx, 'native', 'dev');
      await ensureClient(ctx, 'native', 'prod');
      await ensureResourceServer(ctx, 'dev');
      await ensureResourceServer(ctx, 'prod');
      break;
    case 'ensure-client-for-build':
      await ensureClient(ctx, 'native', resolveEnvironment(process.env.DEPLOY_ENV ?? 'dev').name);
      break;
    default:
      console.error(`unknown command: ${command}`);
      process.exit(1);
  }
}

interface Context {
  domain: string;
  management: { clientId: string; clientSecret: string };
  hostedZones: { dev?: string; prod?: string };
}

function buildContext(): Context {
  const domain = required('AUTH0_DOMAIN');
  const clientId = required('AUTH0_CLIENT_ID');
  const clientSecret = required('AUTH0_CLIENT_SECRET');
  return {
    domain,
    management: { clientId, clientSecret },
    hostedZones: {
      dev: process.env.NONPROD_HOSTED_ZONE,
      prod: process.env.PROD_HOSTED_ZONE,
    },
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function getManagementToken(ctx: Context): Promise<string> {
  const res = await fetch(`https://${ctx.domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: ctx.management.clientId,
      client_secret: ctx.management.clientSecret,
      audience: `https://${ctx.domain}/api/v2/`,
    }),
  });
  if (!res.ok) throw new Error(`management token failed: ${await res.text()}`);
  const body = (await res.json()) as ManagementToken;
  return body.access_token;
}

async function ensureClient(ctx: Context, type: ClientType, envName: EnvName): Promise<Auth0Client> {
  const token = await getManagementToken(ctx);
  const clientName = `sprout-${type}-${envName}`;

  const all = (await api<Auth0Client[]>(ctx, token, 'GET', '/api/v2/clients')) ?? [];
  const existing = all.find((c) => c.name === clientName);
  const payload = {
    name: clientName,
    app_type: type === 'native' ? 'native' : 'spa',
    callbacks: type === 'native'
      ? ['http://127.0.0.1/callback']
      : envName === 'prod'
        ? [`https://app.sprout.${ctx.hostedZones.prod ?? ''}/callback`]
        : [`https://app.${envName}.sprout.${ctx.hostedZones.dev ?? ''}/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    allowed_logout_urls: [],
  } satisfies Partial<Auth0Client>;

  if (existing) {
    return (await api<Auth0Client>(
      ctx,
      token,
      'PATCH',
      `/api/v2/clients/${existing.client_id}`,
      payload,
    )) as Auth0Client;
  }
  return (await api<Auth0Client>(ctx, token, 'POST', '/api/v2/clients', payload)) as Auth0Client;
}

async function ensureResourceServer(ctx: Context, envName: EnvName): Promise<void> {
  const token = await getManagementToken(ctx);
  const hostedZone =
    envName === 'prod' ? ctx.hostedZones.prod : ctx.hostedZones.dev;
  if (!hostedZone) {
    console.warn(`skipping resource server for ${envName}: hosted zone not configured`);
    return;
  }
  const identifier = buildAuth0Audience(envName, hostedZone);
  const all = (await api<Array<{ identifier: string; id: string }>>(
    ctx,
    token,
    'GET',
    '/api/v2/resource-servers',
  )) ?? [];
  const existing = all.find((rs) => rs.identifier === identifier);
  const payload = {
    name: `sprout-api-${envName}`,
    identifier,
    signing_alg: 'RS256',
  };

  if (existing) {
    await api(ctx, token, 'PATCH', `/api/v2/resource-servers/${existing.id}`, payload);
  } else {
    await api(ctx, token, 'POST', '/api/v2/resource-servers', payload);
  }
}

async function api<T>(
  ctx: Context,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  const res = await fetch(`https://${ctx.domain}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined;
  return (await res.json()) as T;
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
