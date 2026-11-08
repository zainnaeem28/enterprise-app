// Job type and event of the alert part (ARCHITECTURE 33.1, 32.4). The handler is `escalateAlert` in `escalate.ts`; the worker
// registers it (apps/worker/src/jobs/notifications is outside this ticket's paths: see README, ALR-N2).
import type { JobType } from '@ehr/kernel';

export const ALERT_JOBS: readonly JobType[] = [
  // Runs at `escalate_at`. Patient alerts carry their patient ID (the job then runs in a patients scope and resolves a merge);
  // an alert without a patient (admin realm) carries only the alert ID and runs in an org scope.
  {
    name: 'notifications.escalate_alert',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
];

/** Published when an alert is still unacknowledged at its time: the owning module re-targets (25.5). */
export const ALERT_UNACKNOWLEDGED = 'notifications.alert_unacknowledged';
export const ALERT_EVENTS = [ALERT_UNACKNOWLEDGED] as const;

/** One escalation per alert in R1 (32.4); a repeat is the D-12a decision BQ-12. */
export const ESCALATION_LEVEL = 1;
