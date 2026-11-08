// Registry codes of the alert part of the notifications module (ARCHITECTURE 30). Codes only, never a value.
import { NotificationsError } from '../errors.js';

/** 409 `notifications.alert_closed` (draft 8, AL-02): the alert was closed; the client reloads the alerts list. */
export class AlertClosedError extends NotificationsError {
  constructor() {
    super('notifications.alert_closed', 409);
    this.name = 'AlertClosedError';
  }
}
