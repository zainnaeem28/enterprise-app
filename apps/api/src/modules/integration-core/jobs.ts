// Job types this module owns (ARCHITECTURE 33.1). Handlers live in apps/worker/src/jobs/integration-core; the API tier
// enqueues `dispatch_inbound` in the webhook transaction and `apply_inbound_secret` with a secret request. Keep the two
// lists in step (each side's test pins the same names and attempts).
import type { JobType } from '@ehr/kernel';

export const INTEGRATION_CORE_JOBS: readonly JobType[] = [
  {
    name: 'integration_core.dispatch_inbound',
    maxAttempts: 8,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'job',
  },
  {
    name: 'integration_core.health_check',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  {
    name: 'integration_core.apply_inbound_secret',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'job',
  },
];
