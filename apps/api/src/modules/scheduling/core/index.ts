// Public surface of the scheduling booking core (ARCHITECTURE 24, ticket BE-11). Other modules import only from here.
// Composition, at start-up:
//   1. define SCHEDULING_CORE_JOBS in the API's and the worker's JobRegistry (and sync queue task types);
//   2. registerSchedulingParticipants() next to the patient merge's other participants (merge) and the privacy export (exportPart);
//   3. API: new SchedulingCoreService({ audit, organisation, availability, queue }); controllers via createSchedulingControllers;
//      resolvers via schedulingResolvers(). `availability` is the AvailabilityPort BE-12 provides: without one no hold is possible;
//   4. worker: task `scheduling.expire_holds` -> db.withScope({audience:'system', realm:'worker', jobScope:'org'}, tx => svc.sweepExpired(tx)).
export { SchedulingCoreService, ACTIVE_STATUSES, nearbyFreeStarts } from './service.js';
export type { SchedulingCoreDeps } from './service.js';
export { createSchedulingControllers, schedulingResolvers } from './controller.js';
export type { SchedulingControllerDeps } from './controller.js';
export {
  SCHEDULING_CONFLICT_RULES,
  SCHEDULING_MERGE_TABLES,
  registerSchedulingParticipants,
  schedulingExportContributor,
  schedulingMergeParticipant,
} from './merge.js';
export { SCHEDULING_CORE_EVENTS, SCHEDULING_CORE_JOBS } from './jobs.js';
export {
  CutoffPassedError,
  FeeAcceptanceRequiredError,
  HoldExpiredError,
  InvalidTransitionError,
  LeadTimeError,
  LicensingRefusedError,
  MaxFutureReachedError,
  OutsideHoursError,
  OverlappingAppointmentError,
  PatientMergedError,
  PreconditionFailedError,
  ReservationNotFoundError,
  SchedulingError,
  SchedulingScopeError,
  SchedulingValidationError,
  SlotTakenError,
  translateDbError,
} from './errors.js';
export type {
  AppointmentView,
  AvailabilityPort,
  BookedVia,
  HeldReservation,
  HoldInput,
  OccupancyStatus,
  RequestMeta,
  SlotQuery,
  VisitMode,
} from './types.js';
