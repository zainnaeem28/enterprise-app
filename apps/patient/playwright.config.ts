import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  reporter: [['list'], ['json', { outputFile: 'dist-reports/axe-report.json' }]],
  use: { baseURL: 'http://127.0.0.1:4174' },
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
  },
});
