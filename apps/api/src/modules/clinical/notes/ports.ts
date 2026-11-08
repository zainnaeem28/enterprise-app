// What the notes need from other modules, as narrow ports (ARCHITECTURE 24; SHARED-BOUNDARIES 4). The composition root hands in
// adapters over the real services (adapters.ts); the tests use the same adapters over real services, not fakes. The READ of the
// reservation is a plain SELECT in the caller's own transaction (scheduling's row-level security decides what is visible); every
// write to another module goes through its function or service.
import type { Tx } from '@ehr/kernel';

export interface ReservationInfo {
  reservationId: string;
  patientId: string;
  locationId: string;
  serviceId: string;
  clinicianPrincipalId: string;
  mode: 'in_person' | 'video';
  /** The occupancy status: `checked_in` is the only one a consultation starts from (23.1). */
  occupancyStatus: string;
}

export interface ReservationPort {
  /** The reservation and its occupancy status as the caller's RLS shows them, or undefined. */
  get(tx: Tx, reservationId: string): Promise<ReservationInfo | undefined>;
  /** `scheduling.set_status(id, 'checked_in', 'in_consultation')` (23.1, BR-09 passed). */
  startConsultation(tx: Tx, reservationId: string): Promise<void>;
  /** `scheduling.set_status(id, 'in_consultation', 'completed')` (23.1: note signed or deferral recorded). */
  completeConsultation(tx: Tx, reservationId: string): Promise<void>;
}

export interface NoteAlertInput {
  type: 'note_unsigned';
  severity: 'low' | 'medium' | 'high' | 'critical';
  targets: { kind: 'principal'; principalIds: readonly string[] };
  resourceType: string;
  resourceId: string;
  patientId: string;
  locationId?: string;
}

export interface NoteAlertPort {
  /** `notifications.raiseAlert` for the unsigned-note reminder (ADR-022: only red_flag and note_unsigned name a patient). */
  raise(tx: Tx, input: NoteAlertInput): Promise<{ alertId: string }>;
}

export interface EventPort {
  publish(tx: Tx, event: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface JobPort {
  /** Enqueue a job in the caller's transaction (the outbox, ADR-020). */
  enqueue(
    tx: Tx,
    name: string,
    payload: Record<string, unknown>,
    opts: { runAt: Date; jobKey: string },
  ): Promise<unknown>;
}

export interface NotesPorts {
  reservations: ReservationPort;
  alerts: NoteAlertPort;
  events: EventPort;
  jobs: JobPort;
}
