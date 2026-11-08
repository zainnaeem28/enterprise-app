// Merge and export participation of the encounters and notes (ARCHITECTURE 22.11, 22.16, 24; SHARED-BOUNDARIES 9.2):
// `clinical.repointPatient` and `clinical.exportPart` for the tables of BE-17. Both run in the caller's transaction (the merge
// transaction of 25.4, the export job) as `system` in a patients-scope job whose `job_patient_ids` include the IDs involved.
//
//   clinical.encounter     R open, in_consultation     K completed, cancelled
//   clinical.note          R draft, pending_cosign     K signed (locked: its content is never edited, and it is never re-pointed)
//   clinical.note_cosign   K, append-only: counted as kept and never touched
//   clinical.note_addendum K, append-only: counted as kept and never touched. A NEW addendum to a note of a merged patient carries the
//                          survivor's patient ID from the start (22.11); the existing rows stay as written
//
// Conflict rules: 22.16 gives none for these tables ("None"). No unique constraint spans two patients (the encounter's unique key is the
// reservation, which has one patient), so re-pointing cannot collide.
//
// The registry takes ONE participant per module: this is a `ClinicalMergePart` / `ClinicalExportPart` that the composition root adds to
// the lists of `registerClinicalParticipants` next to the chart's and the front door's (`registerNotesParticipants` in index.ts).
import type { MergeParticipant, Tx } from '@ehr/kernel';
import { ChartScopeError, ChartValidationError } from '../chart/errors.js';
import type { ClinicalExportPart, ClinicalMergePart } from '../chart/merge.js';
import { isUuid } from '../chart/ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

interface Spec {
  table: string;
  /** The R states, or null when every row is K. */
  rStates: readonly string[] | null;
  rule: string;
}

const NO_UNIQUE =
  'No unique constraint spans two patients, so re-pointing cannot collide (22.16: None). ';

export const NOTES_SPECS: readonly Spec[] = [
  {
    table: 'clinical.encounter',
    rStates: ['open', 'in_consultation'],
    rule:
      NO_UNIQUE +
      'open and in_consultation are R and move with their patient; completed and cancelled are K and stay',
  },
  {
    table: 'clinical.note',
    rStates: ['draft', 'pending_cosign'],
    rule:
      NO_UNIQUE +
      'draft and pending_cosign are R and move with their patient (content unchanged); signed is K: locked, never edited and never re-pointed',
  },
  {
    table: 'clinical.note_cosign',
    rStates: null,
    rule: 'Append-only, all K: counted as kept, never touched',
  },
  {
    table: 'clinical.note_addendum',
    rStates: null,
    rule: "Append-only, all K: counted as kept, never touched. A new addendum to a merged patient's note carries the survivor's patient ID",
  },
];

export const NOTES_MERGE_TABLES = NOTES_SPECS.map((s) => s.table);
export const NOTES_CONFLICT_RULES: readonly ConflictRule[] = NOTES_SPECS.map((s) => ({
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

export const notesMergePart: ClinicalMergePart = {
  tables: NOTES_MERGE_TABLES,
  conflictRules: NOTES_CONFLICT_RULES,
  async repointPatient(tx, mergedId, survivorId, requestId): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new ChartValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);

    // Lock first, in id order: a concurrent sign, save or completion of one of these rows waits, so a row is never read in two states
    // (a note signed while it is being counted would be both R and K). The append-only tables cannot change; they are read, not locked.
    for (const s of NOTES_SPECS.filter((x) => x.rStates !== null))
      await tx.query(
        `SELECT x.id FROM ${s.table} x WHERE x.patient_id = $1::uuid ORDER BY x.id FOR UPDATE`,
        [mergedId],
      );

    const out: MergeCounts[] = [];
    for (const s of NOTES_SPECS) {
      const found = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${s.table} WHERE patient_id = $1::uuid`,
        [mergedId],
      );
      let moved = 0;
      if (s.rStates !== null) {
        const u = await tx.query(
          `UPDATE ${s.table} SET patient_id = $2::uuid WHERE patient_id = $1::uuid AND status = ANY($3::text[])`,
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
    for (const s of NOTES_SPECS) {
      if (s.rStates === null) continue;
      const left = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${s.table} WHERE patient_id = $1::uuid AND status = ANY($2::text[])`,
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

/**
 * The privacy export part (22.16, 24): the patient's own encounters, notes (with their content), co-signatures and addenda, every
 * status. The content is the patient's data and is exported; principal IDs are exported as IDs.
 */
export const notesExportPart: ClinicalExportPart = {
  async exportPart(tx, patientIds): Promise<Record<string, unknown>> {
    if (patientIds.some((p) => !isUuid(p))) throw new ChartValidationError(['patientIds']);
    const ids = [...patientIds];
    const q = async (sql: string): Promise<Row[]> => (await tx.query(sql, [ids])).rows as Row[];
    const encounters = await q(
      `SELECT * FROM clinical.encounter WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const notes = await q(
      `SELECT * FROM clinical.note WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const cosigns = await q(
      `SELECT * FROM clinical.note_cosign WHERE patient_id = ANY($1::uuid[]) ORDER BY cosigned_at, note_id`,
    );
    const addenda = await q(
      `SELECT * FROM clinical.note_addendum WHERE patient_id = ANY($1::uuid[]) ORDER BY signed_at, id`,
    );
    return {
      encounters: encounters.map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        locationId: x['location_id'],
        reservationId: x['reservation_id'],
        clinicianPrincipalId: x['clinician_principal_id'],
        mode: x['mode'],
        status: x['status'],
        startedAt: iso(x['started_at']),
        endedAt: iso(x['ended_at']),
        noteDeferredReason: x['note_deferred_reason'],
        createdAt: iso(x['created_at']),
      })),
      notes: notes.map((x) => ({
        id: x['id'],
        encounterId: x['encounter_id'],
        patientId: x['patient_id'],
        authorPrincipalId: x['author_principal_id'],
        templateId: x['template_id'],
        body: x['body'],
        status: x['status'],
        submittedForCosignAt: iso(x['submitted_for_cosign_at']),
        cosignRequiredFrom: x['cosign_required_from'],
        signedAt: iso(x['signed_at']),
        signedBy: x['signed_by'],
        createdAt: iso(x['created_at']),
      })),
      noteCosigns: cosigns.map((x) => ({
        noteId: x['note_id'],
        patientId: x['patient_id'],
        supervisorPrincipalId: x['supervisor_principal_id'],
        cosignedAt: iso(x['cosigned_at']),
      })),
      noteAddenda: addenda.map((x) => ({
        id: x['id'],
        noteId: x['note_id'],
        patientId: x['patient_id'],
        authorPrincipalId: x['author_principal_id'],
        body: x['body'],
        signedAt: iso(x['signed_at']),
      })),
    };
  },
};
