/** Registry codes of the organisation module (ARCHITECTURE 30). Codes only: no value from the request, no database text. */
export class OrganisationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'OrganisationError';
  }
}

/** `kernel.validation_failed`: `fields` names the offending input fields, never their values. */
export class OrganisationValidationError extends OrganisationError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 400);
    this.name = 'OrganisationValidationError';
  }
}

/** 422 `organisation.neutral_name_required` (BR-23 extension): a condition-revealing service needs a different patient-visible name. */
export class NeutralNameRequiredError extends OrganisationError {
  constructor() {
    super('organisation.neutral_name_required', 422);
    this.name = 'NeutralNameRequiredError';
  }
}

/**
 * A setting with no stored value (or one of the two settings that have no proposed default). Fails closed: nothing falls
 * back to a value written in code. Reported as `kernel.unavailable`; `key` is for logs only.
 */
export class SettingNotConfiguredError extends OrganisationError {
  constructor(readonly key: string) {
    super('kernel.unavailable', 503);
    this.name = 'SettingNotConfiguredError';
  }
}
