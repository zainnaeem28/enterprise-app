// `telehealth.close_meeting` (ARCHITECTURE 33.1, DL-1 of HEAAA-707; `on_merged = resolve`): closes the vendor room of an ended session.
// Enqueued in the transaction that ends the session (the host's `end`, or `end_stale`), so the close is durable and retried (8 attempts).
// Issued Chime tokens stay usable until the meeting closes, so this job is part of token lifetime (ST-4).
//
//   1. a patients-scope transaction reads the room of the (ended) session; the meeting ID is never in the payload (BD-09);
//   2. the vendor is asked OUTSIDE any transaction (`callVendor`: call log, retry and circuit are the gateway's). A vendor that
//      no longer has the meeting counts as done (the video adapter treats a 404 / `not_found` as success);
//   3. the close is audited in a patients-scope transaction of the patient whose scope found the room (after a merge that is the
//      survivor, never the payload patient). A session no longer in that scope throws, so the queue retries (the vendor close is idempotent).
// A vendor failure is rethrown so the queue retries; an exhausted job goes to `dead` and shows in the operations view.
import { isUuid } from './ids.js';
import { asPatient } from './on-reservation-confirmed.js';
import type { TelehealthJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

export type CloseOutcome = 'closed' | 'nothing';

export async function runCloseMeeting(
  deps: TelehealthJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'telehealth.close_meeting',
): Promise<CloseOutcome> {
  const sessionId = payload['sessionId'];
  const patientId = payload['patientId'];
  if (!isUuid(sessionId) || !isUuid(patientId))
    throw new Error('telehealth.close_meeting: sessionId and patientId are required');
  const sid = sessionId.toLowerCase();

  let room: { vendor: string; meetingId: string } | null = null;
  let scope: string = patientId.toLowerCase();
  await asPatient<'found' | 'gone'>(deps, patientId.toLowerCase(), (pid) =>
    deps.db.withScope(patientsScope(deps.orgId, [pid]), async (tx) => {
      room = await deps.telehealth.meetingToClose(tx, sid);
      scope = pid;
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
  const recorded = await deps.db.withScope(patientsScope(deps.orgId, [scope]), (tx) =>
    deps.telehealth.recordMeetingClosed(tx, { requestId: null, jobId: jobRef.slice(0, 200) }, sid),
  );
  if (!recorded) throw new Error('telehealth.close_meeting: session not found to audit the close');
  return 'closed';
}
