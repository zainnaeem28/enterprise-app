// Job types and events of the scheduling flow (ARCHITECTURE 33.1, 24). The task handlers live with the worker
// (apps/worker/src/jobs/scheduling); keep that file's list in step with this one (each side's test pins the same list).
//
// `kernel.publish` names a handler job `<handler module>.on_<event>`, so the two events this module consumes arrive as
// `scheduling.on_slot_freed` and `scheduling.on_reservation_confirmed`. Each is a thin handler that schedules the job the design names
// (`scheduling.offer_waitlist`, `scheduling.send_previsit`); registering the handlers is `registerSchedulingFlowHandlers`.
import type { JobRegistry, JobType } from '@ehr/kernel';

export const SCHEDULING_FLOW_JOBS: readonly JobType[] = [
  // Event handler for `scheduling.slot_freed` (published by cancel, reschedule, the hold sweep, a declined or lapsed offer).
  {
    name: 'scheduling.on_slot_freed',
    maxAttempts: 5,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'handler',
  },
  // 25.6: the first fitting waitlist entry gets a hold through scheduling.hold and an offer. One per freed occupancy (job key).
  {
    name: 'scheduling.offer_waitlist',
    maxAttempts: 5,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  // At the offer's expiry: release the hold, mark the offer expired, offer the slot to the next entry.
  {
    name: 'scheduling.expire_offer',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  // Every 5 minutes: marks no-show only where the setting allows it, otherwise flags for staff.
  {
    name: 'scheduling.no_show_sweep',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  // Event handler for `scheduling.reservation_confirmed`: schedules the pre-visit invitation at start minus the setting.
  {
    name: 'scheduling.on_reservation_confirmed',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  // At start - 72 h (Setting `previsit_send_offset`): the PHI-free pre-visit invitation. Skips a cancelled booking.
  {
    name: 'scheduling.send_previsit',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  // Event handler for the cancel/reschedule notices (INT02-R11-N1).
  {
    name: 'scheduling.on_reservation_cancelled',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
  {
    name: 'scheduling.on_reservation_rescheduled',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
];

/** graphile-worker crontab (33.1): the no-show sweep every 5 minutes. */
export const SCHEDULING_FLOW_CRONTAB = '*/5 * * * * scheduling.no_show_sweep';

/** Events this module publishes (24). IDs only (BD-09). */
export const SCHEDULING_FLOW_EVENTS = [
  'scheduling.checked_in',
  'scheduling.no_show',
  'scheduling.waitlist_offered',
] as const;

/** Registers this module as the handler of the events it consumes. Call once per registry, before `publish` is used. */
export function registerSchedulingFlowHandlers(registry: JobRegistry): void {
  registry.registerHandler('scheduling.slot_freed', 'scheduling');
  registry.registerHandler('scheduling.reservation_confirmed', 'scheduling');
  registry.registerHandler('scheduling.reservation_cancelled', 'scheduling');
  registry.registerHandler('scheduling.reservation_rescheduled', 'scheduling');
}
