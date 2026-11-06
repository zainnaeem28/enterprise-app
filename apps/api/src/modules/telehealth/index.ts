// Public surface of the telehealth module (ARCHITECTURE 24, ticket BE-15): sessions, the waiting room and admit, join tokens, the device
// check, and the licensing check at join. Other modules import only from here. Composition, at start-up:
//   1. define TELEHEALTH_JOBS in the API's and the worker's JobRegistry (and sync queue task types); `registerTelehealthHandlers` on the
//      registry used by `Queue.publish`;
//   2. registerTelehealthParticipants() (merge participant + export contributor; the registry takes one per module);
//   3. API: new TelehealthService({ db, audit, organisation, vendor, queue }) where `vendor` is a VideoVendorPort over the worker's
//      VendorGateway (`callVendor('video', 'join_token' | 'end_meeting', ...)`); controllers via createTelehealthControllers; the
//      `reservation` resolver is the booking core's (schedulingResolvers());
//   4. worker: createTelehealthTasks (apps/worker/src/jobs/telehealth) with a `TelehealthPort` that is `telehealthPort(service)`, the
//      VideoAdapter registered with integration-core's AdapterRegistry, and TELEHEALTH_CRONTAB.
export { TelehealthService } from './service.js';
export type { JoinPrepared, TelehealthDeps } from './service.js';
export { createTelehealthControllers } from './controller.js';
export type { TelehealthControllerDeps } from './controller.js';
export {
  TELEHEALTH_CONFLICT_RULES,
  TELEHEALTH_MERGE_TABLES,
  registerTelehealthParticipants,
  telehealthExportContributor,
  telehealthMergeParticipant,
} from './merge.js';
export {
  TELEHEALTH_CRONTAB,
  TELEHEALTH_EVENTS,
  TELEHEALTH_JOBS,
  registerTelehealthHandlers,
} from './jobs.js';
export { TelehealthJobService } from './job-service.js';
export type { EndedStale, EnsureOutcome, StaleSession, TelehealthJobDeps } from './job-service.js';
export { telehealthPort } from './port.js';
export type {
  JoinTokenGrant,
  JoinTokenRequest,
  TelehealthWorkerPort,
  VideoVendorPort,
} from './port.js';
export {
  JOIN_OPENS_MINUTES,
  LOCATION_VALID_HOURS,
  MEETING_LEAD_MINUTES,
  STALE_AFTER_HOURS,
  TOKEN_TTL_SECONDS,
  joinOpensAt,
  meetingDueAt,
  normaliseState,
  parseDeviceCheck,
  patientWindow,
  hostWindow,
  isStale,
} from './rules.js';
export {
  LicensingRefusedError,
  LocationRequiredError,
  NotAdmittedError,
  PatientMergedError,
  SessionClosedError,
  SessionNotFoundError,
  TelehealthError,
  TelehealthScopeError,
  TelehealthValidationError,
  TooEarlyError,
  VendorUnavailableError,
} from './errors.js';
export type {
  Admission,
  DeviceCheck,
  HostSessionView,
  JoinGrant,
  LicensingResult,
  LocationOutcome,
  ParticipantRole,
  PatientSessionView,
  SessionStatus,
  TelehealthMeta,
  WaitingEntry,
} from './types.js';
