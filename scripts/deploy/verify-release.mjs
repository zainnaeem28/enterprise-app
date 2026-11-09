#!/usr/bin/env node
// First job of every production/staging deploy: refuse unless the manifest bytes, the dispatch input and the
// approved-release record agree (DEVOPS-PLAN 7.4, 15.3). The record is read from the production account by the caller
// (aws ssm get-parameter) and passed as a file; this script never talks to AWS, so it also runs against a local stub.
//
//   verify-release.mjs --manifest m.json --manifest-hash H --record r.json --environment production \
//       --actions migrate,rollout,smoke [--previous-manifest p.json] [--now ISO] [--has-migration-check]
import { readFileSync } from 'node:fs';
import { args, main, setOutput } from './lib/cli.mjs';
import { checkManifestBytes, imageRefs } from './lib/manifest-check.mjs';
import { checkRecord, minClientRelease, newMigrations, parseRecord } from './lib/record.mjs';
import { sha256 } from '../release/lib/hash.mjs';

main(() => {
  const a = args(process.argv.slice(2), {
    manifest: 'required',
    'manifest-hash': 'required',
    record: 'required',
    environment: 'required',
    actions: 'required',
    'previous-manifest': 'optional',
    now: 'optional',
    'no-rollback-target': 'flag',
    'skip-min-client': 'flag',
  });
  const errors = [];
  const bytes = readFileSync(a.manifest);
  const m = checkManifestBytes(bytes, a['manifest-hash']);
  errors.push(...m.errors);
  const record = parseRecord(readFileSync(a.record, 'utf8'));

  let previous;
  let previousHash;
  if (a['previous-manifest']) {
    const pb = readFileSync(a['previous-manifest']);
    previousHash = sha256(pb);
    const pc = checkManifestBytes(pb, previousHash);
    errors.push(...pc.errors.map((e) => `previous manifest: ${e}`));
    previous = pc.manifest;
  }
  // `migrate` is required of the record exactly when this release adds a migration (8.2).
  let fresh = [];
  if (m.manifest) {
    try {
      fresh = newMigrations(m.manifest, previous);
    } catch (e) {
      errors.push(e.message);
    }
  }
  const actions = a.actions.split(',').filter(Boolean);
  if (fresh.length > 0 && !actions.includes('migrate')) actions.push('migrate');
  errors.push(
    ...checkRecord(record, {
      environment: a.environment,
      manifestHash: a['manifest-hash'],
      actions,
      now: a.now ? new Date(a.now) : new Date(),
      previousManifestHash: previousHash,
      noRollbackTarget: a['no-rollback-target'] === true,
    }),
  );

  let minClient;
  if (m.manifest && errors.length === 0 && a['skip-min-client'] !== true) {
    try {
      minClient = minClientRelease({ record, manifest: m.manifest, previousManifest: previous });
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::refused: ${e}`);
    process.exit(1);
  }
  setOutput('manifest_hash', m.hash);
  setOutput('release_number', m.manifest.release_number);
  setOutput('client_release', m.manifest.client_release);
  setOutput('git_sha', m.manifest.git_sha);
  if (minClient !== undefined) setOutput('min_client_release', minClient);
  setOutput('new_migrations', fresh.length);
  for (const [n, ref] of Object.entries(imageRefs(m.manifest))) setOutput(`image_${n}`, ref);
  console.log(
    'verified: manifest bytes = dispatch hash = record manifest_hash; record unexpired for this environment and actions',
  );
});
