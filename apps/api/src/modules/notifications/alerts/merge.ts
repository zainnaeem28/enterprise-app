// Merge and export contribution of the alert tables (ARCHITECTURE 22.16, 22.13; NOT-N12). The notifications module has ONE merge
// participant (`../merge.ts`, BE-06); it must call these functions and add `ALERT_MERGE_TABLES` and `ALERT_CONFLICT_RULES` to its
// own lists (README, ALR-N4: that file is outside this ticket's paths, so the three-line edit is requested, not made here).
//
//   notifications.staff_alert        R: open, acknowledged, escalated -> re-pointed (an alert still lives on)   K: closed -> kept
//   notifications.staff_alert_event  append-only, all K: counted as kept and never touched (they name the patient of the time)
//   notifications.staff_alert_setting  no patient column
// No unique constraint can collide: nothing unique contains a patient ID. Runs in a patients-scope system job that names the IDs.
import type { ExportContributor, MergeParticipant, Tx } from '@ehr/kernel';
import { NotificationsScopeError, NotificationsValidationError } from '../errors.js';
import { isUuid } from '../ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];

export const ALERT_MERGE_TABLES = [
  'notifications.staff_alert',
  'notifications.staff_alert_event',
] as const;

export const ALERT_CONFLICT_RULES: readonly ConflictRule[] = [
  {
    table: 'notifications.staff_alert',
    rule: 'No unique constraint contains a patient ID. R: open, acknowledged, escalated (the alert and its escalation timer are still live). K: closed',
  },
];

const R_STATES = ['open', 'acknowledged', 'escalated'];

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new NotificationsScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new NotificationsScopeError();
}

const n = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

/** The alert part of `notifications.repointPatient(mergedId, survivorId, requestId)`. */
export async function repointAlertRows(
  tx: Tx,
  mergedId: string,
  survivorId: string,
): Promise<MergeCounts[]> {
  if (!isUuid(mergedId) || !isUuid(survivorId))
    throw new NotificationsValidationError(['mergedId', 'survivorId']);
  mustBeMergeJob(tx, [mergedId, survivorId]);
  const found = await n(
    tx,
    `SELECT count(*)::int AS n FROM notifications.staff_alert WHERE patient_id = $1`,
    [mergedId],
  );
  const moved = await tx.query(
    `UPDATE notifications.staff_alert SET patient_id = $2 WHERE patient_id = $1 AND status = ANY($3::text[])`,
    [mergedId, survivorId, R_STATES],
  );
  const alert: MergeCounts = {
    table: 'notifications.staff_alert',
    found,
    repointed: moved.rowCount ?? 0,
    resolved: 0,
    kept: 0,
    deleted: [],
  };
  alert.kept = found - alert.repointed;
  const events = await n(
    tx,
    `SELECT count(*)::int AS n FROM notifications.staff_alert_event WHERE patient_id = $1`,
    [mergedId],
  );
  const left = await n(
    tx,
    `SELECT count(*)::int AS n FROM notifications.staff_alert WHERE patient_id = $1 AND status = ANY($2::text[])`,
    [mergedId, R_STATES],
  );
  if (left !== 0)
    throw new Error('notifications.repointPatient: an alert R row is left on the merged patient');
  const out: MergeCounts[] = [
    alert,
    {
      table: 'notifications.staff_alert_event',
      found: events,
      repointed: 0,
      resolved: 0,
      kept: events,
      deleted: [],
    },
  ];
  for (const c of out)
    if (c.found !== c.repointed + c.resolved + c.kept)
      throw new Error(`notifications.repointPatient: counts do not add up for ${c.table}`);
  return out;
}

/** The alert part of `notifications.exportPart`: what was raised about the patients and what happened to it. IDs, types, times. */
export const alertExportContributor: Pick<ExportContributor, 'exportPart'> = {
  async exportPart(tx: Tx, patientIds: readonly string[], requestId: string): Promise<unknown> {
    if (!isUuid(requestId) || patientIds.length === 0 || patientIds.some((p) => !isUuid(p)))
      throw new NotificationsValidationError(['patientIds', 'requestId']);
    mustBeMergeJob(tx, patientIds);
    const alerts = await tx.query(
      `SELECT id, type, severity, patient_id, resource_type, resource_id, status, acknowledged_by, acknowledged_at,
              escalation_level, created_at FROM notifications.staff_alert
        WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id, created_at, id`,
      [patientIds],
    );
    const events = await tx.query(
      `SELECT id, alert_id, patient_id, kind, principal_id, at FROM notifications.staff_alert_event
        WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id, at, id`,
      [patientIds],
    );
    return { staffAlerts: alerts.rows, staffAlertEvents: events.rows };
  },
};
