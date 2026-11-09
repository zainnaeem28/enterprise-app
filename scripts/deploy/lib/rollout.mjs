// Rollout rules and observation thresholds (DEVOPS-PLAN 9.1, 9.2). Pure; the numbers are the plan's proposed starting
// values and the G3 package sets the final ones, so they are inputs with these defaults, never hard-coded in a workflow.

export const START_LIMITS = { api: 6, worker: 3 }; // 9.1 connection arithmetic (DPR-05)

/** A normal release is deferred while desired counts are above the limits. Rollback/recovery redeploys skip this (DPR-20). */
export function startGate({ api, worker, isRollback = false }) {
  if (isRollback) return [];
  const e = [];
  if (!Number.isInteger(api) || !Number.isInteger(worker))
    return ['desired counts are not integers'];
  if (api > START_LIMITS.api)
    e.push(
      `api desired count ${api} is above ${START_LIMITS.api}: release deferred (connection budget, 9.1)`,
    );
  if (worker > START_LIMITS.worker)
    e.push(
      `worker desired count ${worker} is above ${START_LIMITS.worker}: release deferred (connection budget, 9.1)`,
    );
  return e;
}

export const DEFAULT_THRESHOLDS = {
  errorRatePct: 1,
  p95LatencySeconds: 1,
  consecutiveMinutes: 5,
};

/**
 * samples: one per minute, oldest first: { errorRatePct, p95LatencySeconds, unhealthyHosts, alarmsInAlarm: string[] }.
 * Abort when a condition holds for `consecutiveMinutes` in a row at the END of the series (9.2). Any alarm in ALARM
 * (audit write failures, booking invariant, alert latency, queue age are alarms of 11.3) counts as a breached minute.
 * Returns { abort, reasons[] }.
 */
export function observationVerdict(samples, t = DEFAULT_THRESHOLDS) {
  const conditions = {
    'error rate above threshold': (s) => s.errorRatePct > t.errorRatePct,
    'p95 latency above threshold': (s) => s.p95LatencySeconds > t.p95LatencySeconds,
    'unhealthy hosts present': (s) => s.unhealthyHosts > 0,
    'alarm in ALARM state': (s) => (s.alarmsInAlarm ?? []).length > 0,
  };
  const reasons = [];
  for (const [name, hit] of Object.entries(conditions)) {
    let run = 0;
    for (const s of samples) run = hit(s) ? run + 1 : 0;
    if (run >= t.consecutiveMinutes) reasons.push(`${name} for ${run} consecutive minutes`);
  }
  return { abort: reasons.length > 0, reasons };
}

/** Staging floor (6.2, DPR-33): a lower release number than the one on staging is refused unless a rollback rehearsal. */
export function stagingOrderErrors({ deployedNumber, manifestNumber, rollbackRehearsal }) {
  if (deployedNumber == null) return [];
  if (manifestNumber < deployedNumber && !rollbackRehearsal)
    return [
      `manifest number ${manifestNumber} is lower than the ${deployedNumber} on staging and this is not a rollback rehearsal`,
    ];
  return [];
}
