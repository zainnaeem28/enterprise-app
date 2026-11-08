// Merge and export participation of the clinical front door (ARCHITECTURE 22.11, 22.16, 24; SHARED-BOUNDARIES 9.2):
// `clinical.repointPatient` and `clinical.exportPart` for the tables of BE-18. Both run in the caller's transaction (the merge
// transaction of 25.4, the export job) as `system` in a patients-scope job whose `job_patient_ids` include the IDs involved.
//
//   clinical.questionnaire_response  R in_progress          K submitted
//   clinical.triage_assessment       K, append-only: counted as kept and never touched
//   clinical.referral                R draft, sent, accepted  K declined, completed, cancelled
//   clinical.consent_exception       K, append-only: counted as kept and never touched
//   clinical.follow_up               R open, booked           K done, cancelled
//
// Conflict rules: 22.16 gives none for these tables ("None"); no unique constraint spans two patients, so re-pointing cannot collide.
// (The unique index of questionnaire_response is per patient, visit and template, and a visit has one patient.) `referral_inbox` has
// no patient column and is not a participant: it names the referral, and the referral moves.
//
// The registry takes ONE participant per module: this is a `ClinicalMergePart` / `ClinicalExportPart` that the composition root adds
// to the lists of `registerClinicalParticipants` next to the chart's (see `registerFrontdoorParticipants` in index.ts).
import type { MergeParticipant, Tx } from '@ehr/kernel';
import { ChartScopeError, ChartValidationError } from '../chart/errors.js';
import type { ClinicalExportPart, ClinicalMergePart } from '../chart/merge.js';
import { isUuid } from './ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

interface Spec {
  table: string;
  /** SQL list of the R states, or null when every row is K. */
  rStates: readonly string[] | null;
  statusCol: string;
  rule: string;
}

const NO_UNIQUE =
  'No unique constraint spans two patients, so re-pointing cannot collide (22.16: None). ';

export const FRONTDOOR_SPECS: readonly Spec[] = [
  {
    table: 'clinical.questionnaire_response',
    rStates: ['in_progress'],
    statusCol: 'status',
    rule: NO_UNIQUE + 'in_progress is R and moves with its patient; submitted is K and stays',
  },
  {
    table: 'clinical.triage_assessment',
    rStates: null,
    statusCol: 'check_in_id',
    rule: 'Append-only, all K: counted as kept, never touched',
  },
  {
    table: 'clinical.referral',
    rStates: ['draft', 'sent', 'accepted'],
    statusCol: 'status',
    rule:
      NO_UNIQUE +
      'draft, sent and accepted are R; declined, completed and cancelled are K. The inbox row names the referral and follows it',
  },
  {
    table: 'clinical.consent_exception',
    rStates: null,
    statusCol: 'encounter_id',
    rule: 'Append-only, all K: counted as kept, never touched',
  },
  {
    table: 'clinical.follow_up',
    rStates: ['open', 'booked'],
    statusCol: 'status',
    rule: NO_UNIQUE + 'open and booked are R; done and cancelled are K',
  },
];

export const FRONTDOOR_MERGE_TABLES = FRONTDOOR_SPECS.map((s) => s.table);
export const FRONTDOOR_CONFLICT_RULES: readonly ConflictRule[] = FRONTDOOR_SPECS.map((s) => ({
  table: s.table,
  rule: s.rule,
}));

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new ChartScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new ChartScopeError();
}

const count = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

