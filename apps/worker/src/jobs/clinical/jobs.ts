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

// The front door's and the notes' job types (BE-18, BE-17). Keep apps/api/src/modules/clinical/{frontdoor,notes}/jobs.ts in step.
export const CLINICAL_FRONTDOOR_JOBS: readonly JobType[] = [
  // Handler of `notifications.alert_unacknowledged` (25.5): re-targets an unacknowledged red flag to the on-call doctor.
  {
    name: 'clinical.on_alert_unacknowledged',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
];

export const CLINICAL_NOTES_JOBS: readonly JobType[] = [
  {
    name: 'clinical.note_sign_reminder',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
];

/** Every job type of the clinical module the worker owns. */
export const CLINICAL_JOBS: readonly JobType[] = [
  ...CLINICAL_CHART_JOBS,
  ...CLINICAL_FRONTDOOR_JOBS,
  ...CLINICAL_NOTES_JOBS,
];
