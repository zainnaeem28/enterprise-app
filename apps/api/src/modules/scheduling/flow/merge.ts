// Merge and export participation of the scheduling module (ARCHITECTURE 22.16, 24, 38.2 item 11). The registry takes one participant per
// module, so this one covers every `scheduling` table with a patient: the booking core's `slot_reservation` (delegated to BE-11's
// participant, unchanged) and this ticket's `check_in`, `queue_entry`, `waitlist_entry` and `waitlist_offer`.
//
// Composition: call `registerSchedulingFlowParticipants()` INSTEAD of the core's `registerSchedulingParticipants()` (it registers the
// core's tables too; calling both is a RegistryError, which is the point: a module cannot be registered half).
//
//   table                        R (re-pointed)                      K (kept, never written again)   conflict rule
//   scheduling.check_in          occupancy checked_in                in_consultation, completed,      none (PK = reservation)
//                                                                    no_show
//   scheduling.queue_entry       every stage but done                done                             none
//   scheduling.waitlist_entry    active, offered                     fulfilled, cancelled, expired    both patients active for the same service,
//                                                                                                     place and doctor: the earlier position_at
//                                                                                                     stays, the other is cancelled
//                                                                                                     (merged_duplicate); an offered entry never is
//   scheduling.waitlist_offer    offered                             accepted, declined, expired      none
//
// Every table: found = re-pointed + resolved + kept (SHARED-BOUNDARIES 9.2); no R row may be left on the merged ID (22.16 step 4).
// An open offer on the merged ID is re-pointed together with its held reservation, its entry and its job (`expire_offer`, on_merged =
// resolve): it resolves on the survivor, it is never duplicated.
import { defaultRegistries } from '@ehr/kernel';
import type { ExportContributor, MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import {
  SCHEDULING_CONFLICT_RULES,
  SCHEDULING_MERGE_TABLES,
  schedulingExportContributor,
  schedulingMergeParticipant,
} from '../core/merge.js';
import { SchedulingScopeError, SchedulingValidationError } from '../core/errors.js';
import { isUuid } from '../core/ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

export const FLOW_MERGE_TABLES = [
  'scheduling.check_in',
  'scheduling.queue_entry',
  'scheduling.waitlist_entry',
  'scheduling.waitlist_offer',
] as const;

export const FLOW_CONFLICT_RULES: readonly ConflictRule[] = [
  {
    table: 'scheduling.check_in',
    rule: 'No unique constraint on the patient (PK = reservation ID). R: occupancy checked_in. K: in_consultation, completed, no_show',
  },
  {
    table: 'scheduling.queue_entry',
    rule: 'No unique constraint on the patient (PK = reservation ID). R: every stage except done. K: done',
  },
  {
    table: 'scheduling.waitlist_entry',
    rule: 'If both patients have an active entry for the same service, location and clinician, keep the earlier position_at and set the other to cancelled with cancel_reason merged_duplicate. An offered entry is never cancelled by this rule. R: active, offered. K: fulfilled, cancelled, expired',
  },
  {
    table: 'scheduling.waitlist_offer',
    rule: 'No unique constraint on the patient (UQ is per occupancy). R: offered. K: accepted, declined, expired',
  },
];

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new SchedulingScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new SchedulingScopeError();
}

const count = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

/**
 * One table with no conflict rule. `isR` is a predicate over the alias `t` (and `other`, an optional second table joined on `joinOn`,
 * which the predicate reads). The rows are locked first, in ID order, so a concurrent writer waits instead of moving a row between R and K
 * after it was counted.
 */
