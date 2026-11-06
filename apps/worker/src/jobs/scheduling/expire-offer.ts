// `scheduling.expire_offer` (ARCHITECTURE 25.6, 33.1; `on_merged = resolve`): at the offer's expiry the hold is released, the offer is
// `expired`, the entry returns to line and `slot_freed` offers the slot to the next entry. A patients-scope job for the offer's patient.
// A merged patient finds no row under its scope: the survivor is asked for and the job runs again under the survivor's scope; the offer
// was re-pointed by the merge, so it finishes on the survivor (38.2 item 11).
import { randomUUID } from 'node:crypto';
import { isUuid } from './ids.js';
import type { LapseOutcome, SchedulingJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

export async function runLapse(
  deps: SchedulingJobDeps,
  offerId: string,
  patientId: string,
  jobRef: string,
): Promise<LapseOutcome> {
  const attempt = (pid: string): Promise<LapseOutcome> =>
    deps.db.withScope(patientsScope(deps.orgId, [pid]), (tx) =>
      deps.flow.lapseOffer(tx, { requestId: randomUUID(), jobId: jobRef.slice(0, 200) }, offerId),
    );
  let r = await attempt(patientId);
  if (r === 'gone' && deps.survivorOf !== undefined) {
    const survivor = (await deps.survivorOf(patientId))?.toLowerCase();
    if (survivor !== undefined && survivor !== patientId.toLowerCase()) r = await attempt(survivor);
  }
  return r;
}

export async function runExpireOffer(
  deps: SchedulingJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'scheduling.expire_offer',
): Promise<LapseOutcome> {
  const offerId = payload['offerId'];
  const patientId = payload['patientId'];
  if (!isUuid(offerId) || !isUuid(patientId))
    throw new Error('scheduling.expire_offer: offerId and patientId are required');
  const r = await runLapse(deps, offerId.toLowerCase(), patientId.toLowerCase(), jobRef);
  if (r === 'not_due') {
    // Clock skew between the queue and the database: ask again shortly rather than leave the hold in place.
    const now = (deps.now ?? ((): Date => new Date()))();
    await deps.db.withScope(patientsScope(deps.orgId, [patientId]), (tx) =>
      deps.queue.enqueue(
        tx,
        'scheduling.expire_offer',
        { offerId, patientId },
        { runAt: new Date(now.getTime() + 30_000), jobKey: `expire_offer_${offerId}` },
      ),
    );
  }
  return r;
}
