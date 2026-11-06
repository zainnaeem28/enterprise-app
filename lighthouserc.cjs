/* global module, process */
// Lighthouse CI for the BUILT staff shell (F-09, DEVOPS-PLAN 5.1 "Bundle and LCP budget", NFR-7: LCP < 2.5 s on 4G).
// Lighthouse's default mobile profile simulates slow 4G and a 4x CPU slowdown. The script-size ceiling matches the
// initial shell ceiling of apps/staff/scripts/bundle-budget.mjs (gzip) as raw bytes with a margin; raise it only by a
// reviewed change. `assert` fails the run (exit 1) when a budget is exceeded or an audit is missing.
//   pnpm dlx @lhci/cli@0.16.0 autorun   (see the bundle-budget job)
module.exports = {
  ci: {
    collect: {
      startServerCommand:
        'pnpm --filter @ehr/staff exec vite preview --host 127.0.0.1 --port 4173 --strictPort' +
        (process.env.SMOKE_DIST_DIR ? ` --outDir ${process.env.SMOKE_DIST_DIR}` : ''),
      startServerReadyPattern: 'Local',
      startServerReadyTimeout: 60000,
      url: ['http://127.0.0.1:4173/'],
      numberOfRuns: 3,
      settings: {
        onlyCategories: ['performance'],
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      assertions: {
        'largest-contentful-paint': [
          'error',
          { maxNumericValue: 2500, aggregationMethod: 'median-run' },
        ],
        'resource-summary:script:size': [
          'error',
          { maxNumericValue: Number(process.env.BUDGET_SCRIPT_BYTES ?? 307200) },
        ],
        'resource-summary:total:size': [
          'error',
          { maxNumericValue: Number(process.env.BUDGET_TOTAL_BYTES ?? 409600) },
        ],
        'total-blocking-time': ['error', { maxNumericValue: 300, aggregationMethod: 'median-run' }],
        'cumulative-layout-shift': [
          'error',
          { maxNumericValue: 0.1, aggregationMethod: 'median-run' },
        ],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: process.env.LHCI_OUTPUT_DIR ?? 'reports/bundle-budget/lhci',
    },
  },
};
