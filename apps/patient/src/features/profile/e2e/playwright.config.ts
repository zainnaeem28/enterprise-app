import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Run from apps/patient: pnpm exec playwright test -c src/features/profile/e2e/playwright.config.ts
export default defineConfig({
  testDir: here('.'),
  testMatch: '*.spec.ts',
  outputDir: here('../evidence/test-results'),
  reporter: [['list'], ['json', { outputFile: here('../evidence/playwright-report.json') }]],
  // Reduced motion: the kit's hover transition otherwise leaves axe sampling a button half-way between two colours.
  use: { baseURL: 'http://127.0.0.1:4176', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: {
    command: `pnpm exec vite --config ${here('./vite.config.ts')} --host 127.0.0.1 --port 4176 --strictPort`,
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: false,
  },
});
