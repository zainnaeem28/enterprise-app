#!/usr/bin/env node
// Gzip budget of the built staff app, for any build output directory (the seeded-violation run points it at a bloated
// copy). One implementation: apps/staff/scripts/bundle-budget.mjs runs this file on apps/staff/dist.
//   bundle-gzip.mjs [dist-dir]      default apps/staff/dist
// Three checks, all evaluated on every run (decision HEAAA-604 D-4):
//   1. initial JS  = every .js that dist/index.html loads via <script src> or <link rel="modulepreload">.
//                    NFR-7 proxy and the primary budget: 120 KiB, env BUDGET_GZIP_BYTES.
//   2. largest lazy chunk (any other .js in dist/assets): 30 KiB, env BUDGET_CHUNK_GZIP_BYTES.
//   3. total JS (all dist/assets/*.js): 192 KiB tripwire for dependency bloat, env BUDGET_TOTAL_GZIP_BYTES.
// A limit is raised only by a reviewed change (HEAAA-604 D-4 and D-6), never silently. Lighthouse CI stays the NFR-7 gate.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const INITIAL_LIMIT = Number(process.env.BUDGET_GZIP_BYTES ?? 120 * 1024);
const CHUNK_LIMIT = Number(process.env.BUDGET_CHUNK_GZIP_BYTES ?? 30 * 1024);
const TOTAL_LIMIT = Number(process.env.BUDGET_TOTAL_GZIP_BYTES ?? 192 * 1024);

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

const dist = resolve(process.argv[2] ?? join(import.meta.dirname, '../../../apps/staff/dist'));
const dir = join(dist, 'assets');
const indexHtml = join(dist, 'index.html');
if (!existsSync(indexHtml)) fail(`${indexHtml} is missing (cannot determine the initial JavaScript)`);
if (!existsSync(dir)) fail(`no JavaScript in ${dir} (an empty build fails)`);
const files = readdirSync(dir).filter((n) => n.endsWith('.js'));
if (files.length === 0) fail(`no JavaScript in ${dir} (an empty build fails)`);

const html = readFileSync(indexHtml, 'utf8');
const initial = new Set();
const refs = [];
for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
  const m = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
  if (m) refs.push(m[1]);
}
for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
  if (!/\brel\s*=\s*["']modulepreload["']/i.test(tag)) continue;
  const m = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
  if (m) refs.push(m[1]);
}
for (const ref of refs) {
  const path = ref.split(/[?#]/)[0];
  if (!path.endsWith('.js') || !/^\/?assets\//.test(path)) continue;
  const file = join(dist, path.replace(/^\//, ''));
  if (!existsSync(file)) fail(`index.html references ${path} but ${file} does not exist`);
  initial.add(file);
}
if (initial.size === 0) fail(`index.html references no JavaScript under assets/ (${indexHtml})`);

let initialSum = 0;
let total = 0;
let largestLazy = { name: 'none', size: 0 };
for (const f of files) {
  const file = join(dir, f);
  const size = gzipSync(readFileSync(file)).length;
  const isInitial = initial.has(file);
  console.log(`${f}: ${size} bytes gzip (${isInitial ? 'initial' : 'lazy'})`);
  total += size;
  if (isInitial) initialSum += size;
  else if (size > largestLazy.size) largestLazy = { name: f, size };
}
for (const file of initial) {
  if (!files.includes(file.slice(dir.length + 1))) fail(`${file} is referenced by index.html but is not a top-level asset`);
}

console.log(`initial JS gzip: ${initialSum} / ${INITIAL_LIMIT}`);
console.log(`largest lazy chunk gzip: ${largestLazy.name} ${largestLazy.size} / ${CHUNK_LIMIT}`);
console.log(`total JS gzip: ${total} / ${TOTAL_LIMIT}`);
let bad = false;
if (initialSum > INITIAL_LIMIT) {
  console.error(`::error::budget initial: ${initialSum} > ${INITIAL_LIMIT}`);
  bad = true;
}
if (largestLazy.size > CHUNK_LIMIT) {
  console.error(`::error::budget lazy-chunk: ${largestLazy.name} ${largestLazy.size} > ${CHUNK_LIMIT}`);
  bad = true;
}
if (total > TOTAL_LIMIT) {
  console.error(`::error::budget total: ${total} > ${TOTAL_LIMIT}`);
  bad = true;
}
process.exit(bad ? 1 : 0);
