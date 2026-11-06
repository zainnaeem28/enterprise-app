// Registry codes of the patient module (ARCHITECTURE 30). Codes only: no value from the request, no database text. They extend
// the platform's ApiError, so the exception filter sends them as the standard error body (28.4).
import { ApiError } from '../../platform/errors.js';

export class PatientError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'PatientError';
  }
}

/** 422 kernel.validation_failed. `fields` names the offending fields (JSON pointers), never their values. */
export class PatientValidationError extends PatientError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422, false, {
      errors: fields.map((f) => ({
        path: f.startsWith('/') ? f : `/${f}`,
        code: 'kernel.invalid_value',
      })),
    });
    this.name = 'PatientValidationError';
  }
}

/** 404 kernel.not_found: absent, or hidden by row-level security (CN-04: the two are indistinguishable). */
export class PatientNotFoundError extends PatientError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'PatientNotFoundError';
  }
}

/** 409 patient.merged. The survivor's ID is added by the caller only when the caller may read the survivor (9.2). */
export class PatientMergedError extends PatientError {
  /**
   * The platform's error body has no member for extra data, so the survivor travels as the one entry of `errors`:
   * `{path: '/survivorId', code: <uuid>}`. Absent when the caller cannot read the survivor.
   */
  constructor(readonly survivorId?: string) {
    super(
      'patient.merged',
      409,
      false,
      survivorId === undefined ? {} : { errors: [{ path: '/survivorId', code: survivorId }] },
    );
    this.name = 'PatientMergedError';
  }
}

export class MatchCheckRequiredError extends PatientError {
  constructor() {
    super('patient.match_check_required', 422);
    this.name = 'MatchCheckRequiredError';
  }
}

export class MatchCheckStaleError extends PatientError {
  constructor() {
    super('patient.match_check_stale', 422);
    this.name = 'MatchCheckStaleError';
  }
}

/** 422 kernel.validation_failed: a candidate was returned, so the registration needs an acknowledgement with a reason (25.3). */
export class DuplicateAcknowledgementRequiredError extends PatientError {
  constructor() {
    super('kernel.validation_failed', 422, false, {
      errors: [
        { path: '/duplicateAcknowledged', code: 'kernel.required' },
        { path: '/acknowledgeReason', code: 'kernel.required' },
      ],
    });
    this.name = 'DuplicateAcknowledgementRequiredError';
  }
}

/** 403 patient.attach_not_allowed: setting off, not an exact match, patient not present, or a ref that is not the caller's. */
export class AttachNotAllowedError extends PatientError {
  constructor() {
    super('patient.attach_not_allowed', 403);
    this.name = 'AttachNotAllowedError';
  }
}

export class AlreadyLinkedError extends PatientError {
  constructor() {
    super('patient.already_linked', 409);
    this.name = 'AlreadyLinkedError';
  }
}

export class ConsentNotPendingError extends PatientError {
  constructor() {
    super('patient.consent_not_pending', 409);
    this.name = 'ConsentNotPendingError';
  }
}

export class ChannelUnavailableError extends PatientError {
  constructor() {
    super('patient.channel_unavailable', 422);
    this.name = 'ChannelUnavailableError';
  }
}

/** 422 identity.proxy_rules_not_configured: the D-7 verification rule values do not exist yet (RA-R1-20b is blocked). */
export class ProxyRulesNotConfiguredError extends PatientError {
  constructor() {
    super('identity.proxy_rules_not_configured', 422);
    this.name = 'ProxyRulesNotConfiguredError';
  }
}

export class PreconditionRequiredError extends PatientError {
  constructor() {
    super('kernel.precondition_required', 428);
    this.name = 'PreconditionRequiredError';
  }
}

export class PreconditionFailedError extends PatientError {
  constructor() {
    super('kernel.precondition_failed', 412);
    this.name = 'PreconditionFailedError';
  }
}

/** The caller's transaction lacks what the operation needs (a missing setting fails closed). */
export class PatientScopeError extends PatientError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'PatientScopeError';
  }
}

/** 429 kernel.rate_limited (the identity-label limit, 6.7). */
export class PatientRateLimitedError extends PatientError {
  constructor(retryAfterSeconds: number) {
    super('kernel.rate_limited', 429, true, { retryAfterSeconds });
    this.name = 'PatientRateLimitedError';
  }
}

/**
 * The patient functions raise class-P SQLSTATEs (migrations 0701-0704). This turns the ones with a registry code into the
 * module's errors and rethrows everything else unchanged, for the platform's database-error mapper (42501 -> 403/404, ...).
 */
export function translateDbError(err: unknown): never {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  switch (code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM002':
      throw new MatchCheckRequiredError();
    case 'PM003':
      throw new MatchCheckStaleError();
    case 'PM004':
      throw new DuplicateAcknowledgementRequiredError();
    case 'PM005':
      throw new AttachNotAllowedError();
    case 'PM006':
      throw new AlreadyLinkedError();
    case 'PM008':
      throw new PatientNotFoundError();
    default:
      throw err;
  }
}
