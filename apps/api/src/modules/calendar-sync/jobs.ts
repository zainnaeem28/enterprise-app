// Job types, events and crontab of calendar-sync (ARCHITECTURE 33.1, 24). The task handlers live with the worker
// (apps/worker/src/jobs/calendar-sync); keep that file's list in step with this one (each side's test pins the same list).
//
// `kernel.publish` names a handler job `<handler module>.on_<event>`, so the three events this module consumes arrive as
// `calendar_sync.on_reservation_confirmed`, `_cancelled` and `_rescheduled`. Each is a thin handler that schedules the job the
// design names (`push_busy`, `delete_busy`). Those events carry the booking's patient ID, so the handler declares it (on_merged =
// resolve); the jobs it schedules carry the occupancy ID only and run at organisation scope with no patient (33.1).
import type { JobRegistry, JobType } from '@ehr/kernel';

const org = (name: string, maxAttempts: number): JobType => ({
  name,
  maxAttempts,
  onMerged: 'none',
  carriesPatientIds: false,
  jobScope: 'org',
  jobClass: 'job',
});

export const CALENDAR_SYNC_JOBS: readonly JobType[] = [
  {
    name: 'calendar_sync.on_reservation_confirmed',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  {
    name: 'calendar_sync.on_reservation_cancelled',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  {
    name: 'calendar_sync.on_reservation_rescheduled',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  org('calendar_sync.push_busy', 8),
  org('calendar_sync.delete_busy', 8),
  // Google push, or every 15 minutes. Without a clinician ID it is the timer's fan-out (departure D4 in the README).
  org('calendar_sync.incremental_sync', 8),
  org('calendar_sync.full_resync', 8),
  // Daily. Without a clinician ID it is the sweep that decides which links need a new channel.
  org('calendar_sync.renew_watch', 8),
  // Departure D3: a link that is deleted leaves busy blocks, channels and Busy events behind; this clears them.
  org('calendar_sync.unlink_cleanup', 8),
];

/** graphile-worker crontab (33.1): incremental sync every 15 minutes, watch renewal daily at 03:00. */
export const CALENDAR_SYNC_CRONTAB = [
  '*/15 * * * * calendar_sync.incremental_sync',
  '0 3 * * * calendar_sync.renew_watch',
].join('\n');

/** Events this module publishes (24). IDs only (BD-09). */
export const CALENDAR_SYNC_EVENTS = ['calendar_sync.link_broken'] as const;

/** Registers this module as the handler of the three booking events it consumes. Call once per registry, before `publish` is used. */
export function registerCalendarSyncHandlers(registry: JobRegistry): void {
  registry.registerHandler('scheduling.reservation_confirmed', 'calendar_sync');
  registry.registerHandler('scheduling.reservation_cancelled', 'calendar_sync');
  registry.registerHandler('scheduling.reservation_rescheduled', 'calendar_sync');
}
