// Public surface of the patient module (ARCHITECTURE 24). Other modules import only from here.
export { createPatient } from './runtime.js';
export type { Patient, PatientDeps } from './runtime.js';
export { PatientService, validateDemographics } from './service.js';
export type { PatientServiceDeps } from './service.js';
export { PatientRecordsService, CHANNELS } from './records.js';
export type {
  CareTeamView,
  Channel,
  ConsentTemplatePort,
  ConsentView,
  ContactView,
  CoverageView,
  DuplicateFlagView,
  PreferenceView,
  RecordsDeps,
  StaffDirectoryPort,
} from './records.js';
export { patientScopeContributor, patientInScope } from './scope.js';
export { createPatientControllers, patientResolvers, ifMatchVersion } from './controller.js';
export type { PatientControllerDeps } from './controller.js';
export { PATIENT_JOBS, PATIENT_EVENTS } from './jobs.js';
export {
  matchValuesHash,
  normaliseDateOfBirth,
  normaliseEmail,
  normaliseName,
  normalisePhone,
} from './normalise.js';
export {
  AlreadyLinkedError,
  AttachNotAllowedError,
  ChannelUnavailableError,
  ConsentNotPendingError,
  DuplicateAcknowledgementRequiredError,
  MatchCheckRequiredError,
  MatchCheckStaleError,
  PatientError,
  PatientMergedError,
  PatientNotFoundError,
  PatientRateLimitedError,
  PatientScopeError,
  PatientValidationError,
  PreconditionFailedError,
  PreconditionRequiredError,
  ProxyRulesNotConfiguredError,
  translateDbError,
} from './errors.js';
export type {
  Demographics,
  IdentityLabel,
  MatchCandidate,
  MatchResult,
  PatientBanner,
  PatientRecord,
  RegisterInput,
  RequestMeta,
} from './types.js';
export {
  AlreadyMergedError,
  MergeExecutionError,
  MergeNotDecidableError,
  MergePendingError,
  MergeSelfApprovalError,
  MergeService,
  createMergeControllers,
  executeMerge,
  MERGE_JOBS,
  mergeResolvers,
} from './merge/index.js';
export type { ExecuteDeps, ExecuteResult } from './merge/index.js';
// Test harness: type-only exports plus a lazy loader, so importing this index never runs the harness (it needs a test database).
export type { Client, Kit, SeededSession } from './testkit.js';
export const loadPatientTestkit = (): Promise<typeof import('./testkit.js')> =>
  import('./testkit.js');
