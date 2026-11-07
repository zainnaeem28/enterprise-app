// Task handlers of the scheduling flow (ARCHITECTURE 33.1). `createSchedulingFlowTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `defineSchedulingFlowJobs` registers the types with the JobRegistry. SCHEDULING_FLOW_CRONTAB is wired at
// integration (the runner does not pass a crontab yet, as for the other modules). The work itself is the scheduling flow service's
// (apps/api/src/modules/scheduling/flow), reached through the port in ports.ts.
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { runExpireOffer } from './expire-offer.js';
import { SCHEDULING_FLOW_JOBS } from './jobs.js';
import { runNoShowSweep } from './no-show-sweep.js';
import { runOfferWaitlist } from './offer-waitlist.js';
import { runOnSlotFreed } from './on-slot-freed.js';
import type { SchedulingJobDeps } from './ports.js';
import {
  runOnReservationCancelled,
  runOnReservationConfirmed,
  runOnReservationRescheduled,
  runSendPrevisit,
} from './send-previsit.js';

export { SCHEDULING_FLOW_CRONTAB, SCHEDULING_FLOW_JOBS } from './jobs.js';
export { runOfferWaitlist } from './offer-waitlist.js';
export type { OfferJobOutcome } from './offer-waitlist.js';
export { runExpireOffer, runLapse } from './expire-offer.js';
export { runNoShowSweep } from './no-show-sweep.js';
export type { SweepResult } from './no-show-sweep.js';
export { runOnSlotFreed } from './on-slot-freed.js';
export {
  runOnReservationCancelled,
  runOnReservationConfirmed,
  runOnReservationRescheduled,
  runSendPrevisit,
} from './send-previsit.js';
export type {
  FlowMeta,
  FreedSlot,
  LapseOutcome,
  NoticeOutcome,
  NoticeResult,
  NoShowCandidate,
  OfferCandidate,
  OfferOutcome,
  SchedulingFlowPort,
  SchedulingJobDeps,
  SendPrevisitOutcome,
} from './ports.js';
export { patientsScope, systemScope } from './scope.js';

export function defineSchedulingFlowJobs(registry: JobRegistry): void {
  for (const j of SCHEDULING_FLOW_JOBS) registry.defineJob(j);
}

export function createSchedulingFlowTasks(deps: SchedulingJobDeps): Record<string, Task> {
  return {
    'scheduling.on_slot_freed': async (payload) => {
      await runOnSlotFreed(deps, payload as Record<string, unknown>);
    },
    'scheduling.offer_waitlist': async (payload, helpers) => {
      await runOfferWaitlist(
        deps,
        payload as Record<string, unknown>,
        `scheduling.offer_waitlist:${helpers.job.id}`,
      );
    },
    'scheduling.expire_offer': async (payload, helpers) => {
      await runExpireOffer(
        deps,
        payload as Record<string, unknown>,
        `scheduling.expire_offer:${helpers.job.id}`,
      );
    },
    'scheduling.no_show_sweep': async (_payload, helpers) => {
      await runNoShowSweep(deps, `scheduling.no_show_sweep:${helpers.job.id}`);
    },
    'scheduling.on_reservation_confirmed': async (payload, helpers) => {
      await runOnReservationConfirmed(
        deps,
        payload as Record<string, unknown>,
        `scheduling.on_reservation_confirmed:${helpers.job.id}`,
      );
    },
    'scheduling.on_reservation_cancelled': async (payload, helpers) => {
      await runOnReservationCancelled(
        deps,
        payload as Record<string, unknown>,
        `scheduling.on_reservation_cancelled:${helpers.job.id}`,
      );
    },
    'scheduling.on_reservation_rescheduled': async (payload, helpers) => {
      await runOnReservationRescheduled(
        deps,
        payload as Record<string, unknown>,
        `scheduling.on_reservation_rescheduled:${helpers.job.id}`,
      );
    },
    'scheduling.send_previsit': async (payload, helpers) => {
      await runSendPrevisit(
        deps,
        payload as Record<string, unknown>,
        `scheduling.send_previsit:${helpers.job.id}`,
      );
    },
  };
}
