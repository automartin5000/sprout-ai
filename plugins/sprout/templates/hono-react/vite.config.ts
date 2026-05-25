import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Sprout sets `NEXT_PUBLIC_BASE_PATH=/<projectId>` at publish time. The Vite
 * build uses it as `base` so all asset URLs (`/_static/foo.js`) end up
 * prefixed with the projectId — which matches how Sprout's edge router
 * routes `<host>/<projectId>/_static/*` to the assets bucket.
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
      '/api': 'http://localhost:5175',
    },
  },
});
