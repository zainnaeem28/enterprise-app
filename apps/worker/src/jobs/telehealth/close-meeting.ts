// `telehealth.close_meeting` (ARCHITECTURE 33.1, DL-1 of HEAAA-707; `on_merged = resolve`): closes the vendor room of an ended session.
// Enqueued in the transaction that ends the session (the host's `end`, or `end_stale`), so the close is durable and retried (8 attempts).
// Issued Chime tokens stay usable until the meeting closes, so this job is part of token lifetime (ST-4).
//
//   1. a patients-scope transaction reads the room of the (ended) session; the meeting ID is never in the payload (BD-09);
//   2. the vendor is asked OUTSIDE any transaction (`callVendor`: call log, retry and circuit are the gateway's). A vendor that
//      no longer has the meeting counts as done (the video adapter / transport treats "not found" as success).
// A vendor failure is rethrown so the queue retries; an exhausted job goes to `dead` and shows in the operations view.
import { isUuid } from './ids.js';
import { asPatient } from './on-reservation-confirmed.js';
import type { TelehealthJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

export type CloseOutcome = 'closed' | 'nothing';

export async function runCloseMeeting(
  deps: TelehealthJobDeps,
  payload: Record<string, unknown>,
): Promise<CloseOutcome> {
  const sessionId = payload['sessionId'];
  const patientId = payload['patientId'];
  if (!isUuid(sessionId) || !isUuid(patientId))
    throw new Error('telehealth.close_meeting: sessionId and patientId are required');
  const sid = sessionId.toLowerCase();

  let room: { vendor: string; meetingId: string } | null = null;
  await asPatient<'found' | 'gone'>(deps, patientId.toLowerCase(), (pid) =>
    deps.db.withScope(patientsScope(deps.orgId, [pid]), async (tx) => {
      room = await deps.telehealth.meetingToClose(tx, sid);
      // not this patient's session (any more): after a merge the survivor owns it
      return room === null ? 'gone' : 'found';
    }),
  );
  if (room === null) return 'nothing';

  await deps.vendor.callVendor(
    'video',
    'end_meeting',
    { meetingId: (room as { meetingId: string }).meetingId },
    { type: 'telehealth.session', id: sid, idempotencyToken: `end-${sid}` },
  );
  return 'closed';
}
