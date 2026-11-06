// Job types and events of the booking core (ARCHITECTURE 33.1, 24). The handler of `scheduling.expire_holds` lives with the worker
// (apps/worker) and is wired at integration; it opens an organisation-scope system transaction and calls
// `SchedulingCoreService.sweepExpired`. The API tier enqueues none of these jobs (the worker's crontab does).
import type { JobType } from '@ehr/kernel';

export const SCHEDULING_CORE_JOBS: readonly JobType[] = [
  // Cleanup of lapsed holds, every minute (25.1). Not needed for correctness: the inserting transaction expires what is in its way.
  {
    name: 'scheduling.expire_holds',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** Events this module publishes (24). IDs only (BD-09). */
export const SCHEDULING_CORE_EVENTS = [
  'scheduling.reservation_held',
  'scheduling.reservation_confirmed',
  'scheduling.reservation_cancelled',
  'scheduling.reservation_rescheduled',
  'scheduling.slot_freed',
] as const;
