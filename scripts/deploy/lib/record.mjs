// Approved-release record checks (DEVOPS-PLAN 7.4, 15.3). Pure functions: the workflow reads the record from the
// production account (SSM SecureString /approved/<kind>) and this code decides; nothing here talks to AWS.
// Record shape is the one infra/modules/ci-trust writes: { state, environment, manifest_hash, previous_manifest,
// permitted_actions, g3_reference, not_before, expires, approvals, applier, first_release }.
import { resolveMinClientRelease } from '../../release/lib/release-number.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
export const ACTIONS = [
  'migrate',
  'rollout',
  'smoke',
  'portal-switch',
  'rollback-redeploy',
  'publish',
];

export function parseRecord(text) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    throw new Error('approved-release record is not valid JSON');
  }
  if (!r || typeof r !== 'object' || Array.isArray(r))
    throw new Error('approved-release record is not an object');
  return r;
}

/**
 * Every reason the record does not authorise this deploy; empty array = it does.
 * @param {object} record parsed record
 * @param {{environment:string, manifestHash:string, actions:string[], now?:Date, previousManifestHash?:string, noRollbackTarget?:boolean}} want
 * `noRollbackTarget` is for the marketing site only (no PHI, no migration, no previous-manifest rule; 9.1).
 */
export function checkRecord(record, want) {
  const e = [];
  const now = want.now ?? new Date();
  if (record.state !== 'approved')
    e.push(`record state is "${record.state}", not "approved" (missing or empty record)`);
  if (record.environment !== want.environment)
    e.push(
      `record is for environment "${record.environment}", this run is for "${want.environment}"`,
    );
  if (!HEX64.test(want.manifestHash ?? ''))
    e.push('dispatch manifest hash is not 64 lowercase hex');
  if (!HEX64.test(record.manifest_hash ?? '')) e.push('record has no valid manifest_hash');
  else if (record.manifest_hash !== want.manifestHash)
    e.push(
      `manifest hash ${want.manifestHash} differs from the record's manifest_hash ${record.manifest_hash}`,
    );
  const permitted = Array.isArray(record.permitted_actions) ? record.permitted_actions : [];
  for (const a of want.actions)
    if (!permitted.includes(a) && !permitted.includes('*'))
      e.push(`action "${a}" is not in the record's permitted_actions`);
  if (!record.g3_reference || typeof record.g3_reference !== 'string')
    e.push('record has no g3_reference');
  const nb = Date.parse(record.not_before);
  const ex = Date.parse(record.expires);
  if (Number.isNaN(nb) || Number.isNaN(ex))
    e.push('record not_before/expires missing or malformed');
  else {
    if (now.getTime() < nb) e.push(`record is not valid before ${record.not_before}`);
    if (now.getTime() >= ex) e.push(`record expired at ${record.expires}`);
  }
  if (!Array.isArray(record.approvals) || record.approvals.length < 1)
    e.push('record names no approver');
  // Rollback target (15.3): absent only for the first production release.
  const prev = record.previous_manifest ?? '';
  if (want.noRollbackTarget) {
    // marketing: no rollback manifest is required
  } else if (record.first_release === true) {
    if (prev) e.push('first_release is true but the record names a previous manifest');
  } else if (!HEX64.test(prev)) {
    e.push(
      'record has no previous_manifest and is not marked first_release: the rollback target is missing',
    );
  }
  if (prev && want.previousManifestHash !== undefined && want.previousManifestHash !== prev)
    e.push(
      `previous manifest supplied (${want.previousManifestHash}) differs from the record's (${prev})`,
    );
  return e;
}

/**
 * min_client_release for this deploy (6.2, 15.3): the release_number of the previous RELEASED manifest named in the
 * record; the manifest's own number for the first release. Anything else is refused by resolveMinClientRelease.
 */
export function minClientRelease({ record, manifest, previousManifest, override }) {
  const first = record.first_release === true;
  if (first && previousManifest)
    throw new Error('first release: a previous manifest was supplied but the record has none');
  if (!first && !previousManifest)
    throw new Error('previous manifest not available for rollback and min_client_release (15.3)');
  return resolveMinClientRelease({
    ownReleaseNumber: manifest.release_number,
    previousReleasedNumber: first ? null : previousManifest.release_number,
    override,
  });
}

/**
 * Migrations in `manifest` that `previous` (the released manifest being replaced) does not have. A migration file that
 * exists in both with a different hash is an edit of an applied migration and is refused. No previous = all are new.
 */
export function newMigrations(manifest, previous) {
  const mine = manifest.migrations?.files ?? [];
  if (!previous) return mine;
  const before = new Map((previous.migrations?.files ?? []).map((f) => [f.name, f.sha256]));
  const changed = mine.filter((f) => before.has(f.name) && before.get(f.name) !== f.sha256);
  if (changed.length)
    throw new Error(`migration(s) edited after release: ${changed.map((f) => f.name).join(', ')}`);
  return mine.filter((f) => !before.has(f.name));
}
