/* global module, process */
// Lighthouse CI for the BUILT brand site (NFR-7: LCP < 2.5 s on 4G; F-BS-05 SEO). Needs a Chrome and the built output:
//   pnpm --filter @ehr/site build && pnpm --filter @ehr/site lighthouse
// The server reads the directory from PUBLIC_API_ORIGIN; point it at the e2e contract mock (node e2e/fake-api.mjs) for a
// repeatable run. Budgets follow the root lighthouserc.cjs. Not yet run in CI: the job is a request to DevOps (outside FE-15 paths).
module.exports = {
  ci: {
    collect: {
      startServerCommand:
        'node e2e/fake-api.mjs & PORT=4330 SITE_ORIGIN=http://127.0.0.1:4330 PUBLIC_API_ORIGIN=http://127.0.0.1:4321 PATIENT_ORIGIN=http://127.0.0.1:4323 node dist/server/server.js',
      startServerReadyPattern: 'listening',
      startServerReadyTimeout: 60000,
      url: [
        'http://127.0.0.1:4330/',
        'http://127.0.0.1:4330/services',
        'http://127.0.0.1:4330/doctors',
        'http://127.0.0.1:4330/locations',
        'http://127.0.0.1:4330/contact',
      ],
      numberOfRuns: 3,
      settings: { chromeFlags: '--no-sandbox --headless=new' },
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9, aggregationMethod: 'median-run' }],
        'categories:accessibility': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        'categories:seo': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        'categories:best-practices': ['warn', { minScore: 0.9, aggregationMethod: 'median-run' }],
        'largest-contentful-paint': [
          'error',
          { maxNumericValue: 2500, aggregationMethod: 'median-run' },
        ],
        'total-blocking-time': ['error', { maxNumericValue: 300, aggregationMethod: 'median-run' }],
        'cumulative-layout-shift': [
          'error',
          { maxNumericValue: 0.1, aggregationMethod: 'median-run' },
        ],
        'resource-summary:script:size': [
          'error',
          { maxNumericValue: Number(process.env.BUDGET_SCRIPT_BYTES ?? 307200) },
        ],
        'resource-summary:total:size': [
          'error',
          { maxNumericValue: Number(process.env.BUDGET_TOTAL_BYTES ?? 409600) },
        ],
      },
    },
    upload: { target: 'filesystem', outputDir: process.env.LHCI_OUTPUT_DIR ?? 'reports/lhci' },
  },
};
