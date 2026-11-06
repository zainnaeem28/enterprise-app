// Job types of integration-core (ARCHITECTURE 33.1). The API tier enqueues `dispatch_inbound` (webhook transaction, 25.7)
// and `apply_inbound_secret` (secret request, 25.9); `health_check` is scheduled. Keep apps/api/src/modules/integration-core/jobs.ts
// in step (each side's test pins the same list).
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

/** Events this module publishes (24). Handlers register in the notifications module. */
export const INTEGRATION_CORE_EVENTS = [
  'integration_core.inbound_received',
  'integration_core.connection_down',
  'integration_core.connection_restored',
  'integration_core.secret_change_refused',
] as const;

/** graphile-worker crontab: the health sweep every 5 minutes (the job key is the 5-minute window). */
export const INTEGRATION_CORE_CRONTAB = '*/5 * * * * integration_core.health_check';
