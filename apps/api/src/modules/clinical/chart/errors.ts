// Registry codes of the clinical chart (ARCHITECTURE 29.3, 29.4, 30). Codes only: no value from the request, no chart text, no
// database text. They extend the platform's ApiError, so the exception filter sends them as the standard error body (28.4).
import { ApiError } from '../../../platform/errors.js';

export class ChartError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'ChartError';
  }
}

export class ChartValidationError extends ChartError {
  constructor(
    readonly fields: readonly string[],
    code = 'kernel.invalid_value',
  ) {
    super('kernel.validation_failed', 422, false, {
      errors: fields.map((f) => ({ path: f.startsWith('/') ? f : `/${f}`, code })),
    });
    this.name = 'ChartValidationError';
  }
}

/** 404 kernel.not_found: absent, or hidden by row-level security (CN-04). */
export class ChartNotFoundError extends ChartError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'ChartNotFoundError';
  }
}

/** 422 clinical.uncoded_requires_display: free text needs its text (RA-R1-09: saved with `coded: false`). */
export class UncodedRequiresDisplayError extends ChartError {
  constructor() {
    super('clinical.uncoded_requires_display', 422, false, {
      errors: [{ path: '/display', code: 'clinical.uncoded_requires_display' }],
    });
    this.name = 'UncodedRequiresDisplayError';
  }
}

/** 409 clinical.vital_range_overlap: an active range already covers this code, sex and age (exclusion constraint, 22.11). */
export class VitalRangeOverlapError extends ChartError {
  constructor() {
    super('clinical.vital_range_overlap', 409);
    this.name = 'VitalRangeOverlapError';
  }
}

/** 409 clinical.invalid_transition: the change is not allowed from the entry's state (an entry entered in error is final). */
export class InvalidTransitionError extends ChartError {
  constructor() {
    super('clinical.invalid_transition', 409);
    this.name = 'InvalidTransitionError';
  }
}

export class PatientMergedError extends ChartError {
  constructor() {
    super('patient.merged', 409);
    this.name = 'PatientMergedError';
  }
}

export class PreconditionFailedError extends ChartError {
  constructor() {
    super('kernel.precondition_failed', 412);
    this.name = 'PreconditionFailedError';
  }
}

/** The caller's transaction lacks what the operation needs. */
export class ChartScopeError extends ChartError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'ChartScopeError';
  }
}

/**
 * The tables' triggers raise class-P SQLSTATEs (migrations 1601): PS001 an illegal change, PM001 a merged patient, PM008 an unknown
 * one; the exclusion constraint of the reference ranges raises 23P01. This turns them into the module's errors and rethrows
 * everything else for the platform's database-error mapper.
 */
export function translateDbError(err: unknown): never {
  const e =
    typeof err === 'object' && err !== null
      ? (err as { code?: unknown; constraint?: unknown })
      : {};
  switch (e.code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM008':
      throw new ChartNotFoundError();
    case 'PS001':
      throw new InvalidTransitionError();
    case '23P01':
      if (e.constraint === 'vital_range_no_overlap') throw new VitalRangeOverlapError();
      throw err;
    case '23505':
      // A vital sign is corrected at most once (UNIQUE corrects_id): the second correction of the same row loses the race.
      if (e.constraint === 'vital_sign_corrects_uq') throw new InvalidTransitionError();
      throw err;
    default:
      throw err;
  }
}
