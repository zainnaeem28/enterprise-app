// Merge participation and the module's own export part (ARCHITECTURE 22.14, 22.16, 24; SHARED-BOUNDARIES 9.2):
//
//   privacy.request         R received, identity_verified, in_progress, blocked_d8    K fulfilled, refused
//   privacy.export_package  R assembling, ready, released                            K failed, expired
//   privacy.incident_patient  exempt from the guard (it records history): not a participant, kept on the ID it was written with
//   privacy.incident        has no patient column
//
// No unique constraint spans two patients: a request has at most one live package and both move together, so re-pointing cannot
// collide (22.16: None). A fulfilled request stays on the merged ID while its package, still R until it expires, follows the patient:
// the package is found through `request_id`, and a patient sees both through the closure of their IDs.
//
// Needs one line in the merge executor's `NOT_PARTICIPANT_TABLES` for `privacy.incident_patient` (outside this ticket's paths: see
// the module README and `catalog-lists.requested.patch`).
import { defaultRegistries } from '@ehr/kernel';
import type { MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { PrivacyScopeError, PrivacyValidationError } from './errors.js';
import { isUuid } from './ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

interface Spec {
  table: string;
  rStates: readonly string[];
  rule: string;
}

const NO_UNIQUE =
  'No unique constraint spans two patients, so re-pointing cannot collide (22.16: None). ';

export const PRIVACY_SPECS: readonly Spec[] = [
  {
    table: 'privacy.request',
    rStates: ['received', 'identity_verified', 'in_progress', 'blocked_d8'],
    rule:
      NO_UNIQUE +
      'received, identity_verified, in_progress and blocked_d8 are R and move with their patient; fulfilled and refused are K and stay',
  },
  {
    table: 'privacy.export_package',
    rStates: ['assembling', 'ready', 'released'],
    rule:
      NO_UNIQUE +
      'assembling, ready and released are R and move with their patient (the expiry job still updates them); failed and expired are K and stay',
  },
];

export const PRIVACY_MERGE_TABLES = PRIVACY_SPECS.map((s) => s.table);
export const PRIVACY_CONFLICT_RULES: readonly ConflictRule[] = PRIVACY_SPECS.map((s) => ({
  table: s.table,
  rule: s.rule,
}));

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new PrivacyScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new PrivacyScopeError();
}

const count = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

export const privacyMergeParticipant: MergeParticipant = {
  module: 'privacy',
  tables: PRIVACY_MERGE_TABLES,
  conflictRules: PRIVACY_CONFLICT_RULES,
  async repointPatient(tx, mergedId, survivorId, requestId): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new PrivacyValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);

    // Lock first, in id order: a concurrent decision, completion or release waits, so a row is never read in two states.
    for (const s of PRIVACY_SPECS)
      await tx.query(
        `SELECT x.id FROM ${s.table} x WHERE x.patient_id = $1::uuid ORDER BY x.id FOR UPDATE`,
        [mergedId],
      );

    const out: MergeCounts[] = [];
    for (const s of PRIVACY_SPECS) {
      const found = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${s.table} WHERE patient_id = $1::uuid`,
        [mergedId],
      );
      const u = await tx.query(
        `UPDATE ${s.table} SET patient_id = $2::uuid WHERE patient_id = $1::uuid AND status = ANY($3::text[])`,
        [mergedId, survivorId, [...s.rStates]],
      );
      const moved = u.rowCount ?? 0;
      out.push({
        table: s.table,
        found,
        repointed: moved,
        resolved: 0,
        kept: found - moved,
        deleted: [],
      });
    }

    // 22.16 step 4: no R row may be left on the merged ID, and every table's counts add up.
    for (const s of PRIVACY_SPECS) {
      const left = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${s.table} WHERE patient_id = $1::uuid AND status = ANY($2::text[])`,
        [mergedId, [...s.rStates]],
      );
      if (left !== 0)
        throw new Error(
          `privacy.repointPatient: an R row is left on the merged patient (${s.table})`,
        );
    }
    for (const c of out)
      if (c.found !== c.repointed + c.kept + c.resolved)
        throw new Error(`privacy.repointPatient: counts do not add up for ${c.table}`);
    return out;
  },
};

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

/**
 * The patient's own privacy requests, for their export (the owner's part, 22.14): kind, status, dates, the requester's own text and
 * the decision reason. Package metadata is left out (the package is the export itself).
 */
export async function privacyExportPart(
  tx: Tx,
  patientIds: readonly string[],
): Promise<Record<string, unknown>> {
  if (patientIds.some((p) => !isUuid(p))) throw new PrivacyValidationError(['patientIds']);
  const r = await tx.query(
    `SELECT id, patient_id, kind, channel, status, detail, verification_method, verified_at, decided_at, decision_reason, due_at, created_at
       FROM privacy.request WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [[...patientIds]],
  );
  return {
    requests: (r.rows as Row[]).map((x) => ({
      id: x['id'],
      patientId: x['patient_id'],
      kind: x['kind'],
      channel: x['channel'],
      status: x['status'],
      detail: x['detail'],
      verificationMethod: x['verification_method'],
      verifiedAt: iso(x['verified_at']),
      decidedAt: iso(x['decided_at']),
      decisionReason: x['decision_reason'],
      dueAt: iso(x['due_at']),
      createdAt: iso(x['created_at']),
    })),
  };
}

/** Registers the merge participant with the kernel registry at start-up. A second call is a RegistryError. */
export function registerPrivacyParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registries.registerMergeParticipant(privacyMergeParticipant);
}
