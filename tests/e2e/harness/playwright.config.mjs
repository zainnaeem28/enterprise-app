// Playwright configuration for the QA suites (DEVOPS-PLAN 5.1, 5.3). Always records traces, writes JUnit XML into the
// report directory and refuses to start without an environment name, a candidate commit and an allowed target.
//   QA_ENVIRONMENT   e.g. ENV-INT/ci (required)          QA_BASE_URL  portal under test (required)
//   QA_REPORT_DIR    default reports/qa-e2e              QA_TEST_DIR  directory of the specs (required)
// Reports: <report>/junit.xml, <report>/traces/** (archive with finalize.mjs). Sign-in secrets come from QA_SECRET_*.
import { resolve } from 'node:path';
import { assertTargetAllowed, candidateCommit, requireEnvironment } from './run-meta.mjs';

const environment = requireEnvironment(process.env.QA_ENVIRONMENT);
const baseURL = process.env.QA_BASE_URL;
if (!baseURL) throw new Error('QA_BASE_URL is required');
assertTargetAllowed(environment, baseURL);
const commit = candidateCommit();
const testDir = process.env.QA_TEST_DIR;
if (!testDir) throw new Error('QA_TEST_DIR is required');
const report = resolve(process.env.QA_REPORT_DIR ?? 'reports/qa-e2e');

export default {
  testDir: resolve(testDir),
  outputDir: resolve(report, 'traces'),
  fullyParallel: false,
  workers: 1,
  retries: 0, // a flaky pass is not a pass (WORKFLOW Stage 4)
  forbidOnly: true,
  reporter: [
    ['list'],
    ['junit', { outputFile: resolve(report, 'junit.xml') }],
    ['json', { outputFile: resolve(report, 'report.json') }],
  ],
  metadata: { environment, candidateCommit: commit },
  use: { baseURL, trace: 'on', screenshot: 'off', video: 'off' },
};
