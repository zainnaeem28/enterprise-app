import type { Tx } from '@ehr/kernel';

// Staff-alert vocabulary (ARCHITECTURE 22.13, 32.1). The closed lists mirror the CHECK constraints of migration 1200.
export const ALERT_TYPES = [
  'red_flag',
  'btg_opened',
  'privileged_change',
  'kill_switch_used',
  'audit_anchor_mismatch',
  'scope_drift',
  'note_unsigned',
  'integration_down',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Only these two types name a patient. Every other alert is about a grant, a request or an anchor (ADR-022). */
export const PATIENT_ALERT_TYPES: readonly AlertType[] = ['red_flag', 'note_unsigned'];

export const ALERT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export type AlertStatus = 'open' | 'acknowledged' | 'escalated' | 'closed';

/** The `GET /alerts` item (29.3). `escalatesAt` is null unless the alert is open with a scheduled escalation. */
export interface AlertView {
  alertId: string;
  seq: number;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  createdAt: string;
  escalationLevel: number;
  escalatesAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedByDisplayName: string | null;
  patientId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  link: string | null;
}

/** The `GET /alerts/open-ids` item (26.2, passive). */
export interface OpenAlertId {
  alertId: string;
  seq: number;
  status: AlertStatus;
  escalationLevel: number;
  escalatesAt: string | null;
}

export interface AcknowledgeResult {
  alertId: string;
  status: 'acknowledged';
  acknowledgedAt: string;
  acknowledgedBy: string;
  escalationLevel: number;
  escalatesAt: null;
  alreadyAcknowledged: boolean;
}

export type AlertTargets =
  | { kind: 'principal'; principalIds: readonly string[] }
  | { kind: 'role_location'; roleKey: string; locationIds: readonly string[] }
  | { kind: 'compliance_permission'; permission: string };

/** `notifications.raiseAlert(type, targets, resourceRef, patientId?)` (24). */
export interface RaiseAlertInput {
  type: AlertType;
  severity: AlertSeverity;
  targets: AlertTargets;
  resourceType: string;
  resourceId: string;
  patientId?: string;
  /** The location whose escalation setting applies; none means the organisation-wide setting. */
  locationId?: string;
}

export interface RaisedAlert {
  alertId: string;
  seq: number;
  /** When the escalation job runs; null when no escalation time is configured for this type (and location). */
  escalatesAt: Date | null;
  targetPrincipalIds: string[];
}

/** Resolves a role or a permission to principals at creation and at each escalation (ADR-022). Supplied by identity/roster. */
export interface TargetResolver {
  roleHolders(tx: Tx, roleKey: string, locationIds: readonly string[]): Promise<string[]>;
  permissionHolders(tx: Tx, permission: string): Promise<string[]>;
}

/** `link` is a portal path with IDs only (32.1); the detail is read through the normal audited routes. */
export const alertLink = (alertId: string): string => `/alerts/${alertId}`;

/** The realms that read and acknowledge alerts: staff, and the admin pool for the compliance alerts (ARCHITECTURE 32.2 point 1). */
export const ALERT_REALMS = ['google', 'admin_pool'] as const;
