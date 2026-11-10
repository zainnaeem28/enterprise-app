// The merge participant of the patient module (ARCHITECTURE 22.16): `repointPatient` for the tables `patient` itself holds that carry
// a patient_id and are R or R/K. It runs in the caller's transaction (the merge transaction of 25.4) as `system` in a patients-scope
// job whose `job_patient_ids` include both IDs, like the identity and notifications participants. The care relationships, the root
// and the merge map are not participants: `complete_merge` (0803) handles them. `staff_scope`, `patient_merge`, `merge_request`
// and `match_check` are exempt or carry no patient_id; `merge_residue` is append-only (all K) and is never touched.
//
//   patient.patient_contact, patient.insurance_coverage     R (all)                           no unique constraint
//   patient.consent                 R pending, signed         K superseded, withdrawn         UQ signed (patient, template); UQ pending (patient, template, version)
//   patient.communication_preference R (all)                                                    PK (patient): the survivor's row wins; the merged row is deleted and returned
//   patient.care_team_member        R active                  K ended                         UQ active (patient, principal, role): the survivor's wins; the merged row is ended
//   patient.duplicate_flag          R open, merge_requested   K not_duplicate, resolved       flags between the two are resolved; others get the survivor; a doubled pair keeps the older flag
// SEC03-F11: app_worker holds SELECT only on these tables. Every write goes through a patient_scope_owner function of migration 2503
// (patient.merge_repoint_*, scheduling.merge_repoint_slot_reservation), which refuses unless `requestId` is the executing merge of
// the job's two patients; the row locks (FOR UPDATE) are taken inside them too.
import { defaultRegistries } from '@ehr/kernel';
import type { MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { PatientScopeError, PatientValidationError } from '../errors.js';
import { isUuid } from '../ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

export const PATIENT_MERGE_TABLES = [
  'patient.patient_contact',
  'patient.insurance_coverage',
  'patient.consent',
  'patient.communication_preference',
  'patient.care_team_member',
  'patient.duplicate_flag',
] as const;

export const PATIENT_CONFLICT_RULES: readonly ConflictRule[] = [
  {
    table: 'patient.consent',
    rule: 'UQ (patient, template) WHERE signed: keep the signed consent with the higher template_version, then the later signed_at; set the other to superseded (K). UQ (patient, template, version) WHERE pending: a merged pending consent for a version the survivor already has pending is withdrawn (reason merged_duplicate, K). R: pending, signed. K: superseded, withdrawn',
  },
  {
    table: 'patient.communication_preference',
    rule: "PK (patient): if both patients have a row, keep the survivor's and delete the merged row (returned for residue)",
  },
  {
    table: 'patient.care_team_member',
    rule: "UQ active (patient, principal, role): keep the survivor's row; end the merged row (to_date = current date, end_reason merged_duplicate, K). R: active. K: ended",
  },
  {
    table: 'patient.duplicate_flag',
    rule: 'Every open flag between the two merging patients (either direction) is set resolved (reason merged). Open flags of other patients whose candidate is the merged ID get the survivor as candidate; if that leaves two open flags for the same pair, the newer one is set resolved (reason merged_duplicate). R: open, merge_requested. K: not_duplicate, resolved',
  },
];

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new PatientScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new PatientScopeError();
}

async function n(tx: Tx, sql: string, params: unknown[]): Promise<number> {
  return Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);
}

// `kept` is counted from the rows' own K state before any rule runs, not derived, so found = repointed + resolved + kept is a real check.
const counts = (
  table: string,
  found: number,
  repointed: number,
  resolved: number,
  kept: number,
  deleted: unknown[] = [],
): MergeCounts => ({ table, found, repointed, resolved, kept, deleted });

/** Tables whose every row is R and has no unique constraint: one set-based UPDATE. */
async function simple(
  tx: Tx,
  table: 'patient.patient_contact' | 'patient.insurance_coverage',
  merged: string,
  survivor: string,
  requestId: string,
): Promise<MergeCounts> {
  const found = await n(tx, `SELECT count(*)::int AS n FROM ${table} WHERE patient_id = $1`, [
    merged,
  ]);
  const fn =
    table === 'patient.patient_contact'
      ? 'patient.merge_repoint_patient_contact'
      : 'patient.merge_repoint_insurance_coverage';
  const moved = await n(tx, `SELECT ${fn}($1::uuid) AS n`, [requestId]);
  return counts(table, found, moved, 0, 0);
}

async function consents(
  tx: Tx,
  merged: string,
  survivor: string,
  requestId: string,
): Promise<MergeCounts> {
  const found = await n(
    tx,
    `SELECT count(*)::int AS n FROM patient.consent WHERE patient_id = $1`,
    [merged],
  );
  const kept = await n(
    tx,
    `SELECT count(*)::int AS n FROM patient.consent WHERE patient_id = $1 AND status IN ('superseded', 'withdrawn')`,
    [merged],
  );
  // Signed on both for one template: the higher version wins, then the later signing time; ties go to the survivor. Pending on both
  // for one template version: the merged one is withdrawn. Then the pending and signed rows move. All three steps run in the function.
  const r = (
    await tx.query(`SELECT repointed, resolved FROM patient.merge_repoint_consent($1::uuid)`, [
      requestId,
    ])
  ).rows[0] as Row;
  return counts('patient.consent', found, Number(r['repointed']), Number(r['resolved']), kept);
}

