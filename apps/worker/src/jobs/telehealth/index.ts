// Task handlers of telehealth (ARCHITECTURE 33.1). `createTelehealthTasks` returns a task table for the worker's `startWorker({ tasks })`;
// `defineTelehealthJobs` registers the types with the JobRegistry. TELEHEALTH_CRONTAB is wired at integration (the runner does not pass a
// crontab yet, as for the other modules). The work is the telehealth job service's (apps/api/src/modules/telehealth), reached through the
// port in ports.ts; the video adapter is registered with integration-core's `AdapterRegistry`.
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { runCloseMeeting } from './close-meeting.js';
import { runCreateMeeting } from './create-meeting.js';
import { runEndStale } from './end-stale.js';
import { TELEHEALTH_JOBS } from './jobs.js';
import { runOnReservationConfirmed } from './on-reservation-confirmed.js';
import { runOnVisitOver } from './on-visit-over.js';
import type { TelehealthJobDeps } from './ports.js';

export { TELEHEALTH_CRONTAB, TELEHEALTH_JOBS, MEETING_LEAD_MINUTES } from './jobs.js';
export {
  runOnReservationConfirmed,
  scheduleMeeting,
  asPatient,
  meetingRunAt,
} from './on-reservation-confirmed.js';
export type { ConfirmedOutcome } from './on-reservation-confirmed.js';
export { runOnVisitOver } from './on-visit-over.js';
export type { VisitOverOutcome } from './on-visit-over.js';
export { runCreateMeeting } from './create-meeting.js';
export type { MeetingOutcome } from './create-meeting.js';
export { runCloseMeeting } from './close-meeting.js';
export type { CloseOutcome } from './close-meeting.js';
export { runEndStale } from './end-stale.js';
export type { StaleResult } from './end-stale.js';
export { VideoAdapter, MIN_TTL_SECONDS, MAX_TTL_SECONDS } from './video-adapter.js';
export type { VideoTransport } from './video-adapter.js';
export { FakeVideoTransport } from './fake-transport.js';
export type {
  EndedForVisitOver,
  EndedStale,
  EnsureOutcome,
  StaleSession,
  TelehealthJobDeps,
  TelehealthMeta,
  TelehealthWorkerPort,
  VendorPort,
  VisitOverReason,
} from './ports.js';
export { patientsScope, systemScope } from './scope.js';

export function defineTelehealthJobs(registry: JobRegistry): void {
  for (const j of TELEHEALTH_JOBS) registry.defineJob(j);
}

export function createTelehealthTasks(deps: TelehealthJobDeps): Record<string, Task> {
  return {
    'telehealth.on_reservation_confirmed': async (payload, helpers) => {
      await runOnReservationConfirmed(
        deps,
        payload as Record<string, unknown>,
        `telehealth.on_reservation_confirmed:${helpers.job.id}`,
      );
    },
    'telehealth.create_meeting': async (payload, helpers) => {
      await runCreateMeeting(
        deps,
        payload as Record<string, unknown>,
        `telehealth.create_meeting:${helpers.job.id}`,
      );
    },
    'telehealth.close_meeting': async (payload, helpers) => {
      await runCloseMeeting(
        deps,
        payload as Record<string, unknown>,
        `telehealth.close_meeting:${helpers.job.id}`,
      );
    },
    'telehealth.on_reservation_cancelled': async (payload, helpers) => {
      const n = 'telehealth.on_reservation_cancelled';
      await runOnVisitOver(
        deps,
        payload as Record<string, unknown>,
        n,
        'cancelled',
        `${n}:${helpers.job.id}`,
      );
    },
    'telehealth.on_no_show': async (payload, helpers) => {
      const n = 'telehealth.on_no_show';
      await runOnVisitOver(
        deps,
        payload as Record<string, unknown>,
        n,
        'no_show',
        `${n}:${helpers.job.id}`,
      );
    },
    'telehealth.on_reservation_rescheduled': async (payload, helpers) => {
      const n = 'telehealth.on_reservation_rescheduled';
      await runOnVisitOver(
        deps,
        payload as Record<string, unknown>,
        n,
        'rescheduled',
        `${n}:${helpers.job.id}`,
      );
    },
    'telehealth.end_stale': async (_payload, helpers) => {
      await runEndStale(deps, `telehealth.end_stale:${helpers.job.id}`);
    },
  };
}
