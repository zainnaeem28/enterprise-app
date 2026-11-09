// Job type and event of the alert part (ARCHITECTURE 33.1, 32.4). The handler is `escalateAlert` in `escalate.ts`; the worker
// registers it (apps/worker/src/jobs/notifications is outside this ticket's paths: see README, ALR-N2).
import type { JobRegistry, JobType } from '@ehr/kernel';

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
  // Handlers of the events that raise a compliance alert (SEC05-F03). `kernel.publish` creates `notifications.on_<event>` for each
  // registered handler; the worker runs them (apps/worker/src/jobs/notifications/compliance-alerts.ts holds the same definitions).
  {
    name: 'notifications.on_btg_opened',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  {
    name: 'notifications.on_anchor_mismatch',
    maxAttempts: 8,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'handler',
  },
  {
    name: 'notifications.on_kill_switch_used',
    maxAttempts: 8,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'handler',
  },
];

/** Events whose handler is the compliance alert of this module. */
export const COMPLIANCE_ALERT_EVENTS = [
  'audit.btg_opened',
  'audit.anchor_mismatch',
  'identity.kill_switch_used',
] as const;

export function registerComplianceAlertHandlers(
  registry: Pick<JobRegistry, 'registerHandler'>,
): void {
  for (const e of COMPLIANCE_ALERT_EVENTS) registry.registerHandler(e, 'notifications');
}

/** Published when an alert is still unacknowledged at its time: the owning module re-targets (25.5). */
export const ALERT_UNACKNOWLEDGED = 'notifications.alert_unacknowledged';
export const ALERT_EVENTS = [ALERT_UNACKNOWLEDGED] as const;

/** One escalation per alert in R1 (32.4); a repeat is the D-12a decision BQ-12. */
export const ESCALATION_LEVEL = 1;
