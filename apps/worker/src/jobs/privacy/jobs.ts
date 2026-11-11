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
    name: 'privacy.execute_deletion',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'privacy.send_deletion_statement',
    maxAttempts: 10,
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
  {
    name: 'privacy.retention_purge',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab: the expiry daily at 03:50 (33.1), the retention purge daily at 04:10 (after documents.retention_sweep at 03:40). */
export const PRIVACY_CRONTAB =
  '50 3 * * * privacy.expire_packages\n10 4 * * * privacy.retention_purge';
