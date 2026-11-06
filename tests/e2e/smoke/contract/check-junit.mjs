#!/usr/bin/env node
// Reads Schemathesis's JUnit report and requires at least one executed test case per selected operation, no failure,
// no error and no skip. A tool that exits 0 after testing nothing fails here.
//   check-junit.mjs <schemathesis-report-dir> <selection.json>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, selFile] = process.argv.slice(2);
const selected = JSON.parse(readFileSync(selFile, 'utf8')).selectedOperations ?? [];
const xmlFile = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.xml')) : undefined;
if (!xmlFile) {
  console.error(
    `::error::no JUnit report in ${dir}: Schemathesis did not report (an empty run fails)`,
  );
  process.exit(1);
}
const xml = readFileSync(join(dir, xmlFile), 'utf8');
const tests = (xml.match(/<testcase\b/g) ?? []).length;
const failed = (xml.match(/<(failure|error)\b/g) ?? []).length;
const skipped = (xml.match(/<skipped\b/g) ?? []).length;
console.log(
  `schemathesis junit: ${tests} test case(s) for ${selected.length} selected operation(s), ${failed} failure/error, ${skipped} skipped`,
);
const problems = [];
if (selected.length === 0) problems.push('no operation was selected');
if (tests < selected.length)
  problems.push(
    `${tests} test case(s) < ${selected.length} selected operation(s) (an operation was not tested)`,
  );
if (failed > 0) problems.push(`${failed} failing case(s)`);
if (skipped > 0) problems.push(`${skipped} skipped case(s)`);
for (const p of problems) console.error(`::error::${p}`);
process.exit(problems.length === 0 ? 0 : 1);
