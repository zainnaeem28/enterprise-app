// Public surface of the privacy module (ARCHITECTURE 24, ticket BE-20). Other modules import only from here.
// Composition, at start-up:
//   1. define PRIVACY_JOBS in the API's and the worker's JobRegistry (and sync queue task types);
//   2. registerPrivacyParticipants() next to the patient merge's other participants; every module that holds patient data registers
//      its export contributor with the kernel's `registerExportContributor` (documents, identity, notifications, scheduling and
//      clinical do; messaging and telehealth do when they arrive; `patient.exportPart` is passed as `downward`);
//   3. API: createPrivacy({ db, audit, organisation, identity, queue, store }); register `controllers` (it registers its resolvers
//      `privacy-patient` and `privacy-request` with the identity module);
//   4. worker: `privacy.assemble_export` -> assembleExport(deps, { packageId: payload.packageId, jobId, attempt, maxAttempts }) with the
//      worker's package writer; `privacy.check_legal_holds` and `privacy.expire_packages` from apps/worker/src/jobs/privacy; PRIVACY_CRONTAB.
export { createPrivacy } from './runtime.js';
export type { Privacy, PrivacyDeps } from './runtime.js';
export { createPrivacyControllers, privacyResolvers } from './controller.js';
export type { PrivacyControllerDeps } from './controller.js';
export {
  ASSEMBLE_EXPORT_JOB,
  CHECK_HOLDS_JOB,
  CORRECTION_EVENT,
  DEFAULT_DUE_DAYS,
  DEFAULT_EXPORT_EXPIRY_DAYS,
  RequestService,
  toRequestView,
} from './requests.js';
export type { Decision, RequestDeps } from './requests.js';
export { IncidentService } from './incidents.js';
export type { IncidentDeps } from './incidents.js';
export { DOWNLOAD_URL_SECONDS, PackageService } from './packages.js';
export type { PackageDeps } from './packages.js';
export { OWNER_COVERED, assembleExport, patientDataModules } from './assemble.js';
export type { AssembleDeps, AssembleInput, AssembleResult } from './assemble.js';
export {
  PRIVACY_CONFLICT_RULES,
  PRIVACY_MERGE_TABLES,
  privacyExportPart,
  privacyMergeParticipant,
  registerPrivacyParticipants,
} from './merge.js';
export { PRIVACY_CRONTAB, PRIVACY_EVENTS, PRIVACY_JOBS } from './jobs.js';
export { SignedPackageUrls } from './ports.js';
export type { PackageStorePort, PackageWriterPort, PresignedGet } from './ports.js';
export { patientsScope, systemScope } from './scope.js';
export {
  BlockedOnDecisionError,
  ExportAssemblyError,
  ExportNotReadyError,
  InvalidTransitionError,
  PatientMergedError,
  PreconditionFailedError,
  PrivacyError,
  PrivacyNotFoundError,
  PrivacyScopeError,
  PrivacyValidationError,
  translateDbError,
} from './errors.js';
export type {
  DownloadUrl,
  IncidentStatus,
  IncidentView,
  PackageStatus,
  PackageView,
  RequestKind,
  RequestMeta,
  RequestStatus,
  RequestView,
  Severity,
} from './types.js';
