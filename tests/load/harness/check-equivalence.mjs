#!/usr/bin/env node
// Production-equivalence check (TEST-CASES ENV-LOAD). Compares the effective `profile`
// output of the loadtest module with the same values taken from the production plan.
// Any difference not listed in the allow-list file fails. Usage:
//   node check-equivalence.mjs <loadtest-profile.json> <production-profile.json> [allowed-differences.json]
// Inputs are `terraform output -json profile` documents (or plain objects).
import { readFileSync } from 'node:fs';

const load = (f) => { const j = JSON.parse(readFileSync(f, 'utf8')); return j && typeof j === 'object' && 'value' in j && 'type' in j ? j.value : j; };
const flatten = (o, p = '', out = {}) => {
  if (o !== null && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) flatten(v, p ? `${p}.${k}` : k, out);
  else out[p] = JSON.stringify(o);
  return out;
};
const [lt, prod, allowFile] = process.argv.slice(2);
if (!lt || !prod) { console.error('usage: check-equivalence.mjs <loadtest.json> <production.json> [allowed.json]'); process.exit(2); }
const allowed = allowFile ? JSON.parse(readFileSync(allowFile, 'utf8')) : {}; // { "path": "justification" }
const a = flatten(load(lt)), b = flatten(load(prod));
const diffs = [];
for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) diffs.push({ path: k, loadtest: a[k] ?? '(missing)', production: b[k] ?? '(missing)', justified: allowed[k] ?? null });
const unjustified = diffs.filter((d) => !d.justified);
console.log(JSON.stringify({ compared: Object.keys(b).length, differences: diffs, unjustified: unjustified.length }, null, 2));
process.exit(unjustified.length ? 1 : 0);
