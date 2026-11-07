import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Two builds (see package.json): the browser bundle (cookie-consent island, `dist/client`) and the Node server (`dist/server`).
// Asset names carry no hash so the server can name them in the page; they are served with a short cache lifetime.
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
  build: {
    sourcemap: false,
    target: 'es2023',
    cssCodeSplit: false,
    rollupOptions: {
      input: { site: 'src/client.tsx' },
      output: {
        entryFileNames: isSsrBuild ? '[name].js' : 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/site[extname]',
      },
    },
  },
  ssr: { noExternal: ['@ehr/ui'] },
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
