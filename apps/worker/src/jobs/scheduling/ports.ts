// What the scheduling jobs need from the scheduling flow service (apps/api/src/modules/scheduling/flow). The worker cannot import the API
// package, so the jobs depend on this port; the API's `flowPort(service)` is the implementation. Each method takes the transaction the job
// opened: the job decides the scope (organisation for reads and the sweep, one patient for everything that writes patient rows, so the
// patient root lock and the row-level policies apply), the service does the work.
import type { KernelDb, Logger, Queue, Tx } from '@ehr/kernel';

export interface FlowMeta {
  requestId: string | null;
  jobId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

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

export type OfferOutcome =
  | { outcome: 'offered'; offerId: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'slot_gone' };

export type LapseOutcome = 'expired' | 'not_due' | 'already_decided' | 'gone';
export type SendPrevisitOutcome = 'sent' | 'duplicate' | 'skipped' | 'gone';

export interface SchedulingFlowPort {
  freedSlot(tx: Tx, occupancyId: string): Promise<FreedSlot | undefined>;
  candidates(tx: Tx, slot: FreedSlot): Promise<OfferCandidate[]>;
  lapsedOffersOn(tx: Tx, occupancyId: string): Promise<{ offerId: string; patientId: string }[]>;
  offerToCandidate(
    tx: Tx,
    meta: FlowMeta,
    slot: FreedSlot,
    cand: OfferCandidate,
  ): Promise<OfferOutcome>;
  lapseOffer(tx: Tx, meta: FlowMeta, offerId: string): Promise<LapseOutcome>;
  noShowCandidates(tx: Tx): Promise<NoShowCandidate[]>;
  noShowAutoAllowed(tx: Tx, locationId: string): Promise<boolean>;
  flagNoShow(tx: Tx, meta: FlowMeta, c: NoShowCandidate): Promise<boolean>;
  autoNoShow(tx: Tx, meta: FlowMeta, c: NoShowCandidate): Promise<'marked' | 'skipped'>;
  sendPrevisit(tx: Tx, meta: FlowMeta, reservationId: string): Promise<SendPrevisitOutcome>;
  previsitDueAt(tx: Tx, reservationId: string): Promise<Date | 'skip' | 'gone'>;
}

export interface SchedulingJobDeps {
  db: KernelDb;
  orgId: string;
  /** Worker-path queue (`new Queue(registry, 'worker')`). */
  queue: Queue;
  flow: SchedulingFlowPort;
  log: Logger;
  /** `patient`'s answer to "who is the survivor of this ID". Without it a merged ID is never followed. */
  survivorOf?: (patientId: string) => Promise<string | undefined>;
  now?: () => Date;
}
