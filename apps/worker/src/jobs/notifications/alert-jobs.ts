// The staff-alert escalation timer (ARCHITECTURE 32.4, 33.1). The API's alert service enqueues `notifications.escalate_alert` in the
// caller's transaction; the work is the API's `escalateAlert`, reached through the port below (`apps/api/src/worker-ports.ts`).
// Keep apps/api/src/modules/notifications/alerts/jobs.ts in step (a test compares them).
import type { Task } from 'graphile-worker';
import type { JobType, KernelDb, Tx } from '@ehr/kernel';
import { jobUuid } from '../messaging/index.js';
import { patientsScope, systemScope } from '../clinical/scope.js';

export const ALERT_JOBS: readonly JobType[] = [
  {
    name: 'notifications.escalate_alert',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
];

export interface AlertWorkerPort {
  /** `escalateAlert` on the transaction the handler opened; `jobId` is a UUID naming the queue job (stable across redelivery). */
  escalateAlert(
    tx: Tx,
    payload: { alertId: string; level: number },
    jobId: string,
  ): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAlertTasks(deps: {
  db: KernelDb;
  orgId: string;
  alerts: AlertWorkerPort;
}): Record<string, Task> {
  return {
    'notifications.escalate_alert': async (payload, helpers) => {
      const p = payload as Record<string, unknown>;
      const alertId = p['alertId'];
      const level = p['level'];
      if (typeof alertId !== 'string' || !UUID.test(alertId))
        throw new Error('alertId is required');
      if (typeof level !== 'number') throw new Error('level is required');
      const patientId = p['patientId'];
      // A patient alert runs in a patients scope for its patient; an admin-realm alert (no patient) in the org scope.
      const scope =
        typeof patientId === 'string' && UUID.test(patientId)
          ? patientsScope(deps.orgId, [patientId.toLowerCase()])
          : systemScope(deps.orgId);
      const jobId = jobUuid('notifications.escalate_alert', String(helpers.job.id));
      await deps.db.withScope(scope, (tx) =>
        deps.alerts.escalateAlert(tx, { alertId: alertId.toLowerCase(), level }, jobId),
      );
    },
  };
}
