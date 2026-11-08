// Job types and events of telehealth (ARCHITECTURE 33.1, 24). The task handlers live with the worker (apps/worker/src/jobs/telehealth);
// keep that file's list in step with this one (each side's test pins the same list).
//
// `kernel.publish` names a handler job `<handler module>.on_<event>`, so the one event this module consumes arrives as
// `telehealth.on_reservation_confirmed`. It is a thin handler: it makes the session row (so a device check can start at once) and
// schedules the job the design names, `telehealth.create_meeting`, for start - 15 minutes (ahead of time, 33.1).
import type { JobRegistry, JobType } from '@ehr/kernel';

export const TELEHEALTH_JOBS: readonly JobType[] = [
  {
    name: 'telehealth.on_reservation_confirmed',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  // 33.1: the vendor room, created ahead of time (start - 15 min at the latest). One per reservation (job key). The API asks for it again
  // when a person joins and the room is missing.
  {
    name: 'telehealth.create_meeting',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  // Every 15 minutes: ends sessions 2 h after their slot, revoking their tokens first.
  {
    name: 'telehealth.end_stale',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab (33.1): the stale-session sweep every 15 minutes. */
export const TELEHEALTH_CRONTAB = '*/15 * * * * telehealth.end_stale';

/** Events this module publishes (24). IDs only (BD-09). */
export const TELEHEALTH_EVENTS = ['telehealth.patient_waiting'] as const;

/** Registers this module as the handler of the one event it consumes. Call once per registry, before `publish` is used. */
export function registerTelehealthHandlers(registry: JobRegistry): void {
  registry.registerHandler('scheduling.reservation_confirmed', 'telehealth');
}
