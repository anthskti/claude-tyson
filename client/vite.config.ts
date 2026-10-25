import { defineConfig } from 'vite';

// Proxy /api/* to the Bun dev server (bun dev/server.ts → localhost:8787).
// This allows the Vite client to call /api/strategist and /api/analysis without
// CORS issues or manual port management.
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
