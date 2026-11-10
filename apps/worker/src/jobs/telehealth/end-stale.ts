// `telehealth.end_stale` (ARCHITECTURE 33.1): every 15 minutes, ends sessions two hours after their slot. The list is read at organisation
// scope; each session is ended in its own patients-scope transaction (join tokens revoked first, `failed` when no room was ever made);
// the vendor room is closed by `telehealth.close_meeting`, enqueued in that same transaction (DL-1): one durable, retried close path.
import { randomUUID } from 'node:crypto';
import type { TelehealthJobDeps } from './ports.js';
import { patientsScope, systemScope } from './scope.js';

export interface StaleResult {
  listed: number;
  ended: number;
  failed: number;
  closeQueued: number;
}

export async function runEndStale(
  deps: TelehealthJobDeps,
  jobRef = 'telehealth.end_stale',
): Promise<StaleResult> {
  const stale = await deps.db.withScope(systemScope(deps.orgId), (tx) =>
    deps.telehealth.staleSessions(tx),
  );
  const out: StaleResult = {
    listed: stale.length,
    ended: 0,
    failed: 0,
    closeQueued: 0,
  };
  for (const s of stale) {
    const queued = await deps.db.withScope(patientsScope(deps.orgId, [s.patientId]), async (tx) => {
      const r = await deps.telehealth.endStale(
        tx,
        { requestId: null, jobId: `${jobRef}:${randomUUID()}`.slice(0, 200) },
        s.sessionId,
      );
      if (r.status === 'ended' && r.meetingId !== null)
        await deps.queue.enqueue(
          tx,
          'telehealth.close_meeting',
          { sessionId: s.sessionId, patientId: s.patientId },
          { jobKey: `close_meeting_${s.sessionId}` },
        );
      return { status: r.status, queued: r.status === 'ended' && r.meetingId !== null };
    });
    if (queued.status === 'already') continue;
    if (queued.status === 'ended') out.ended++;
    else out.failed++;
    if (queued.queued) out.closeQueued++;
  }
  return out;
}
