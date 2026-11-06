import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Run from apps/patient: pnpm exec playwright test -c src/features/booking/e2e/playwright.config.ts
export default defineConfig({
  testDir: here('.'),
  testMatch: '*.spec.ts',
  outputDir: here('../evidence/test-results'),
  reporter: [['list'], ['json', { outputFile: here('../evidence/playwright-report.json') }]],
  // Reduced motion: the kit's hover transition (components.css, prefers-reduced-motion: no-preference) otherwise leaves
  // axe sampling a button half-way between two colours right after a click.
  use: { baseURL: 'http://127.0.0.1:4175', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: {
    command: `pnpm exec vite --config ${here('./vite.config.ts')} --host 127.0.0.1 --port 4175 --strictPort`,
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
  },
});
