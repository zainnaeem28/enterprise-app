// Job types of calendar-sync (ARCHITECTURE 33.1). Keep apps/api/src/modules/calendar-sync/jobs.ts in step (each side's test pins the
// same list).
import type { JobType } from '@ehr/kernel';

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
  org('calendar_sync.incremental_sync', 8),
  org('calendar_sync.full_resync', 8),
  org('calendar_sync.renew_watch', 8),
  org('calendar_sync.unlink_cleanup', 8),
];

/** graphile-worker crontab (33.1): incremental sync every 15 minutes, watch renewal daily at 03:00. */
export const CALENDAR_SYNC_CRONTAB = [
  '*/15 * * * * calendar_sync.incremental_sync',
  '0 3 * * * calendar_sync.renew_watch',
].join('\n');
