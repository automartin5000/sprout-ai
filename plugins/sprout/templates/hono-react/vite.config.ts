import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Sprout sets `NEXT_PUBLIC_BASE_PATH=/<projectId>` at publish time. The Vite
 * build uses it as `base` so the emitted HTML references assets via
 * `/<projectId>/assets/index-<hash>.js` etc. — which is what the deployed
 * SPA shell ends up serving when a browser hits the project's CloudFront
 * URL. Sprout's edge router rewrites `/<projectId>/assets/<rest>` to the
 * versioned S3 key `/<projectId>/v<version>/assets/<rest>` so each publish
 * is independently cacheable at the edge.
 *
 * In `vite dev` mode (local preview), the env var is unset → base is '/'.
 */
const projectId = process.env.NEXT_PUBLIC_BASE_PATH ?? process.env.VITE_BASE_PATH ?? '';

export default defineConfig({
  root: 'client',
  base: projectId ? `${projectId}/` : '/',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      // Use 127.0.0.1 explicitly. `localhost` resolves to both ::1 and
      // 127.0.0.1; Node's "happy eyeballs" tries IPv6 first, but
      // @hono/node-server's `serve({ port })` binds IPv4 only by default.
      // The IPv6 attempt either fails fast (clear) or hangs (vite swallows
      // the upstream timeout and returns an empty body to the browser —
      // exactly what looks like "high scores aren't saving").
      '/api': 'http://127.0.0.1:5175',
    },
  },
});
