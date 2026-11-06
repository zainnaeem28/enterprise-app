// The handlers of the three booking events calendar-sync consumes (ARCHITECTURE 24, 33.1): thin jobs that schedule `push_busy` or
// `delete_busy` for the occupancy. The event carries the patient ID (the handler declares on_merged = resolve, 9.2) and the handler
// discards it: the jobs it schedules carry the occupancy ID only (33.1: "org, reads occupancy only, no patient").
import { isUuid } from './ids.js';
import type { CalendarJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

type Event = 'confirmed' | 'cancelled' | 'rescheduled';

export async function runOnReservation(
  deps: CalendarJobDeps,
  event: Event,
  payload: Record<string, unknown>,
): Promise<void> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error(`calendar_sync.on_reservation_${event}: reservationId and patientId are required`);
  const newId = payload['newReservationId'];
  if (event === 'rescheduled' && !isUuid(newId))
    throw new Error('calendar_sync.on_reservation_rescheduled: newReservationId is required');
  const rid = reservationId.toLowerCase();
  await deps.db.withScope(patientsScope(deps.orgId, [patientId.toLowerCase()]), async (tx) => {
    if (event === 'confirmed')
      await deps.queue.enqueue(tx, 'calendar_sync.push_busy', { occupancyId: rid }, { jobKey: `push_${rid}` });
    else {
      await deps.queue.enqueue(tx, 'calendar_sync.delete_busy', { occupancyId: rid }, { jobKey: `delete_${rid}` });
      if (event === 'rescheduled') {
        const nid = (newId as string).toLowerCase();
        await deps.queue.enqueue(tx, 'calendar_sync.push_busy', { occupancyId: nid }, { jobKey: `push_${nid}` });
      }
    }
  });
}
