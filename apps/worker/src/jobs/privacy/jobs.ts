// Job types of the privacy module (ARCHITECTURE 33.1). Keep apps/api/src/modules/privacy/jobs.ts in step (each side's test pins the
// same list).
import type { JobType } from '@ehr/kernel';

export const PRIVACY_JOBS: readonly JobType[] = [
  {
    name: 'privacy.assemble_export',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'privacy.check_legal_holds',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'privacy.expire_packages',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab: the expiry daily at 03:50 (33.1). */
export const PRIVACY_CRONTAB = '50 3 * * * privacy.expire_packages';
