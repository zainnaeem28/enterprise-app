// QA-06 (HEAAA-145): TC-A11Y-01 and the automated parts of TC-A11Y-04/05/06 and TC-XB-01/03, on `ENV-INT/ci`.
// Three browser engines (Chromium, Firefox, WebKit builds of Playwright). Servers: built staff and patient apps through
// `vite preview`, and the built brand-site server with the contract-mock public directory (apps/site/e2e/fake-api.mjs).
// Browser API answers are contract mocks (see support.ts); the real API is not exercised here.
//
//   NODE_PATH=$PWD/apps/staff/node_modules pnpm --filter @ehr/staff exec playwright test \
//     -c ../../tests/e2e/a11y/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../..');
const reports = process.env.QA_REPORT_DIR ?? resolve(repoRoot, 'reports/qa-a11y');
const projectsFilter = process.env.QA_BROWSERS?.split(',');
const all = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
];

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  failOnFlakyTests: true,
  timeout: 60_000,
  outputDir: resolve(reports, 'test-results'),
  reporter: [
    ['list'],
    ['json', { outputFile: resolve(reports, 'report.json') }],
    ['junit', { outputFile: resolve(reports, 'junit.xml') }],
  ],
  use: { trace: 'retain-on-failure' },
  projects: projectsFilter ? all.filter((p) => projectsFilter.includes(p.name)) : all,
  webServer: [
    {
      command: `pnpm --filter @ehr/staff exec vite preview --host 127.0.0.1 --port 4173 --strictPort`,
      cwd: repoRoot,
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @ehr/patient exec vite preview --host 127.0.0.1 --port 4174 --strictPort`,
      cwd: repoRoot,
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/fake-api.mjs',
      cwd: resolve(repoRoot, 'apps/site'),
      url: 'http://127.0.0.1:4321/public/v1/services',
      reuseExistingServer: false,
    },
    {
      command: 'node dist/server/server.js',
      cwd: resolve(repoRoot, 'apps/site'),
      url: 'http://127.0.0.1:4320/healthz',
      reuseExistingServer: false,
      env: {
        PORT: '4320',
        SITE_ORIGIN: 'http://127.0.0.1:4320',
        PUBLIC_API_ORIGIN: 'http://127.0.0.1:4321',
        PATIENT_ORIGIN: 'http://127.0.0.1:4174',
        ANALYTICS_SRC: 'http://127.0.0.1:4322/analytics.js',
      },
    },
  ],
});
