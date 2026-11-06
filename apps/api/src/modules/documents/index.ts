// Public surface of the documents module (ARCHITECTURE 24, ticket BE-10). Other modules import only from here.
// Composition, at start-up:
//   1. define DOCUMENTS_JOBS in the API's and the worker's JobRegistry (and sync queue task types);
//   2. registerDocumentsParticipants() next to the patient merge's other participants (merge) and the privacy export (exportPart);
//   3. API: new DocumentsService({ audit, organisation, store, queue }) with the object store's presigner (SignedUrlPresigner is
//      for tests only); controllers via createDocumentsControllers; resolvers via documentsResolvers();
//   4. worker: createDocumentsTasks (apps/worker/src/jobs/documents) with the object store, scanner and OCR ports, and DOCUMENTS_CRONTAB.
export {
  DocumentsService,
  DOWNLOAD_URL_SECONDS,
  UPLOAD_URL_SECONDS,
  fileNameAllowed,
} from './service.js';
export type { DocumentsDeps } from './service.js';
export { createDocumentsControllers, documentsResolvers } from './controller.js';
export type { DocumentsControllerDeps } from './controller.js';
export {
  DOCUMENTS_CONFLICT_RULES,
  DOCUMENTS_MERGE_TABLES,
  documentsExportContributor,
  documentsMergeParticipant,
  registerDocumentsParticipants,
} from './merge.js';
export { DOCUMENTS_CRONTAB, DOCUMENTS_EVENTS, DOCUMENTS_JOBS } from './jobs.js';
export { SignedUrlPresigner } from './ports.js';
export type { Bucket, ObjectStorePort, PresignGet, PresignPut, Presigned } from './ports.js';
export {
  DocumentNotFoundError,
  DocumentsError,
  DocumentsScopeError,
  DocumentsValidationError,
  InvalidTransitionError,
  LegalHoldError,
  NotAvailableError,
  PatientMergedError,
  PreconditionFailedError,
  RetentionError,
  TooLargeError,
  TypeNotAllowedError,
  UploadLimitError,
  translateDbError,
} from './errors.js';
export {
  ALLOWED_TYPES,
  CLASSIFICATIONS,
  PATIENT_RELEASED_CLASSIFICATIONS,
  PATIENT_UPLOAD_CLASSIFICATIONS,
} from './types.js';
export type {
  Classification,
  CreateUploadInput,
  DeletionOutcome,
  DeletionRequestView,
  DocumentStatus,
  DocumentView,
  DownloadUrl,
  HoldAction,
  RequestMeta,
  ScanStatus,
  UploadTicket,
} from './types.js';
