import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Run from apps/staff: pnpm exec playwright test -c src/app/e2e/playwright.config.ts
// Serves the real app entry (index.html -> main.tsx -> StaffApp) with a Vite dev server; the API is mocked per test.
export default defineConfig({
  testDir: here('.'),
  testMatch: '*.spec.ts',
  outputDir: here('../evidence/test-results'),
  reporter: [['list'], ['json', { outputFile: here('../evidence/playwright-report.json') }]],
  use: { baseURL: 'http://127.0.0.1:4178', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4178 --strictPort',
    cwd: here('../../..'),
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
  },
});
