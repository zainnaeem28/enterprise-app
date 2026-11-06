// Registry codes of the notifications module (ARCHITECTURE 30). Codes and rule names only: no template text, no value from
// the request, no database message.
export class NotificationsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'NotificationsError';
  }
}

/** `kernel.validation_failed`: `fields` names the offending input fields, never their values. */
export class NotificationsValidationError extends NotificationsError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 400);
    this.name = 'NotificationsValidationError';
  }
}

export interface RenderFailure {
  rule: string;
  channel?: string;
  language?: string;
}

/** 422 `notifications.render_check_failed` (30): lists the failing rules, for example a forbidden variable. */
export class RenderCheckFailedError extends NotificationsError {
  constructor(readonly failures: readonly RenderFailure[]) {
    super('notifications.render_check_failed', 422);
    this.name = 'RenderCheckFailedError';
  }
}

export class NotificationsNotFoundError extends NotificationsError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'NotificationsNotFoundError';
  }
}

/** The merge and export participants run only in a patients-scope system job that names the IDs involved. */
export class NotificationsScopeError extends NotificationsError {
  constructor() {
    super('kernel.validation_failed', 400);
    this.name = 'NotificationsScopeError';
  }
}
