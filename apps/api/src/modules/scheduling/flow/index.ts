// Public surface of the scheduling flow (ARCHITECTURE 24, ticket BE-13): check-in, queue, arrivals, no-show, waitlist offers, pre-visit.
// Other modules import only from here. Composition, at start-up:
//   1. define SCHEDULING_FLOW_JOBS in the API's and the worker's JobRegistry (and sync queue task types); `registerSchedulingFlowHandlers`
//      on the registry used by `Queue.publish`;
//   2. registerSchedulingFlowParticipants() INSTEAD of the booking core's registerSchedulingParticipants() (it registers the core's table
//      as well: the registry takes one participant per module);
//   3. API: new SchedulingFlowService({ audit, organisation, availability, notifications, records, queue, qrKey, portalUrl });
//      controllers via createFlowControllers; resolvers via flowResolvers() next to schedulingResolvers();
//   4. worker: createSchedulingFlowTasks (apps/worker/src/jobs/scheduling) with a `SchedulingFlowPort` that is this service's
//      `flowPort(service)`, and SCHEDULING_FLOW_CRONTAB.
export { SchedulingFlowService } from './service.js';
export { WaitlistService } from './waitlist.js';
export type { LapseOutcome, OfferOutcome } from './waitlist.js';
export { PrevisitService } from './previsit.js';
export type { SendPrevisitOutcome } from './previsit.js';
export type { FlowDeps } from './common.js';
export { createFlowControllers, flowResolvers } from './controller.js';
export type { FlowControllerDeps } from './controller.js';
export { qrToken, qrTokenMatches } from './qr.js';
export {
  FLOW_CONFLICT_RULES,
  FLOW_MERGE_TABLES,
  registerSchedulingFlowParticipants,
  schedulingFlowExportContributor,
  schedulingFlowMergeParticipant,
} from './merge.js';
export {
  SCHEDULING_FLOW_CRONTAB,
  SCHEDULING_FLOW_EVENTS,
  SCHEDULING_FLOW_JOBS,
  registerSchedulingFlowHandlers,
} from './jobs.js';
export { flowPort } from './port.js';
export {
  CheckInNotAllowedError,
  GraceNotElapsedError,
  OfferExpiredError,
  WaitlistDisabledError,
} from './errors.js';
export { QUEUE_STAGES, TRIAGE_CATEGORIES } from './types.js';
export type {
  ArrivalView,
  CheckInMethod,
  CheckInResult,
  FlowMeta,
  FreedSlot,
  NoShowCandidate,
  OfferCandidate,
  OfferView,
  Previsit,
  PrevisitPort,
  QrKeyProvider,
  QueueEntryView,
  QueueStage,
  TriageCategory,
  WaitlistEntryInput,
  WaitlistEntryView,
  WaitlistStatus,
} from './types.js';
