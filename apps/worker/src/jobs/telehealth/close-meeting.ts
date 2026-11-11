// `telehealth.close_meeting` (ARCHITECTURE 33.1; `on_merged = resolve`): ends the vendor room of a video visit once the visit is over.
// Queued three ways for the one job key `close_meeting_<reservation>`: at confirmation for the end of the join window (slot end + 30 min),
// and at once by the handlers of a cancelled or no-show visit (the later enqueue replaces the unstarted one, so the earlier run wins).
//
//   1. a patients-scope transaction asks whether the room is due (visit over, session ended or window closed) and ends a session still
//      live, join tokens revoked first;
//   2. the vendor is told OUTSIDE any transaction (`callVendor`: log, retry and circuit are the gateway's). A room the vendor no longer
//      has counts as closed (the adapter maps it); any other vendor failure is rethrown so the queue retries (8 attempts) and a dead job
//      raises the `telehealth.close_meeting` alarm;
//   3. a patients-scope transaction records the close in the visit audit.
import { randomUUID } from 'node:crypto';
import { isUuid } from './ids.js';
import { asPatient } from './on-reservation-confirmed.js';
import type { TelehealthJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

export type CloseResult = 'closed' | 'none' | 'not_due' | 'gone';

export async function runCloseMeeting(
  deps: TelehealthJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'telehealth.close_meeting',
): Promise<CloseResult> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error('telehealth.close_meeting: reservationId and patientId are required');
  const rid = reservationId.toLowerCase();
  const meta = () => ({ requestId: null, jobId: `${jobRef}:${randomUUID()}`.slice(0, 200) });

  let scope = patientId.toLowerCase();
  let target: { sessionId: string; vendor: string; meetingId: string } | undefined;
  const first = await asPatient<'close' | 'none' | 'not_due' | 'gone'>(deps, scope, async (pid) => {
    scope = pid;
    return deps.db.withScope(patientsScope(deps.orgId, [pid]), async (tx) => {
      const r = await deps.telehealth.meetingToClose(tx, meta(), rid);
      if (r.outcome !== 'close') return r.outcome === 'none' ? 'gone' : r.outcome;
      target = r;
      return 'close';
    });
  });
  if (first === 'gone') return 'none';
  if (first === 'not_due') return 'not_due';
  if (target === undefined) return 'none';
  const t = target;

  await deps.vendor.callVendor(
    'video',
    'end_meeting',
    { meetingId: t.meetingId },
    { type: 'telehealth.session', id: t.sessionId, idempotencyToken: `end-${t.sessionId}` },
  );

  await deps.db.withScope(patientsScope(deps.orgId, [scope]), (tx) =>
    deps.telehealth.recordMeetingClosed(tx, meta(), t.sessionId),
  );
  return 'closed';
}
