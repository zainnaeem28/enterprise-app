#!/usr/bin/env node
// Empty-suite guard for the database jobs. Reads JUnit XML (node:test --test-reporter=junit) from a directory and
// fails on: no report, a report with zero test cases, any failure/error, any skipped or todo test.
//   check-junit.mjs <dir> <suiteName>...     every named suite must have <dir>/<suiteName>.xml
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...names] = process.argv.slice(2);
if (!dir || names.length === 0) {
  console.error('usage: check-junit.mjs <dir> <suite>...');
  process.exit(2);
}
let bad = 0;
let total = 0;
for (const n of names) {
  const f = join(dir, `${n}.xml`);
  if (!existsSync(f)) {
    console.error(`::error::suite ${n}: report ${f} is missing (the suite did not run)`);
    bad++;
    continue;
  }
  const xml = readFileSync(f, 'utf8');
  const tests = (xml.match(/<testcase\b/g) ?? []).length;
  const failed = (xml.match(/<(failure|error)\b/g) ?? []).length;
  const skipped = (xml.match(/<skipped\b/g) ?? []).length;
  total += tests;
  console.log(`${n}: ${tests} test(s), ${failed} failure(s), ${skipped} skipped`);
  if (tests === 0) {
    console.error(`::error::suite ${n} ran zero tests (an empty suite fails)`);
    bad++;
  }
  if (failed > 0) {
    console.error(`::error::suite ${n} has ${failed} failing test(s)`);
    bad++;
  }
  if (skipped > 0) {
    console.error(`::error::suite ${n} skipped ${skipped} test(s) (a skipped test fails)`);
    bad++;
  }
}
console.log(`database suites: ${names.length} suite(s), ${total} test(s)`);
process.exit(bad === 0 ? 0 : 1);
