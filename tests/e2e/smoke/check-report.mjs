#!/usr/bin/env node
// Empty-suite and skip guard for the Playwright jobs. Reads the JSON reporter output of one run.
//   check-report.mjs <report.json> <minimum tests>
// Fails when: the report is missing, fewer than <minimum> tests ran, any test failed, was flaky or was skipped.
import { existsSync, readFileSync } from 'node:fs';

const [file, minRaw] = process.argv.slice(2);
const min = Number(minRaw);
if (!file || !Number.isInteger(min) || min < 1) {
  console.error('usage: check-report.mjs <report.json> <minimum tests >= 1>');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`::error::${file} is missing: Playwright did not produce a report`);
  process.exit(1);
}
const { stats, errors } = JSON.parse(readFileSync(file, 'utf8'));
const ran = (stats?.expected ?? 0) + (stats?.unexpected ?? 0) + (stats?.flaky ?? 0);
console.log(
  `playwright: ${ran} ran, ${stats?.expected} passed, ${stats?.unexpected} failed, ${stats?.flaky} flaky, ${stats?.skipped} skipped, ${errors?.length ?? 0} error(s)`,
);
const problems = [];
if (ran < min)
  problems.push(`only ${ran} test(s) ran, ${min} required (an empty or shrunken suite fails)`);
if (stats?.unexpected > 0) problems.push(`${stats.unexpected} failed`);
if (stats?.flaky > 0) problems.push(`${stats.flaky} flaky`);
if (stats?.skipped > 0) problems.push(`${stats.skipped} skipped`);
if ((errors?.length ?? 0) > 0) problems.push(`${errors.length} runner error(s)`);
for (const p of problems) console.error(`::error::${p}`);
process.exit(problems.length === 0 ? 0 : 1);
