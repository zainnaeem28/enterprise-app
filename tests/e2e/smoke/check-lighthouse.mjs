#!/usr/bin/env node
// Empty-run guard for the Lighthouse CI budget job: the output directory must hold one Lighthouse report (*.report.json) per
// configured run, each with a measured LCP and a script-size summary. `lhci autorun` enforces the budgets (exit 1); this
// proves it measured something.   check-lighthouse.mjs <lhci-output-dir> <runs>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, runsRaw] = process.argv.slice(2);
const runs = Number(runsRaw);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.report\.json$/.test(f)) : [];
const problems = [];
if (files.length < runs)
  problems.push(
    `${files.length} Lighthouse report(s) in ${dir}, ${runs} required (nothing or too little was measured)`,
  );
for (const f of files) {
  const lhr = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const lcp = lhr.audits?.['largest-contentful-paint']?.numericValue;
  const script = lhr.audits?.['resource-summary']?.details?.items?.find(
    (i) => i.resourceType === 'script',
  );
  console.log(
    `${f}: ${lhr.lighthouseVersion} LCP ${lcp === undefined ? 'MISSING' : Math.round(lcp) + ' ms'}, script ${script ? script.transferSize + ' B' : 'MISSING'}`,
  );
  if (typeof lcp !== 'number') problems.push(`${f}: no LCP measured`);
  if (!script) problems.push(`${f}: no script resource summary`);
}
for (const p of problems) console.error(`::error::${p}`);
process.exit(problems.length === 0 ? 0 : 1);
