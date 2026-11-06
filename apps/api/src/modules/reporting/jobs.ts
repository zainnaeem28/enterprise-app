// Job types of the reporting module (ARCHITECTURE 33.1). The handler lives with the worker (apps/worker) and is wired at integration:
// it opens an organisation-scope system transaction through `runRefreshOps`. The API tier enqueues nothing; the worker's crontab does.
import type { JobType } from '@ehr/kernel';

export const REFRESH_OPS_JOB = 'reporting.refresh_ops';

export const REPORTING_JOBS: readonly JobType[] = [
  // Every minute, idempotency key = the minute. Internal job: 3 attempts (33.1 defaults).
  {
    name: REFRESH_OPS_JOB,
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab: the operations read models every minute (33.1). */
export const REPORTING_CRONTAB = `* * * * * ${REFRESH_OPS_JOB}`;
