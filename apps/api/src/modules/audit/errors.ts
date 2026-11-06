/** Registry codes of the audit module (ARCHITECTURE 30). Codes only: no value from the request, no database text. */
export class AuditError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'AuditError';
  }
}

/** The envelope breaks a SHARED-BOUNDARIES 8.1 rule. `fields` names the offending envelope fields, never their values. */
export class AuditEnvelopeError extends AuditError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422);
    this.name = 'AuditEnvelopeError';
  }
}

/** 422 audit.export_too_large: the export would exceed the size limit (setting audit_export_max_rows). */
export class ExportTooLargeError extends AuditError {
  constructor() {
    super('audit.export_too_large', 422);
    this.name = 'ExportTooLargeError';
  }
}

/** 403 audit.self_review: the reviewer is the holder of the grant. */
export class SelfReviewError extends AuditError {
  constructor() {
    super('audit.self_review', 403);
    this.name = 'SelfReviewError';
  }
}

/** The scope of the transaction lacks what the operation needs (a missing setting fails closed). */
export class AuditScopeError extends AuditError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'AuditScopeError';
  }
}
