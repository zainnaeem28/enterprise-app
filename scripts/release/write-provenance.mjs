#!/usr/bin/env node
// Usage: write-provenance.mjs --image <name> --digest sha256:.. --release-number n --lockfile-sha256 h --built-at iso --out statement.json [--predicate-out predicate.json]
// Reads the GitHub Actions environment (GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF, GITHUB_RUN_ID, ...).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { provenance } from './provenance.mjs';

const { values: v } = parseArgs({
  options: {
    image: { type: 'string' },
    digest: { type: 'string' },
    'release-number': { type: 'string' },
    'lockfile-sha256': { type: 'string' },
    'built-at': { type: 'string' },
    out: { type: 'string' },
    'predicate-out': { type: 'string' },
  },
});
const env = process.env;
for (const k of [
  'GITHUB_REPOSITORY',
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_RUN_ID',
  'GITHUB_SERVER_URL',
]) {
  if (!env[k]) {
    console.error(`${k} is not set`);
    process.exit(2);
  }
}
if (!/^sha256:[0-9a-f]{64}$/.test(v.digest ?? '')) {
  console.error('--digest must be sha256:<64 hex>');
  process.exit(2);
}
const statement = provenance({
  imageName: v.image,
  digest: v.digest,
  repo: env.GITHUB_REPOSITORY,
  sha: env.GITHUB_SHA,
  ref: env.GITHUB_REF,
  workflow: 'build-release.yml',
  runId: env.GITHUB_RUN_ID,
  runAttempt: env.GITHUB_RUN_ATTEMPT ?? '1',
  serverUrl: env.GITHUB_SERVER_URL,
  builtAt: v['built-at'],
  releaseNumber: Number(v['release-number']),
  lockfileSha256: v['lockfile-sha256'],
});
writeFileSync(v.out, JSON.stringify(statement, null, 2) + '\n');
// `cosign attest --predicate` takes the predicate alone and builds the statement (subject = the signed digest) itself.
if (v['predicate-out'])
  writeFileSync(v['predicate-out'], JSON.stringify(statement.predicate, null, 2) + '\n');
