// Playwright configuration for the PR smoke subset (F-09, DEVOPS-PLAN 5.1 "Accessibility smoke" and "Browser
// end-to-end smoke"). Runs against the BUILT staff shell (`vite preview` of apps/staff/dist) with /api forwarded to the
// API at API_ORIGIN, so the browser sees one origin. Two projects, one per CI job: `a11y` and `e2e`.
//
//   pnpm --filter @ehr/staff build
//   NODE_PATH=apps/staff/node_modules pnpm --filter @ehr/staff exec playwright test \
//     -c ../../tests/e2e/smoke/playwright.config.ts --project=e2e
//
// SMOKE_DIST_DIR (seeded-violation proof only) serves a different build output directory.
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const port = 4173;
const repoRoot = resolve(__dirname, '../../..');
const dist = process.env.SMOKE_DIST_DIR ?? resolve(repoRoot, 'apps/staff/dist');
const reports = process.env.SMOKE_REPORT_DIR ?? resolve(repoRoot, 'reports/smoke');

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  failOnFlakyTests: true,
  timeout: 30_000,
  outputDir: resolve(reports, 'test-results'),
  reporter: [
    ['list'],
    [
      'json',
      { outputFile: resolve(reports, `${process.env.SMOKE_PROJECT ?? 'smoke'}-report.json`) },
    ],
    [
      'junit',
      { outputFile: resolve(reports, `${process.env.SMOKE_PROJECT ?? 'smoke'}-junit.xml`) },
    ],
  ],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  projects: [
    { name: 'a11y', testMatch: /a11y\.spec\.ts/ },
    { name: 'e2e', testMatch: /e2e\.spec\.ts/ },
  ],
  webServer: {
    command: `pnpm --filter @ehr/staff exec vite preview --host 127.0.0.1 --port ${port} --strictPort --outDir ${dist}`,
    cwd: repoRoot,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { API_ORIGIN: process.env.API_ORIGIN ?? 'http://127.0.0.1:3000' },
  },
});
