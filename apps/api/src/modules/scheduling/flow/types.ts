import type { Tx } from '@ehr/kernel';
import type { RequestMeta } from '../core/types.js';

export type { RequestMeta };

/** Who is acting, for audit and the booking core: a request (`requestId`) or a job (`jobId`; the core still needs a request-shaped ID). */
export interface FlowMeta extends RequestMeta {
  jobId?: string | null;
}

export type CheckInMethod = 'desk' | 'qr';
export type QueueStage = 'waiting' | 'vitals' | 'triage' | 'ready' | 'with_clinician' | 'done';
export const QUEUE_STAGES: readonly QueueStage[] = [
  'waiting',
  'vitals',
  'triage',
  'ready',
  'with_clinician',
  'done',
];
export type TriageCategory = 'emergency' | 'urgent' | 'standard' | 'non_urgent';
export const TRIAGE_CATEGORIES: readonly TriageCategory[] = [
  'emergency',
  'urgent',
  'standard',
  'non_urgent',
];

/** AC-09: each of the three pre-visit items is done or not. Never their content. */
export interface Previsit {
  questionnaire: boolean;
  consents: boolean;
  insurance: boolean;
}

/** One consent the service requires, as the patient sees it (HEAAA-296 D1). `id` is the pending patient.consent row, else null. */
export interface PrevisitRequiredConsent {
  id: string | null;
  templateKey: string;
  templateVersion: number;
  language: string;
  title: string | null;
  text: string | null;
  status: 'signed' | 'pending' | 'missing' | 'outdated';
}

/** `GET /appointments/{reservationId}/previsit`. A proxy never reaches it (the guard answers 404, CN-04). */
export interface PrevisitView extends Previsit {
  reservationId: string;
  /** True iff the occupancy is `confirmed` or `checked_in`: the POST accepts it only then. */
  canOpenConsents: boolean;
  requiredConsents: PrevisitRequiredConsent[];
}

/** One item of the compact POST body: no wording (it is kept out of the idempotency store). */
export interface PrevisitConsentRef {
  id: string | null;
  templateKey: string;
  templateVersion: number;
  language: string;
  status: 'signed' | 'pending' | 'missing' | 'outdated';
}

/** `POST /appointments/{reservationId}/previsit/consents`. */
export interface PrevisitConsentsOpened {
  reservationId: string;
  requiredConsents: PrevisitConsentRef[];
}

/**
 * What the check-in asks of the modules that do not exist yet in this build (clinical, BE-18): which consent templates a service
 * requires, and whether the pre-visit questionnaire is complete. Both are optional. Without a source a service requires no consent
 * (nothing is asked, nothing is flagged) and the questionnaire is reported as not complete, which is the conservative answer for a
 * front desk deciding what to chase.
 */
export interface PrevisitPort {
  requiredConsents?(
    tx: Tx,
    serviceId: string,
  ): Promise<readonly { key: string; version: number }[]>;
  questionnaireComplete?(tx: Tx, patientId: string, reservationId: string): Promise<boolean>;
}

/** The application key of the QR token (22.8 note, TDR-10): `<env>/app/checkin-qr-key`. Read by the API, rotated by the DevOps runbook. */
export interface QrKeyProvider {
  current(): Promise<Buffer>;
}

export interface CheckInResult {
  reservationId: string;
  patientId: string;
  locationId: string;
  method: CheckInMethod;
  checkedInAt: string;
  queueEntryId: string;
  previsit: Previsit;
  /** True when this call changed nothing because the visit was already checked in. */
  alreadyCheckedIn: boolean;
}

export interface ArrivalView {
  reservationId: string;
  patientId: string;
  patientName: string | null;
  mrn: string | null;
  serviceId: string;
  clinicianId: string;
  mode: 'in_person' | 'video';
  status: string;
  startsAt: string;
  endsAt: string;
  checkedInAt: string | null;
  method: CheckInMethod | null;
  queueStage: QueueStage | null;
  previsit: Previsit | null;
  /** The grace period after the start has passed and the visit is still `confirmed`: a no-show candidate (TC-PC-09). */
  noShowCandidate: boolean;
  /** The sweep flagged it for staff (automatic no-show is off). */
  flaggedForStaff: boolean;
  version: number;
}

/**
 * `GET /clinicians/{id}/schedule` item (draft 8.3, FE-10): a subset of {@link ArrivalView}. The front-desk fields (`method`, `previsit`,
 * `noShowCandidate`, `flaggedForStaff`, `version`) are left out on purpose: the doctor has no write on these rows.
 */
export interface ClinicianScheduleItem {
  reservationId: string;
  patientId: string;
  patientName: string | null;
  mrn: string | null;
  serviceId: string;
  mode: 'in_person' | 'video';
  status: 'confirmed' | 'checked_in' | 'in_consultation' | 'completed' | 'no_show';
  startsAt: string;
  endsAt: string;
  checkedInAt: string | null;
  queueStage: QueueStage | null;
}

export interface QueueEntryView {
  id: string;
  patientId: string;
  patientName: string | null;
  stage: QueueStage;
  triageCategory: TriageCategory | null;
  enteredAt: string;
  stageChangedAt: string;
  /** Whole seconds since arrival, at the time of the request (TC-PC-05: now minus arrival). */
  waitSeconds: number;
  assignedClinicianId: string | null;
  roomId: string | null;
  version: number;
}

export type WaitlistStatus = 'active' | 'offered' | 'fulfilled' | 'cancelled' | 'expired';

export interface WaitlistEntryInput {
  patientId: string;
  serviceId: string;
  locationId?: string | null;
  clinicianId?: string | null;
  /** The acceptable dates: an ISO start and end (end after start, both bounded). */
  from: string;
  to: string;
}

export interface WaitlistEntryView {
  id: string;
  patientId: string;
  patientName?: string | null;
  serviceId: string;
  locationId: string | null;
  clinicianId: string | null;
  from: string;
  to: string;
  status: WaitlistStatus;
  cancelReason: 'patient' | 'staff' | 'merged_duplicate' | null;
  positionAt: string;
  openOffer: { id: string; expiresAt: string } | null;
  version: number;
}

export type OfferStatus = 'offered' | 'accepted' | 'declined' | 'expired';

export interface OfferView {
  id: string;
  waitlistEntryId: string;
  patientId: string;
  /** The held reservation (= occupancy) the patient accepts. */
  reservationId: string;
  locationId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  status: OfferStatus;
  expiresAt: string;
  decidedAt: string | null;
}

/** The slot a freed occupancy leaves, as the offer job reads it (organisation scope). */
export interface FreedSlot {
  occupancyId: string;
  organisationId: string;
  locationId: string;
  clinicianId: string;
  roomId: string | null;
  serviceId: string;
  mode: 'in_person' | 'video';
  startsAt: string;
  endsAt: string;
}

export interface OfferCandidate {
  entryId: string;
  patientId: string;
  serviceId: string;
}

export interface NoShowCandidate {
  reservationId: string;
  patientId: string;
  locationId: string;
  serviceId: string;
  mode: 'in_person' | 'video';
  startsAt: string;
}
