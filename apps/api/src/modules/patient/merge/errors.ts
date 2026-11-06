// Registry codes of the merge (ARCHITECTURE 30, OpenAPI patient.yaml `patient-merges`). Codes only: no value from the request, no
// database text. SQLSTATEs PM009..PM013 are raised by the functions of migration 0803.
import { PatientError, PatientMergedError, PatientNotFoundError } from '../errors.js';

/** 409 patient.already_merged: one of the two records is no longer active (or the request's merge is done). */
export class AlreadyMergedError extends PatientError {
  constructor() {
    super('patient.already_merged', 409);
    this.name = 'AlreadyMergedError';
  }
}

/** 409 patient.merge_pending: an open request already exists for the merged patient. */
export class MergePendingError extends PatientError {
  constructor() {
    super('patient.merge_pending', 409);
    this.name = 'MergePendingError';
  }
}

/** 403 patient.merge_self_approval: the requester (or the same person) may not decide the request (BQ-3). */
export class MergeSelfApprovalError extends PatientError {
  constructor() {
    super('patient.merge_self_approval', 403);
    this.name = 'MergeSelfApprovalError';
  }
}

/** 412 kernel.precondition_failed: the request is not awaiting a decision (already approved, rejected, failed or cancelled). */
export class MergeNotDecidableError extends PatientError {
  constructor() {
    super('kernel.precondition_failed', 412);
    this.name = 'MergeNotDecidableError';
  }
}

/** Raised by the execute job when the merge cannot be completed. Never reaches an HTTP client. */
export class MergeExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MergeExecutionError';
  }
}

/** Turns the class-P SQLSTATEs of 0803 (and 0701-0704) into registry errors; anything else is rethrown for the platform mapper. */
export function translateMergeDbError(err: unknown): never {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  switch (code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM008':
      throw new PatientNotFoundError();
    case 'PM009':
      throw new AlreadyMergedError();
    case 'PM010':
      throw new MergePendingError();
    case 'PM011':
      throw new MergeSelfApprovalError();
    case 'PM012':
      throw new MergeNotDecidableError();
    default:
      throw err;
  }
}
