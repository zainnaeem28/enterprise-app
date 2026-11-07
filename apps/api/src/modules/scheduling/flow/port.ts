// The port the worker's scheduling jobs are written against (apps/worker/src/jobs/scheduling/ports.ts), backed by the flow service. The
// worker cannot import this package; the shapes are structurally identical and the integration tests run the worker's real job handlers
// against this adapter.
import type { SchedulingFlowService } from './service.js';

export function flowPort(s: SchedulingFlowService): {
  freedSlot: SchedulingFlowService['waitlist']['freedSlot'];
  candidates: SchedulingFlowService['waitlist']['candidates'];
  lapsedOffersOn: SchedulingFlowService['waitlist']['lapsedOffersOn'];
  offerToCandidate: SchedulingFlowService['waitlist']['offerToCandidate'];
  lapseOffer: SchedulingFlowService['waitlist']['lapseOffer'];
  noShowCandidates: SchedulingFlowService['noShowCandidates'];
  noShowAutoAllowed: SchedulingFlowService['noShowAutoAllowed'];
  flagNoShow: SchedulingFlowService['flagNoShow'];
  autoNoShow: SchedulingFlowService['autoNoShow'];
  sendPrevisit: SchedulingFlowService['previsit']['send'];
  previsitDueAt: SchedulingFlowService['previsit']['dueAt'];
  noticeConfirmed: SchedulingFlowService['notices']['confirmed'];
  noticeCancelled: SchedulingFlowService['notices']['cancelled'];
  noticeRescheduled: SchedulingFlowService['notices']['rescheduled'];
} {
  return {
    freedSlot: (tx, id) => s.waitlist.freedSlot(tx, id),
    candidates: (tx, slot) => s.waitlist.candidates(tx, slot),
    lapsedOffersOn: (tx, id) => s.waitlist.lapsedOffersOn(tx, id),
    offerToCandidate: (tx, meta, slot, cand) => s.waitlist.offerToCandidate(tx, meta, slot, cand),
    lapseOffer: (tx, meta, id) => s.waitlist.lapseOffer(tx, meta, id),
    noShowCandidates: (tx) => s.noShowCandidates(tx),
    noShowAutoAllowed: (tx, loc) => s.noShowAutoAllowed(tx, loc),
    flagNoShow: (tx, meta, c) => s.flagNoShow(tx, meta, c),
    autoNoShow: (tx, meta, c) => s.autoNoShow(tx, meta, c),
    sendPrevisit: (tx, meta, id) => s.previsit.send(tx, meta, id),
    previsitDueAt: (tx, id) => s.previsit.dueAt(tx, id),
    noticeConfirmed: (tx, meta, id) => s.notices.confirmed(tx, meta, id),
    noticeCancelled: (tx, meta, id, was, to) => s.notices.cancelled(tx, meta, id, was, to),
    noticeRescheduled: (tx, meta, id, nid, to) => s.notices.rescheduled(tx, meta, id, nid, to),
  };
}
