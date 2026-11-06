// Registry codes of the identity module (ARCHITECTURE 30). Codes only: no value from the request, no database text.
// They extend the platform's ApiError, so the exception filter sends them as the standard error body (28.4).
import { ApiError } from '../../platform/errors.js';

export class IdentityError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'IdentityError';
  }
}

/** 401 identity.sign_in_failed: one code for every sign-in failure (state, nonce, token, domain, provisioning). */
export class SignInFailedError extends IdentityError {
  constructor() {
    super('identity.sign_in_failed', 401);
    this.name = 'SignInFailedError';
  }
}

/** 401 auth.unauthenticated / auth.session_expired. */
export class UnauthenticatedError extends IdentityError {
  constructor(code: 'auth.unauthenticated' | 'auth.session_expired' = 'auth.unauthenticated') {
    super(code, 401);
    this.name = 'UnauthenticatedError';
  }
}

/** 403 auth.forbidden (and the other 403 codes of 30). */
export class ForbiddenError extends IdentityError {
  constructor(code = 'auth.forbidden') {
    super(code, 403);
    this.name = 'ForbiddenError';
  }
}

/** 429 kernel.rate_limited, raised before any verification work. */
export class RateLimitedError extends IdentityError {
  constructor(readonly retryAfterSeconds: number) {
    super('kernel.rate_limited', 429, true, { retryAfterSeconds });
    this.name = 'RateLimitedError';
  }
}

/** The caller's transaction lacks what the operation needs (a missing setting fails closed). */
export class IdentityScopeError extends IdentityError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'IdentityScopeError';
  }
}

/** 422 kernel.validation_failed raised by a service method. `fields` names the offending fields, never their values. */
export class IdentityValidationError extends IdentityError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422);
    this.name = 'IdentityValidationError';
  }
}
