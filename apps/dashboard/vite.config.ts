/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defaultServerConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Resolve @memebots/* to their TypeScript sources in dev and tests (no build step needed).
  resolve: { conditions: ['@memebots/source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['@memebots/source', ...defaultServerConditions] } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? 3001}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: { name: 'dashboard', environment: 'node' },
});
