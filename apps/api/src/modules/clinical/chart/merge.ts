// Merge and export participation of the clinical chart (ARCHITECTURE 22.11, 22.16, 24; SHARED-BOUNDARIES 9.2): `clinical.repointPatient`
// and `clinical.exportPart` for the chart tables. Both run in the caller's transaction (the merge transaction of 25.4, the export job)
// as `system` in a patients-scope job whose `job_patient_ids` include the IDs involved.
//
//   clinical.problem, .allergy, .medication_statement   R, every status (22.16: "all"): the record follows the patient
//   clinical.vital_sign                                  K, append-only: counted as kept and never touched; a correction of a merged
//                                                        ID's row is a new row on the survivor (VitalsService.correctVital)
//
// Conflict rules: 22.16 gives none for these tables ("None. Duplicates are kept and shown; reconciliation is a clinical task"). No
// unique constraint involves the patient, so re-pointing cannot collide. In particular nothing here merges, de-duplicates or drops an
// allergy or a medication: two records that both list penicillin both survive on the survivor, so no allergy is lost to a merge.
//
// There is ONE participant per module name in the F-04 registry, and the clinical schema is shared by several tickets (this one:
// the chart; BE-17: encounters and notes; BE-18: questionnaires, triage, referrals). `clinicalMergeParticipant(parts)` composes the
// parts the composition root hands it, in the order given, into the single registered participant; the later tickets export their own
// `ClinicalMergePart` / `ClinicalExportPart` and are added to the two lists at registration.
import { defaultRegistries } from '@ehr/kernel';
import type { ExportContributor, MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { ChartScopeError, ChartValidationError } from './errors.js';
import { isUuid } from './ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

export interface ClinicalMergePart {
  tables: readonly string[];
  conflictRules: readonly ConflictRule[];
  repointPatient(
    tx: Tx,
    mergedId: string,
    survivorId: string,
    requestId: string,
  ): Promise<MergeCounts[]>;
}
export interface ClinicalExportPart {
  /** The keys this part adds to the clinical export (they must not collide with another part's). */
  exportPart(
    tx: Tx,
    patientIds: readonly string[],
    requestId: string,
  ): Promise<Record<string, unknown>>;
}

export const CHART_MERGE_TABLES = [
  'clinical.problem',
  'clinical.allergy',
  'clinical.medication_statement',
  'clinical.vital_sign',
] as const;

const NO_RULE = (what: string): string =>
  `No unique constraint on the patient. R in every status: ${what} keeps its ID and moves to the survivor. Duplicates are kept and shown (22.16); reconciliation is a clinical task`;

export const CHART_CONFLICT_RULES: readonly ConflictRule[] = [
  { table: 'clinical.problem', rule: NO_RULE('a problem') },
  {
    table: 'clinical.allergy',
    rule:
      NO_RULE('an allergy') +
      '. Two allergies for one substance both stay; none is dropped or merged',
  },
  {
    table: 'clinical.medication_statement',
    rule:
      NO_RULE('a medication statement') +
      '. Two statements for one drug both stay; none is dropped or merged',
  },
  {
    table: 'clinical.vital_sign',
    rule: "Append-only, all K: counted as kept, never touched. A correction of a merged ID's row is a new row on the survivor",
  },
];

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new ChartScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new ChartScopeError();
}

const count = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

const R_TABLES = ['clinical.problem', 'clinical.allergy', 'clinical.medication_statement'] as const;

