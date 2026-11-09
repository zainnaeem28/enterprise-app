// Playwright config for the F-07 journey: serves the built apps/staff/dist with /api proxied to API_ORIGIN.
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../../..');
const reports = process.env.JOURNEY_REPORT_DIR ?? resolve(repoRoot, 'reports/journey');
export default defineConfig({
  testDir: __dirname,
  testMatch: /journey\.spec\.ts/,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  outputDir: resolve(reports, 'test-results'),
  reporter: [['list'], ['json', { outputFile: resolve(reports, 'journey-report.json') }]],
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: `pnpm --filter @ehr/staff exec vite preview --host 127.0.0.1 --port 4173 --strictPort --outDir ${resolve(repoRoot, 'apps/staff/dist')}`,
    cwd: repoRoot,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    env: { API_ORIGIN: process.env.API_ORIGIN ?? 'http://127.0.0.1:3000' },
  },
});
