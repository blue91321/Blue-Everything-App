import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `@app/…` is this package's own `src`, for code that lives outside it.
 *
 * A shipped package's browser half sits in `packages/modules/<id>/web/`, which
 * is three directories away from `packages/web/src` — so every import of the
 * API client or `useAsync` would otherwise read `../../../web/src/api` and
 * silently break the day anything moved. The alias is the only thing those
 * folders need to know about where the app lives.
 *
 * Downloaded packages do not use it and cannot: they are not compiled with the
 * app, and get the same things handed to them through `register(host)` instead.
 */
const appSrc = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@app': appSrc } },
  plugins: [react()],
  build: {
    // Served by Fastify from packages/server, so the build lands where the
    // server expects it rather than being copied around.
    outDir: 'dist',
    emptyOutDir: true,
    // One user on a local network — readable stack traces beat a few saved KB.
    sourcemap: true,
  },
  server: {
    // `npm run dev` here proxies to the real server, so the PWA can be
    // developed with hot reload without a second copy of the API.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
    },
  },
});