async function repointSimple(
  tx: Tx,
  table: string,
  isR: string,
  mergedId: string,
  survivorId: string,
  other?: { table: string; joinOn: string },
): Promise<MergeCounts> {
  const from = other === undefined ? '' : `, ${other.table} o`;
  const on = other === undefined ? 'true' : other.joinOn;
  await tx.query(
    `SELECT t.id FROM ${table} t WHERE t.patient_id = $1::uuid ORDER BY t.id FOR UPDATE`,
    [mergedId],
  );
  const found = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} t WHERE t.patient_id = $1::uuid`,
    [mergedId],
  );
  const kept = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} t${from} WHERE t.patient_id = $1::uuid AND ${on} AND NOT (${isR})`,
    [mergedId],
  );
  const moved = await tx.query(
    `UPDATE ${table} t SET patient_id = $2::uuid ${other === undefined ? '' : `FROM ${other.table} o`}
      WHERE t.patient_id = $1::uuid AND ${on} AND (${isR})`,
    [mergedId, survivorId],
  );
  const left = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} t${from} WHERE t.patient_id = $1::uuid AND ${on} AND (${isR})`,
    [mergedId],
  );
  if (left !== 0)
    throw new Error(
      `scheduling.repointPatient: an R row is left on the merged patient in ${table}`,
    );
  const repointed = moved.rowCount ?? 0;
  if (found !== repointed + kept)
    throw new Error(`scheduling.repointPatient: counts do not add up for ${table}`);
  return { table, found, repointed, resolved: 0, kept, deleted: [] };
}

const ms = (v: unknown): number =>
  v instanceof Date ? v.getTime() : new Date(String(v)).getTime();

async function repointWaitlistEntries(
  tx: Tx,
  mergedId: string,
  survivorId: string,
): Promise<MergeCounts> {
  const table = 'scheduling.waitlist_entry';
  await tx.query(
    `SELECT e.id FROM ${table} e WHERE e.patient_id = ANY($1::uuid[]) ORDER BY e.id FOR UPDATE`,
    [[mergedId, survivorId]],
  );
  const found = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} WHERE patient_id = $1::uuid`,
    [mergedId],
  );
  const kept = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} WHERE patient_id = $1::uuid AND status NOT IN ('active', 'offered')`,
    [mergedId],
  );
  // The conflict rule: the same service, place and doctor, both active. The earlier position_at stays; the other is cancelled.
  let resolved = 0;
  const mine = (
    await tx.query(
      `SELECT id, service_id, location_id, clinician_principal_id, position_at FROM ${table}
        WHERE patient_id = $1::uuid AND status = 'active' ORDER BY position_at, id`,
      [mergedId],
    )
  ).rows as Row[];
  for (const m of mine) {
    const theirs = (
      await tx.query(
        `SELECT id, position_at FROM ${table}
          WHERE patient_id = $1::uuid AND status = 'active' AND service_id = $2::uuid
            AND location_id IS NOT DISTINCT FROM $3::uuid AND clinician_principal_id IS NOT DISTINCT FROM $4::uuid
          ORDER BY position_at, id`,
        [survivorId, m['service_id'], m['location_id'], m['clinician_principal_id']],
      )
    ).rows as Row[];
    if (theirs.length === 0) continue;
    if (ms(theirs[0]?.['position_at']) <= ms(m['position_at'])) {
      // The survivor's entry is earlier (a tie goes to the survivor): the merged patient's row is the duplicate.
      const u = await tx.query(
        `UPDATE ${table} SET status = 'cancelled', cancel_reason = 'merged_duplicate' WHERE id = $1::uuid AND status = 'active'`,
        [m['id']],
      );
      resolved += u.rowCount ?? 0;
    } else {
      // The merged patient's entry is earlier: it stays (and moves), the survivor's duplicates are cancelled.
      await tx.query(
        `UPDATE ${table} SET status = 'cancelled', cancel_reason = 'merged_duplicate' WHERE id = ANY($1::uuid[]) AND status = 'active'`,
        [theirs.map((t) => t['id'])],
      );
    }
  }
  const moved = await tx.query(
    `UPDATE ${table} SET patient_id = $2::uuid WHERE patient_id = $1::uuid AND status IN ('active', 'offered')`,
    [mergedId, survivorId],
  );
  const left = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} WHERE patient_id = $1::uuid AND status IN ('active', 'offered')`,
    [mergedId],
  );
  if (left !== 0)
    throw new Error(
      'scheduling.repointPatient: an R row is left on the merged patient in scheduling.waitlist_entry',
    );
  const repointed = moved.rowCount ?? 0;
  if (found !== repointed + resolved + kept)
    throw new Error(
      'scheduling.repointPatient: counts do not add up for scheduling.waitlist_entry',
    );
  return { table, found, repointed, resolved, kept, deleted: [] };
}

