// Registry codes of the documents module (ARCHITECTURE 29.2, 29.3, 30). Codes only: no value from the request, no file name, no
// database text. They extend the platform's ApiError, so the exception filter sends them as the standard error body (28.4).
import { ApiError } from '../../platform/errors.js';

export class DocumentsError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'DocumentsError';
  }
}

export class DocumentsValidationError extends DocumentsError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422, false, {
      errors: fields.map((f) => ({
        path: f.startsWith('/') ? f : `/${f}`,
        code: 'kernel.invalid_value',
      })),
    });
    this.name = 'DocumentsValidationError';
  }
}

/** 404 kernel.not_found: absent, or hidden by row-level security (CN-04, TC-DOC-06). */
export class DocumentNotFoundError extends DocumentsError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'DocumentNotFoundError';
  }
}

/** 422 documents.type_not_allowed: the declared type, or the file name's extensions, are not on the allow list (NFR-17, TC-DOC-03). */
export class TypeNotAllowedError extends DocumentsError {
  constructor() {
    super('documents.type_not_allowed', 422);
    this.name = 'TypeNotAllowedError';
  }
}

/** 422 documents.too_large: over `upload_max_mb` (29.2 lists it under 422). */
export class TooLargeError extends DocumentsError {
  constructor() {
    super('documents.too_large', 422);
    this.name = 'TooLargeError';
  }
}

/** 409 documents.not_available: the file is not clean (or is gone), so no one gets a URL for it (BR-28, AC-30). */
export class NotAvailableError extends DocumentsError {
  constructor() {
    super('documents.not_available', 409);
    this.name = 'NotAvailableError';
  }
}

/** 409 documents.legal_hold: a deletion request met a hold; the refusal and its reason are recorded (AC-31). */
export class LegalHoldError extends DocumentsError {
  constructor(readonly requestId?: string) {
    super(
      'documents.legal_hold',
      409,
      false,
      requestId === undefined
        ? {}
        : { errors: [{ path: `/deletionRequests/${requestId}`, code: 'documents.legal_hold' }] },
    );
    this.name = 'LegalHoldError';
  }
}

/** 409 documents.retention: the retention period has not ended or is not set (BR-29, D-8). */
export class RetentionError extends DocumentsError {
  constructor(readonly requestId?: string) {
    super(
      'documents.retention',
      409,
      false,
      requestId === undefined
        ? {}
        : { errors: [{ path: `/deletionRequests/${requestId}`, code: 'documents.retention' }] },
    );
    this.name = 'RetentionError';
  }
}

/** 409 documents.invalid_transition: the step is not allowed from the document's state (ST-06). */
export class InvalidTransitionError extends DocumentsError {
  constructor() {
    super('documents.invalid_transition', 409);
    this.name = 'InvalidTransitionError';
  }
}

export class PatientMergedError extends DocumentsError {
  constructor() {
    super('patient.merged', 409);
    this.name = 'PatientMergedError';
  }
}

export class PreconditionFailedError extends DocumentsError {
  constructor() {
    super('kernel.precondition_failed', 412);
    this.name = 'PreconditionFailedError';
  }
}

/** 429 kernel.rate_limited: more uploads than `uploads_per_day` for this person. */
export class UploadLimitError extends DocumentsError {
  constructor() {
    super('kernel.rate_limited', 429, true);
    this.name = 'UploadLimitError';
  }
}

/** The caller's transaction lacks what the operation needs. */
export class DocumentsScopeError extends DocumentsError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'DocumentsScopeError';
  }
}

/**
 * The tables' triggers raise class-P SQLSTATEs (migrations 1001): PS001 an illegal step, PS002 a deletion that a hold or the
 * retention rule refuses (the message is the reason code), PM001 a merged patient, PM008 an unknown one. This turns them into the
 * module's errors and rethrows everything else for the platform's database-error mapper.
 */
export function translateDbError(err: unknown): never {
  const e =
    typeof err === 'object' && err !== null ? (err as { code?: unknown; message?: unknown }) : {};
  switch (e.code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM008':
      throw new DocumentNotFoundError();
    case 'PS001':
      throw new InvalidTransitionError();
    case 'PS002':
      throw e.message === 'legal_hold' ? new LegalHoldError() : new RetentionError();
    default:
      throw err;
  }
}
