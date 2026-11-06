// Merge and export participation (ARCHITECTURE 22.16, 24): `notifications.repointPatient` and `notifications.exportPart`.
// Both run in the caller's transaction (the merge transaction of 25.4, the export job), as `system` in a patients-scope job
// whose `job_patient_ids` include the IDs involved.
//
//   notifications.notification  R: queued, sending, failed -> re-pointed    K: sent, suppressed, cancelled -> kept
//   notifications.delivery_receipt, notifications.in_app_read  append-only, all K: counted as kept, never touched
//
// No unique constraint can collide: a dedupe key never contains a patient ID (22.13). The receipts of a kept notification
// that arrive AFTER the merge attach to the survivor (the receipt handler resolves it), so nothing ever writes a row for a
// merged ID. The staff-alert tables (BE-07) are added to this participant by that ticket.
import { defaultRegistries } from '@ehr/kernel';
import type { ExportContributor, MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { NotificationsScopeError, NotificationsValidationError } from './errors.js';
import { isUuid } from './ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];

export const NOTIFICATIONS_MERGE_TABLES = [
  'notifications.notification',
  'notifications.delivery_receipt',
  'notifications.in_app_read',
] as const;

export const NOTIFICATIONS_CONFLICT_RULES: readonly ConflictRule[] = [
  {
    table: 'notifications.notification',
    rule: 'UQ (dedupe_key) cannot collide, because dedupe keys never contain a patient ID (22.13). R: queued, sending, failed (a retry still updates them). K: sent, suppressed, cancelled',
  },
];

const R_STATES = ['queued', 'sending', 'failed'];

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new NotificationsScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new NotificationsScopeError();
}

async function count(tx: Tx, sql: string, params: unknown[]): Promise<number> {
  return Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);
}

export const notificationsMergeParticipant: MergeParticipant = {
  module: 'notifications',
  tables: NOTIFICATIONS_MERGE_TABLES,
  conflictRules: NOTIFICATIONS_CONFLICT_RULES,
  async repointPatient(
    tx: Tx,
    mergedId: string,
    survivorId: string,
    requestId: string,
  ): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new NotificationsValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);

    const found = await count(
      tx,
      `SELECT count(*)::int AS n FROM notifications.notification WHERE patient_id = $1`,
      [mergedId],
    );
    const moved = await tx.query(
      `UPDATE notifications.notification SET patient_id = $2 WHERE patient_id = $1 AND status = ANY($3::text[])`,
      [mergedId, survivorId, R_STATES],
    );
    const notification: MergeCounts = {
      table: 'notifications.notification',
      found,
      repointed: moved.rowCount ?? 0,
      resolved: 0,
      kept: 0,
      deleted: [],
    };
    notification.kept = found - notification.repointed;
    const receipts = await count(
      tx,
      `SELECT count(*)::int AS n FROM notifications.delivery_receipt WHERE patient_id = $1`,
      [mergedId],
    );
    const reads = await count(
      tx,
      `SELECT count(*)::int AS n FROM notifications.in_app_read WHERE patient_id = $1`,
      [mergedId],
    );
    const counts: MergeCounts[] = [
      notification,
      {
        table: 'notifications.delivery_receipt',
        found: receipts,
        repointed: 0,
        resolved: 0,
        kept: receipts,
        deleted: [],
      },
      {
        table: 'notifications.in_app_read',
        found: reads,
        repointed: 0,
        resolved: 0,
        kept: reads,
        deleted: [],
      },
    ];
    // 22.16 step 4: no R row may be left on the merged ID, and found = re-pointed + resolved + kept.
    const left = await count(
      tx,
      `SELECT count(*)::int AS n FROM notifications.notification WHERE patient_id = $1 AND status = ANY($2::text[])`,
      [mergedId, R_STATES],
    );
    if (left !== 0)
      throw new Error('notifications.repointPatient: an R row is left on the merged patient');
    for (const c of counts)
      if (c.found !== c.repointed + c.resolved + c.kept)
        throw new Error(`notifications.repointPatient: counts do not add up for ${c.table}`);
    return counts;
  },
};

export const notificationsExportContributor: ExportContributor = {
  module: 'notifications',
  /**
   * What notifications holds about the patients: which notices were sent, when, on which channel, and what happened to
   * them. Template key/version and allowlisted values only; no address and no message text is stored, so none is exported.
   */
  async exportPart(tx: Tx, patientIds: readonly string[], requestId: string): Promise<unknown> {
    if (!isUuid(requestId) || patientIds.length === 0 || patientIds.some((p) => !isUuid(p)))
      throw new NotificationsValidationError(['patientIds', 'requestId']);
    mustBeMergeJob(tx, patientIds);
    const notifications = await tx.query(
      `SELECT id, patient_id, template_key, template_version, channel, language, variables, status, suppress_reason,
              attempts, send_after, sent_at, created_at
         FROM notifications.notification WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id, created_at, id`,
      [patientIds],
    );
    const receipts = await tx.query(
      `SELECT id, notification_id, patient_id, status, received_at FROM notifications.delivery_receipt
        WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id, received_at, id`,
      [patientIds],
    );
    const reads = await tx.query(
      `SELECT notification_id, patient_id, read_at FROM notifications.in_app_read
        WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id, read_at, notification_id`,
      [patientIds],
    );
    return {
      module: 'notifications',
      notifications: notifications.rows,
      deliveryReceipts: receipts.rows,
      inAppReads: reads.rows,
    };
  },
};

/** Registers both with the kernel registries (22.16, 24). Called once at start-up; a second call is a RegistryError. */
export function registerNotificationsParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registries.registerMergeParticipant(notificationsMergeParticipant);
  registries.registerExportContributor(notificationsExportContributor);
}
