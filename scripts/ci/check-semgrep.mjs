// Fails on: scan errors, zero files scanned, any ERROR finding, any finding under a sensitive path.
// Usage: node check-semgrep.mjs <semgrep.json> <sensitive-paths.txt>
import { readFileSync } from 'node:fs';

const [reportPath, sensitivePath] = process.argv.slice(2);
if (!reportPath || !sensitivePath) {
  console.error('usage: check-semgrep.mjs <semgrep.json> <sensitive-paths.txt>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(`::error::unreadable semgrep report ${reportPath}: ${e.message}`);
  process.exit(1);
}

const sensitive = readFileSync(sensitivePath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const problems = [];
const scanned = report.paths?.scanned ?? [];
if (scanned.length === 0) problems.push('semgrep scanned zero files (an empty scan fails)');
for (const err of report.errors ?? [])
  problems.push(`semgrep error: ${err.type ?? ''} ${err.message ?? JSON.stringify(err)}`);

for (const r of report.results ?? []) {
  const where = `${r.path}:${r.start?.line}`;
  const sev = r.extra?.severity;
  const inSensitive = sensitive.some((p) => r.path.includes(p));
  if (sev === 'ERROR') problems.push(`${r.check_id} (${sev}) at ${where}`);
  else if (inSensitive) problems.push(`${r.check_id} (${sev}) at ${where} in a sensitive path`);
  else console.log(`non-blocking: ${r.check_id} (${sev}) at ${where}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(
  `semgrep: ${scanned.length} files scanned, ${(report.results ?? []).length} finding(s), none blocking`,
);
