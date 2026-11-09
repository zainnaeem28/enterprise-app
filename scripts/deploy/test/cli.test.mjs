// End-to-end of the local dry run and the refusal paths, through the real CLIs against a STUB manifest/record.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { join } from 'node:path';
import { sha256 } from '../../release/lib/hash.mjs';
import { bytesOf, hex, stubManifest, stubRecord, tmp, writeStub } from './helpers.mjs';

const dir = join(import.meta.dirname, '..');
const run = (script, argv, env = {}) =>
  spawnSync('node', [join(dir, script), ...argv], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '', ...env },
  });

function setup(recOver = {}, manOver = {}) {
  const d = tmp();
  const m = stubManifest(manOver);
  const mp = writeStub(d, 'release-manifest.json', bytesOf(m));
  const h = sha256(bytesOf(m));
  const rp = writeStub(d, 'record.json', stubRecord(h, recOver));
  return { d, m, mp, h, rp };
}
const NOW = '2026-11-09T06:00:00Z';

test('dry run against the stub manifest: verified, plan printed, nothing contacted', () => {
  const { mp, rp } = setup();
  const r = run('dry-run.mjs', ['--manifest', mp, '--record', rp, '--now', NOW]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verified: manifest bytes = dispatch hash = record manifest_hash/);
  assert.match(r.stdout, /min_client_release=24/);
  assert.match(r.stdout, /new_migrations=1/);
  assert.match(r.stdout, /nothing was contacted/);
});

test('digest input that is not the record manifest_hash is refused', () => {
  const { mp, rp, h } = setup({ manifest_hash: hex('0') });
  const r = run('verify-release.mjs', [
    '--manifest',
    mp,
    '--manifest-hash',
    h,
    '--record',
    rp,
    '--environment',
    'production',
    '--actions',
    'rollout',
    '--now',
    NOW,
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /differs from the record's manifest_hash/);
});

test('input digest that is not the hash of the manifest bytes is refused', () => {
  const { mp, rp } = setup();
  const r = run('verify-release.mjs', [
    '--manifest',
    mp,
    '--manifest-hash',
    hex('0'),
    '--record',
    rp,
    '--environment',
    'production',
    '--actions',
    'rollout',
    '--now',
    NOW,
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hash to/);
});

test('expired record, wrong environment, missing record are refused', () => {
  const { mp, rp, h } = setup();
  const common = ['--manifest', mp, '--manifest-hash', h, '--record', rp, '--actions', 'rollout'];
  assert.match(
    run('verify-release.mjs', [
      ...common,
      '--environment',
      'production',
      '--now',
      '2026-11-10T00:00:00Z',
    ]).stderr,
    /expired/,
  );
  assert.match(
    run('verify-release.mjs', [...common, '--environment', 'staging', '--now', NOW]).stderr,
    /environment/,
  );
  const e = setup({ state: 'empty' });
  assert.match(
    run('verify-release.mjs', [
      '--manifest',
      e.mp,
      '--manifest-hash',
      e.h,
      '--record',
      e.rp,
      '--environment',
      'production',
      '--actions',
      'rollout',
      '--now',
      NOW,
    ]).stderr,
    /not "approved"/,
  );
});

test('a release with a new migration needs `migrate` in the record', () => {
  const { mp, rp, h } = setup({ permitted_actions: ['rollout', 'smoke', 'portal-switch'] });
  const r = run('verify-release.mjs', [
    '--manifest',
    mp,
    '--manifest-hash',
    h,
    '--record',
    rp,
    '--environment',
    'production',
    '--actions',
    'rollout',
    '--now',
    NOW,
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /action "migrate"/);
});

test('rollback target: previous manifest required unless first release; its number sets min_client_release', () => {
  const prev = stubManifest({ number: 20, sha: hex('9', 40) });
  const d = tmp();
  const pp = writeStub(d, 'prev.json', bytesOf(prev));
  const ph = sha256(bytesOf(prev));
  const { mp, h, d: d2 } = setup();
  const rec = writeStub(
    d2,
    'rec2.json',
    stubRecord(h, {
      first_release: false,
      previous_manifest: ph,
      permitted_actions: ['migrate', 'rollout', 'smoke', 'portal-switch'],
    }),
  );
  const base = [
    '--manifest',
    mp,
    '--manifest-hash',
    h,
    '--record',
    rec,
    '--environment',
    'production',
    '--actions',
    'rollout',
    '--now',
    NOW,
  ];
  assert.match(run('verify-release.mjs', base).stderr, /not available for rollback/);
  const ok = run('verify-release.mjs', [...base, '--previous-manifest', pp]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /min_client_release=20/);
  assert.match(ok.stdout, /new_migrations=0/);
});

test('start gate stops a release at peak load in the dry run', () => {
  const { mp, rp } = setup();
  const r = run('dry-run.mjs', [
    '--manifest',
    mp,
    '--record',
    rp,
    '--now',
    NOW,
    '--api-desired',
    '8',
    '--worker-desired',
    '2',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /release deferred/);
});

test('set-release-config refuses /approved/* and non-integers; run-migration refuses an unpinned task definition', () => {
  assert.match(
    run('set-release-config.mjs', ['--param', '/approved/release', '--value', '1']).stderr,
    /never \/approved/,
  );
  assert.match(
    run('set-release-config.mjs', ['--param', '/p/x', '--value', 'abc']).stderr,
    /positive integer/,
  );
  assert.match(
    run('run-migration.mjs', [
      '--cluster',
      'c',
      '--taskdef',
      'ehr-migrate',
      '--subnets',
      's',
      '--security-groups',
      'g',
    ]).stderr,
    /pinned/,
  );
  assert.match(
    run('publish-marketing.mjs', ['--dir', '/nonexistent', '--bucket', 'b', '--distribution', 'd'])
      .stderr,
    /no build output/,
  );
});

test('observation job cannot mutate: the read-only wrapper refuses a write verb before any process starts', () => {
  const r = spawnSync(
    'node',
    [
      '-e',
      `process.env.DEPLOY_READ_ONLY='1'; const {aws}=await import(${JSON.stringify(join(dir, 'lib/aws.mjs'))}); aws(['ecs','update-service','--service','x'])`,
      '--input-type=module',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /read-only mode/);
});
