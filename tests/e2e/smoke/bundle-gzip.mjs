#!/usr/bin/env node
// Gzip budget of the built shell: the same ceiling as apps/staff/scripts/bundle-budget.mjs (120 KiB gzip of JavaScript),
// but for any build output directory, so the seeded-violation run can point it at a bloated copy.
//   bundle-gzip.mjs [dist-dir]      default apps/staff/dist
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET = Number(process.env.BUDGET_GZIP_BYTES ?? 120 * 1024);
const dist = resolve(process.argv[2] ?? join(import.meta.dirname, '../../../apps/staff/dist'));
const dir = join(dist, 'assets');
const files = readdirSync(dir).filter((n) => n.endsWith('.js'));
if (files.length === 0) {
  console.error(`::error::no JavaScript in ${dir} (an empty build fails)`);
  process.exit(1);
}
let total = 0;
for (const f of files) {
  const size = gzipSync(readFileSync(join(dir, f))).length;
  console.log(`${f}: ${size} bytes gzip`);
  total += size;
}
console.log(`total JS gzip: ${total} / ${BUDGET}`);
process.exit(total > BUDGET ? 1 : 0);
