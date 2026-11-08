// Public surface of the messaging module (ARCHITECTURE 24, ticket BE-19). Other modules import only from here.
// Composition, at start-up:
//   1. define MESSAGING_JOBS in the API's and the worker's JobRegistry (and sync queue task types); registerMessagingHandlers(registry)
//      on both (the handler of `privacy.correction_requested`);
//   2. registerMessagingParticipants() next to the patient merge's other participants (merge participant AND export contributor);
//   3. API: createMessaging({ db, audit, identity, queue }); register `controllers` (it registers its resolver `messaging-patient`);
//   4. worker: `messaging.on_correction_requested` -> runOnCorrectionRequested({ db, orgId, audit, queue }, payload, jobId).
export { createMessaging } from './runtime.js';
export type { Messaging, MessagingDeps } from './runtime.js';
export { createMessagingControllers, messagingResolvers } from './controller.js';
export type { MessagingControllerDeps } from './controller.js';
export { ThreadService, toMessageView, toThreadView } from './threads.js';
export type { ThreadDeps } from './threads.js';
export { TASK_CREATED_EVENT, TaskService, toTaskView } from './tasks.js';
export type { TaskDeps } from './tasks.js';
export {
  CORRECTION_FALLBACK_ROLE,
  CORRECTION_TASK_DAYS,
  NoAssigneeError,
  runOnCorrectionRequested,
} from './corrections.js';
export type { CorrectionDeps } from './corrections.js';
export {
  MESSAGING_CONFLICT_RULES,
  MESSAGING_MERGE_TABLES,
  messagingExportPart,
  messagingMergeParticipant,
  registerMessagingParticipants,
} from './merge.js';
export {
  CORRECTION_EVENT,
  MESSAGING_EVENTS,
  MESSAGING_JOBS,
  ON_CORRECTION_JOB,
  registerMessagingHandlers,
} from './jobs.js';
export { PATIENT_MESSAGING_FLAG, patientMessagingOn } from './common.js';
export { patientsScope, systemScope } from './scope.js';
export {
  InvalidTransitionError,
  MessagingError,
  MessagingNotFoundError,
  MessagingScopeError,
  MessagingValidationError,
  ParticipantInvalidError,
  PatientMergedError,
  PreconditionFailedError,
  translateDbError,
} from './errors.js';
export type {
  CallerRoles,
  MessageView,
  RequestMeta,
  TaskSource,
  TaskStatus,
  TaskView,
  ThreadKind,
  ThreadStatus,
  ThreadView,
} from './types.js';
