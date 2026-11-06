// Job types of the scheduling flow (ARCHITECTURE 25.6, 33.1). Keep apps/api/src/modules/scheduling/flow/jobs.ts in step (each side's test
// pins the same list).
import type { JobType } from '@ehr/kernel';

export const SCHEDULING_FLOW_JOBS: readonly JobType[] = [
  {
    name: 'scheduling.on_slot_freed',
    maxAttempts: 5,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'handler',
  },
  {
    name: 'scheduling.offer_waitlist',
    maxAttempts: 5,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  {
    name: 'scheduling.expire_offer',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'scheduling.no_show_sweep',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  {
    name: 'scheduling.on_reservation_confirmed',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  {
    name: 'scheduling.send_previsit',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
];

/** graphile-worker crontab: the no-show sweep every 5 minutes (33.1). */
export const SCHEDULING_FLOW_CRONTAB = '*/5 * * * * scheduling.no_show_sweep';
