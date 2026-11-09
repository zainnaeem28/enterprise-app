import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  reporter: [['list'], ['json', { outputFile: 'dist-reports/e2e-report.json' }]],
  use: { baseURL: 'http://127.0.0.1:4320' },
  webServer: [
    {
      command: 'node e2e/fake-api.mjs',
      url: 'http://127.0.0.1:4321/public/v1/services',
      reuseExistingServer: false,
    },
    {
      command: 'node dist/server/server.js',
      url: 'http://127.0.0.1:4320/healthz',
      reuseExistingServer: false,
      env: {
        PORT: '4320',
        SITE_ORIGIN: 'http://127.0.0.1:4320',
        PUBLIC_API_ORIGIN: 'http://127.0.0.1:4321',
        PATIENT_ORIGIN: 'http://127.0.0.1:4323',
        ANALYTICS_SRC: 'http://127.0.0.1:4322/analytics.js',
      },
    },
  ],
});
