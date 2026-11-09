// PHI canary test over the telemetry configuration output (DO-07).
// Usage: node phi-canary-scan.mjs <plan.json> [--self-test]
//  1. No canary value (tests/phi-canaries.json) may appear anywhere in the rendered plan: alarm and rule
//     descriptions, dashboard JSON, collector configuration, data-protection policy, canary environment, tags.
//  2. The collector redaction patterns and the log data-protection policy must each match the canary shapes
//     they are meant to catch (so a regex edit that stops matching fails here).
//  3. --self-test injects a canary into a copy of the plan and requires the scan to fail: a scan that cannot fail proves nothing.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith('--'));
if (!planPath) {
  console.error('usage: phi-canary-scan.mjs <plan.json> [--self-test]');
  process.exit(2);
}
const canaries = JSON.parse(readFileSync(join(here, 'phi-canaries.json'), 'utf8')).values;
const planText = readFileSync(planPath, 'utf8');
const plan = JSON.parse(planText);

function scan(text) {
  return canaries.filter((c) => text.includes(c) || text.includes(JSON.stringify(c).slice(1, -1)));
}

function findResources(type) {
  const out = [];
  const walk = (m) => {
    for (const r of m?.resources ?? []) if (r.type === type) out.push(r);
    for (const c of m?.child_modules ?? []) walk(c);
  };
  walk(plan.planned_values?.root_module);
  return out;
}

const failures = [];
const hits = scan(planText);
if (hits.length > 0) failures.push(`canary values present in plan output: ${hits.join(', ')}`);

// Pattern effectiveness: use the regexes the plan actually carries.
const policies = findResources('aws_cloudwatch_log_data_protection_policy');
if (policies.length === 0) failures.push('no log data-protection policy in the plan');
const customRegexes = [];
for (const p of policies) {
  const doc = JSON.parse(p.values.policy_document);
  for (const c of doc.Configuration?.CustomDataIdentifier ?? []) customRegexes.push(c.Regex);
  const ops = doc.Statement.map((s) => Object.keys(s.Operation)[0]);
  if (!ops.includes('Audit') || !ops.includes('Deidentify')) failures.push(`policy for ${p.values.log_group_name} lacks Audit and Deidentify`);
}
const params = findResources('aws_ssm_parameter');
const collector = params.find((p) => p.values.name?.endsWith('adot-collector-config'));
const blocked = [];
if (!collector) failures.push('no collector configuration in the plan');
else {
  const lines = collector.values.value.split('\n');
  let inBlocked = false;
  for (const l of lines) {
    if (/"blocked_values":/.test(l)) { inBlocked = true; continue; }
    if (inBlocked) {
      const m = l.match(/^\s+- "(.*)"$/);
      if (m) blocked.push(JSON.parse(`"${m[1]}"`));
      else inBlocked = false;
    }
  }
}
// Go RE2 \b and (?i) are accepted by JavaScript too, which is enough to exercise these patterns.
const toRe = (s) => new RegExp(s.replace(/^\(\?i\)/, ''), s.startsWith('(?i)') ? 'i' : '');
const detectors = [...customRegexes.map(toRe), ...blocked.map(toRe)];
if (blocked.length === 0) failures.push('collector blocked_values not found');
for (const c of canaries) {
  const inLogs = customRegexes.map(toRe).some((r) => r.test(c));
  const inCollector = blocked.map(toRe).some((r) => r.test(c));
  // Email, SSN and phone are caught by the managed identifiers in the log policy; the collector must catch every canary shape.
  if (!inCollector) failures.push(`collector patterns do not match canary: ${c}`);
  if (/^PHI-CANARY-|^Bearer |^eyJ|^dob:/.test(c) && !inLogs) failures.push(`log policy custom identifiers do not match canary: ${c}`);
}
const benign = ['GET /api/v1/appointments', 'ehr.request_id=3f9a1c2b7d10', 'release r142.3f9a1c2b7d10', 'status=200 ms=41'];
for (const b of benign) if (detectors.some((r) => r.test(b))) failures.push(`pattern matches benign text: ${b}`);

if (args.includes('--self-test')) {
  const injected = planText.replace('"ehr-production-operations"', '"ehr-production-operations PHI-CANARY-A1B2C3D4"');
  if (injected === planText || scan(injected).length === 0) failures.push('self-test could not inject a canary');
  else console.log('self-test: injected canary is detected by the scan (control passes)');
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`PASS ${canaries.length} canary values absent from plan output; ${customRegexes.length} log-policy and ${blocked.length} collector patterns match all canary shapes and no benign text`);
