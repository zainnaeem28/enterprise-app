// Task handlers of the identity module (ARCHITECTURE 33.1). `createIdentityTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `defineIdentityJobs` registers the types with the JobRegistry. The runner does not pass a
// crontab yet: IDENTITY_CRONTAB is wired at integration.
import type { Task } from 'graphile-worker';
import type { JobRegistry, KernelDb, Queue } from '@ehr/kernel';
import { runApplyReferenceData } from './apply-reference-data.js';
import { IDENTITY_JOBS } from './jobs.js';
import { runPurgeSessions } from './purge-sessions.js';
import { runRecordSignIn } from './record-sign-in.js';

export { IDENTITY_CRONTAB, IDENTITY_EVENTS, IDENTITY_JOBS } from './jobs.js';
export { expandRole, expandedMapping, checksum, runApplyReferenceData, ReferenceDataError } from './apply-reference-data.js';
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
}

export function createIdentityTasks(deps: IdentityTaskDeps): Record<string, Task> {
  return {
    'identity.record_sign_in': async (payload, helpers) => {
      await runRecordSignIn(
        { db: deps.db, orgId: deps.orgId, queue: deps.queue, ...(deps.workspaceDomain === undefined ? {} : { workspaceDomain: deps.workspaceDomain }) },
        payload as Record<string, unknown>,
        String(helpers.job.id),
      );
    },
    'identity.apply_reference_data': async (_payload, helpers) => {
      await runApplyReferenceData({ db: deps.db, orgId: deps.orgId, jobId: String(helpers.job.id) });
    },
    'identity.purge_sessions': async () => {
      await runPurgeSessions({ db: deps.db, orgId: deps.orgId });
    },
  };
}
