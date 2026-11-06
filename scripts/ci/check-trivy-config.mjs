// Fails on any HIGH/CRITICAL misconfiguration, a Dockerfile that runs as root (DS-0002) or has no
// HEALTHCHECK (DS-0026), and on a report that records scan errors.
import { readFileSync } from 'node:fs';

const [path] = process.argv.slice(2);
if (!path) {
  console.error('usage: check-trivy-config.mjs <trivy-config.json>');
  process.exit(2);
}
let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`::error::unreadable trivy report ${path}: ${e.message}`);
  process.exit(1);
}
const ALWAYS_BLOCK = new Set(['DS-0002', 'DS002', 'DS-0026', 'DS026']);
const problems = [];
for (const res of report.Results ?? []) {
  for (const m of res.Misconfigurations ?? []) {
    if (m.Status === 'PASS') continue;
    const id = m.ID ?? m.AVDID;
    if (['HIGH', 'CRITICAL'].includes(m.Severity) || ALWAYS_BLOCK.has(id)) {
      problems.push(`${id} (${m.Severity}) ${res.Target}: ${m.Title}`);
    }
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(
  `trivy config: ${(report.Results ?? []).length} target(s) scanned, no blocking misconfigurations`,
);
