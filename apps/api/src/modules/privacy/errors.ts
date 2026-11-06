// Registry codes of the privacy module (ARCHITECTURE 29.2, 29.4, 30). Codes only: no value from the request, no database text. They
// extend the platform's ApiError, so the exception filter sends them as the standard error body (28.4).
import { ApiError } from '../../platform/errors.js';

export class PrivacyError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'PrivacyError';
  }
}

export class PrivacyValidationError extends PrivacyError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422, false, {
      errors: fields.map((f) => ({
        path: f.startsWith('/') ? f : `/${f}`,
        code: 'kernel.invalid_value',
      })),
    });
    this.name = 'PrivacyValidationError';
  }
}

/** 404 kernel.not_found: absent, or hidden by row-level security (CN-04, TC-PR-04). */
export class PrivacyNotFoundError extends PrivacyError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'PrivacyNotFoundError';
  }
}

/** 409 privacy.export_not_ready: the package is not `ready` or `released` (still assembling, failed, expired, or never started). */
export class ExportNotReadyError extends PrivacyError {
  constructor() {
    super('privacy.export_not_ready', 409);
    this.name = 'ExportNotReadyError';
  }
}

/** 409 privacy.blocked_on_decision: what deletion means is undecided (D-8), so no deletion request can be approved. */
export class BlockedOnDecisionError extends PrivacyError {
  constructor() {
    super('privacy.blocked_on_decision', 409);
    this.name = 'BlockedOnDecisionError';
  }
}

/**
 * 409 privacy.invalid_transition: the step is not allowed from the request's, package's or incident's state (ST-06), for example
 * approving a request whose identity is not verified (TC-PR-05). PS001 maps here (30); the code is not in the registry yet (README O-1).
 */
export class InvalidTransitionError extends PrivacyError {
  constructor() {
    super('privacy.invalid_transition', 409);
    this.name = 'InvalidTransitionError';
  }
}

export class PatientMergedError extends PrivacyError {
  constructor() {
    super('patient.merged', 409);
    this.name = 'PatientMergedError';
  }
}

export class PreconditionFailedError extends PrivacyError {
  constructor() {
    super('kernel.precondition_failed', 412);
    this.name = 'PreconditionFailedError';
  }
}

/** The caller's transaction lacks what the operation needs (a wrong audience or realm for the method). */
export class PrivacyScopeError extends PrivacyError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'PrivacyScopeError';
  }
}

/**
 * An export assembly that cannot complete. `code` is a registry-style code recorded on the package (`failure_code`): a code only.
 * `privacy.contributor_missing` is a module that holds patient data and has no export contributor (SHARED-BOUNDARIES 6.7, TICKETS BE-20).
 */
export class ExportAssemblyError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'ExportAssemblyError';
  }
}

/**
 * The tables' triggers raise class-P SQLSTATEs (migration 1901): PS001 an illegal step, PM001 a merged patient, PM008 an unknown one;
 * 23505 on the one live package per request. Anything else is rethrown for the platform's database-error mapper.
 */
export function translateDbError(err: unknown): never {
  const e = typeof err === 'object' && err !== null ? (err as { code?: unknown }) : {};
  switch (e.code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM008':
      throw new PrivacyNotFoundError();
    case 'PS001':
    case '23505':
      throw new InvalidTransitionError();
    default:
      throw err;
  }
}
