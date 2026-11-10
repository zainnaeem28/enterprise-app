import { defineConfig } from 'vitest/config';

// Integration tests against a real PostgreSQL (CMS_TEST_DATABASE_URL, a throwaway CMS-role database). Not part of
// the default unit run. They exercise the real Payload local API and the real OAuth handlers with Google stubbed.
export default defineConfig({
  test: {
    include: ['src/**/*.dbtest.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
