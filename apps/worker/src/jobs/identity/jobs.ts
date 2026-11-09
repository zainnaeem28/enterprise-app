// Job types of the identity module (ARCHITECTURE 33.1). The API tier enqueues only `record_sign_in` (inside the sign-in
// transaction, 26.1). Keep apps/api/src/modules/identity/jobs.ts in step (each side's test pins the same list).
import type { JobType } from '@ehr/kernel';

export const IDENTITY_JOBS: readonly JobType[] = [
  {
    name: 'identity.record_sign_in',
    maxAttempts: 8,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'job',
  },
  {
    name: 'identity.apply_reference_data',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  {
    name: 'identity.purge_sessions',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** Admin realm event job (ARCHITECTURE 26.3 B2-9). Keep apps/api/src/modules/identity/admin/jobs.ts in step (a test compares them). */
export const IDENTITY_ADMIN_JOBS: readonly JobType[] = [
  {
    name: 'identity.admin_event',
    maxAttempts: 8,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'job',
  },
];

/** Worker-only: the notice is queued by `identity.admin_event` (worker path), never by the API tier. */
export const ADMIN_EVENT_NOTICE_JOB = 'identity.admin_event_notice';
export const IDENTITY_ADMIN_WORKER_JOBS: readonly JobType[] = [
  {
    name: ADMIN_EVENT_NOTICE_JOB,
    apiEnqueue: false,
    maxAttempts: 8,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'job',
  },
];

export const ADMIN_EVENT_KINDS = [
  'credential_enrolled',
  'credential_revoked',
  'counter_regression',
  'enrolment_token_requested',
  'enrolment_token_approved',
  'role_change_requested',
  'role_change_decided',
  'handle_failures',
  'bootstrap_run',
] as const;
export type AdminEventKind = (typeof ADMIN_EVENT_KINDS)[number];

/** Events this module publishes (24). Handlers register in the notifications module (BE-06). */
export const IDENTITY_EVENTS = ['identity.principal_bound'] as const;

/** graphile-worker crontab: hourly session purge (33.1). The reference data is applied at deploy, not on a timer. */
export const IDENTITY_CRONTAB = '0 * * * * identity.purge_sessions';
