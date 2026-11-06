/** Registry codes of integration-core on the API side (ARCHITECTURE 30). Codes only: no request value, no database text. */
export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'IntegrationError';
  }
}

/** 422 kernel.validation_failed. `fields` names the offending fields, never their values. */
export class IntegrationValidationError extends IntegrationError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422);
    this.name = 'IntegrationValidationError';
  }
}

/** 403 auth.forbidden: the scope lacks the admin realm the operation needs. */
export class IntegrationScopeError extends IntegrationError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'IntegrationScopeError';
  }
}

/** 404 kernel.not_found. Invisible and non-existent look the same. */
export class IntegrationNotFoundError extends IntegrationError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'IntegrationNotFoundError';
  }
}

/** 403 identity.self_approval: the approver is the requester. */
export class SelfApprovalError extends IntegrationError {
  constructor() {
    super('identity.self_approval', 403);
    this.name = 'SelfApprovalError';
  }
}

/** 409 identity.request_expired. */
export class RequestExpiredError extends IntegrationError {
  constructor() {
    super('identity.request_expired', 409);
    this.name = 'RequestExpiredError';
  }
}

/** 409 kernel.state_conflict: the request is not in a state that allows the action. */
export class RequestStateError extends IntegrationError {
  constructor() {
    super('kernel.state_conflict', 409);
    this.name = 'RequestStateError';
  }
}

/** 503 kernel.unavailable: the secret store or the sealing key did not answer. Retryable; says nothing else. */
export class SecretStoreUnavailableError extends IntegrationError {
  constructor() {
    super('kernel.unavailable', 503, true);
    this.name = 'SecretStoreUnavailableError';
  }
}
