// Error classes of the worker side of integration-core. Codes follow the registry of ARCHITECTURE 30; messages carry
// no vendor text, no argument values and no credential, so a log line or a job failure can never leak them.
export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'IntegrationError';
  }
}

/** 503 integration.vendor_unavailable: circuit open, connection disabled/missing, or the retries ran out. Reschedule the job. */
export class VendorUnavailableError extends IntegrationError {
  constructor(readonly reason: 'circuit_open' | 'disabled' | 'exhausted' | 'timeout' | 'error') {
    super('integration.vendor_unavailable', 503, true);
    this.name = 'VendorUnavailableError';
  }
}

/** 502 integration.vendor_rejected: the vendor refused the request itself (a 4xx). Retrying the same request will not help. */
export class VendorRejectedError extends IntegrationError {
  constructor(readonly httpStatus?: number) {
    super('integration.vendor_rejected', 502, false);
    this.name = 'VendorRejectedError';
  }
}

/** The caller asked for something the contract does not allow (unknown kind or operation, bad correlation). */
export class IntegrationUsageError extends IntegrationError {
  constructor(readonly what: string) {
    super('kernel.validation_failed', 422, false);
    this.name = 'IntegrationUsageError';
  }
}

/** An adapter reports a failed vendor call with this; `retryable` follows the vendor's answer (5xx, 408, 429, network). */
export class AdapterFailure extends Error {
  constructor(
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly errorClass = 'vendor_error',
  ) {
    super(errorClass);
    this.name = 'AdapterFailure';
  }
}
