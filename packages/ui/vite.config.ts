import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Gallery build for the browser accessibility run and candidate screenshots. Not part of the shipped package.
export default defineConfig({
  root: fileURLToPath(new URL('./gallery', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist-gallery', import.meta.url)),
    emptyOutDir: true,
    target: 'es2023',
  },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
});
