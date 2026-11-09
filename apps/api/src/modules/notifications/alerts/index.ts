// Public surface of the alert part of the notifications module (ARCHITECTURE 24). Other modules import only from here.
export { AlertService, toView, DEFAULT_PAGE, MAX_PAGE } from './service.js';
export type { AlertContext, AlertDeps } from './service.js';
export { AlertSettingService } from './settings.js';
export type { AlertSetting } from './settings.js';
export { escalateAlert } from './escalate.js';
export type { EscalationOutcome, EscalationPayload } from './escalate.js';
export { createAlertsController } from './controller.js';
export type { AlertsControllerDeps } from './controller.js';
export { AlertClosedError } from './errors.js';
export { ALERT_EVENTS, ALERT_JOBS, ALERT_UNACKNOWLEDGED, ESCALATION_LEVEL } from './jobs.js';
export {
  ALERT_CONFLICT_RULES,
  ALERT_MERGE_TABLES,
  alertExportContributor,
  repointAlertRows,
} from './merge.js';
export {
  ALERT_REALMS,
  ALERT_SEVERITIES,
  ALERT_TYPES,
  PATIENT_ALERT_TYPES,
  alertLink,
} from './types.js';
export type {
  AcknowledgeResult,
  AlertSeverity,
  AlertStatus,
  AlertTargets,
  AlertType,
  AlertView,
  OpenAlertId,
  RaiseAlertInput,
  RaisedAlert,
  TargetResolver,
} from './types.js';
