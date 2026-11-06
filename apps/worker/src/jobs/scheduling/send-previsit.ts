// `scheduling.send_previsit` (ARCHITECTURE 33.1; `on_merged = resolve`) and its scheduler, the handler of `scheduling.reservation_confirmed`
// (25.1: the pre-visit invitation at start minus 72 h, Setting `previsit_send_offset`).
//
// The send runs under the reservation's patient. A cancelled, rescheduled, expired or finished booking is skipped; a merged patient finds
// no row under its scope, so the job asks for the survivor and runs again (the reservation was re-pointed). The message is PHI-free and
// deduplicated by reservation in the notifications module, so a retry or a second run sends nothing twice.
import { randomUUID } from 'node:crypto';
import { isUuid } from './ids.js';
import type { SchedulingJobDeps, SendPrevisitOutcome } from './ports.js';
import { patientsScope } from './scope.js';

async function asPatient<T extends string | Date>(
  deps: SchedulingJobDeps,
  patientId: string,
  fn: (pid: string) => Promise<T>,
): Promise<T> {
  let r = await fn(patientId);
  if (r === 'gone' && deps.survivorOf !== undefined) {
    const survivor = (await deps.survivorOf(patientId))?.toLowerCase();
    if (survivor !== undefined && survivor !== patientId.toLowerCase()) r = await fn(survivor);
  }
  return r;
}

export async function runSendPrevisit(
  deps: SchedulingJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'scheduling.send_previsit',
): Promise<SendPrevisitOutcome> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error('scheduling.send_previsit: reservationId and patientId are required');
  return asPatient(deps, patientId.toLowerCase(), (pid) =>
    deps.db.withScope(patientsScope(deps.orgId, [pid]), (tx) =>
      deps.flow.sendPrevisit(
        tx,
        { requestId: randomUUID(), jobId: jobRef.slice(0, 200) },
        reservationId.toLowerCase(),
      ),
    ),
  );
}

/** The handler of `scheduling.reservation_confirmed`: schedules the invitation (one job per reservation, replaced on a repeat event). */
export async function runOnReservationConfirmed(
  deps: SchedulingJobDeps,
  payload: Record<string, unknown>,
): Promise<'scheduled' | 'skipped' | 'gone'> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error(
      'scheduling.on_reservation_confirmed: reservationId and patientId are required',
    );
  const rid = reservationId.toLowerCase();
  const result = await asPatient(deps, patientId.toLowerCase(), async (pid) => {
    return deps.db.withScope(patientsScope(deps.orgId, [pid]), async (tx) => {
      const due = await deps.flow.previsitDueAt(tx, rid);
      if (due === 'gone') return due;
      if (due === 'skip') return 'skipped' as const;
      await deps.queue.enqueue(
        tx,
        'scheduling.send_previsit',
        { reservationId: rid, patientId: pid },
        { runAt: due, jobKey: `previsit_${rid}` },
      );
      return 'scheduled' as const;
    });
  });
  return result as 'scheduled' | 'skipped' | 'gone';
}
