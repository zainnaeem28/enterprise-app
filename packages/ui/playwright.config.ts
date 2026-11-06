import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  reporter: [['list'], ['json', { outputFile: 'dist-reports/axe-report.json' }]],
  use: { baseURL: 'http://127.0.0.1:4174' },
  webServer: {
    command: 'pnpm exec vite build && pnpm exec vite preview',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
