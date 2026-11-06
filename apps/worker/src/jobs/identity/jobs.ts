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

/** Events this module publishes (24). Handlers register in the notifications module (BE-06). */
export const IDENTITY_EVENTS = ['identity.principal_bound'] as const;

/** graphile-worker crontab: hourly session purge (33.1). The reference data is applied at deploy, not on a timer. */
export const IDENTITY_CRONTAB = '0 * * * * identity.purge_sessions';
