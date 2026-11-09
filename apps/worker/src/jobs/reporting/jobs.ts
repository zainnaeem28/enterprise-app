// Job types of the reporting module (ARCHITECTURE 33.1). Keep apps/api/src/modules/reporting/jobs.ts in step (the cross-check test pins
// the same list).
import type { JobType } from '@ehr/kernel';

export const REPORTING_JOBS: readonly JobType[] = [
  // Every minute, idempotency key = the minute. Internal job: 3 attempts (33.1 defaults).
  {
    name: 'reporting.refresh_ops',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab: the operations read models every minute (33.1). */
export const REPORTING_CRONTAB = '* * * * * reporting.refresh_ops';
