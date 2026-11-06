// `telehealth.on_reservation_confirmed` (ARCHITECTURE 33.1; `on_merged = resolve`): the handler of `scheduling.reservation_confirmed`.
// For a VIDEO booking it makes the session row now (so a device check can start at once) and schedules `telehealth.create_meeting` for
// start - 15 minutes. An in-person visit is skipped. A reservation re-pointed by a merge is not the old patient's any more: the handler
// asks for the survivor and runs again.
import { MEETING_LEAD_MINUTES } from './jobs.js';
import { isUuid } from './ids.js';
import { nowOf } from './ports.js';
import type { TelehealthJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

export type ConfirmedOutcome = 'scheduled' | 'skipped' | 'gone';

/** Runs `fn` for the patient and, when the reservation is gone from their scope, once for the survivor of a merge. */
export async function asPatient<T extends string>(
  deps: Pick<TelehealthJobDeps, 'survivorOf'>,
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

export function meetingRunAt(startsAt: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), startsAt.getTime() - MEETING_LEAD_MINUTES * 60_000));
}

export async function runOnReservationConfirmed(
  deps: TelehealthJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'telehealth.on_reservation_confirmed',
): Promise<ConfirmedOutcome> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error(
      'telehealth.on_reservation_confirmed: reservationId and patientId are required',
    );
  const rid = reservationId.toLowerCase();
  return asPatient(deps, patientId.toLowerCase(), (pid) =>
    deps.db.withScope(patientsScope(deps.orgId, [pid]), async (tx) => {
      const r = await deps.telehealth.ensureSession(
        tx,
        { requestId: null, jobId: jobRef.slice(0, 200) },
        rid,
      );
      if (r.outcome === 'gone') return 'gone' as const;
      if (r.outcome === 'skipped') return 'skipped' as const;
      await deps.queue.enqueue(
        tx,
        'telehealth.create_meeting',
        { reservationId: rid, patientId: pid },
        { runAt: meetingRunAt(new Date(r.startsAt), nowOf(deps)), jobKey: `create_meeting_${rid}` },
      );
      return 'scheduled' as const;
    }),
  );
}
