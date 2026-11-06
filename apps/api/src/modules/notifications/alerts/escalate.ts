// `notifications.escalate_alert` (ARCHITECTURE 32.4): the logic of the escalation timer job. The worker registers a handler that
// opens a transaction in the job's scope (patients scope with the payload's patient ID, or org scope for an alert without a
// patient) and calls `escalateAlert`.
//
// The job RE-READS the alert under a row lock. It does nothing when the alert is closed, already acknowledged, already
// escalated, or has no `escalate_at` (acknowledge clears it, so a timer that fires after an acknowledgement finds nothing to do).
// Otherwise it raises the level, sets `status = 'escalated'`, clears `escalate_at` (one escalation per alert in R1), records
// the `escalated` event and publishes `notifications.alert_unacknowledged`, on which the owning module re-targets (25.5).
// Idempotent by (alert, level): the level must be exactly one above the stored one, and the event table allows one `escalated`
// event per alert.
import type { Queue, Tx } from '@ehr/kernel';
import { isUuid, uuidv7 } from '../ids.js';
import { NotificationsValidationError } from '../errors.js';
import type { AuditService } from '../../audit/index.js';
import { ALERT_UNACKNOWLEDGED, ESCALATION_LEVEL } from './jobs.js';

export type EscalationOutcome =
  | 'escalated'
  | 'not_found'
  | 'closed'
  | 'acknowledged'
  | 'already_escalated'
  | 'no_timer'
  | 'stale_level'
  | 'rescheduled';

export interface EscalationPayload {
  alertId: string;
  level: number;
}

export async function escalateAlert(
  tx: Tx,
  queue: Queue,
  payload: EscalationPayload,
  opts: { jobId?: string; audit?: AuditService } = {},
): Promise<EscalationOutcome> {
  if (!isUuid(payload.alertId) || payload.level !== ESCALATION_LEVEL)
    throw new NotificationsValidationError(['alertId', 'level']);
  if (tx.scope.audience !== 'system') throw new NotificationsValidationError(['scope']);
  const r = await tx.query(
    `SELECT id, status, patient_id, escalation_level, escalate_at, (escalate_at <= now()) AS due
       FROM notifications.staff_alert WHERE id = $1 FOR UPDATE`,
    [payload.alertId],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return 'not_found';
  const status = row['status'];
  if (status === 'closed') return 'closed';
  if (status === 'acknowledged') return 'acknowledged';
  if (status === 'escalated') return 'already_escalated';
  if (row['escalate_at'] === null) return 'no_timer';
  if (Number(row['escalation_level']) + 1 !== payload.level) return 'stale_level';
  const patientId = (row['patient_id'] as string | null) ?? null;
  if (row['due'] !== true) {
    // Ran early (clock difference): put the same job back at its time instead of escalating ahead of the setting.
    await queue.enqueue(
      tx,
      'notifications.escalate_alert',
      patientId === null
        ? { alertId: payload.alertId, level: payload.level }
        : { alertId: payload.alertId, patientId, level: payload.level },
      { runAt: row['escalate_at'] as Date, jobKey: `alert:${payload.alertId}:${payload.level}` },
    );
    return 'rescheduled';
  }
  await tx.query(
    `UPDATE notifications.staff_alert
        SET status = 'escalated', escalation_level = $2, escalate_at = NULL WHERE id = $1`,
    [payload.alertId, payload.level],
  );
  await tx.query(
    `INSERT INTO notifications.staff_alert_event (id, organisation_id, alert_id, patient_id, kind, principal_id, created_by_job)
     VALUES ($1, $2, $3, $4, 'escalated', NULL, $5)`,
    [uuidv7(), tx.scope.orgId, payload.alertId, patientId, opts.jobId ?? null],
  );
  if (opts.audit !== undefined && opts.jobId !== undefined) {
    await opts.audit.record(tx, {
      action: 'update',
      jobId: opts.jobId,
      requestId: null,
      resourceType: 'notifications.staff_alert',
      resourceId: payload.alertId,
      patientId,
      change: { status: 'escalated', level: payload.level },
    });
  }
  await queue.publish(
    tx,
    ALERT_UNACKNOWLEDGED,
    patientId === null
      ? { alertId: payload.alertId, level: payload.level }
      : { alertId: payload.alertId, patientId, level: payload.level },
  );
  return 'escalated';
}
