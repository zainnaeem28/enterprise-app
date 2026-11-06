// The handler of `scheduling.slot_freed` (published by cancel, reschedule, the hold sweep, and a declined or lapsed offer; 25.1, 25.6):
// schedules `scheduling.offer_waitlist` for the freed occupancy. One job per occupancy (the job key replaces one that has not started), so a
// burst of events for the same slot is one offer run.
import { isUuid } from './ids.js';
import type { SchedulingJobDeps } from './ports.js';
import { systemScope } from './scope.js';

export async function runOnSlotFreed(
  deps: SchedulingJobDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const occupancyId = payload['occupancyId'];
  if (!isUuid(occupancyId)) throw new Error('scheduling.on_slot_freed: occupancyId is required');
  const occ = occupancyId.toLowerCase();
  await deps.db.withScope(systemScope(deps.orgId), (tx) =>
    deps.queue.enqueue(
      tx,
      'scheduling.offer_waitlist',
      { occupancyId: occ },
      { jobKey: `offer_${occ}` },
    ),
  );
}
