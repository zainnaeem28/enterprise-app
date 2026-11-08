// Registry codes of calendar-sync (ARCHITECTURE 29.3, 30). Codes only: no value from the request, no vendor text, no database text.
// They extend the platform's ApiError, so the exception filter sends them as the standard error body (28.4).
import { ApiError } from '../../platform/errors.js';

export class CalendarSyncError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'CalendarSyncError';
  }
}

/** 400 kernel.validation_failed: a malformed, expired or foreign OAuth `state`, or a missing `code`. Names the field only. */
export class CalendarValidationError extends CalendarSyncError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 400, false, {
      errors: fields.map((f) => ({ path: `/${f}`, code: 'kernel.invalid_value' })),
    });
    this.name = 'CalendarValidationError';
  }
}

/** 404 kernel.not_found: the caller has no calendar link. */
export class CalendarLinkNotFoundError extends CalendarSyncError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'CalendarLinkNotFoundError';
  }
}

/** 403 auth.forbidden: not a google-realm staff principal (the guard has already refused; this is the second line). */
export class CalendarScopeError extends CalendarSyncError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'CalendarScopeError';
  }
}

/** 503 kernel.unavailable: no enabled google_calendar connection, or the secret store did not answer. Nothing was stored. */
export class CalendarUnavailableError extends CalendarSyncError {
  constructor() {
    super('kernel.unavailable', 503, true);
    this.name = 'CalendarUnavailableError';
  }
}
