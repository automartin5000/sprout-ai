import type { Auth0Native } from '../auth/auth0-native.js';

export interface ApiClientOpts {
  /** Base URL of the sprout Hono API (no trailing slash). */
  baseUrl: string;
  /** Resolves a bearer token for authenticated calls. Returns undefined for guest/anon. */
  tokenProvider: () => Promise<string | undefined>;
}

/**
 * Thin fetch wrapper for the sprout cloud API. Adds the bearer token
 * (when available) and parses JSON. Used by the publish + share flows.
 *
 * Two modes:
 *   • Authed   — POST /projects/:id/publish, POST /projects/:id/share, etc.
 *                Token comes from Auth0Native (signed-in user) or MOCK_AUTH.
 *   • Anonymous — GET /share/:code/open, POST /share/:code/publish.
 *                 The share code itself is the credential; no JWT.
 */
export class ApiClient {
  constructor(private readonly opts: ApiClientOpts) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.opts.tokenProvider().catch(() => undefined);
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  async get<T>(path: string, opts: { anonymous?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!opts.anonymous) Object.assign(headers, await this.authHeaders());
    const res = await fetch(`${this.opts.baseUrl}${path}`, { headers });
    return parseResponse<T>(res);
  }

  async post<T>(path: string, body: unknown, opts: { anonymous?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (!opts.anonymous) Object.assign(headers, await this.authHeaders());
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return parseResponse<T>(res);
  }

  /** Upload a Buffer to a presigned PUT URL. Doesn't go through our API. */
  static async putBlob(url: string, body: Buffer, contentType = 'application/gzip'): Promise<void> {
    // Wrap in a Blob — Node's fetch (undici) accepts it directly and it
    // satisfies the DOM `BodyInit` type that TypeScript pulls in here.
    // Copy into a fresh ArrayBuffer so TS is happy about the (non-shared)
    // ArrayBufferLike → ArrayBuffer narrowing.
    const buf = new ArrayBuffer(body.byteLength);
    new Uint8Array(buf).set(body);
    const blob = new Blob([buf], { type: contentType });
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: blob,
    });
    if (!res.ok) {
      throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
    }
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

/** Build the auth0-backed token provider, falling back to undefined for guests. */
export function buildTokenProvider(auth0: Auth0Native | undefined, mockAuth: boolean): () => Promise<string | undefined> {
  if (mockAuth) return async () => 'mock-token';
  if (!auth0) return async () => undefined;
  return async () => {
    try { return await auth0.getAccessToken(); }
    catch { return undefined; }
  };
}
