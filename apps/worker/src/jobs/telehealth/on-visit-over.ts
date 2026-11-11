// `telehealth.on_reservation_cancelled` and `telehealth.on_no_show` (ARCHITECTURE 33.1; `on_merged = resolve`): the handlers of
// `scheduling.reservation_cancelled` and `scheduling.no_show`. Both do one thing: bring `telehealth.close_meeting` forward to now for that
// reservation (same job key as the window-close job, which this replaces). A visit with no session is left alone by the job itself.
import { isUuid } from './ids.js';
import { nowOf } from './ports.js';
import type { TelehealthJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

export const closeMeetingKey = (reservationId: string): string => `close_meeting_${reservationId}`;

export async function runOnVisitOver(
  deps: TelehealthJobDeps,
  payload: Record<string, unknown>,
  name: string,
): Promise<void> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error(`${name}: reservationId and patientId are required`);
  const rid = reservationId.toLowerCase();
  const pid = patientId.toLowerCase();
  await deps.db.withScope(patientsScope(deps.orgId, [pid]), (tx) =>
    deps.queue.enqueue(
      tx,
      'telehealth.close_meeting',
      { reservationId: rid, patientId: pid },
      { runAt: nowOf(deps), jobKey: closeMeetingKey(rid) },
    ),
  );
}
