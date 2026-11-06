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
): Promise<MergeCounts> {
  const found = await n(tx, `SELECT count(*)::int AS n FROM ${table} WHERE patient_id = $1`, [
    merged,
  ]);
  const moved = await tx.query(`UPDATE ${table} SET patient_id = $2 WHERE patient_id = $1`, [
    merged,
    survivor,
  ]);
  return counts(table, found, moved.rowCount ?? 0, 0, 0);
}

async function consents(tx: Tx, merged: string, survivor: string): Promise<MergeCounts> {
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
  let resolved = 0;
  // Signed on both for one template: the higher version wins, then the later signing time; ties go to the survivor.
  const pairs = (
    await tx.query(
      `SELECT m.id AS m_id, s.id AS s_id,
              (m.template_version, m.signed_at) > (s.template_version, s.signed_at) AS merged_wins
         FROM patient.consent m JOIN patient.consent s
           ON s.patient_id = $2 AND s.template_key = m.template_key AND s.status = 'signed'
        WHERE m.patient_id = $1 AND m.status = 'signed'
        ORDER BY m.id FOR UPDATE OF m, s`,
      [merged, survivor],
    )
  ).rows as Row[];
  for (const p of pairs) {
    const loser = p['merged_wins'] === true ? p['s_id'] : p['m_id'];
    await tx.query(`UPDATE patient.consent SET status = 'superseded' WHERE id = $1`, [loser]);
    if (p['merged_wins'] !== true) resolved += 1; // a loser on the merged ID stays there as K
  }
  // Pending on both for one template version: the survivor's pending request stays; the merged one is withdrawn.
  const dup = await tx.query(
    `UPDATE patient.consent m SET status = 'withdrawn', reason = 'merged_duplicate'
      WHERE m.patient_id = $1 AND m.status = 'pending'
        AND EXISTS (SELECT 1 FROM patient.consent s WHERE s.patient_id = $2 AND s.status = 'pending'
                       AND s.template_key = m.template_key AND s.template_version = m.template_version)`,
    [merged, survivor],
  );
  resolved += dup.rowCount ?? 0;
  const moved = await tx.query(
    `UPDATE patient.consent SET patient_id = $2 WHERE patient_id = $1 AND status IN ('pending', 'signed')`,
    [merged, survivor],
  );
  return counts('patient.consent', found, moved.rowCount ?? 0, resolved, kept);
}

async function preferences(tx: Tx, merged: string, survivor: string): Promise<MergeCounts> {
  const found = await n(
    tx,
    `SELECT count(*)::int AS n FROM patient.communication_preference WHERE patient_id = $1`,
    [merged],
  );
  const deleted = (
    await tx.query(
      `DELETE FROM patient.communication_preference m
        WHERE m.patient_id = $1 AND EXISTS (SELECT 1 FROM patient.communication_preference s WHERE s.patient_id = $2)
        RETURNING to_jsonb(m) AS row`,
      [merged, survivor],
    )
  ).rows.map((r) => (r as Row)['row']);
  const moved = await tx.query(
    `UPDATE patient.communication_preference SET patient_id = $2 WHERE patient_id = $1`,
    [merged, survivor],
  );
  return counts(
    'patient.communication_preference',
    found,
    moved.rowCount ?? 0,
    deleted.length,
    0,
    deleted,
  );
}

async function careTeam(tx: Tx, merged: string, survivor: string): Promise<MergeCounts> {
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
  const ended = await tx.query(
    `UPDATE patient.care_team_member m SET to_date = greatest(current_date, m.from_date), end_reason = 'merged_duplicate'
      WHERE m.patient_id = $1 AND m.to_date IS NULL
        AND EXISTS (SELECT 1 FROM patient.care_team_member s WHERE s.patient_id = $2 AND s.to_date IS NULL
                       AND s.principal_id = m.principal_id AND s.role = m.role)`,
    [merged, survivor],
  );
  const moved = await tx.query(
    `UPDATE patient.care_team_member SET patient_id = $2 WHERE patient_id = $1 AND to_date IS NULL`,
    [merged, survivor],
  );
  return counts('patient.care_team_member', found, moved.rowCount ?? 0, ended.rowCount ?? 0, kept);
}

async function flags(tx: Tx, merged: string, survivor: string): Promise<MergeCounts> {
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
  let resolved = 0;
  let repointed = 0;
  // 1. Flags between the two merging patients, either direction.
  const between = await tx.query(
    `UPDATE patient.duplicate_flag SET status = 'resolved', resolved_reason = 'merged'
      WHERE status IN ('open', 'merge_requested')
        AND ((patient_id = $1 AND candidate_patient_id = $2) OR (patient_id = $2 AND candidate_patient_id = $1))`,
    [merged, survivor],
  );
  resolved += between.rowCount ?? 0;
  // 2. The rest, oldest first: the survivor takes the merged side; a doubled pair keeps the older flag.
  const rest = (
    await tx.query(
      `SELECT id, patient_id, candidate_patient_id, created_at FROM patient.duplicate_flag
        WHERE status IN ('open', 'merge_requested') AND (patient_id = $1 OR candidate_patient_id = $1)
        ORDER BY created_at, id FOR UPDATE`,
      [merged],
    )
  ).rows as Row[];
  for (const f of rest) {
    const other = f['patient_id'] === merged ? f['candidate_patient_id'] : f['patient_id'];
    const e = (
      await tx.query(
        `SELECT id, created_at FROM patient.duplicate_flag
          WHERE status IN ('open', 'merge_requested') AND id <> $3
            AND ((patient_id = $1 AND candidate_patient_id = $2) OR (patient_id = $2 AND candidate_patient_id = $1))
          FOR UPDATE`,
        [survivor, other, f['id']],
      )
    ).rows[0] as Row | undefined;
    if (e !== undefined) {
      const fNewer =
        (f['created_at'] as Date).getTime() > (e['created_at'] as Date).getTime() ||
        ((f['created_at'] as Date).getTime() === (e['created_at'] as Date).getTime() &&
          String(f['id']) > String(e['id']));
      if (fNewer) {
        await tx.query(
          `UPDATE patient.duplicate_flag SET status = 'resolved', resolved_reason = 'merged_duplicate' WHERE id = $1`,
          [f['id']],
        );
        resolved += 1;
        continue;
      }
      await tx.query(
        `UPDATE patient.duplicate_flag SET status = 'resolved', resolved_reason = 'merged_duplicate' WHERE id = $1`,
        [e['id']],
      );
    }
    await tx.query(
      `UPDATE patient.duplicate_flag
          SET patient_id = CASE WHEN patient_id = $2 THEN $3::uuid ELSE patient_id END,
              candidate_patient_id = CASE WHEN candidate_patient_id = $2 THEN $3::uuid ELSE candidate_patient_id END
        WHERE id = $1`,
      [f['id'], merged, survivor],
    );
    repointed += 1;
  }
  return counts('patient.duplicate_flag', found, repointed, resolved, kept);
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
      await simple(tx, 'patient.patient_contact', mergedId, survivorId),
      await simple(tx, 'patient.insurance_coverage', mergedId, survivorId),
      await consents(tx, mergedId, survivorId),
      await preferences(tx, mergedId, survivorId),
      await careTeam(tx, mergedId, survivorId),
      await flags(tx, mergedId, survivorId),
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
