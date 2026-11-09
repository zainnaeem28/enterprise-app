#!/usr/bin/env node
// Build the portal bundles once, embed r<n>.<sha12> and write release.json (DEVOPS-PLAN 6.2, producer side of DEV-1).
// Usage: build-bundles.mjs --out <dir> --release-number <n> --sha <40hex> [--built-at <iso>] [--no-build]
//   <out>/bundles/<portal>/...  (the built files + release.json)    <out>/bundles.json (summary used by the manifest)
// A required portal that cannot be built fails the build. An optional one is recorded as not-built with its reason.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listing, listingHash, walk } from './lib/hash.mjs';
import { formatClientRelease } from './lib/release-number.mjs';

const root = resolve(import.meta.dirname, '../..');
const { values: a } = parseArgs({
  options: {
    out: { type: 'string' },
    'release-number': { type: 'string' },
    sha: { type: 'string' },
    'built-at': { type: 'string' },
    'no-build': { type: 'boolean', default: false },
  },
});
const n = Number(a['release-number']);
if (!a.out || !Number.isSafeInteger(n) || n < 1 || !/^[0-9a-f]{40}$/.test(a.sha ?? '')) {
  console.error('usage: build-bundles.mjs --out <dir> --release-number <n> --sha <40hex>');
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(join(root, 'scripts/release/release.config.json'), 'utf8'));
const clientRelease = formatClientRelease(n, a.sha);
const builtAt = a['built-at'] ?? new Date().toISOString();
const out = resolve(a.out);
rmSync(join(out, 'bundles'), { recursive: true, force: true });
mkdirSync(join(out, 'bundles'), { recursive: true });

const summary = {};
for (const b of cfg.bundles) {
  const dir = join(root, b.dir);
  const buildable = existsSync(join(dir, 'index.html')) && existsSync(join(dir, 'vite.config.ts'));
  if (!buildable) {
    if (b.required)
      throw new Error(
        `required bundle "${b.name}" cannot be built: ${b.dir} has no index.html/vite.config.ts`,
      );
    summary[b.name] = { status: 'not-built', reason: b.reason };
    console.log(`bundle ${b.name}: NOT BUILT (${b.reason})`);
    continue;
  }
  const dist = join(dir, b.out);
  if (!a['no-build']) {
    rmSync(dist, { recursive: true, force: true });
    // CLIENT_RELEASE is read by vite.config.ts (define __CLIENT_RELEASE__); nothing else changes between builds.
    execFileSync('pnpm', ['--filter', b.filter, 'run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CLIENT_RELEASE: clientRelease },
    });
  }
  if (!existsSync(dist)) throw new Error(`bundle ${b.name}: ${b.dir}/${b.out} was not produced`);
  const target = join(out, 'bundles', b.name);
  cpSync(dist, target, { recursive: true });
  writeFileSync(
    join(target, 'release.json'),
    JSON.stringify({ release_number: n, git_sha12: a.sha.slice(0, 12), built_at: builtAt }) + '\n',
  );
  // The embedded value must really be in the shipped JavaScript, or the portal would send a different header.
  const js = walk(target).filter((p) => p.endsWith('.js'));
  const hit = js.filter((p) => readFileSync(p, 'utf8').includes(clientRelease));
  if (js.length === 0 || hit.length === 0) {
    throw new Error(
      `bundle ${b.name}: "${clientRelease}" is not embedded in any shipped .js file (${js.length} scanned)`,
    );
  }
  const entries = listing(target);
  summary[b.name] = {
    status: 'built',
    client_release: clientRelease,
    embedded_in: hit.map((p) => p.slice(target.length + 1)).sort(),
    file_count: entries.length,
    listing_sha256: listingHash(entries),
    s3_prefix: `releases/${a.sha}/bundles/${b.name}/`,
  };
  console.log(
    `bundle ${b.name}: built, ${entries.length} files, listing ${summary[b.name].listing_sha256}`,
  );
}
writeFileSync(join(out, 'bundles.json'), JSON.stringify(summary, null, 2) + '\n');
