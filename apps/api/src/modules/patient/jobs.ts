// Job types this module owns (ARCHITECTURE 33.1). The handlers live in apps/worker/src/jobs/patient; the API tier enqueues none of
// them (both are scheduled by the worker's crontab), so this list exists for the registry and the parity test. `patient.execute_merge`
// belongs to BE-09. Keep the two lists in step (the worker test compares them).
import type { JobType } from '@ehr/kernel';

export const PATIENT_JOBS: readonly JobType[] = [
  // Daily drift check of staff_scope against the derivation (SHARED-BOUNDARIES 6.6). Organisation-wide.
  {
    name: 'patient.verify_staff_scope',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  // Hourly purge of expired match checks (25.3, 22.6).
  {
    name: 'patient.purge_match_checks',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** Events this module publishes (24). IDs only. */
export const PATIENT_EVENTS = [
  'patient.registered',
  'patient.duplicate_flagged',
  'patient.consent_signed',
] as const;
