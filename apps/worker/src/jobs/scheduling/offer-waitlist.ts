// `scheduling.offer_waitlist` (ARCHITECTURE 25.6, PRD BR-03, RA-R1-22; TC-BK-19..22): a slot was freed; the first fitting waitlist entry
// gets a hold through `scheduling.hold` and an offer. Organisation scope for the reads, then one transaction per candidate patient (a
// patients-scope job for exactly that patient: the patient root lock and the row-level policies apply to what the hold writes).
//
//   0. open offers on this very occupancy whose time ran out (the hold sweep got there first) are lapsed first, so their entry is back in line;
//   1. the freed slot is read; nothing to offer when it was taken, started or is held by an earlier offer (one offer per slot at a time);
//   2. candidates, in line order; for each: the hold, the offer row, the entry state, the PHI-free message and the expiry job, all in one
//      transaction. A refusal for that patient (BR-04, overlap, licensing, hours, no portal account) tries the next; `slot_taken` stops.
//
// The entries of a merged patient were re-pointed by the merge, so the candidate list names the survivor: an open offer on the merged ID
// resolves on the survivor and is never duplicated (TC-BK-22, 38.2 item 11).
import { randomUUID } from 'node:crypto';
import { isUuid } from './ids.js';
import { runLapse } from './expire-offer.js';
import type { SchedulingJobDeps } from './ports.js';
import { patientsScope, systemScope } from './scope.js';

export type OfferJobOutcome =
  | { outcome: 'offered'; offerId: string; tried: number }
  | { outcome: 'nothing_to_offer' }
  | { outcome: 'no_candidate'; tried: number; skipped: Record<string, number> }
  | { outcome: 'slot_gone'; tried: number };

export async function runOfferWaitlist(
  deps: SchedulingJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'scheduling.offer_waitlist',
): Promise<OfferJobOutcome> {
  const occupancyId = payload['occupancyId'];
  if (!isUuid(occupancyId)) throw new Error('scheduling.offer_waitlist: occupancyId is required');
  const occ = occupancyId.toLowerCase();

  const lapsed = await deps.db.withScope(systemScope(deps.orgId), (tx) =>
    deps.flow.lapsedOffersOn(tx, occ),
  );
  for (const l of lapsed) await runLapse(deps, l.offerId, l.patientId, jobRef);

  const read = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const slot = await deps.flow.freedSlot(tx, occ);
    return slot === undefined
      ? undefined
      : { slot, candidates: await deps.flow.candidates(tx, slot) };
  });
  if (read === undefined) return { outcome: 'nothing_to_offer' };

  let tried = 0;
  const skipped: Record<string, number> = {};
  for (const cand of read.candidates) {
    tried++;
    const r = await deps.db.withScope(patientsScope(deps.orgId, [cand.patientId]), (tx) =>
      deps.flow.offerToCandidate(
        tx,
        { requestId: randomUUID(), jobId: jobRef.slice(0, 200) },
        read.slot,
        cand,
      ),
    );
    if (r.outcome === 'offered') return { outcome: 'offered', offerId: r.offerId, tried };
    if (r.outcome === 'slot_gone') return { outcome: 'slot_gone', tried };
    skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
  }
  // A job that tried candidates and offered to none is not a quiet success (INT02-R9-B1): the reasons are logged (no patient data).
  if (tried > 0)
    deps.log.warn('scheduling.offer_waitlist: every candidate was skipped, no offer made', {
      occupancyId: occ,
      tried,
      skipped,
    });
  return { outcome: 'no_candidate', tried, skipped };
}
