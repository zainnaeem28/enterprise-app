// Fails when the gzipped JS of the built shell exceeds the budget. NFR-7 sets the real budget; this
// initial value is a ceiling for the shell only and is raised by a reviewed change, not silently.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET_GZIP_BYTES = 120 * 1024;
const dir = new URL('../dist/assets/', import.meta.url).pathname;
let total = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
  const size = gzipSync(readFileSync(join(dir, f))).length;
  console.log(`${f}: ${size} bytes gzip`);
  total += size;
}
console.log(`total JS gzip: ${total} / ${BUDGET_GZIP_BYTES}`);
if (total > BUDGET_GZIP_BYTES) process.exit(1);
