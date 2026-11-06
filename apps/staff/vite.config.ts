import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The release pipeline injects `CLIENT_RELEASE=r<n>.<sha12>` (DEVOPS-PLAN 6.2). The default marks a local build.
const clientRelease = process.env.CLIENT_RELEASE ?? 'r1.000000000000';
// Dev/preview only: forward /api to a local API so the browser still sees one origin (no CORS).
const apiOrigin = process.env.API_ORIGIN ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  define: { __CLIENT_RELEASE__: JSON.stringify(clientRelease) },
  resolve: {
    alias: {
      '@ehr/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: { proxy: { '/api': apiOrigin } },
  preview: { proxy: { '/api': apiOrigin } },
  build: { sourcemap: false, target: 'es2023' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
