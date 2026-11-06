import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./harness'),
  plugins: [react()],
  resolve: {
    alias: { '@ehr/contracts': here('../../../../../../packages/contracts/src/index.ts') },
  },
  server: { fs: { allow: [here('../../../../../../')] } },
});
