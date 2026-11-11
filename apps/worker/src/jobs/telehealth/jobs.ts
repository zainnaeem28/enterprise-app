// Job types of telehealth on the worker side (ARCHITECTURE 33.1). Keep this list in step with
// apps/api/src/modules/telehealth/jobs.ts (each side's test pins the same list).
import type { JobType } from '@ehr/kernel';

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
  {
    name: 'telehealth.create_meeting',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'telehealth.close_meeting',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
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

/** The room is made this long before the start at the latest. */
export const MEETING_LEAD_MINUTES = 15;
