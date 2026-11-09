// Release manifest (DEVOPS-PLAN 6.1): assembly and validation. Fields are snake_case like release.json.
import { sha256 } from './hash.mjs';
import { CLIENT_RELEASE_RE, formatClientRelease } from './release-number.mjs';

export const SCHEMA = 'ehr.release-manifest/v1';
const HEX64 = /^[0-9a-f]{64}$/;

export function assemble({
  mode,
  release,
  builtAt,
  images,
  notBuiltImages,
  bundles,
  inventory,
  checks,
  signing,
  config,
}) {
  return {
    schema: SCHEMA,
    mode, // 'publish' = pushed, signed, stored; 'dry-run' = built and inspected only, nothing published
    git_sha: release.git_sha,
    git_tree_hash: release.git_tree_hash,
    release_number: release.release_number,
    client_release: formatClientRelease(release.release_number, release.git_sha),
    built_at: builtAt,
    images,
    images_not_built: notBuiltImages,
    bundles,
    migrations: inventory.migrations,
    iac: {
      approved_plan_hashes: [],
      note: 'no Terraform plan is applied by build-release; infra.yml records plan hashes for the release that needs them',
    },
    locks: inventory.locks,
    tools: inventory.tools,
    checks,
    signatures: signing,
    min_client_release: {
      value: null,
      rule: 'set at deploy time to the release_number of previous_manifest_hash in the approved-release record (DEVOPS-PLAN 6.2, 15.3); lib/release-number.mjs resolveMinClientRelease implements and refuses the wrong values',
    },
    required: {
      images: config.images.filter((i) => i.required).map((i) => i.name),
      bundles: config.bundles.filter((b) => b.required).map((b) => b.name),
    },
  };
}

export function validate(m) {
  const e = [];
  const need = (c, msg) => {
    if (!c) e.push(msg);
  };
  need(m && m.schema === SCHEMA, `schema must be ${SCHEMA}`);
  if (!m || m.schema !== SCHEMA) return e;
  need(['publish', 'dry-run'].includes(m.mode), 'mode must be publish or dry-run');
  need(/^[0-9a-f]{40}$/.test(m.git_sha), 'git_sha must be 40 hex');
  need(/^[0-9a-f]{40}$/.test(m.git_tree_hash), 'git_tree_hash must be 40 hex');
  need(
    Number.isSafeInteger(m.release_number) && m.release_number > 0,
    'release_number must be a positive integer',
  );
  need(
    m.client_release === formatClientRelease(m.release_number, m.git_sha ?? ''),
    'client_release must equal r<release_number>.<git_sha12>',
  );
  need(CLIENT_RELEASE_RE.test(m.client_release ?? ''), 'client_release is malformed');
  need(!Number.isNaN(Date.parse(m.built_at)), 'built_at must be a date');
  for (const name of m.required?.images ?? []) {
    const i = m.images?.[name];
    need(i, `required image ${name} is missing`);
    if (!i) continue;
    need(/^sha256:[0-9a-f]{64}$/.test(i.digest), `image ${name}: digest must be sha256:<64 hex>`);
    need(i.sbom && HEX64.test(i.sbom.sha256 ?? ''), `image ${name}: SBOM hash missing`);
    if (m.mode === 'publish') {
      need(
        i.published === true && i.signed === true,
        `image ${name}: publish mode needs published and signed`,
      );
      need(
        typeof i.reference === 'string' && i.reference.endsWith(`@${i.digest}`),
        `image ${name}: reference must end with @<digest> (deploys reference digests, never tags)`,
      );
      need(
        (i.attestations ?? []).includes('sbom') && (i.attestations ?? []).includes('provenance'),
        `image ${name}: SBOM and provenance attestations required`,
      );
    } else {
      need(
        i.published === false && i.reference === null,
        `image ${name}: dry-run must not claim a published reference`,
      );
    }
  }
  for (const name of m.required?.bundles ?? []) {
    const b = m.bundles?.[name];
    need(b && b.status === 'built', `required bundle ${name} is not built`);
    if (b?.status === 'built') {
      need(HEX64.test(b.listing_sha256 ?? ''), `bundle ${name}: listing_sha256 missing`);
      need(
        b.client_release === m.client_release,
        `bundle ${name}: embedded release differs from the manifest`,
      );
      need(
        (b.embedded_in ?? []).length > 0,
        `bundle ${name}: client release is not embedded in any file`,
      );
    }
  }
  for (const [name, b] of Object.entries(m.bundles ?? {}))
    need(
      b.status === 'built' || (b.status === 'not-built' && b.reason),
      `bundle ${name}: status/reason invalid`,
    );
  for (const [name, i] of Object.entries(m.images_not_built ?? {}))
    need(i.reason, `image ${name}: not-built needs a reason`);
  const mig = m.migrations;
  need(mig && Array.isArray(mig.files), 'migrations.files missing');
  if (mig && Array.isArray(mig.files))
    need(
      mig.combined_sha256 === sha256(mig.files.map((f) => `${f.sha256}  ${f.name}\n`).join('')),
      'migrations.combined_sha256 does not match the file list',
    );
  need(HEX64.test(m.locks?.lockfile_sha256 ?? ''), 'locks.lockfile_sha256 missing');
  need((m.locks?.base_images ?? []).length > 0, 'locks.base_images empty');
  need(m.checks?.workflow_run_id, 'checks.workflow_run_id missing');
  need(m.source_sbom && HEX64.test(m.source_sbom.sha256 ?? ''), 'source_sbom hash missing');
  need(m.min_client_release && 'value' in m.min_client_release, 'min_client_release rule missing');
  if (m.mode === 'publish') need(m.signatures?.key_ref, 'signatures.key_ref missing');
  return e;
}

/** The manifest hash named in the G3 package: sha256 of the exact bytes written. */
export const serialize = (m) => JSON.stringify(m, null, 2) + '\n';
export const manifestHash = (m) => sha256(serialize(m));
