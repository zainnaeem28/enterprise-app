// `telehealth.on_reservation_cancelled`, `telehealth.on_no_show` and `telehealth.on_reservation_rescheduled` (ARCHITECTURE 33.1,
// HEAAA-916 SA-916-2; `on_merged = resolve`): the handlers of `scheduling.reservation_cancelled`, `scheduling.no_show` and
// `scheduling.reservation_rescheduled`. In ONE patients-scope transaction each ends the reservation's live session (tokens revoked
// first) and, when the session has a room, enqueues `telehealth.close_meeting` for it. A rescheduled visit also gets its new
// reservation's session and room scheduled here, because `reschedule()` publishes no `reservation_confirmed` (SA-916-5). A reservation
// re-pointed by a merge is `gone` for the payload patient: the handler runs again for the survivor.
import { isUuid } from './ids.js';
import { asPatient, scheduleMeeting } from './on-reservation-confirmed.js';
import type { TelehealthJobDeps, VisitOverReason } from './ports.js';
import { patientsScope } from './scope.js';

export type VisitOverOutcome = 'ended' | 'nothing' | 'gone';

export async function runOnVisitOver(
  deps: TelehealthJobDeps,
  payload: Record<string, unknown>,
  name: string,
  reason: VisitOverReason,
  jobRef = name,
): Promise<VisitOverOutcome> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  const newReservationId = payload['newReservationId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error(`${name}: reservationId and patientId are required`);
  if (reason === 'rescheduled' && !isUuid(newReservationId))
    throw new Error(`${name}: newReservationId is required`);
  const rid = reservationId.toLowerCase();
  const meta = { requestId: null, jobId: jobRef.slice(0, 200) };
  return asPatient<VisitOverOutcome>(deps, patientId.toLowerCase(), (pid) =>
    deps.db.withScope(patientsScope(deps.orgId, [pid]), async (tx) => {
      const r = await deps.telehealth.endForVisitOver(tx, meta, rid, reason);
      if (r.status === 'gone') return 'gone';
      if ((r.status === 'ended' || r.status === 'failed') && r.meetingId !== null)
        await deps.queue.enqueue(
          tx,
          'telehealth.close_meeting',
          { sessionId: r.sessionId, patientId: pid },
          { jobKey: `close_meeting_${r.sessionId}` },
        );
      if (reason === 'rescheduled')
        await scheduleMeeting(deps, tx, meta, (newReservationId as string).toLowerCase(), pid);
      return r.status === 'ended' ? 'ended' : 'nothing';
    }),
  );
}
