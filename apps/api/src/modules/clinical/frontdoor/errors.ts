// Registry codes of the clinical front door (ARCHITECTURE 29.3, 30). Codes only: no value from the request, no clinical text, no
// database text. The chart's errors (validation, not found, precondition, invalid transition, merged patient) are reused as they
// are; the codes below are the front door's own.
import { ApiError } from '../../../platform/errors.js';
import {
  ChartError,
  ChartNotFoundError,
  InvalidTransitionError,
  PatientMergedError,
} from '../chart/errors.js';

export {
  ChartNotFoundError as FrontdoorNotFoundError,
  ChartScopeError as FrontdoorScopeError,
  ChartValidationError as FrontdoorValidationError,
  InvalidTransitionError,
  PatientMergedError,
  PreconditionFailedError,
} from '../chart/errors.js';

/**
 * 409 clinical.consents_missing: a required consent is not signed in the required version (BR-09). The template KEYS are named
 * (they are catalogue keys, not patient data): in `errors` as `/missingConsentTemplates/<key>`, which the standard body carries, and
 * as the `missingConsentTemplates` member (30), which the standard body does not serialise yet (see the module README).
 */
export class ConsentsMissingError extends ApiError {
  constructor(readonly missingConsentTemplates: readonly string[]) {
    super(409, 'clinical.consents_missing', false, {
      errors: missingConsentTemplates.map((k) => ({
        path: `/missingConsentTemplates/${k}`,
        code: 'clinical.consent_missing',
      })),
    });
    this.name = 'ConsentsMissingError';
  }
}

/** 422 clinical.referral_target_invalid: an internal referral without a target location, or the location does not offer the service. */
export class ReferralTargetInvalidError extends ChartError {
  constructor() {
    super('clinical.referral_target_invalid', 422, false, {
      errors: [{ path: '/target', code: 'clinical.referral_target_invalid' }],
    });
    this.name = 'ReferralTargetInvalidError';
  }
}

/** 409 clinical.referral_not_pending: the inbox row is no longer pending, or no longer matches the referral's sent state and target. */
export class ReferralNotPendingError extends ChartError {
  constructor() {
    super('clinical.referral_not_pending', 409);
    this.name = 'ReferralNotPendingError';
  }
}

/** 422 clinical.red_flag_answer_required: a question that a red-flag rule reads was not answered; blank is never "no" (BR-10). */
export class RedFlagAnswerRequiredError extends ChartError {
  constructor(questionIds: readonly string[]) {
    super('kernel.validation_failed', 422, false, {
      errors: questionIds.map((q) => ({
        path: `/answers/${q}`,
        code: 'clinical.red_flag_answer_required',
      })),
    });
    this.name = 'RedFlagAnswerRequiredError';
  }
}

/**
 * 409 clinical.red_flag_no_recipient: a red flag was found and nobody can receive the alert (no doctor on duty and no holder of
 * `clinical.alert.red_flag.receive` at the location). The triage is NOT saved: a red flag that reaches nobody must not look handled
 * (25.5: the alert commits with the triage or not at all). The nurse escalates by the clinic's own means; the roster gap is reported.
 */
export class RedFlagNoRecipientError extends ChartError {
  constructor() {
    super('clinical.red_flag_no_recipient', 409);
    this.name = 'RedFlagNoRecipientError';
  }
}

/**
 * The tables' triggers raise class-P SQLSTATEs (migration 1701): PS001 an illegal change, PM001 a merged patient, PM008 an unknown
 * one; 23505 on the unique indexes (one first triage per check-in, a re-triage supersedes a row once, one exception per encounter,
 * one response per visit and template). Anything else is rethrown for the platform's database-error mapper.
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
    case '23505':
      throw new InvalidTransitionError();
    default:
      throw err;
  }
}
