// Shapes the telehealth screens read (apps/api telehealth `PatientSessionView`, `JoinGrant`). The contract types the bodies as opaque
// objects, so each is checked here and a malformed answer becomes a server-error state.
import { asRecord, str } from '../profile/lib/core.js';

export type SessionStatus = 'scheduled' | 'open' | 'ended' | 'failed';
export type Admission = 'waiting' | 'admitted' | 'removed';

export interface SessionView {
  status: SessionStatus;
  admission: Admission;
  joinOpensAt: string;
  needsLocationConfirmation: boolean;
  startsAt: string;
  endsAt: string;
  clinicTimeZone: string;
}

const STATUSES: readonly string[] = ['scheduled', 'open', 'ended', 'failed'];
const ADMISSIONS: readonly string[] = ['waiting', 'admitted', 'removed'];

export function parseSession(d: unknown): SessionView | undefined {
  const o = asRecord(d);
  const status = str(o['status']);
  const admission = str(o['admission']);
  const joinOpensAt = str(o['joinOpensAt']);
  const startsAt = str(o['startsAt']);
  const endsAt = str(o['endsAt']);
  const zone = str(o['clinicTimeZone']);
  if (
    status === undefined ||
    !STATUSES.includes(status) ||
    admission === undefined ||
    !ADMISSIONS.includes(admission) ||
    joinOpensAt === undefined ||
    startsAt === undefined ||
    endsAt === undefined ||
    zone === undefined ||
    typeof o['needsLocationConfirmation'] !== 'boolean'
  )
    return undefined;
  return {
    status: status as SessionStatus,
    admission: admission as Admission,
    joinOpensAt,
    needsLocationConfirmation: o['needsLocationConfirmation'],
    startsAt,
    endsAt,
    clinicTimeZone: zone,
  };
}

/** The credential handed to the video vendor's client. Never rendered, stored, logged or put in a URL. */
export interface JoinGrant {
  vendor: string;
  meetingId: string;
  attendeeToken: string;
}

export function parseGrant(d: unknown): JoinGrant | undefined {
  const o = asRecord(d);
  const vendor = str(o['vendor']);
  const meetingId = str(o['meetingId']);
  const attendeeToken = str(o['attendeeToken']);
  return vendor === undefined || meetingId === undefined || attendeeToken === undefined
    ? undefined
    : { vendor, meetingId, attendeeToken };
}

export type Verdict = 'pass' | 'fail';
export interface DeviceCheck {
  camera: Verdict;
  mic: Verdict;
  bandwidth: Verdict;
}
