// Registry codes of the admin realm (ARCHITECTURE 29.1, 29.4, 30). Codes only: nothing from the request, nothing from the
// database or the WebAuthn library ever reaches a body.
import { IdentityError } from '../errors.js';

/** 401 identity.elevation_failed: one code for every elevation-ceremony failure. */
export class ElevationFailedError extends IdentityError {
  constructor() {
    super('identity.elevation_failed', 401);
    this.name = 'ElevationFailedError';
  }
}

/** 401 identity.enrolment_failed: one code for every enrolment failure (unknown handle, bad, used or expired token...). */
export class EnrolmentFailedError extends IdentityError {
  constructor() {
    super('identity.enrolment_failed', 401);
    this.name = 'EnrolmentFailedError';
  }
}

/** 403 identity.elevation_required: a privileged route without a live elevation grant (25.8). */
export class ElevationRequiredError extends IdentityError {
  constructor() {
    super('identity.elevation_required', 403);
    this.name = 'ElevationRequiredError';
  }
}

export class AdminForbiddenError extends IdentityError {
  constructor(code: 'identity.self_approval' | 'identity.approver_is_subject' | 'auth.forbidden') {
    super(code, 403);
    this.name = 'AdminForbiddenError';
  }
}

export class AdminNotFoundError extends IdentityError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'AdminNotFoundError';
  }
}

/** 409 for a request that is no longer pending or has expired. */
export class AdminConflictError extends IdentityError {
  constructor(
    code: 'identity.request_expired' | 'identity.request_not_pending' | 'identity.principal_exists',
  ) {
    super(code, 409);
    this.name = 'AdminConflictError';
  }
}

/** 422 with a specific registry code (role realm mismatch, privileged role in the staff realm...). */
export class AdminUnprocessableError extends IdentityError {
  constructor(
    code:
      | 'identity.role_realm_mismatch'
      | 'identity.privileged_role_in_staff_realm'
      | 'identity.principal_not_enrollable',
  ) {
    super(code, 422);
    this.name = 'AdminUnprocessableError';
  }
}
