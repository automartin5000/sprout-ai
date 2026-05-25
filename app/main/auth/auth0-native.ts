import { shell } from 'electron';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { TokenStore, type StoredTokens } from './token-store.js';

export interface Auth0NativeOpts {
  domain: string;
  clientId: string;
  audience: string;
  scopes?: string[];
  tokenStore?: TokenStore;
}

export interface UserProfile {
  sub: string;
  email?: string;
  name?: string;
}

/**
 * Authorization Code Flow with PKCE for native Mac apps.
 *
 *   1. Spawn a one-shot loopback HTTP server on a random localhost port.
 *   2. Open the user's system browser to /authorize with code_challenge.
 *   3. Auth0 redirects back to http://127.0.0.1:<port>/callback?code=...
 *   4. Exchange the code at /oauth/token.
 *   5. Persist the refresh token via safeStorage.
 */
export class Auth0Native {
  private readonly store: TokenStore;
  private tokens?: StoredTokens;

  constructor(private readonly opts: Auth0NativeOpts) {
    this.store = opts.tokenStore ?? new TokenStore();
  }

  async restore(): Promise<UserProfile | undefined> {
    this.tokens = await this.store.load();
    if (!this.tokens) return undefined;
    if (this.tokens.expiresAt < Date.now()) {
      if (!this.tokens.refreshToken) return undefined;
      this.tokens = await this.refresh(this.tokens.refreshToken);
      await this.store.save(this.tokens);
    }
    return this.parseProfile(this.tokens);
  }

  async login(): Promise<UserProfile> {
    const verifier = randomString(64);
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = randomString(16);

    const { code, redirectUri } = await this.captureAuthCode({ state, challenge });
    const tokens = await this.exchangeCode({ code, verifier, redirectUri });
    this.tokens = tokens;
    await this.store.save(tokens);
    return this.parseProfile(tokens);
  }

  async logout(): Promise<void> {
    this.tokens = undefined;
    await this.store.clear();
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new Error('not_authenticated');
    if (this.tokens.expiresAt < Date.now() + 30_000) {
      if (!this.tokens.refreshToken) throw new Error('access_token_expired_no_refresh');
      this.tokens = await this.refresh(this.tokens.refreshToken);
      await this.store.save(this.tokens);
    }
    return this.tokens.accessToken;
  }

  private captureAuthCode(args: {
    state: string;
    challenge: string;
  }): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let redirectUri = '';
      const server = http.createServer((req, res) => {
        if (!req.url) return;
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const returnedState = u.searchParams.get('state');
        const code = u.searchParams.get('code');
        if (returnedState !== args.state || !code) {
          res.writeHead(400).end('invalid state or missing code');
          server.close();
          reject(new Error('invalid auth response'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          '<!doctype html><html><body><h2>Signed in.</h2><p>You can close this window.</p></body></html>',
        );
        server.close();
        resolve({ code, redirectUri });
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address !== 'object') {
          reject(new Error('failed to bind loopback server'));
          return;
        }
        redirectUri = `http://127.0.0.1:${address.port}/callback`;
        const url = new URL(`https://${this.opts.domain}/authorize`);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', this.opts.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('audience', this.opts.audience);
        url.searchParams.set(
          'scope',
          (this.opts.scopes ?? ['openid', 'profile', 'email', 'offline_access']).join(' '),
        );
        url.searchParams.set('state', args.state);
        url.searchParams.set('code_challenge', args.challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        void shell.openExternal(url.toString());
      });

      server.on('error', reject);
      setTimeout(() => {
        server.close();
        reject(new Error('auth login timed out'));
      }, 5 * 60_000);
    });
  }

  private async exchangeCode(args: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<StoredTokens> {
    const res = await fetch(`https://${this.opts.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.opts.clientId,
        code: args.code,
        code_verifier: args.verifier,
        redirect_uri: args.redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
    }
    return tokensFromResponse(await res.json());
  }

  private async refresh(refreshToken: string): Promise<StoredTokens> {
    const res = await fetch(`https://${this.opts.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.opts.clientId,
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) {
      throw new Error(`token refresh failed (${res.status}): ${await res.text()}`);
    }
    const tokens = tokensFromResponse(await res.json());
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    return tokens;
  }

  private parseProfile(tokens: StoredTokens): UserProfile {
    if (!tokens.idToken) return { sub: 'unknown' };
    const payload = tokens.idToken.split('.')[1];
    if (!payload) return { sub: 'unknown' };
    try {
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        sub: string;
        email?: string;
        name?: string;
      };
      return { sub: json.sub, email: json.email, name: json.name };
    } catch {
      return { sub: 'unknown' };
    }
  }
}

function tokensFromResponse(body: unknown): StoredTokens {
  const b = body as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  return {
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    idToken: b.id_token,
    expiresAt: Date.now() + b.expires_in * 1000,
  };
}

function randomString(bytes: number): string {
  return base64url(crypto.randomBytes(bytes));
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
