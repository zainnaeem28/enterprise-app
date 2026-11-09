// The worker's job registry: every job type the worker deployable owns, defined once. `syncTaskTypes` writes it into
// `queue_api.task_type` (ARCHITECTURE 21.8) at worker start and from the deploy-pipeline step (`sync-task-types-cli.ts`).
// Each module's list is pinned equal to the API's copy by that module's cross-check test.
import { JobRegistry } from '@ehr/kernel';
import type { JobType } from '@ehr/kernel';
import { AUDIT_JOBS } from './jobs/audit/jobs.js';
import { CALENDAR_SYNC_JOBS } from './jobs/calendar-sync/jobs.js';
import { CLINICAL_JOBS } from './jobs/clinical/jobs.js';
import { DOCUMENTS_JOBS } from './jobs/documents/jobs.js';
import { IDENTITY_JOBS } from './jobs/identity/jobs.js';
import { INTEGRATION_CORE_JOBS } from './jobs/integration-core/jobs.js';
import { MESSAGING_JOBS } from './jobs/messaging/jobs.js';
import { ALERT_JOBS } from './jobs/notifications/alert-jobs.js';
import { NOTIFICATIONS_JOBS } from './jobs/notifications/jobs.js';
import { PATIENT_JOBS } from './jobs/patient/jobs.js';
import { PRIVACY_CRONTAB, PRIVACY_JOBS } from './jobs/privacy/jobs.js';
import { REPORTING_CRONTAB, REPORTING_JOBS } from './jobs/reporting/jobs.js';
import { SCHEDULING_FLOW_JOBS } from './jobs/scheduling/jobs.js';
import { TELEHEALTH_JOBS } from './jobs/telehealth/jobs.js';

export const WORKER_JOBS: readonly JobType[] = [
  ...IDENTITY_JOBS,
  ...AUDIT_JOBS,
  ...PATIENT_JOBS,
  ...NOTIFICATIONS_JOBS,
  ...ALERT_JOBS,
  ...SCHEDULING_FLOW_JOBS,
  ...TELEHEALTH_JOBS,
  ...CALENDAR_SYNC_JOBS,
  ...DOCUMENTS_JOBS,
  ...INTEGRATION_CORE_JOBS,
  ...CLINICAL_JOBS,
  ...MESSAGING_JOBS,
  ...PRIVACY_JOBS,
  ...REPORTING_JOBS,
];

/** The recurring entries the worker runs (graphile-worker crontab text). Milestone M4: privacy expiry and the operations refresh. */
export const WORKER_CRONTAB: string = [PRIVACY_CRONTAB, REPORTING_CRONTAB].join('\n');

export function buildWorkerRegistry(): JobRegistry {
  const registry = new JobRegistry();
  for (const j of WORKER_JOBS) registry.defineJob(j);
  return registry;
}
