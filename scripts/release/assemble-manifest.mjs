#!/usr/bin/env node
// Assemble, validate and hash the release manifest.
// Usage: assemble-manifest.mjs --mode publish|dry-run --release release.json --bundles bundles.json --inventory inventory.json
//        --images images.json --out release-manifest.json [--key-ref arn] [--built-at iso]
// Writes <out> and <out>.sha256 ("<hash>  release-manifest.json"). Exits non-zero when the manifest is invalid.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256 } from './lib/hash.mjs';
import { assemble, manifestHash, serialize, validate } from './lib/manifest.mjs';

const { values: v } = parseArgs({
  options: {
    mode: { type: 'string' },
    release: { type: 'string' },
    bundles: { type: 'string' },
    inventory: { type: 'string' },
    images: { type: 'string' },
    out: { type: 'string' },
    'key-ref': { type: 'string' },
    'built-at': { type: 'string' },
    'source-sbom': { type: 'string' },
  },
});
for (const k of ['mode', 'release', 'bundles', 'inventory', 'images', 'out'])
  if (!v[k]) {
    console.error(`--${k} is required`);
    process.exit(2);
  }
const J = (p) => JSON.parse(readFileSync(p, 'utf8'));
const config = J(
  join(resolve(import.meta.dirname, '../..'), 'scripts/release/release.config.json'),
);
const images = J(v.images);
const notBuilt = Object.fromEntries(
  config.images
    .filter((i) => !images[i.name])
    .filter((i) => !i.required)
    .map((i) => [i.name, { reason: i.reason }]),
);
const m = assemble({
  mode: v.mode,
  release: J(v.release),
  builtAt: v['built-at'] ?? new Date().toISOString(),
  images,
  notBuiltImages: notBuilt,
  bundles: J(v.bundles),
  inventory: J(v.inventory),
  config,
  checks: {
    workflow_run_id: process.env.GITHUB_RUN_ID ?? null,
    workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    run_url: process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    scan_and_test_reports: 'artifacts of this run: release-reports-*',
  },
  signing: {
    key_ref: v['key-ref'] ?? null,
    method:
      'cosign with an AWS KMS asymmetric key (awskms://); signatures and attestations are stored in the registry next to the image digest',
    transparency_log:
      'not used (private repository); verify with the public key from kms:GetPublicKey',
    provenance_note:
      'self-generated SLSA v1 predicate signed with the release key; not an isolated-builder SLSA L3 claim',
  },
});
if (v['source-sbom'])
  m.source_sbom = {
    file: basename(v['source-sbom']),
    sha256: sha256(readFileSync(v['source-sbom'])),
    note: 'CycloneDX SBOM of the lockfile-resolved packages that went into every bundle and image',
  };
const errors = validate(m);
if (errors.length) {
  console.error('manifest invalid:\n - ' + errors.join('\n - '));
  process.exit(1);
}
writeFileSync(v.out, serialize(m));
writeFileSync(`${v.out}.sha256`, `${manifestHash(m)}  ${basename(v.out)}\n`);
console.log(
  `manifest ${basename(v.out)} release_number=${m.release_number} client_release=${m.client_release} mode=${m.mode} sha256=${manifestHash(m)}`,
);
