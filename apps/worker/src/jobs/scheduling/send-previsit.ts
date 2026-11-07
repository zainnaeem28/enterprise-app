// `scheduling.send_previsit` (ARCHITECTURE 33.1; `on_merged = resolve`) and its scheduler, the handler of `scheduling.reservation_confirmed`
// (25.1: the pre-visit invitation at start minus 72 h, Setting `previsit_send_offset`).
//
// The send runs under the reservation's patient. A cancelled, rescheduled, expired or finished booking is skipped; a merged patient finds
// no row under its scope, so the job asks for the survivor and runs again (the reservation was re-pointed). The message is PHI-free and
// deduplicated by reservation in the notifications module, so a retry or a second run sends nothing twice.
import { randomUUID } from 'node:crypto';
import { isUuid } from './ids.js';
import type { NoticeOutcome, SchedulingJobDeps, SendPrevisitOutcome } from './ports.js';
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

type Tx = Parameters<SchedulingJobDeps['flow']['previsitDueAt']>[0];

/** Schedules the pre-visit invitation for a confirmed reservation (one job per reservation, replaced on a repeat event). */
async function schedulePrevisit(
  deps: SchedulingJobDeps,
  tx: Tx,
  rid: string,
  pid: string,
): Promise<'scheduled' | 'skipped' | 'gone'> {
  const due = await deps.flow.previsitDueAt(tx, rid);
  if (due === 'gone') return due;
  if (due === 'skip') return 'skipped';
  await deps.queue.enqueue(
    tx,
    'scheduling.send_previsit',
    { reservationId: rid, patientId: pid },
    { runAt: due, jobKey: `previsit_${rid}` },
  );
  return 'scheduled';
}

function logIgnored(deps: SchedulingJobDeps, handler: string, offsets: number[]): void {
  if (offsets.length > 0)
    deps.log.error(`${handler}: reminder_offsets has values with no template; skipped`, {
      offsets,
    });
}

/**
 * The handler of `scheduling.reservation_confirmed`: sends the confirmation, schedules the reminders (INT02-R11-N1) and the pre-visit
 * invitation. The reservation is read first; a merged patient finds none and the handler runs again as the survivor.
 */
export async function runOnReservationConfirmed(
  deps: SchedulingJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'scheduling.on_reservation_confirmed',
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
      const notice = await deps.flow.noticeConfirmed(
        tx,
        { requestId: randomUUID(), jobId: jobRef.slice(0, 200) },
        rid,
      );
      if (notice.outcome === 'gone') return 'gone' as const;
      logIgnored(deps, 'scheduling.on_reservation_confirmed', notice.ignoredOffsets);
      return schedulePrevisit(deps, tx, rid, pid);
    });
  });
  return result;
}

/**
 * The patient a cancel/reschedule notice is for, and the scope that sees both rows. A merge re-points the patient's queued reminders to the
 * survivor but keeps a cancelled or rescheduled reservation on the merged patient, so the scope names both and the notice goes to the survivor.
 */
async function noticeScope(
  deps: SchedulingJobDeps,
  patientId: string,
): Promise<{ pid: string; scope: ReturnType<typeof patientsScope> }> {
  const own = patientId.toLowerCase();
  const survivor = (await deps.survivorOf?.(own))?.toLowerCase() ?? own;
  return { pid: survivor, scope: patientsScope(deps.orgId, [...new Set([own, survivor])]) };
}

/** The handler of `scheduling.reservation_cancelled`: cancels the reminders and tells the patient (a released hold is silent). */
export async function runOnReservationCancelled(
  deps: SchedulingJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'scheduling.on_reservation_cancelled',
): Promise<NoticeOutcome> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error(
      'scheduling.on_reservation_cancelled: reservationId and patientId are required',
    );
  const wasConfirmed = payload['wasConfirmed'] === true;
  const { pid, scope } = await noticeScope(deps, patientId);
  return deps.db.withScope(
    scope,
    async (tx) =>
      (
        await deps.flow.noticeCancelled(
          tx,
          { requestId: randomUUID(), jobId: jobRef.slice(0, 200) },
          reservationId.toLowerCase(),
          wasConfirmed,
          pid,
        )
      ).outcome,
  );
}

/** The handler of `scheduling.reservation_rescheduled`: old reminders cancelled; notice, reminders and pre-visit for the new booking. */
export async function runOnReservationRescheduled(
  deps: SchedulingJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'scheduling.on_reservation_rescheduled',
): Promise<NoticeOutcome> {
  const reservationId = payload['reservationId'];
  const newReservationId = payload['newReservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(newReservationId) || !isUuid(patientId))
    throw new Error(
      'scheduling.on_reservation_rescheduled: reservationId, newReservationId and patientId are required',
    );
  const nid = newReservationId.toLowerCase();
  const { pid, scope } = await noticeScope(deps, patientId);
  return deps.db.withScope(scope, async (tx) => {
    const notice = await deps.flow.noticeRescheduled(
      tx,
      { requestId: randomUUID(), jobId: jobRef.slice(0, 200) },
      reservationId.toLowerCase(),
      nid,
      pid,
    );
    if (notice.outcome === 'gone' || notice.outcome === 'skipped') return notice.outcome;
    logIgnored(deps, 'scheduling.on_reservation_rescheduled', notice.ignoredOffsets);
    // A reschedule publishes no `reservation_confirmed` for the new reservation, so its invitation is scheduled here.
    await schedulePrevisit(deps, tx, nid, pid);
    return notice.outcome;
  });
}
