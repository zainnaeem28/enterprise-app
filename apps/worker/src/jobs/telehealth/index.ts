// Task handlers of telehealth (ARCHITECTURE 33.1). `createTelehealthTasks` returns a task table for the worker's `startWorker({ tasks })`;
// `defineTelehealthJobs` registers the types with the JobRegistry. TELEHEALTH_CRONTAB is wired at integration (the runner does not pass a
// crontab yet, as for the other modules). The work is the telehealth job service's (apps/api/src/modules/telehealth), reached through the
// port in ports.ts; the video adapter is registered with integration-core's `AdapterRegistry`.
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { runCreateMeeting } from './create-meeting.js';
import { runEndStale } from './end-stale.js';
import { TELEHEALTH_JOBS } from './jobs.js';
import { runOnReservationConfirmed } from './on-reservation-confirmed.js';
import type { TelehealthJobDeps } from './ports.js';

export { TELEHEALTH_CRONTAB, TELEHEALTH_JOBS, MEETING_LEAD_MINUTES } from './jobs.js';
export { runOnReservationConfirmed, asPatient, meetingRunAt } from './on-reservation-confirmed.js';
export type { ConfirmedOutcome } from './on-reservation-confirmed.js';
export { runCreateMeeting } from './create-meeting.js';
export type { MeetingOutcome } from './create-meeting.js';
export { runEndStale } from './end-stale.js';
export type { StaleResult } from './end-stale.js';
export { VideoAdapter, MIN_TTL_SECONDS, MAX_TTL_SECONDS } from './video-adapter.js';
export type { VideoTransport } from './video-adapter.js';
export { FakeVideoTransport } from './fake-transport.js';
export type {
  EndedStale,
  EnsureOutcome,
  StaleSession,
  TelehealthJobDeps,
  TelehealthMeta,
  TelehealthWorkerPort,
  VendorPort,
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
    'telehealth.end_stale': async (_payload, helpers) => {
      await runEndStale(deps, `telehealth.end_stale:${helpers.job.id}`);
    },
  };
}
