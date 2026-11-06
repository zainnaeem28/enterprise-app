// Job types this module owns (ARCHITECTURE 33.1). The handlers live in apps/worker/src/jobs/identity; the API tier only
// needs the names to enqueue `identity.record_sign_in`. Keep the two lists in step (the worker test compares them).
import type { JobType } from '@ehr/kernel';

export const IDENTITY_JOBS: readonly JobType[] = [
  // Queued by the sign-in transaction: audit event and, for a binding, the notice to the pre-registering admin (26.1).
  { name: 'identity.record_sign_in', maxAttempts: 8, onMerged: 'none', carriesPatientIds: false, jobScope: 'org', jobClass: 'job' },
  { name: 'identity.apply_reference_data', maxAttempts: 3, onMerged: 'none', carriesPatientIds: false, jobScope: 'org', jobClass: 'system' },
  { name: 'identity.purge_sessions', maxAttempts: 3, onMerged: 'none', carriesPatientIds: false, jobScope: 'org', jobClass: 'system' },
];
