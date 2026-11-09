// Handlers of the three events that raise a compliance alert (ARCHITECTURE 24, 25.5, SEC05-F03): `audit.btg_opened`,
// `audit.anchor_mismatch` and `identity.kill_switch_used`. `kernel.publish` creates one `notifications.on_<event>` job per registered
// handler, so the worker's registry registers the three below (`registerComplianceAlertHandlers`) and the API's registry does the same
// for the events the API publishes. Each job raises the alert under system scope through the port (the API's `AlertService`), with
// IDs only and no patient on the alert (ADR-022). A missing recipient fails the job, which dead-letters visibly.
import type { Task } from 'graphile-worker';
import type { JobRegistry, JobType, KernelDb } from '@ehr/kernel';
import { COMPLIANCE_PERMISSION, type ComplianceAlertPort } from '../identity/admin-events.js';
import { isUuid, systemScope } from '../identity/scope.js';
import { jobUuid } from '../messaging/index.js';

export const COMPLIANCE_ALERT_JOBS: readonly JobType[] = [
  {
    name: 'notifications.on_btg_opened',
    maxAttempts: 8,
    // The event payload names the patient; the alert does not. A merged patient resolves the job (it needs no patient to run).
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

/** Event -> handler module; the same three lines are in the API's registration (a test pins that every published event has a handler). */
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

export function createComplianceAlertTasks(deps: {
  db: KernelDb;
  orgId: string;
  alerts: ComplianceAlertPort;
}): Record<string, Task> {
  const raise = (
    name: string,
    input: Parameters<ComplianceAlertPort['raise']>[1],
    libraryJobId: unknown,
  ): Promise<void> =>
    deps.db.withScope(systemScope(deps.orgId), async (tx) => {
      await deps.alerts.raise(tx, input, jobUuid(name, String(libraryJobId)));
    });
  return {
    'notifications.on_btg_opened': async (payload, helpers) => {
      const grantId = (payload as Record<string, unknown>)['grantId'];
      if (!isUuid(grantId)) throw new Error('notifications.on_btg_opened: bad grantId');
      await raise(
        'notifications.on_btg_opened',
        {
          type: 'btg_opened',
          severity: 'high',
          resourceType: 'audit.btg_grant',
          resourceId: grantId.toLowerCase(),
          permission: COMPLIANCE_PERMISSION,
        },
        helpers.job.id,
      );
    },
    'notifications.on_anchor_mismatch': async (payload, helpers) => {
      const anchorId = (payload as Record<string, unknown>)['anchorId'];
      if (typeof anchorId !== 'number' || !Number.isInteger(anchorId) || anchorId < 0)
        throw new Error('notifications.on_anchor_mismatch: bad anchorId');
      await raise(
        'notifications.on_anchor_mismatch',
        {
          type: 'audit_anchor_mismatch',
          severity: 'critical',
          resourceType: 'audit.anchor',
          // The anchor's key is a bigint; an alert names its resource by UUID, so the same anchor always maps to the same one.
          resourceId: jobUuid('audit.anchor', String(anchorId)),
          permission: COMPLIANCE_PERMISSION,
        },
        helpers.job.id,
      );
    },
    'notifications.on_kill_switch_used': async (payload, helpers) => {
      const principalId = (payload as Record<string, unknown>)['principalId'];
      if (!isUuid(principalId))
        throw new Error('notifications.on_kill_switch_used: bad principalId');
      await raise(
        'notifications.on_kill_switch_used',
        {
          type: 'kill_switch_used',
          severity: 'critical',
          resourceType: 'identity.principal',
          resourceId: principalId.toLowerCase(),
          permission: COMPLIANCE_PERMISSION,
        },
        helpers.job.id,
      );
    },
  };
}
