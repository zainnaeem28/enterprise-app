// Job types of the clinical module's chart part (ARCHITECTURE 33.1). Keep apps/api/src/modules/clinical/chart/jobs.ts in step (each
// side's test pins the same list).
import type { JobType } from '@ehr/kernel';

export const CLINICAL_CHART_JOBS: readonly JobType[] = [
  {
    name: 'clinical.terminology_load',
    maxAttempts: 5,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];
