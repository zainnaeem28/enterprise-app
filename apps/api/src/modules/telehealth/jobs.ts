// Job types and events of telehealth (ARCHITECTURE 33.1, 24). The task handlers live with the worker (apps/worker/src/jobs/telehealth);
// keep that file's list in step with this one (each side's test pins the same list).
//
// `kernel.publish` names a handler job `<handler module>.on_<event>`, so the four events this module consumes arrive as
// `telehealth.on_reservation_confirmed`, `on_reservation_cancelled`, `on_no_show` and `on_reservation_rescheduled`. It is a thin handler: it makes the session row (so a device check can start at once) and
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
  {
    name: 'telehealth.on_reservation_cancelled',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  {
    name: 'telehealth.on_no_show',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  {
    name: 'telehealth.on_reservation_rescheduled',
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
  // The vendor room of an ended session, closed durably (DL-1): enqueued in the transaction that ends the session (host `end` or
  // `end_stale`). Issued Chime tokens stay usable until the meeting closes, so this is part of token lifetime (ST-4).
  {
    name: 'telehealth.close_meeting',
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

/** Registers this module as the handler of the four events it consumes. Call once per registry, before `publish` is used. */
export function registerTelehealthHandlers(registry: JobRegistry): void {
  registry.registerHandler('scheduling.reservation_confirmed', 'telehealth');
  // The visit is over: end its live session and queue the vendor close (completed and expired visits publish no event; `end_stale`
  // is their backstop).
  registry.registerHandler('scheduling.reservation_cancelled', 'telehealth');
  registry.registerHandler('scheduling.no_show', 'telehealth');
  registry.registerHandler('scheduling.reservation_rescheduled', 'telehealth');
}