async function preferences(
  tx: Tx,
  merged: string,
  survivor: string,
  requestId: string,
): Promise<MergeCounts> {
  const found = await n(
    tx,
    `SELECT count(*)::int AS n FROM patient.communication_preference WHERE patient_id = $1`,
    [merged],
  );
  const r = (
    await tx.query(
      `SELECT repointed, deleted FROM patient.merge_repoint_communication_preference($1::uuid)`,
      [requestId],
    )
  ).rows[0] as Row;
  const deleted = r['deleted'] as unknown[];
  return counts(
    'patient.communication_preference',
    found,
    Number(r['repointed']),
    deleted.length,
    0,
    deleted,
  );
}

async function careTeam(
  tx: Tx,
  merged: string,
  survivor: string,
  requestId: string,
): Promise<MergeCounts> {
  const found = await n(
    tx,
    `SELECT count(*)::int AS n FROM patient.care_team_member WHERE patient_id = $1`,
    [merged],
  );
  const kept = await n(
    tx,
    `SELECT count(*)::int AS n FROM patient.care_team_member WHERE patient_id = $1 AND to_date IS NOT NULL`,
    [merged],
  );
  const r = (
    await tx.query(
      `SELECT repointed, ended FROM patient.merge_repoint_care_team_member($1::uuid)`,
      [requestId],
    )
  ).rows[0] as Row;
  return counts(
    'patient.care_team_member',
    found,
    Number(r['repointed']),
    Number(r['ended']),
    kept,
  );
}

async function flags(
  tx: Tx,
  merged: string,
  survivor: string,
  requestId: string,
): Promise<MergeCounts> {
  const found = await n(
    tx,
    `SELECT count(*)::int AS n FROM patient.duplicate_flag WHERE patient_id = $1 OR candidate_patient_id = $1`,
    [merged],
  );
  const kept = await n(
    tx,
    `SELECT count(*)::int AS n FROM patient.duplicate_flag
      WHERE (patient_id = $1 OR candidate_patient_id = $1) AND status IN ('not_duplicate', 'resolved')`,
    [merged],
  );
  // 1. Flags between the two merging patients, either direction, are resolved. 2. The rest, oldest first: the survivor takes the merged
  // side; a doubled pair keeps the older flag. Both steps run in the function.
  const r = (
    await tx.query(
      `SELECT repointed, resolved FROM patient.merge_repoint_duplicate_flag($1::uuid)`,
      [requestId],
    )
  ).rows[0] as Row;
  return counts(
    'patient.duplicate_flag',
    found,
    Number(r['repointed']),
    Number(r['resolved']),
    kept,
  );
}

export const patientMergeParticipant: MergeParticipant = {
  module: 'patient',
  tables: PATIENT_MERGE_TABLES,
  conflictRules: PATIENT_CONFLICT_RULES,
  async repointPatient(
    tx: Tx,
    mergedId: string,
    survivorId: string,
    requestId: string,
  ): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new PatientValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);
    const out = [
      await simple(tx, 'patient.patient_contact', mergedId, survivorId, requestId),
      await simple(tx, 'patient.insurance_coverage', mergedId, survivorId, requestId),
      await consents(tx, mergedId, survivorId, requestId),
      await preferences(tx, mergedId, survivorId, requestId),
      await careTeam(tx, mergedId, survivorId, requestId),
      await flags(tx, mergedId, survivorId, requestId),
    ];
    // 22.16 step 4: no R row may be left on the merged ID.
    const left = await n(
      tx,
      `SELECT (SELECT count(*) FROM patient.patient_contact WHERE patient_id = $1)
            + (SELECT count(*) FROM patient.insurance_coverage WHERE patient_id = $1)
            + (SELECT count(*) FROM patient.consent WHERE patient_id = $1 AND status IN ('pending', 'signed'))
            + (SELECT count(*) FROM patient.communication_preference WHERE patient_id = $1)
            + (SELECT count(*) FROM patient.care_team_member WHERE patient_id = $1 AND to_date IS NULL)
            + (SELECT count(*) FROM patient.duplicate_flag WHERE status IN ('open', 'merge_requested') AND (patient_id = $1 OR candidate_patient_id = $1)) AS n`,
      [mergedId],
    );
    if (left !== 0)
      throw new Error('patient.repointPatient: an R row is left on the merged patient');
    for (const c of out)
      if (c.found !== c.repointed + c.resolved + c.kept)
        throw new Error(`patient.repointPatient: counts do not add up for ${c.table}`);
    return out;
  },
};

/** Registers the patient participant with the kernel registry (22.16). Called once at start-up; a second call is a RegistryError. */
export function registerPatientParticipant(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registries.registerMergeParticipant(patientMergeParticipant);
}
