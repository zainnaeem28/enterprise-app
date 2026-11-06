// Registry codes of the scheduling flow (ARCHITECTURE 25.5, 25.6, 29.2, 29.3, 30). Codes only: no value from the request, no database
// text. They extend the booking core's SchedulingError (an ApiError), so the exception filter sends the standard error body (28.4).
// Errors the core already owns (not found, invalid transition, precondition failed, validation) are re-exported, not redefined.
import { SchedulingError } from '../core/errors.js';

export {
  InvalidTransitionError,
  PatientMergedError,
  PreconditionFailedError,
  ReservationNotFoundError,
  SchedulingScopeError,
  SchedulingValidationError,
  SlotTakenError,
  translateDbError,
} from '../core/errors.js';

/** 422 scheduling.check_in_not_allowed (25.5): wrong place, day, mode or state, and also a wrong or stale QR token (29.2). */
export class CheckInNotAllowedError extends SchedulingError {
  constructor() {
    super('scheduling.check_in_not_allowed', 422);
    this.name = 'CheckInNotAllowedError';
  }
}

/** 422 scheduling.grace_not_elapsed (29.3): staff mark a no-show only once the grace period after the start has passed. */
export class GraceNotElapsedError extends SchedulingError {
  constructor() {
    super('scheduling.grace_not_elapsed', 422);
    this.name = 'GraceNotElapsedError';
  }
}

/** 422 scheduling.waitlist_disabled (29.2): the booking policy for this service and place has the waitlist off. */
export class WaitlistDisabledError extends SchedulingError {
  constructor() {
    super('scheduling.waitlist_disabled', 422);
    this.name = 'WaitlistDisabledError';
  }
}

/** 409 scheduling.offer_expired (29.2): the offer lapsed, was taken back, or is no longer open. The "no longer available" answer. */
export class OfferExpiredError extends SchedulingError {
  constructor() {
    super('scheduling.offer_expired', 409);
    this.name = 'OfferExpiredError';
  }
}
