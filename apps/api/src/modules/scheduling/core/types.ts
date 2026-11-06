import type { Tx } from '@ehr/kernel';

export interface RequestMeta {
  requestId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type BookedVia = 'patient' | 'proxy' | 'staff' | 'waitlist';
export type VisitMode = 'in_person' | 'video';

/** The statuses of `scheduling.slot_occupancy.status` (23.1). */
export type OccupancyStatus =
  | 'held'
  | 'confirmed'
  | 'checked_in'
  | 'in_consultation'
  | 'completed'
  | 'cancelled_patient'
  | 'cancelled_clinic'
  | 'rescheduled'
  | 'no_show'
  | 'expired';

/** A hold request. `startsAt` is an ISO instant; the end is the service's duration plus buffer. */
export interface HoldInput {
  patientId: string;
  serviceId: string;
  locationId: string;
  clinicianId: string;
  roomId?: string | null;
  startsAt: string;
  mode: VisitMode;
  reason?: string | null;
  /** Two-letter state the patient says they are in; required for a video visit (TL-1). */
  patientState?: string | null;
  /** A confirmed appointment of the same patient that this hold is meant to replace (reschedule): it is left out of the overlap and BR-04 checks. */
  rescheduleOf?: string | null;
  followUpOfEncounterId?: string | null;
  /** Only for the waitlist offer job (a system transaction has no principal): the patient's own portal principal, who is recorded as the booker. */
  onBehalfOfPrincipalId?: string | null;
}

export interface HeldReservation {
  reservationId: string;
  expiresAt: string;
}

export interface AppointmentView {
  id: string;
  patientId: string;
  serviceId: string;
  locationId: string;
  locationTimeZone: string;
  clinicianId: string;
  roomId: string | null;
  mode: VisitMode;
  status: OccupancyStatus;
  startsAt: string;
  endsAt: string;
  expiresAt: string | null;
  reason: string | null;
  bookedVia: BookedVia;
  rescheduledFromId: string | null;
  cancelReason: string | null;
  lateChange: boolean | null;
  version: number;
}

export interface SlotQuery {
  clinicianId: string;
  locationId: string;
  serviceId: string;
  roomId: string | null;
  startsAt: Date;
  endsAt: Date;
  mode: VisitMode;
}

/**
 * What the booking core asks of the availability module (BE-12): is this start time on the doctor's template (outside hours,
 * leave, blocked time, busy block), is the session overbookable, and which other start times are free. The core has no default:
 * a hold without a resolver is refused, so a missing availability module fails closed.
 */
export interface AvailabilityPort {
  resolve(
    tx: Tx,
    q: SlotQuery,
  ): Promise<{ ok: true; overbook?: { sessionKey: string } } | { ok: false; code: 'scheduling.outside_hours' }>;
  /** Up to five alternative start times (ISO) for the same service, as the slot search would offer them. */
  alternatives(tx: Tx, q: SlotQuery): Promise<string[]>;
}
