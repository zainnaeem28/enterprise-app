// Registry codes of the availability module (ARCHITECTURE 29.3, 30). Codes only: no value from the request, no database text. They
// extend the booking core's SchedulingError (and so the platform's ApiError). Counts of affected appointments travel as `errors`
// entries `{path: '/conflicts/<status>', code: '<count>'}`, the same device the booking core uses for alternatives (the error body has
// no member for data, and an appointment's patient never appears here: occupancy rows have none).
import { SchedulingError } from '../core/errors.js';

export {
  InvalidTransitionError,
  PreconditionFailedError,
  SchedulingScopeError,
  SchedulingValidationError,
} from '../core/errors.js';

/** 409 scheduling.conflicts_with_appointments (29.3): leave or blocked time over booked appointments; lists counts only. */
export class ConflictsWithAppointmentsError extends SchedulingError {
  constructor(readonly counts: Readonly<Record<string, number>>) {
    super('scheduling.conflicts_with_appointments', 409, false, {
      errors: Object.entries(counts).map(([k, n]) => ({
        path: `/conflicts/${k}`,
        code: String(n),
      })),
    });
    this.name = 'ConflictsWithAppointmentsError';
  }
}

/** 422 scheduling.roster_principal_ineligible (29.3, draft 6): the principal does not hold the duty's role at the location. */
export class RosterPrincipalIneligibleError extends SchedulingError {
  constructor() {
    super('scheduling.roster_principal_ineligible', 422);
    this.name = 'RosterPrincipalIneligibleError';
  }
}

/** 404 kernel.not_found: absent, or hidden by row-level security (CN-04). */
export class AvailabilityNotFoundError extends SchedulingError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'AvailabilityNotFoundError';
  }
}
