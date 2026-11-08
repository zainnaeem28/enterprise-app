// What the front door needs from other modules, as narrow ports (ARCHITECTURE 24; SHARED-BOUNDARIES 4). The composition root hands in
// adapters over the real services (adapters.ts); the tests use the same adapters over real services, not fakes. Reads of other
// modules' tables are RLS-bound reads in the caller's own transaction; every write to another module goes through its service.
import type { Tx } from '@ehr/kernel';
import type { CheckInInfo, QuestionnaireTemplate, RequestMeta, TriageCategory } from './types.js';

// The shapes of `notifications.raiseAlert` (24, 32.1), restated here because the notifications public index does not carry them;
// the structural types match the service's, which the adapters pass them to.
export type AlertTargets =
  | { kind: 'principal'; principalIds: readonly string[] }
  | { kind: 'role_location'; roleKey: string; locationIds: readonly string[] }
  | { kind: 'compliance_permission'; permission: string };

export interface RaiseAlertInput {
  type: 'red_flag';
  severity: 'low' | 'medium' | 'high' | 'critical';
  targets: AlertTargets;
  resourceType: string;
  resourceId: string;
  patientId?: string;
  locationId?: string;
}

export interface RaisedAlert {
  alertId: string;
  seq: number;
  /** When the escalation job runs; null when no escalation time is configured. */
  escalatesAt: Date | null;
  targetPrincipalIds: string[];
}

export interface CheckInPort {
  /** The check-in (= reservation) as the caller's own RLS shows it, or undefined. */
  get(tx: Tx, checkInId: string): Promise<CheckInInfo | undefined>;
  /** The reservation's patient, place and service, as the caller's RLS shows it (patient or staff), or undefined. */
  reservation(tx: Tx, reservationId: string): Promise<CheckInInfo | undefined>;
  /** `scheduling.setTriageCategory` for the queue entry of the check-in (same ID). It takes the patient lock (key_share) itself. */
  setTriageCategory(
    tx: Tx,
    meta: RequestMeta,
    checkInId: string,
    category: TriageCategory,
  ): Promise<void>;
}

export type RosterDuty = 'on_duty_doctor' | 'on_call_doctor';

/** Who is on duty (25.5): `scheduling.onDuty(location, duty, at)`, and the holders of a permission at a location. */
export interface DutyPort {
  onDuty(tx: Tx, locationId: string, duty: RosterDuty, at: Date): Promise<string[]>;
  /** Principals holding `permission` at the location (role assignments with the location in scope). */
  permissionHoldersAt(tx: Tx, permission: string, locationId: string): Promise<string[]>;
}

export interface AlertPort {
  raise(tx: Tx, input: RaiseAlertInput): Promise<RaisedAlert>;
  /** `notifications.escalate`: ADD targets to an alert (a worker only). */
  addTargets(tx: Tx, alertId: string, targets: AlertTargets): Promise<string[]>;
}

export interface CatalogPort {
  /** Latest published version of each consent template the service requires. */
  requiredConsents(tx: Tx, serviceId: string): Promise<readonly { key: string; version: number }[]>;
  /** A published questionnaire template: the stated version, or the latest published one when none is stated. */
  questionnaireTemplate(
    tx: Tx,
    key: string,
    version?: number,
  ): Promise<QuestionnaireTemplate | null>;
  /** Does the location offer the service (`organisation.service_location`), both active. */
  serviceOffered(tx: Tx, serviceId: string, locationId: string): Promise<boolean>;
}

export interface ConsentPort {
  status(
    tx: Tx,
    patientId: string,
    templates: readonly { key: string; version: number }[],
  ): Promise<
    { key: string; version: number; status: 'signed' | 'outdated' | 'pending' | 'missing' }[]
  >;
}

export interface CarePort {
  /** `patient.ensureCareRelationship(patient, location, 'referral')`; the caller has locked the patient. */
  ensureForReferral(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    locationId: string,
  ): Promise<string>;
}

export interface EventPort {
  publish(tx: Tx, event: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface FrontdoorPorts {
  checkIns: CheckInPort;
  duty: DutyPort;
  alerts: AlertPort;
  catalog: CatalogPort;
  consents: ConsentPort;
  care: CarePort;
  events: EventPort;
}
