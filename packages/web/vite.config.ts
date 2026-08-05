import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
