import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Run from apps/staff: pnpm exec playwright test -c src/features/doctor/e2e/playwright.config.ts
export default defineConfig({
  testDir: here('.'),
  testMatch: '*.spec.ts',
  outputDir: here('../evidence/test-results'),
  reporter: [['list'], ['json', { outputFile: here('../evidence/playwright-report.json') }]],
  use: { baseURL: 'http://127.0.0.1:4178', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: {
    command: `pnpm exec vite --config ${here('./vite.config.ts')} --host 127.0.0.1 --port 4178 --strictPort`,
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
  },
});
