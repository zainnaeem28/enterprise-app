// Registry codes of telehealth (ARCHITECTURE 29.2, 29.3, 30). Codes only: no value from the request, no vendor text, no database text,
// no state name. They extend the platform's ApiError, so the exception filter sends them as the standard error body (28.4).
import { ApiError } from '../../platform/errors.js';

export class TelehealthError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'TelehealthError';
  }
}

export class TelehealthValidationError extends TelehealthError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422, false, {
      errors: fields.map((f) => ({
        path: f.startsWith('/') ? f : `/${f}`,
        code: 'kernel.invalid_value',
      })),
    });
    this.name = 'TelehealthValidationError';
  }
}

/** 404 kernel.not_found: absent, hidden by row-level security (CN-04), or not a video visit. */
export class SessionNotFoundError extends TelehealthError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'SessionNotFoundError';
  }
}

/** 403 auth.forbidden: the caller is not the host of the session (the guard has already refused; this is the second line). */
export class TelehealthScopeError extends TelehealthError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'TelehealthScopeError';
  }
}

/** 409 telehealth.not_admitted (retryable: the patient keeps polling): the host has not admitted this person from the waiting room. */
export class NotAdmittedError extends TelehealthError {
  constructor() {
    super('telehealth.not_admitted', 409, true);
    this.name = 'NotAdmittedError';
  }
}

/** 409 telehealth.location_required: no current confirmation of where the patient is (TL-1). */
export class LocationRequiredError extends TelehealthError {
  constructor() {
    super('telehealth.location_required', 409);
    this.name = 'LocationRequiredError';
  }
}

/** 422 telehealth.licensing_refused (TL-1, RA-R1-28): the confirmed state is outside the clinician's licence or the operating states. */
export class LicensingRefusedError extends TelehealthError {
  constructor() {
    super('telehealth.licensing_refused', 422);
    this.name = 'LicensingRefusedError';
  }
}

/** 409 telehealth.session_closed: the session ended or failed, the visit was cancelled, or the join window has closed. */
export class SessionClosedError extends TelehealthError {
  constructor() {
    super('telehealth.session_closed', 409);
    this.name = 'SessionClosedError';
  }
}

/**
 * 409 telehealth.not_admitted (retryable) before the join window opens (TC-TH-05: "refused 'too early' with the start time"). The
 * registry of section 30 has no separate code and a new one needs the Architect and the OpenAPI file, so the existing poll-again code is
 * used and the time travels as an `errors` entry `{path: '/joinOpensAt', code: <ISO time>}` (the body has no member for data).
 */
export class TooEarlyError extends TelehealthError {
  constructor(joinOpensAt: string) {
    super('telehealth.not_admitted', 409, true, {
      errors: [{ path: '/joinOpensAt', code: joinOpensAt }],
    });
    this.name = 'TooEarlyError';
  }
}

/** 503 telehealth.vendor_unavailable (retryable): the room or the join token could not be had from the video vendor. */
export class VendorUnavailableError extends TelehealthError {
  constructor() {
    super('telehealth.vendor_unavailable', 503, true);
    this.name = 'VendorUnavailableError';
  }
}

/** 409 patient.merged: the patient root is merged (PM001). */
export class PatientMergedError extends TelehealthError {
  constructor() {
    super('patient.merged', 409);
    this.name = 'PatientMergedError';
  }
}

/** Database refusals of this module's triggers and guards -> registry codes. Anything else is rethrown (the filter maps it). */
export function translateDbError(err: unknown): never {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  switch (code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM008':
      throw new SessionNotFoundError();
    case 'PS001':
      throw new SessionClosedError();
    default:
      throw err;
  }
}
