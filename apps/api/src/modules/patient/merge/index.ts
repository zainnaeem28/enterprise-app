// Public surface of the patient merge (ARCHITECTURE 24, ticket BE-09). Composition, at start-up and in this order:
//   1. define MERGE_JOBS in the API's and the worker's JobRegistry (and sync queue task types);
//   2. register the downward participants: registerIdentityParticipants(), the notifications participant, and each higher module's own;
//   3. API: new MergeService({ queue }); controllers via createMergeControllers; resolvers via mergeResolvers();
//   4. worker: task `patient.execute_merge` -> executeMerge(deps, { requestId: payload.mergeRequestId, jobId, attempt, maxAttempts }).
export { MergeService } from './service.js';
export type { MergeRequestView, MergeServiceDeps, MergeStatus } from './service.js';
export { createMergeControllers, mergeResolvers } from './controller.js';
export type { MergeControllerDeps } from './controller.js';
export { executeMerge, NOT_PARTICIPANT_TABLES } from './executor.js';
export type { ExecuteDeps, ExecuteInput, ExecuteResult } from './executor.js';
export {
  PATIENT_CONFLICT_RULES,
  PATIENT_MERGE_TABLES,
  patientMergeParticipant,
  registerPatientParticipant,
} from './participants.js';
export {
  EXECUTE_MERGE_JOB,
  MERGE_JOBS,
  jobDeclarationViolations,
  listJobDeclarations,
} from './jobs.js';
export type { JobDeclaration } from './jobs.js';
export {
  AlreadyMergedError,
  MergeExecutionError,
  MergeNotDecidableError,
  MergePendingError,
  MergeSelfApprovalError,
  translateMergeDbError,
} from './errors.js';
