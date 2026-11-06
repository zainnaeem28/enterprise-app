// Job types of the patient module (ARCHITECTURE 33.1). `patient.execute_merge` belongs to BE-09. Keep
// apps/api/src/modules/patient/jobs.ts in step (each side's test pins the same list).
import type { JobType } from '@ehr/kernel';

export const PATIENT_JOBS: readonly JobType[] = [
  {
    name: 'patient.verify_staff_scope',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  {
    name: 'patient.purge_match_checks',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab: the drift check daily at 03:10, the match-check purge hourly (SHARED-BOUNDARIES 6.6, 25.3). */
export const PATIENT_CRONTAB = [
  '10 3 * * * patient.verify_staff_scope',
  '20 * * * * patient.purge_match_checks',
].join('\n');
