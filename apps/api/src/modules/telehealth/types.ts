export type SessionStatus = 'scheduled' | 'open' | 'ended' | 'failed';
export type Admission = 'waiting' | 'admitted' | 'removed';
export type ParticipantRole = 'patient' | 'proxy' | 'clinician';
export type LicensingResult = 'allowed' | 'refused_not_licensed' | 'refused_not_operating';

export interface TelehealthMeta {
  requestId: string | null;
  jobId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type DeviceVerdict = 'pass' | 'fail';
export interface DeviceCheck {
  camera: DeviceVerdict;
  mic: DeviceVerdict;
  bandwidth: DeviceVerdict;
}

/** `GET /appointments/{id}/video-session` for a patient or proxy (29.2). */
export interface PatientSessionView {
  status: SessionStatus;
  admission: Admission;
  joinOpensAt: string;
  needsLocationConfirmation: boolean;
  startsAt: string;
  endsAt: string;
  /** The clinic's IANA zone and the visit start in it (BR-05: both zones are shown; the viewer's own zone is the browser's). */
  clinicTimeZone: string;
  clinicLocalStart: string;
}

export interface WaitingEntry {
  participantId: string;
  patientId: string;
  role: ParticipantRole;
  waitingSince: string;
  deviceCheck: DeviceCheck | null;
}

/** `GET/POST .../video-session` for the host (29.3). */
export interface HostSessionView {
  status: SessionStatus;
  startsAt: string;
  endsAt: string;
  joinOpensAt: string;
  clinicTimeZone: string;
  clinicLocalStart: string;
  meetingReady: boolean;
  waiting: WaitingEntry[];
}

export interface LocationOutcome {
  result: LicensingResult;
  /** Flag mode: the rule said no and the visit goes ahead, marked. */
  flagged: boolean;
}

export interface JoinGrant {
  vendor: string;
  meetingId: string;
  attendeeToken: string;
}