export const chartMergePart: ClinicalMergePart = {
  tables: CHART_MERGE_TABLES,
  conflictRules: CHART_CONFLICT_RULES,
  async repointPatient(tx, mergedId, survivorId, requestId): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new ChartValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);

    // Lock first, in id order: a concurrent status change of one of these rows waits (an entry marked entered in error under a merge
    // would otherwise be read in two states). The rows are all R, so the lock does not depend on a state.
    for (const t of R_TABLES)
      await tx.query(
        `SELECT x.id FROM ${t} x WHERE x.patient_id = $1::uuid ORDER BY x.id FOR UPDATE`,
        [mergedId],
      );

    const out: MergeCounts[] = [];
    for (const t of R_TABLES) {
      const found = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${t} WHERE patient_id = $1::uuid`,
        [mergedId],
      );
      const moved = await tx.query(
        `UPDATE ${t} SET patient_id = $2::uuid WHERE patient_id = $1::uuid`,
        [mergedId, survivorId],
      );
      out.push({
        table: t,
        found,
        repointed: moved.rowCount ?? 0,
        resolved: 0,
        kept: 0,
        deleted: [],
      });
    }
    const vitals = await count(
      tx,
      `SELECT count(*)::int AS n FROM clinical.vital_sign WHERE patient_id = $1::uuid`,
      [mergedId],
    );
    out.push({
      table: 'clinical.vital_sign',
      found: vitals,
      repointed: 0,
      resolved: 0,
      kept: vitals,
      deleted: [],
    });

    // 22.16 step 4: no R row may be left on the merged ID, and every table's counts add up.
    let left = 0;
    for (const t of R_TABLES)
      left += await count(tx, `SELECT count(*)::int AS n FROM ${t} WHERE patient_id = $1::uuid`, [
        mergedId,
      ]);
    if (left !== 0)
      throw new Error('clinical.repointPatient: an R row is left on the merged patient');
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
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The privacy export part (22.16, 24): the patient's own chart record, every status, including entries marked entered in error (they
 * are part of the record). Free text and codes are the patient's data and are exported; principal IDs are exported as IDs.
 */
export const chartExportPart: ClinicalExportPart = {
  async exportPart(tx, patientIds): Promise<Record<string, unknown>> {
    if (patientIds.some((p) => !isUuid(p))) throw new ChartValidationError(['patientIds']);
    const ids = [...patientIds];
    const q = async (sql: string): Promise<Row[]> => (await tx.query(sql, [ids])).rows as Row[];
    const problems = await q(
      `SELECT * FROM clinical.problem WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const allergies = await q(
      `SELECT * FROM clinical.allergy WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const meds = await q(
      `SELECT * FROM clinical.medication_statement WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const vitals = await q(
      `SELECT * FROM clinical.vital_sign WHERE patient_id = ANY($1::uuid[]) ORDER BY measured_at, id`,
    );
    return {
      problems: problems.map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        codeSystem: x['code_system'],
        code: x['code'],
        display: x['display'],
        coded: x['coded'],
        status: x['status'],
        onsetDate: day(x['onset_date']),
        resolvedDate: day(x['resolved_date']),
        recordedByPrincipalId: x['recorded_by'],
        createdAt: iso(x['created_at']),
      })),
      allergies: allergies.map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        codeSystem: x['code_system'],
        code: x['code'],
        display: x['display'],
        coded: x['coded'],
        category: x['category'],
        reaction: x['reaction'],
        severity: x['severity'],
        status: x['status'],
        onsetDate: day(x['onset_date']),
        resolvedDate: day(x['resolved_date']),
        recordedByPrincipalId: x['recorded_by'],
        createdAt: iso(x['created_at']),
      })),
      medications: meds.map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        rxnormCode: x['rxnorm_code'],
        display: x['display'],
        coded: x['coded'],
        doseText: x['dose_text'],
        status: x['status'],
        startDate: day(x['start_date']),
        endDate: day(x['end_date']),
        recordedByPrincipalId: x['recorded_by'],
        createdAt: iso(x['created_at']),
      })),
      vitals: vitals.map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        encounterId: x['encounter_id'],
        checkInId: x['check_in_id'],
        loincCode: x['loinc_code'],
        value: num(x['value']),
        unit: x['unit'],
        rangeStatus: x['range_status'],
        rangeLow: num(x['range_low']),
        rangeHigh: num(x['range_high']),
        measuredAt: iso(x['measured_at']),
        byPrincipalId: x['by_principal_id'],
        correctsId: x['corrects_id'],
        enteredInError: x['entered_in_error'],
        createdAt: iso(x['created_at']),
      })),
    };
  },
};

/** The single `clinical` merge participant, composed of the parts of the clinical tickets. */
export function clinicalMergeParticipant(
  parts: readonly ClinicalMergePart[] = [chartMergePart],
): MergeParticipant {
  return {
    module: 'clinical',
    tables: parts.flatMap((p) => p.tables),
    conflictRules: parts.flatMap((p) => p.conflictRules),
    async repointPatient(tx, mergedId, survivorId, requestId): Promise<MergeCounts[]> {
      const out: MergeCounts[] = [];
      for (const p of parts)
        out.push(...(await p.repointPatient(tx, mergedId, survivorId, requestId)));
      return out;
    },
  };
}

/** The single `clinical` export contributor: every part's keys, side by side; a key two parts both return is a programming error. */
export function clinicalExportContributor(
  parts: readonly ClinicalExportPart[] = [chartExportPart],
): ExportContributor {
  return {
    module: 'clinical',
    async exportPart(tx, patientIds, requestId): Promise<unknown> {
      const out: Record<string, unknown> = {};
      for (const p of parts)
        for (const [k, v] of Object.entries(await p.exportPart(tx, patientIds, requestId))) {
          if (k in out) throw new Error(`clinical export key ${k} returned by two parts`);
          out[k] = v;
        }
      return out;
    },
  };
}

/** Registers both with the kernel registries at start-up. A second call is a RegistryError. */
export function registerClinicalParticipants(
  registries: ParticipantRegistries = defaultRegistries,
  parts: { merge?: readonly ClinicalMergePart[]; export?: readonly ClinicalExportPart[] } = {},
): void {
  registries.registerMergeParticipant(clinicalMergeParticipant(parts.merge ?? [chartMergePart]));
  registries.registerExportContributor(
    clinicalExportContributor(parts.export ?? [chartExportPart]),
  );
}
