#!/usr/bin/env node
// Usage: validate-manifest.mjs <release-manifest.json>   (also re-checks <file>.sha256 when present)
import { existsSync, readFileSync } from 'node:fs';
import { sha256 } from './lib/hash.mjs';
import { validate } from './lib/manifest.mjs';

const f = process.argv[2];
if (!f) {
  console.error('usage: validate-manifest.mjs <file>');
  process.exit(2);
}
const raw = readFileSync(f);
const errors = validate(JSON.parse(raw.toString('utf8')));
if (existsSync(`${f}.sha256`)) {
  const want = readFileSync(`${f}.sha256`, 'utf8').split(/\s+/)[0];
  if (want !== sha256(raw)) errors.push(`sha256 file says ${want}, file hashes to ${sha256(raw)}`);
}
if (errors.length) {
  console.error('manifest invalid:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`manifest valid: ${f}`);
