// What the telehealth jobs need from their surroundings. The worker cannot import the API package, so the jobs depend on these narrow
// ports; the API's `telehealthPort(service)` is the `telehealth` implementation and integration-core's `VendorGateway` is the `vendor`
// one (the only way worker code reaches a vendor, 24).
import type { KernelDb, Logger, Queue, Tx } from '@ehr/kernel';
import type { VendorResult } from '../integration-core/index.js';

export interface TelehealthMeta {
  requestId: string | null;
  jobId?: string | null;
}

export type EnsureOutcome =
  | { outcome: 'created' | 'exists'; sessionId: string; startsAt: string; hasMeeting: boolean }
  | { outcome: 'skipped' }
  | { outcome: 'gone' };

export interface StaleSession {
  sessionId: string;
  patientId: string;
}

export interface EndedStale {
  status: 'ended' | 'failed' | 'already';
  vendor: string | null;
  meetingId: string | null;
}

export type VisitOverReason = 'cancelled' | 'no_show' | 'rescheduled';

export type EndedForVisitOver =
  | {
      status: 'ended' | 'failed';
      sessionId: string;
      vendor: string | null;
      meetingId: string | null;
    }
  | { status: 'already' | 'none' | 'gone' };

export interface TelehealthWorkerPort {
  ensureSession(tx: Tx, meta: TelehealthMeta, reservationId: string): Promise<EnsureOutcome>;
  recordMeeting(
    tx: Tx,
    meta: TelehealthMeta,
    sessionId: string,
    vendor: string,
    meetingId: string,
  ): Promise<boolean>;
  meetingToClose(tx: Tx, sessionId: string): Promise<{ vendor: string; meetingId: string } | null>;
  staleSessions(tx: Tx, limit?: number): Promise<StaleSession[]>;
  endStale(tx: Tx, meta: TelehealthMeta, sessionId: string): Promise<EndedStale>;
  endForVisitOver(
    tx: Tx,
    meta: TelehealthMeta,
    reservationId: string,
    reason: VisitOverReason,
  ): Promise<EndedForVisitOver>;
  recordMeetingClosed(tx: Tx, meta: TelehealthMeta, sessionId: string): Promise<boolean>;
}

export interface VendorPort {
  callVendor(
    kind: string,
    operation: string,
    args?: Readonly<Record<string, unknown>>,
    correlation?: { type?: string; id?: string; idempotencyToken?: string },
  ): Promise<VendorResult>;
}

export interface TelehealthJobDeps {
  db: KernelDb;
  orgId: string;
  /** Worker-path queue (`new Queue(registry, 'worker')`). */
  queue: Queue;
  telehealth: TelehealthWorkerPort;
  vendor: VendorPort;
  log: Logger;
  /** `patient`'s answer to "who is the survivor of this ID". Without it a merged ID is never followed. */
  survivorOf?: (patientId: string) => Promise<string | undefined>;
  now?: () => Date;
}

export const nowOf = (d: { now?: () => Date }): Date => (d.now ?? (() => new Date()))();
