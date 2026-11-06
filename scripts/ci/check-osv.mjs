// Evaluates an OSV-Scanner JSON report. Blocks on HIGH/CRITICAL (CVSS >= 7.0) vulnerabilities that
// have a fixed version, and on any vulnerability whose severity cannot be determined (fail closed).
// MODERATE/LOW are listed but do not block (DEVOPS-PLAN 5.1: "critical/high with a fix available").
// "Known exploited" (CISA KEV) is not evaluated offline: stated limitation, not a pass.
import { readFileSync } from 'node:fs';

const [path] = process.argv.slice(2);
if (!path) {
  console.error('usage: check-osv.mjs <osv.json>');
  process.exit(2);
}
let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`::error::unreadable OSV report ${path}: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(report.results)) {
  console.error('::error::OSV report has no results array');
  process.exit(1);
}

const label = { CRITICAL: 9, HIGH: 7, MODERATE: 4, MEDIUM: 4, LOW: 1 };
const problems = [];
let packages = 0;
let vulns = 0;
for (const r of report.results) {
  for (const p of r.packages ?? []) {
    packages += 1;
    for (const v of p.vulnerabilities ?? []) {
      vulns += 1;
      const group = (p.groups ?? []).find((g) => g.ids?.includes(v.id));
      let score = Number.parseFloat(group?.max_severity);
      if (Number.isNaN(score))
        score = label[String(v.database_specific?.severity ?? '').toUpperCase()] ?? NaN;
      const fixed = (v.affected ?? []).some((a) =>
        (a.ranges ?? []).some((rg) => (rg.events ?? []).some((e) => e.fixed)),
      );
      const name = `${p.package.name}@${p.package.version} ${v.id} (${v.summary ?? 'no summary'})`;
      if (Number.isNaN(score)) problems.push(`${name}: severity unknown (fail closed)`);
      else if (score >= 7 && fixed)
        problems.push(`${name}: severity ${score}, a fixed version exists`);
      else
        console.log(
          `non-blocking: ${name}: severity ${score}${fixed ? ', fix available' : ', no fix'}`,
        );
    }
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(
  `osv: ${packages} package(s) with findings, ${vulns} vulnerabilit${vulns === 1 ? 'y' : 'ies'}, none blocking`,
);
