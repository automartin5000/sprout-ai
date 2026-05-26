/**
 * Base-path-aware fetch helpers.
 *
 * Sprout serves user apps at `/<projectId>/` (path-based multi-tenant
 * routing). That means an SPA at `/abc12345/` doing `fetch("/api/scores")`
 * sends an origin-absolute request to `/api/scores`, MISSING the `/abc12345`
 * prefix the runtime needs to route to this project's Hono handler.
 *
 * Vite injects `import.meta.env.BASE_URL` at build time — `/abc12345/` in
 * production, `/` in `vite dev`. Use that as the prefix for all API calls
 * and you get the right behavior in both modes automatically.
 *
 * Always use these helpers in app code. Don't call `fetch("/api/...")`
 * directly — it will work in `vite dev` but silently 404 in production.
 */

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * Build a URL for an API endpoint relative to the project's base path.
 *
 *   apiUrl('/api/scores')   → '/abc12345/api/scores'  (production)
 *   apiUrl('api/scores')    → '/abc12345/api/scores'
 *   apiUrl('/api/scores')   → '/api/scores'           (vite dev)
 */
export function apiUrl(path: string): string {
  return `${BASE}/${path.replace(/^\//, '')}`;
}

/**
 * Thin fetch wrapper. Use exactly like `fetch()` — same signature — but pass
 * an API path (e.g. `'/api/scores'`) instead of a full URL. The base path is
 * added for you.
 *
 *   const res = await api('/api/scores');
 *   const res = await api('/api/scores', { method: 'POST', body: '{...}' });
 */
export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
