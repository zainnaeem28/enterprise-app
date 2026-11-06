// `scheduling.no_show_sweep` (ARCHITECTURE 33.1, PRD G-12; TC-PC-09): every 5 minutes, organisation scope. For each confirmed visit whose
// start plus grace period has passed (video has its own grace) it either marks the visit no-show, only where the location's
// `no_show_auto` setting is exactly true, or flags it for staff (the arrivals board shows the flag). Marking is one transaction per
// patient (the root lock and the policies apply); flagging is organisation scope and idempotent. A failure on one visit does not stop
// the others; the job fails at the end so the library retries it.
import { randomUUID } from 'node:crypto';
import type { NoShowCandidate, SchedulingJobDeps } from './ports.js';
import { patientsScope, systemScope } from './scope.js';

export interface SweepResult {
  marked: number;
  flagged: number;
  skipped: number;
  failed: number;
}

export async function runNoShowSweep(
  deps: SchedulingJobDeps,
  jobRef = 'scheduling.no_show_sweep',
): Promise<SweepResult> {
  const candidates: NoShowCandidate[] = await deps.db.withScope(systemScope(deps.orgId), (tx) =>
    deps.flow.noShowCandidates(tx),
  );
  const auto = new Map<string, boolean>();
  const result: SweepResult = { marked: 0, flagged: 0, skipped: 0, failed: 0 };
  for (const c of candidates) {
    try {
      let allowed = auto.get(c.locationId);
      if (allowed === undefined) {
        allowed = await deps.db.withScope(systemScope(deps.orgId), (tx) =>
          deps.flow.noShowAutoAllowed(tx, c.locationId),
        );
        auto.set(c.locationId, allowed);
      }
      const meta = { requestId: randomUUID(), jobId: jobRef.slice(0, 200) };
      if (allowed) {
        const r = await deps.db.withScope(patientsScope(deps.orgId, [c.patientId]), (tx) =>
          deps.flow.autoNoShow(tx, meta, c),
        );
        if (r === 'marked') result.marked++;
        else result.skipped++;
      } else {
        const flagged = await deps.db.withScope(systemScope(deps.orgId), (tx) =>
          deps.flow.flagNoShow(tx, meta, c),
        );
        if (flagged) result.flagged++;
        else result.skipped++;
      }
    } catch {
      result.failed++;
    }
  }
  if (result.failed > 0) {
    deps.log.warn('no-show sweep could not process some visits', { failed: result.failed });
    throw new Error('scheduling.no_show_sweep: some visits could not be processed');
  }
  return result;
}
