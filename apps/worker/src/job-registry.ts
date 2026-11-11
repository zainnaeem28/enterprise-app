// The worker's job registry: every job type the worker deployable owns, defined once. `syncTaskTypes` writes it into
// `queue_api.task_type` (ARCHITECTURE 21.8) at worker start and from the deploy-pipeline step (`sync-task-types-cli.ts`).
// Each module's list is pinned equal to the API's copy by that module's cross-check test.
import { JobRegistry } from '@ehr/kernel';
import type { JobType } from '@ehr/kernel';
import { AUDIT_CRONTAB, AUDIT_JOBS } from './jobs/audit/jobs.js';
import { CALENDAR_SYNC_JOBS } from './jobs/calendar-sync/jobs.js';
import { CLINICAL_JOBS } from './jobs/clinical/jobs.js';
import { DOCUMENTS_JOBS } from './jobs/documents/jobs.js';
import {
  IDENTITY_ADMIN_JOBS,
  IDENTITY_ADMIN_WORKER_JOBS,
  IDENTITY_JOBS,
  IDENTITY_PROXY_WORKER_JOBS,
  PROXY_CRONTAB,
} from './jobs/identity/jobs.js';
import { INTEGRATION_CORE_JOBS } from './jobs/integration-core/jobs.js';
import { MESSAGING_JOBS } from './jobs/messaging/jobs.js';
import { ALERT_JOBS } from './jobs/notifications/alert-jobs.js';
import {
  COMPLIANCE_ALERT_JOBS,
  registerComplianceAlertHandlers,
} from './jobs/notifications/compliance-alerts.js';
import { NOTIFICATIONS_JOBS } from './jobs/notifications/jobs.js';
import { toCrontabText } from './runner.js';
import { PATIENT_JOBS } from './jobs/patient/jobs.js';
import { PRIVACY_CRONTAB, PRIVACY_JOBS } from './jobs/privacy/jobs.js';
import { REPORTING_CRONTAB, REPORTING_JOBS } from './jobs/reporting/jobs.js';
import { SCHEDULING_FLOW_JOBS } from './jobs/scheduling/jobs.js';
import { TELEHEALTH_JOBS } from './jobs/telehealth/jobs.js';

export const WORKER_JOBS: readonly JobType[] = [
  ...IDENTITY_JOBS,
  ...IDENTITY_ADMIN_JOBS,
  ...IDENTITY_ADMIN_WORKER_JOBS,
  ...IDENTITY_PROXY_WORKER_JOBS,
  ...AUDIT_JOBS,
  ...PATIENT_JOBS,
  ...NOTIFICATIONS_JOBS,
  ...ALERT_JOBS,
  ...COMPLIANCE_ALERT_JOBS,
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

/** The recurring entries the worker runs (graphile-worker crontab text). Privacy expiry, the operations refresh (M4), the audit anchor and its verification (M5, SEC05-F01) and the proxy age-out (ruling C item 3). */
export const WORKER_CRONTAB: string = toCrontabText(
  [PRIVACY_CRONTAB, REPORTING_CRONTAB, AUDIT_CRONTAB, PROXY_CRONTAB].join('\n'),
);

export function buildWorkerRegistry(): JobRegistry {
  const registry = new JobRegistry();
  for (const j of WORKER_JOBS) registry.defineJob(j);
  // The worker publishes `audit.anchor_mismatch`; the handler must exist even when the API ports are not loaded (SEC05-F03).
  registerComplianceAlertHandlers(registry);
  return registry;
}