export const schedulingFlowMergeParticipant: MergeParticipant = {
  module: 'scheduling',
  tables: [...SCHEDULING_MERGE_TABLES, ...FLOW_MERGE_TABLES],
  conflictRules: [...SCHEDULING_CONFLICT_RULES, ...FLOW_CONFLICT_RULES],
  async repointPatient(tx, mergedId, survivorId, requestId): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new SchedulingValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);
    // The booking core's table first (BE-11, unchanged): reservations, whose occupancy status decides R and K for the check-in.
    const core = await schedulingMergeParticipant.repointPatient(
      tx,
      mergedId,
      survivorId,
      requestId,
    );
    const checkIn = await repointSimple(
      tx,
      'scheduling.check_in',
      `o.status = 'checked_in'`,
      mergedId,
      survivorId,
      {
        table: 'scheduling.slot_occupancy',
        joinOn: 'o.id = t.id',
      },
    );
    const queue = await repointSimple(
      tx,
      'scheduling.queue_entry',
      `t.stage <> 'done'`,
      mergedId,
      survivorId,
    );
    const entries = await repointWaitlistEntries(tx, mergedId, survivorId);
    const offers = await repointSimple(
      tx,
      'scheduling.waitlist_offer',
      `t.status = 'offered'`,
      mergedId,
      survivorId,
    );
    return [...core, checkIn, queue, entries, offers];
  },
};

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

/** The privacy export part (22.16, 24): the booking core's reservations plus this module's rows. Identifiers, states and times only; no free text. */
export const schedulingFlowExportContributor: ExportContributor = {
  module: 'scheduling',
  async exportPart(tx: Tx, patientIds: readonly string[], requestId: string): Promise<unknown> {
    if (patientIds.some((p) => !isUuid(p))) throw new SchedulingValidationError(['patientIds']);
    const core = (await schedulingExportContributor.exportPart(
      tx,
      patientIds,
      requestId,
    )) as Record<string, unknown>;
    const ids = [...patientIds];
    const checkIns = await tx.query(
      `SELECT id, patient_id, location_id, method, checked_in_at, previsit_status FROM scheduling.check_in WHERE patient_id = ANY($1::uuid[]) ORDER BY checked_in_at, id`,
      [ids],
    );
    const queue = await tx.query(
      `SELECT id, patient_id, location_id, stage, triage_category, entered_at, stage_changed_at FROM scheduling.queue_entry WHERE patient_id = ANY($1::uuid[]) ORDER BY entered_at, id`,
      [ids],
    );
    const entries = await tx.query(
      `SELECT id, patient_id, service_id, location_id, clinician_principal_id, lower("window") AS w_from, upper("window") AS w_to, status, cancel_reason, position_at
         FROM scheduling.waitlist_entry WHERE patient_id = ANY($1::uuid[]) ORDER BY position_at, id`,
      [ids],
    );
    const offers = await tx.query(
      `SELECT id, waitlist_entry_id, patient_id, occupancy_id, status, expires_at, decided_at FROM scheduling.waitlist_offer WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [ids],
    );
    return {
      ...core,
      checkIns: (checkIns.rows as Row[]).map((x) => ({
        reservationId: x['id'],
        patientId: x['patient_id'],
        locationId: x['location_id'],
        method: x['method'],
        checkedInAt: iso(x['checked_in_at']),
        previsit: x['previsit_status'],
      })),
      queueEntries: (queue.rows as Row[]).map((x) => ({
        reservationId: x['id'],
        patientId: x['patient_id'],
        locationId: x['location_id'],
        stage: x['stage'],
        triageCategory: x['triage_category'],
        enteredAt: iso(x['entered_at']),
        stageChangedAt: iso(x['stage_changed_at']),
      })),
      waitlistEntries: (entries.rows as Row[]).map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        serviceId: x['service_id'],
        locationId: x['location_id'],
        clinicianId: x['clinician_principal_id'],
        windowFrom: iso(x['w_from']),
        windowTo: iso(x['w_to']),
        status: x['status'],
        cancelReason: x['cancel_reason'],
        positionAt: iso(x['position_at']),
      })),
      waitlistOffers: (offers.rows as Row[]).map((x) => ({
        id: x['id'],
        waitlistEntryId: x['waitlist_entry_id'],
        patientId: x['patient_id'],
        reservationId: x['occupancy_id'],
        status: x['status'],
        expiresAt: iso(x['expires_at']),
        decidedAt: iso(x['decided_at']),
      })),
    };
  },
};

/** Registers the module's whole participation with the kernel registries at start-up (instead of the core's own). A second call is a RegistryError. */
export function registerSchedulingFlowParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registries.registerMergeParticipant(schedulingFlowMergeParticipant);
  registries.registerExportContributor(schedulingFlowExportContributor);
}
