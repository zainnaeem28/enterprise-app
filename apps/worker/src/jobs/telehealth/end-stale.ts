// `telehealth.end_stale` (ARCHITECTURE 33.1): every 15 minutes, ends sessions two hours after their slot. The list is read at organisation
// scope; each session is ended in its own patients-scope transaction (join tokens revoked first, `failed` when no room was ever made);
// the vendor is told AFTER that commits, best effort: the room also times out at the vendor, and a failure here is logged by class only.
import { randomUUID } from 'node:crypto';
import type { TelehealthJobDeps } from './ports.js';
import { patientsScope, systemScope } from './scope.js';

export interface StaleResult {
  listed: number;
  ended: number;
  failed: number;
  vendorClosed: number;
  vendorFailed: number;
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
    vendorClosed: 0,
    vendorFailed: 0,
  };
  for (const s of stale) {
    const r = await deps.db.withScope(patientsScope(deps.orgId, [s.patientId]), (tx) =>
      deps.telehealth.endStale(
        tx,
        { requestId: null, jobId: `${jobRef}:${randomUUID()}`.slice(0, 200) },
        s.sessionId,
      ),
    );
    if (r.status === 'already') continue;
    if (r.status === 'ended') out.ended++;
    else out.failed++;
    if (r.meetingId === null) continue;
    try {
      await deps.vendor.callVendor(
        'video',
        'end_meeting',
        { meetingId: r.meetingId },
        { type: 'telehealth.session', id: s.sessionId, idempotencyToken: `end-${s.sessionId}` },
      );
      out.vendorClosed++;
    } catch (e) {
      out.vendorFailed++;
      deps.log.error('telehealth.end_stale: the vendor room was not closed', {
        sessionId: s.sessionId,
        errorName: e instanceof Error ? e.name : typeof e,
      });
    }
  }
  return out;
}
