import type { Context } from 'hono';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

export interface UserClaims {
  sub: string;
  email?: string;
  scope?: string;
  raw: Record<string, unknown>;
}

export function readClaims(c: Context): UserClaims {
  // Local-dev escape hatch: when MOCK_AUTH=1 (set by scripts/local-server.ts)
  // we synthesize a fake claims object so the desktop app can run without a
  // real Auth0 tenant. This is gated server-side AND only ever runs from the
  // local Node server — the Lambda environment never sets MOCK_AUTH.
  if (process.env.MOCK_AUTH === '1') {
    return {
      sub: 'local|dev-user',
      email: 'dev@sprout.local',
      raw: { sub: 'local|dev-user' },
    };
  }

  const event = c.env.event as APIGatewayProxyEventV2WithJWTAuthorizer | undefined;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as
    | Record<string, unknown>
    | undefined;

  if (!claims || typeof claims.sub !== 'string') {
    throw new UnauthorizedError('missing or invalid JWT claims');
  }

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    scope: typeof claims.scope === 'string' ? claims.scope : undefined,
    raw: claims,
  };
}

export class UnauthorizedError extends Error {
  readonly status = 401;
}
