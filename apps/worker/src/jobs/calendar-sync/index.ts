// Task handlers of calendar-sync (ARCHITECTURE 33.1). `createCalendarSyncTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `defineCalendarSyncJobs` registers the types with the JobRegistry; CALENDAR_SYNC_CRONTAB is wired at
// integration (the runner does not pass a crontab yet, as for the other modules). The Google adapter is registered with integration-core's
// `AdapterRegistry`; the push handler with its `InboundHandlerRegistry` (`registerGooglePushHandler`).
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { runOnReservation } from './handlers.js';
import { CALENDAR_SYNC_JOBS } from './jobs.js';
import type { CalendarJobDeps } from './ports.js';
import { runDeleteBusy, runPushBusy } from './push-busy.js';
import { runFullResync, runIncrementalSync } from './sync.js';
import { runUnlinkCleanup } from './unlink.js';
import { runRenewWatch } from './watch.js';

export { CALENDAR_SYNC_CRONTAB, CALENDAR_SYNC_JOBS } from './jobs.js';
export { GoogleCalendarAdapter, BUSY_TITLE, OAUTH_CLIENT_SECRET_NAME } from './google-adapter.js';
export type { GoogleAdapterOptions } from './google-adapter.js';
export { toBusyChange, startOfDayIn, OWN_EVENT_KEY } from './busy.js';
export type { BusyChange, GoogleEventLite } from './busy.js';
export { runIncrementalSync, runFullResync, markLink } from './sync.js';
export type { SyncOutcome } from './sync.js';
export { runPushBusy, runDeleteBusy } from './push-busy.js';
export type { PushOutcome } from './push-busy.js';
export { runRenewWatch, channelToken, CHANNEL_LIFETIME_MS } from './watch.js';
export type { RenewOutcome } from './watch.js';
export { runUnlinkCleanup } from './unlink.js';
export {
  handlePush,
  parsePush,
  registerGooglePushHandler,
  GOOGLE_CALENDAR_SOURCE,
  GOOGLE_PUSH_MESSAGE_TYPE,
} from './push-handler.js';
export { runOnReservation } from './handlers.js';
export type { CalendarJobDeps, ChannelKeyProvider, VendorPort } from './ports.js';
export { eventIdFor, externalHash, tokenSecretName } from './ids.js';
export { patientsScope, systemScope } from './scope.js';

export function defineCalendarSyncJobs(registry: JobRegistry): void {
  for (const j of CALENDAR_SYNC_JOBS) registry.defineJob(j);
}

export function createCalendarSyncTasks(deps: CalendarJobDeps): Record<string, Task> {
  const p = (x: unknown): Record<string, unknown> => x as Record<string, unknown>;
  return {
    'calendar_sync.on_reservation_confirmed': async (payload) => {
      await runOnReservation(deps, 'confirmed', p(payload));
    },
    'calendar_sync.on_reservation_cancelled': async (payload) => {
      await runOnReservation(deps, 'cancelled', p(payload));
    },
    'calendar_sync.on_reservation_rescheduled': async (payload) => {
      await runOnReservation(deps, 'rescheduled', p(payload));
    },
    'calendar_sync.push_busy': async (payload) => {
      await runPushBusy(deps, p(payload));
    },
    'calendar_sync.delete_busy': async (payload) => {
      await runDeleteBusy(deps, p(payload));
    },
    'calendar_sync.incremental_sync': async (payload) => {
      await runIncrementalSync(deps, p(payload));
    },
    'calendar_sync.full_resync': async (payload) => {
      await runFullResync(deps, p(payload));
    },
    'calendar_sync.renew_watch': async (payload) => {
      await runRenewWatch(deps, p(payload));
    },
    'calendar_sync.unlink_cleanup': async (payload) => {
      await runUnlinkCleanup(deps, p(payload));
    },
  };
}
