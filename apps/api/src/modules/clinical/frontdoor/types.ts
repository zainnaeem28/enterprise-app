// Shapes of the clinical front door (ARCHITECTURE 22.11, 25.5, 29.3). Plain data; the only import is a type.
import type { RequestMeta } from '../chart/types.js';

export type { RequestMeta };

export const TRIAGE_CATEGORIES = ['emergency', 'urgent', 'standard', 'non_urgent'] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** The place and patient of a check-in (its ID is the reservation ID) and the service booked. */
export interface CheckInInfo {
  checkInId: string;
  patientId: string;
  locationId: string;
  serviceId: string | null;
}

export interface QuestionnaireTemplate {
  key: string;
  version: number;
  /** The template's schema, as stored: `questions`, `red_flag_rules`, `emergency_advice` (see redflag.ts). Returned to the patient as is. */
  schema: Record<string, unknown>;
}

export interface QuestionnaireResponseView {
  id: string;
  patientId: string;
  reservationId: string | null;
  templateKey: string;
  templateVersion: number;
  answers: Record<string, unknown>;
  status: 'in_progress' | 'submitted';
  submittedAt: string | null;
  redFlag: boolean;
  version: number;
}

/** What `GET /appointments/{id}/questionnaire` returns: the template and the patient's response, if any. */
export interface QuestionnaireForVisit {
  reservationId: string;
  template: QuestionnaireTemplate | null;
  response: QuestionnaireResponseView | null;
}

export interface SubmitResult {
  response: QuestionnaireResponseView;
  redFlag: boolean;
  /** The emergency advice text configured on the template (BR-10, AC-08); only when a red flag was found. Never invented here. */
  advice?: string;
}

export interface TriageView {
  id: string;
  checkInId: string;
  patientId: string;
  category: TriageCategory;
  symptoms: Record<string, unknown> | null;
  notes: string | null;
  redFlag: boolean;
  alertId: string | null;
  byPrincipalId: string;
  assessedAt: string;
  supersedesId: string | null;
}

export interface TriageResult {
  triage: TriageView;
  category: TriageCategory;
  redFlag: boolean;
  alertId: string | null;
  /** When the alert's escalation runs; null when no timer is configured (PM-confirm-1, D-12a: nothing is assumed). */
  escalatesAt: string | null;
  /** Emergency advice from the template when a red flag was raised. */
  advice?: string;
  /** Number of assessments of this check-in; the route's ETag. */
  chainLength: number;
}

export type ReferralStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'completed' | 'cancelled';
export type ReferralTargetKind = 'internal_location' | 'internal_service' | 'external';

export interface ReferralView {
  id: string;
  patientId: string;
  fromLocationId: string;
  fromPrincipalId: string;
  targetKind: ReferralTargetKind;
  targetLocationId: string | null;
  targetServiceId: string | null;
  targetExternalText: string | null;
  reason: string;
  status: ReferralStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  createdAt: string;
  version: number;
}

export interface InboxItem {
  referralId: string;
  targetLocationId: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
  /** "A referral for service X from location Y" (22.11): no patient, no reason. Null if the referral row is not visible to the caller. */
  fromLocationId: string | null;
  targetServiceId: string | null;
  /** The referral's own status. A pending inbox row whose referral is no longer `sent` (cancelled by the sender) is stale: hide it. */
  referralStatus: ReferralStatus | null;
}

export type FollowUpStatus = 'open' | 'booked' | 'done' | 'cancelled';

export interface FollowUpView {
  id: string;
  patientId: string;
  locationId: string;
  serviceId: string | null;
  requestedBy: string;
  ownerPrincipalId: string | null;
  dueOn: string;
  reason: string;
  status: FollowUpStatus;
  bookedReservationId: string | null;
  closedAt: string | null;
  createdAt: string;
  version: number;
}

export interface ConsentGateResult {
  /** Template keys whose required version is not signed (missing, pending, outdated or withdrawn). Empty: the consultation may start. */
  missing: string[];
  /** The exception recorded to start anyway, when one was needed and given. */
  exceptionId?: string;
}
