import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../release/lib/hash.mjs';
import { formatClientRelease } from '../../release/lib/release-number.mjs';

const hex = (c, n = 64) => c.repeat(n).slice(0, n);

/** A valid published release manifest (the local STUB used by the dry run). */
export function stubManifest({
  number = 24,
  sha = hex('a', 40),
  migrations = [['0001_init.sql', hex('1')]],
} = {}) {
  const files = migrations.map(([name, h]) => ({ name, sha256: h }));
  const client = formatClientRelease(number, sha);
  const image = (n) => ({
    reference: `123456789012.dkr.ecr.us-east-1.amazonaws.com/ehr/${n}@sha256:${hex(n === 'api' ? 'b' : 'c')}`,
    digest: `sha256:${hex(n === 'api' ? 'b' : 'c')}`,
    published: true,
    signed: true,
    sbom: { sha256: hex('d') },
    attestations: ['sbom', 'provenance'],
  });
  return {
    schema: 'ehr.release-manifest/v1',
    mode: 'publish',
    git_sha: sha,
    git_tree_hash: hex('e', 40),
    release_number: number,
    client_release: client,
    built_at: '2026-11-08T10:00:00Z',
    images: { api: image('api'), worker: image('worker') },
    images_not_built: {},
    bundles: {
      staff: {
        status: 'built',
        listing_sha256: hex('f'),
        client_release: client,
        embedded_in: ['assets/index.js'],
      },
    },
    migrations: {
      files,
      combined_sha256: sha256(files.map((f) => `${f.sha256}  ${f.name}\n`).join('')),
    },
    locks: { lockfile_sha256: hex('9'), base_images: ['node@sha256:' + hex('8')] },
    tools: {},
    checks: { workflow_run_id: '42' },
    signatures: { key_ref: 'awskms://stub' },
    source_sbom: { sha256: hex('7') },
    min_client_release: { value: null, rule: 'set at deploy' },
    required: { images: ['api', 'worker'], bundles: ['staff'] },
  };
}

export const bytesOf = (m) => Buffer.from(JSON.stringify(m, null, 2) + '\n');

export function stubRecord(manifestHash, over = {}) {
  return {
    state: 'approved',
    environment: 'production',
    manifest_hash: manifestHash,
    previous_manifest: '',
    first_release: true,
    permitted_actions: ['migrate', 'rollout', 'smoke', 'portal-switch'],
    g3_reference: 'decision-stub-1@rev1',
    not_before: '2026-11-09T00:00:00Z',
    expires: '2026-11-09T12:00:00Z',
    approvals: ['release-owner'],
    applier: 'platform-admin-apply',
    ...over,
  };
}

export function writeStub(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
  return p;
}
export const tmp = () => mkdtempSync(join(tmpdir(), 'deploy-test-'));
export { hex };