export const frontdoorMergePart: ClinicalMergePart = {
  tables: FRONTDOOR_MERGE_TABLES,
  conflictRules: FRONTDOOR_CONFLICT_RULES,
  async repointPatient(tx, mergedId, survivorId, requestId): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new ChartValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);

    // Lock first, in id order: a concurrent status change of one of these rows waits, so a row is never read in two states. The
    // append-only tables (all K) cannot change and the job has no UPDATE right on them, so they are read, not locked.
    for (const s of FRONTDOOR_SPECS.filter((x) => x.rStates !== null))
      await tx.query(
        `SELECT x.id FROM ${s.table} x WHERE x.patient_id = $1::uuid ORDER BY x.id FOR UPDATE`,
        [mergedId],
      );

    const out: MergeCounts[] = [];
    for (const s of FRONTDOOR_SPECS) {
      const found = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${s.table} WHERE patient_id = $1::uuid`,
        [mergedId],
      );
      let moved = 0;
      if (s.rStates !== null) {
        const u = await tx.query(
          `UPDATE ${s.table} SET patient_id = $2::uuid WHERE patient_id = $1::uuid AND ${s.statusCol} = ANY($3::text[])`,
          [mergedId, survivorId, [...s.rStates]],
        );
        moved = u.rowCount ?? 0;
      }
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
    for (const s of FRONTDOOR_SPECS) {
      if (s.rStates === null) continue;
      const left = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${s.table} WHERE patient_id = $1::uuid AND ${s.statusCol} = ANY($2::text[])`,
        [mergedId, [...s.rStates]],
      );
      if (left !== 0)
        throw new Error(
          `clinical.repointPatient: an R row is left on the merged patient (${s.table})`,
        );
    }
    for (const c of out)
      if (c.found !== c.repointed + c.kept + c.resolved)
        throw new Error(`clinical.repointPatient: counts do not add up for ${c.table}`);
    return out;
  },
};

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);
const day = (v: unknown): string | null =>
  v instanceof Date
    ? v.toISOString().slice(0, 10)
    : v === null || v === undefined
      ? null
      : String(v).slice(0, 10);

/**
 * The privacy export part (22.16, 24): the patient's own front-door record, every status. Answers, notes and reasons are the
 * patient's data and are exported; principal IDs are exported as IDs.
 */
export const frontdoorExportPart: ClinicalExportPart = {
  async exportPart(tx, patientIds): Promise<Record<string, unknown>> {
    if (patientIds.some((p) => !isUuid(p))) throw new ChartValidationError(['patientIds']);
    const ids = [...patientIds];
    const q = async (sql: string): Promise<Row[]> => (await tx.query(sql, [ids])).rows as Row[];
    const responses = await q(
      `SELECT * FROM clinical.questionnaire_response WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const triage = await q(
      `SELECT * FROM clinical.triage_assessment WHERE patient_id = ANY($1::uuid[]) ORDER BY assessed_at, id`,
    );
    const referrals = await q(
      `SELECT * FROM clinical.referral WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const exceptions = await q(
      `SELECT * FROM clinical.consent_exception WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const followUps = await q(
      `SELECT * FROM clinical.follow_up WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    return {
      questionnaireResponses: responses.map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        reservationId: x['reservation_id'],
        templateKey: x['template_key'],
        templateVersion: x['template_version'],
        answers: x['answers'],
        status: x['status'],
        submittedAt: iso(x['submitted_at']),
        redFlag: x['red_flag'],
        createdAt: iso(x['created_at']),
      })),
      triageAssessments: triage.map((x) => ({
        id: x['id'],
        checkInId: x['check_in_id'],
        patientId: x['patient_id'],
        locationId: x['location_id'],
        category: x['category'],
        symptoms: x['symptoms'],
        notes: x['notes'],
        redFlag: x['red_flag'],
        alertId: x['alert_id'],
        byPrincipalId: x['by_principal_id'],
        assessedAt: iso(x['assessed_at']),
        supersedesId: x['supersedes_id'],
      })),
      referrals: referrals.map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        fromLocationId: x['from_location_id'],
        fromPrincipalId: x['from_principal_id'],
        targetKind: x['target_kind'],
        targetLocationId: x['target_location_id'],
        targetServiceId: x['target_service_id'],
        targetExternalText: x['target_external_text'],
        reason: x['reason'],
        status: x['status'],
        decidedBy: x['decided_by'],
        decidedAt: iso(x['decided_at']),
        declineReason: x['decline_reason'],
        createdAt: iso(x['created_at']),
      })),
      consentExceptions: exceptions.map((x) => ({
        id: x['id'],
        encounterId: x['encounter_id'],
        patientId: x['patient_id'],
        missingTemplates: x['missing_templates'],
        reason: x['reason'],
        byPrincipalId: x['by_principal_id'],
        createdAt: iso(x['created_at']),
      })),
      followUps: followUps.map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        locationId: x['location_id'],
        serviceId: x['service_id'],
        requestedBy: x['requested_by'],
        ownerPrincipalId: x['owner_principal_id'],
        dueOn: day(x['due_on']),
        reason: x['reason'],
        status: x['status'],
        bookedReservationId: x['booked_reservation_id'],
        closedAt: iso(x['closed_at']),
        createdAt: iso(x['created_at']),
      })),
    };
  },
};
