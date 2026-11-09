// Task handlers of the identity module (ARCHITECTURE 33.1). `createIdentityTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `defineIdentityJobs` registers the types with the JobRegistry. The runner does not pass a
// crontab yet: IDENTITY_CRONTAB is wired at integration.
import type { Task } from 'graphile-worker';
import type { JobRegistry, KernelDb, Queue } from '@ehr/kernel';
import { runApplyReferenceData } from './apply-reference-data.js';
import { runAdminEvent, type AdminEventDeps } from './admin-events.js';
import { IDENTITY_JOBS } from './jobs.js';
import { jobUuid } from '../messaging/index.js';
import { runPurgeSessions } from './purge-sessions.js';
import { runRecordSignIn } from './record-sign-in.js';

export {
  ADMIN_EVENT_KINDS,
  IDENTITY_ADMIN_JOBS,
  IDENTITY_CRONTAB,
  IDENTITY_EVENTS,
  IDENTITY_JOBS,
} from './jobs.js';
export { runAdminEvent, COMPLIANCE_PERMISSION, MIN_ACTIVE_CREDENTIALS } from './admin-events.js';
export type {
  AdminEventDeps,
  ComplianceAlertInput,
  ComplianceAlertPort,
  SecurityNotice,
  SecurityNoticePort,
} from './admin-events.js';
export {
  expandRole,
  expandedMapping,
  checksum,
  runApplyReferenceData,
  ReferenceDataError,
} from './apply-reference-data.js';
export { PERMISSIONS, ROLES, REFERENCE_DATASET, REFERENCE_VERSION } from './reference-data.js';
export { eventIdFor, runRecordSignIn } from './record-sign-in.js';
export { runPurgeSessions, PURGE_AFTER_HOURS } from './purge-sessions.js';

export function defineIdentityJobs(registry: JobRegistry): void {
  for (const j of IDENTITY_JOBS) registry.defineJob(j);
}

export interface IdentityTaskDeps {
  db: KernelDb;
  orgId: string;
  /** Worker-path queue (`new Queue(registry, 'worker')`). */
  queue: Queue;
  workspaceDomain?: string;
  /** Ports of `identity.admin_event` (alert and security-contact notice). Absent: the handler refuses, so the job retries and dead-letters. */
  adminEvents?: Pick<AdminEventDeps, 'alerts' | 'notice'>;
}

export function createIdentityTasks(deps: IdentityTaskDeps): Record<string, Task> {
  return {
    'identity.record_sign_in': async (payload, helpers) => {
      await runRecordSignIn(
        {
          db: deps.db,
          orgId: deps.orgId,
          queue: deps.queue,
          ...(deps.workspaceDomain === undefined ? {} : { workspaceDomain: deps.workspaceDomain }),
        },
        payload as Record<string, unknown>,
        String(helpers.job.id),
      );
    },
    'identity.admin_event': async (payload, helpers) => {
      if (deps.adminEvents === undefined)
        throw new Error('identity.admin_event: alert and notice ports are not configured');
      const key = (helpers.job as { key?: string | null }).key;
      await runAdminEvent(
        { db: deps.db, orgId: deps.orgId, ...deps.adminEvents },
        payload as Record<string, unknown>,
        jobUuid('identity.admin_event', String(helpers.job.id)),
        `identity.admin_event:${key ?? String(helpers.job.id)}`,
      );
    },
    'identity.apply_reference_data': async (_payload, helpers) => {
      await runApplyReferenceData({
        db: deps.db,
        orgId: deps.orgId,
        jobId: String(helpers.job.id),
      });
    },
    'identity.purge_sessions': async () => {
      await runPurgeSessions({ db: deps.db, orgId: deps.orgId });
    },
  };
}
