#!/usr/bin/env node
// Harness self-tests with a JUnit report: selftest.mjs [report-dir]  (default reports/qa-harness-selftest).
// Exit code is node's; the JUnit file and a manifest (node version, candidate commit, command) are the record.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertJunitGreen } from './junit.mjs';
import { runMeta } from './run-meta.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? 'reports/qa-harness-selftest');
mkdirSync(out, { recursive: true });
const command = `node --test --test-reporter=junit ${join('tests/e2e/harness', 'selftest.test.mjs')}`;
const res = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=junit', join(here, 'selftest.test.mjs')],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const xml = res.stdout ?? '';
writeFileSync(join(out, 'junit.xml'), xml);
writeFileSync(join(out, 'stderr.txt'), res.stderr ?? '');
let counts;
try {
  counts = assertJunitGreen(xml, { minTests: 19 });
} catch (e) {
  console.error(`::error::harness self-tests: ${e.message}`);
  process.exit(1);
}
const meta = runMeta({
  environment: process.env.QA_ENVIRONMENT ?? 'ENV-INT/ci',
  command,
  tools: {},
});
writeFileSync(
  join(out, 'run-manifest.json'),
  `${JSON.stringify({ ...meta, counts, exitStatus: res.status, junitSha256: createHash('sha256').update(xml).digest('hex') }, null, 2)}\n`,
);
console.log(`harness self-tests: ${counts.passed}/${counts.tests} passed`);
process.exit(res.status === 0 ? 0 : 1);
