// Merge and export participation of the booking core (ARCHITECTURE 22.16, 24): `scheduling.repointPatient` and
// `scheduling.exportPart`. Both run in the caller's transaction (the merge transaction of 25.4, the export job) as `system` in a
// patients-scope job whose `job_patient_ids` include the IDs involved.
//
//   scheduling.slot_reservation   R: the occupancy is held, confirmed or checked_in -> re-pointed
//                                 K: every other occupancy status -> kept (the trigger of 0901 refuses any update of a K row)
//
// There is no unique constraint on the patient, so no conflict rule applies, and the overlap and BR-04 rules are NOT re-applied: a
// merge never cancels an appointment. The participant reports how many of the survivor's future active reservations now overlap
// (`overlaps_after_merge`) in an audit row for the requester's follow-up (22.16): the counts object of the merge is table-keyed and
// owned by the patient module, so there is no member to carry a count that is not a table.
import { defaultRegistries } from '@ehr/kernel';
import type { ExportContributor, MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { SchedulingScopeError, SchedulingValidationError } from './errors.js';
import { isUuid } from './ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

export const SCHEDULING_MERGE_TABLES = ['scheduling.slot_reservation'] as const;

export const SCHEDULING_CONFLICT_RULES: readonly ConflictRule[] = [
  {
    table: 'scheduling.slot_reservation',
    rule: 'No unique constraint on the patient. R: occupancy held, confirmed, checked_in. K: every other status. The overlap and BR-04 rules are not re-applied; overlaps_after_merge is reported in the audit row of the merge',
  },
];

const R_STATES = ['held', 'confirmed', 'checked_in'];

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new SchedulingScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new SchedulingScopeError();
}

const count = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

export const schedulingMergeParticipant: MergeParticipant = {
  module: 'scheduling',
  tables: SCHEDULING_MERGE_TABLES,
  conflictRules: SCHEDULING_CONFLICT_RULES,
  async repointPatient(
    tx: Tx,
    mergedId: string,
    survivorId: string,
    requestId: string,
  ): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new SchedulingValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);

    // The rows are locked first, in id order, so a concurrent cancel or confirm of one of them waits (a status change under a merge
    // would move a row between R and K after it had been counted).
    await tx.query(
      `SELECT r.id FROM scheduling.slot_reservation r WHERE r.patient_id = $1::uuid ORDER BY r.id FOR UPDATE`,
      [mergedId],
    );
    const found = await count(
      tx,
      `SELECT count(*)::int AS n FROM scheduling.slot_reservation WHERE patient_id = $1::uuid`,
      [mergedId],
    );
    const kept = await count(
      tx,
      `SELECT count(*)::int AS n FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
        WHERE r.patient_id = $1::uuid AND o.status <> ALL($2::text[])`,
      [mergedId, R_STATES],
    );
    const moved = await tx.query(
      `UPDATE scheduling.slot_reservation r SET patient_id = $2::uuid
         FROM scheduling.slot_occupancy o
        WHERE o.id = r.id AND r.patient_id = $1::uuid AND o.status = ANY($3::text[])`,
      [mergedId, survivorId, R_STATES],
    );
    // 22.16 step 4: no R row may be left on the merged ID.
    const left = await count(
      tx,
      `SELECT count(*)::int AS n FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
        WHERE r.patient_id = $1::uuid AND o.status = ANY($2::text[])`,
      [mergedId, R_STATES],
    );
    if (left !== 0) throw new Error('scheduling.repointPatient: an R row is left on the merged patient');
    const repointed = moved.rowCount ?? 0;
    if (found !== repointed + kept)
      throw new Error('scheduling.repointPatient: counts do not add up for scheduling.slot_reservation');

    const overlaps = await count(
      tx,
      `SELECT count(*)::int AS n
         FROM scheduling.slot_reservation a JOIN scheduling.slot_occupancy oa ON oa.id = a.id
         JOIN scheduling.slot_reservation b ON b.patient_id = a.patient_id AND b.id > a.id
         JOIN scheduling.slot_occupancy ob ON ob.id = b.id
        WHERE a.patient_id = $1::uuid AND oa.status = ANY($2::text[]) AND ob.status = ANY($2::text[])
          AND upper(oa.period) > now() AND upper(ob.period) > now() AND oa.period && ob.period`,
      [survivorId, R_STATES],
    );
    await tx.query(
      `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
       VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'merge', 'scheduling.slot_reservation', $2::uuid, $3::uuid, $4::jsonb, 'allowed')`,
      [
        `scheduling.repointPatient:${requestId}`.slice(0, 200),
        requestId,
        survivorId,
        JSON.stringify({ survivorId, mergedId, overlapsAfterMerge: overlaps }),
      ],
    );
    return [{ table: 'scheduling.slot_reservation', found, repointed, resolved: 0, kept, deleted: [] }];
  },
};

/** The privacy export part (22.16, 24): the patient's reservations with their appointment status and time. No clinician names, no free text beyond the stored reason. */
export const schedulingExportContributor: ExportContributor = {
  module: 'scheduling',
  async exportPart(tx: Tx, patientIds: readonly string[], _requestId: string): Promise<unknown> {
    if (patientIds.some((p) => !isUuid(p))) throw new SchedulingValidationError(['patientIds']);
    const r = await tx.query(
      `SELECT r.id, r.patient_id, r.service_id, r.location_id, r.clinician_principal_id, r.mode, r.reason, r.patient_stated_state,
              r.licensing_result, r.booked_via, r.booked_by_principal_id, r.rescheduled_from_id, r.cancel_reason, r.late_change,
              r.created_at, o.status, lower(o.period) AS starts_at, upper(o.period) AS ends_at, o.room_id
         FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
        WHERE r.patient_id = ANY($1::uuid[]) ORDER BY lower(o.period), r.id`,
      [[...patientIds]],
    );
    const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));
    return {
      reservations: (r.rows as Row[]).map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        serviceId: x['service_id'],
        locationId: x['location_id'],
        clinicianId: x['clinician_principal_id'],
        roomId: x['room_id'],
        mode: x['mode'],
        reason: x['reason'],
        patientStatedState: x['patient_stated_state'],
        licensingResult: x['licensing_result'],
        bookedVia: x['booked_via'],
        bookedByPrincipalId: x['booked_by_principal_id'],
        rescheduledFromId: x['rescheduled_from_id'],
        cancelReason: x['cancel_reason'],
        lateChange: x['late_change'],
        status: x['status'],
        startsAt: iso(x['starts_at']),
        endsAt: iso(x['ends_at']),
        createdAt: iso(x['created_at']),
      })),
    };
  },
};

/** Registers both with the kernel registries at start-up. A second call is a RegistryError. */
export function registerSchedulingParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registries.registerMergeParticipant(schedulingMergeParticipant);
  registries.registerExportContributor(schedulingExportContributor);
}
