// Pure planning helpers for the monthly restore test (DEVOPS-PLAN 10.3 step 1). No AWS calls.
import { randomInt } from 'node:crypto';
import { TARGET_PREFIX } from './aws.mjs';

export const PITR_WINDOW_SECONDS = 7 * 24 * 3600;
export const MIN_AGE_SECONDS = 300; // never ask for a time inside the last 5 minutes: the log tail may not be restorable yet

/**
 * A random PITR time within the last 7 days, inside the instance's restorable range. `rand(n)` returns an integer in
 * [0, n) and is injectable so a test is deterministic; production uses crypto.randomInt, never Math.random.
 */
export function choosePitrTime({
  latestRestorable,
  earliestRestorable,
  now = new Date(),
  rand = randomInt,
}) {
  const latest = Date.parse(latestRestorable);
  if (Number.isNaN(latest))
    throw new Error('no LatestRestorableTime: point-in-time restore is not available');
  const nowMs = now.getTime();
  const hi = Math.min(latest, nowMs - MIN_AGE_SECONDS * 1000);
  let lo = nowMs - PITR_WINDOW_SECONDS * 1000;
  if (earliestRestorable) {
    const e = Date.parse(earliestRestorable);
    if (Number.isNaN(e)) throw new Error('earliest restorable time is malformed');
    lo = Math.max(lo, e);
  }
  if (hi <= lo) throw new Error('the restorable range inside the last 7 days is empty');
  const spanSeconds = Math.floor((hi - lo) / 1000);
  return new Date(lo + rand(spanSeconds + 1) * 1000);
}

/** rt-<yyyymmdd>-<run id>-<attempt>: lowercase, starts with the prefix the AWS wrapper insists on, at most 40 chars. */
export function targetIdentifier({ now = new Date(), runId, attempt = '1' }) {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  const id = `${TARGET_PREFIX}${day}-${String(runId).replace(/[^0-9]/g, '')}-${String(attempt).replace(/[^0-9]/g, '')}`;
  if (!/^rt-[0-9]{8}-[0-9]+-[0-9]+$/.test(id) || id.length > 40)
    throw new Error(`cannot build a target identifier from run ${runId}`);
  return id;
}

/** Instances older than `maxAgeHours` carrying the restore-test tag (the teardown sweep, 10.3 step 2). */
export function staleTargets(instances, { now = new Date(), maxAgeHours = 24 } = {}) {
  const cutoff = now.getTime() - maxAgeHours * 3600 * 1000;
  return instances
    .filter((i) => i.DBInstanceIdentifier?.startsWith(TARGET_PREFIX))
    .filter((i) => (i.TagList ?? []).some((t) => t.Key === 'purpose' && t.Value === 'restore-test'))
    .filter((i) => !i.InstanceCreateTime || Date.parse(i.InstanceCreateTime) < cutoff)
    .map((i) => i.DBInstanceIdentifier);
}
