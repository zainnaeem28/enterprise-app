// Registry codes of the booking core (ARCHITECTURE 25.1, 29.2, 30). Codes only: no value from the request, no database text. They
// extend the platform's ApiError, so the exception filter sends them as the standard error body (28.4). The alternatives of a
// refused slot travel as `errors` entries `{path: '/alternatives/<n>', code: <ISO start time>}` (the body has no member for data).
import { ApiError } from '../../../platform/errors.js';

export class SchedulingError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'SchedulingError';
  }
}

const alternativesOf = (alternatives: readonly string[]): ApiError['extras'] =>
  alternatives.length === 0
    ? {}
    : { errors: alternatives.map((a, i) => ({ path: `/alternatives/${i}`, code: a })) };

export class SchedulingValidationError extends SchedulingError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422, false, {
      errors: fields.map((f) => ({
        path: f.startsWith('/') ? f : `/${f}`,
        code: 'kernel.invalid_value',
      })),
    });
    this.name = 'SchedulingValidationError';
  }
}

/** 404 kernel.not_found: absent, or hidden by row-level security (CN-04). */
export class ReservationNotFoundError extends SchedulingError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'ReservationNotFoundError';
  }
}

/** 409 scheduling.slot_taken, with up to five alternative start times from a fresh search (25.1). */
export class SlotTakenError extends SchedulingError {
  constructor(readonly alternatives: readonly string[] = []) {
    super('scheduling.slot_taken', 409, false, alternativesOf(alternatives));
    this.name = 'SlotTakenError';
  }
}

/** 409 scheduling.hold_expired, with alternatives (25.1 confirm step 4). */
export class HoldExpiredError extends SchedulingError {
  constructor(readonly alternatives: readonly string[] = []) {
    super('scheduling.hold_expired', 409, false, alternativesOf(alternatives));
    this.name = 'HoldExpiredError';
  }
}

export class MaxFutureReachedError extends SchedulingError {
  constructor() {
    super('scheduling.max_future_reached', 422);
    this.name = 'MaxFutureReachedError';
  }
}

/** 422 scheduling.overlapping_appointment (38.2 item 15, BQ-9): the patient already has an active reservation in that time. */
export class OverlappingAppointmentError extends SchedulingError {
  constructor() {
    super('scheduling.overlapping_appointment', 422);
    this.name = 'OverlappingAppointmentError';
  }
}

export class LicensingRefusedError extends SchedulingError {
  constructor() {
    super('scheduling.licensing_refused', 422);
    this.name = 'LicensingRefusedError';
  }
}

export class LeadTimeError extends SchedulingError {
  constructor() {
    super('scheduling.lead_time', 422);
    this.name = 'LeadTimeError';
  }
}

export class OutsideHoursError extends SchedulingError {
  constructor() {
    super('scheduling.outside_hours', 422);
    this.name = 'OutsideHoursError';
  }
}

/** 422 scheduling.cutoff_passed: a patient change inside the cut-off, late_change = block (BR-01, D-3 default). */
export class CutoffPassedError extends SchedulingError {
  constructor() {
    super('scheduling.cutoff_passed', 422);
    this.name = 'CutoffPassedError';
  }
}

/** 422 scheduling.fee_acceptance_required: late_change = fee and the request did not carry acceptFee: true. Nothing is charged (D-3). */
export class FeeAcceptanceRequiredError extends SchedulingError {
  constructor() {
    super('scheduling.fee_acceptance_required', 422);
    this.name = 'FeeAcceptanceRequiredError';
  }
}

export class InvalidTransitionError extends SchedulingError {
  constructor() {
    super('scheduling.invalid_transition', 409);
    this.name = 'InvalidTransitionError';
  }
}

export class PatientMergedError extends SchedulingError {
  constructor() {
    super('patient.merged', 409);
    this.name = 'PatientMergedError';
  }
}

export class PreconditionFailedError extends SchedulingError {
  constructor() {
    super('kernel.precondition_failed', 412);
    this.name = 'PreconditionFailedError';
  }
}

/** The caller's transaction lacks what the operation needs. */
export class SchedulingScopeError extends SchedulingError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'SchedulingScopeError';
  }
}

/**
 * The booking functions and triggers raise class-P SQLSTATEs and the exclusion violation (migrations 0900-0903). This turns the
 * ones with a registry code into the module's errors and rethrows everything else for the platform's database-error mapper.
 * `23P01` is `scheduling.slot_taken` at every place it can come from (the exclusion constraints and the overbook cap).
 */
export function translateDbError(err: unknown, alternatives: readonly string[] = []): never {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  switch (code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM008':
      throw new ReservationNotFoundError();
    case '23P01':
      throw new SlotTakenError(alternatives);
    case 'PS001':
      throw new InvalidTransitionError();
    default:
      throw err;
  }
}
