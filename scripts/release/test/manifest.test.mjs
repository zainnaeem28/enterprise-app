import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sha256 } from '../lib/hash.mjs';
import { assemble, manifestHash, validate } from '../lib/manifest.mjs';

const sha = 'a'.repeat(40);
const d = (c) => `sha256:${c.repeat(64)}`;
const cfg = {
  images: [
    { name: 'api', required: true },
    { name: 'worker', required: true },
    { name: 'site', required: false },
  ],
  bundles: [
    { name: 'staff', required: true },
    { name: 'patient', required: false },
  ],
};
const migFiles = [
  { name: '0001_a.sql', sha256: 'b'.repeat(64) },
  { name: '0002_b.sql', sha256: 'c'.repeat(64) },
];
const inventory = {
  migrations: {
    files: migFiles,
    combined_sha256: sha256(migFiles.map((f) => `${f.sha256}  ${f.name}\n`).join('')),
  },
  locks: {
    files: { 'pnpm-lock.yaml': 'd'.repeat(64) },
    base_images: ['node@sha256:' + 'e'.repeat(64)],
    base_images_sha256: 'f'.repeat(64),
    lockfile_sha256: 'd'.repeat(64),
  },
  tools: { node: 'v24.22.2' },
};
const image = (mode, c) =>
  mode === 'publish'
    ? {
        digest: d(c),
        reference: `123.dkr.ecr.eu-west-1.amazonaws.com/ehr/x@${d(c)}`,
        tag: 'r7.aaaaaaaaaaaa',
        published: true,
        signed: true,
        attestations: ['sbom', 'provenance'],
        sbom: { file: 'x', sha256: '1'.repeat(64) },
      }
    : {
        digest: d(c),
        reference: null,
        tag: null,
        published: false,
        signed: false,
        attestations: [],
        sbom: { file: 'x', sha256: '1'.repeat(64) },
      };
const good = (mode = 'publish') => {
  const m = assemble({
    mode,
    release: { git_sha: sha, git_tree_hash: 'b'.repeat(40), release_number: 7 },
    builtAt: '2026-11-09T10:00:00Z',
    images: { api: image(mode, '1'), worker: image(mode, '2') },
    notBuiltImages: { site: { reason: 'no Dockerfile' } },
    bundles: {
      staff: {
        status: 'built',
        client_release: `r7.${sha.slice(0, 12)}`,
        embedded_in: ['assets/a.js'],
        file_count: 3,
        listing_sha256: '9'.repeat(64),
        s3_prefix: 'x',
      },
      patient: { status: 'not-built', reason: 'no browser build' },
    },
    inventory,
    checks: { workflow_run_id: '123' },
    signing: { key_ref: 'arn:aws:kms:eu-west-1:1:key/k' },
    config: cfg,
  });
  m.source_sbom = { file: 's', sha256: '2'.repeat(64) };
  return m;
};

describe('release manifest', () => {
  test('a complete publish manifest and a dry-run manifest validate', () => {
    assert.deepEqual(validate(good('publish')), []);
    assert.deepEqual(validate(good('dry-run')), []);
  });
  test('lists image digests, bundle hashes, lockfile hash, migrations and release_number', () => {
    const m = good();
    assert.equal(m.release_number, 7);
    assert.equal(m.client_release, 'r7.aaaaaaaaaaaa');
    assert.match(m.images.api.digest, /^sha256:/);
    assert.equal(m.bundles.staff.listing_sha256.length, 64);
    assert.equal(m.locks.lockfile_sha256.length, 64);
    assert.equal(m.migrations.files.length, 2);
    assert.equal(m.images_not_built.site.reason, 'no Dockerfile');
  });
  const broken = [
    [
      'image by tag instead of digest',
      (m) => {
        m.images.api.reference = 'x/api:r7';
      },
      /reference must end with @/,
    ],
    [
      'unsigned image',
      (m) => {
        m.images.api.signed = false;
      },
      /published and signed/,
    ],
    [
      'missing provenance attestation',
      (m) => {
        m.images.worker.attestations = ['sbom'];
      },
      /SBOM and provenance/,
    ],
    [
      'missing required image',
      (m) => {
        delete m.images.worker;
      },
      /required image worker/,
    ],
    [
      'bad digest',
      (m) => {
        m.images.api.digest = 'sha256:zz';
      },
      /digest must be/,
    ],
    [
      'release number not matching client release',
      (m) => {
        m.release_number = 8;
      },
      /client_release must equal/,
    ],
    [
      'bundle embeds another release',
      (m) => {
        m.bundles.staff.client_release = 'r6.aaaaaaaaaaaa';
      },
      /embedded release differs/,
    ],
    [
      'required bundle not built',
      (m) => {
        m.bundles.staff = { status: 'not-built', reason: 'x' };
      },
      /required bundle staff/,
    ],
    [
      'migration list tampered',
      (m) => {
        m.migrations.files[0].sha256 = '0'.repeat(64);
      },
      /combined_sha256/,
    ],
    [
      'no lockfile hash',
      (m) => {
        m.locks.lockfile_sha256 = '';
      },
      /lockfile_sha256/,
    ],
    [
      'no source SBOM',
      (m) => {
        delete m.source_sbom;
      },
      /source_sbom/,
    ],
    [
      'no signing key reference',
      (m) => {
        m.signatures.key_ref = null;
      },
      /key_ref/,
    ],
  ];
  for (const [label, mutate, re] of broken) {
    test(`refuses: ${label}`, () => {
      const m = good();
      mutate(m);
      const e = validate(m);
      assert.ok(
        e.some((x) => re.test(x)),
        `${label}: got ${JSON.stringify(e)}`,
      );
    });
  }
  test('a dry-run manifest cannot claim a published reference', () => {
    const m = good('dry-run');
    m.images.api.reference = 'x@' + d('1');
    m.images.api.published = true;
    assert.ok(validate(m).some((x) => /dry-run must not claim/.test(x)));
  });
  test('the manifest hash is stable and changes with content', () => {
    assert.equal(manifestHash(good()), manifestHash(good()));
    const m = good();
    m.release_number = 7;
    m.built_at = '2026-11-09T10:00:01Z';
    assert.notEqual(manifestHash(good()), manifestHash(m));
  });
});
