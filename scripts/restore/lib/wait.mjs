// Polling with a deadline of our own. `aws ... wait` gives up after 20-30 minutes, a large restore can take longer, and the
// role session lasts 2 h, so the deadline is explicit and the timeout is a named failure (not a silent success).
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export const FAILED_DB_STATUSES = ['failed', 'incompatible-restore', 'incompatible-parameters', 'storage-full', 'inaccessible-encryption-credentials'];

/** Resolves with the first value for which `done(value)` is truthy; throws on `fatal(value)` or when the deadline passes. */
export async function pollUntil(fetch, { done, fatal = () => null, timeoutSeconds, intervalSeconds = 30, sleep = sleepMs, now = Date.now }) {
  const deadline = now() + timeoutSeconds * 1000;
  for (;;) {
    const v = await fetch();
    const bad = fatal(v);
    if (bad) throw new Error(bad);
    if (done(v)) return v;
    if (now() + intervalSeconds * 1000 > deadline) throw new Error(`timed out after ${timeoutSeconds} s`);
    await sleep(intervalSeconds * 1000);
  }
}

export const dbAvailable = (describe, opts) =>
  pollUntil(async () => (await describe()).DBInstances?.[0]?.DBInstanceStatus, {
    done: (s) => s === 'available',
    fatal: (s) => (FAILED_DB_STATUSES.includes(s) ? `restore target entered status "${s}"` : null),
    ...opts,
  });

export const taskStopped = (describe, opts) =>
  pollUntil(async () => (await describe()).tasks?.[0], { done: (t) => t?.lastStatus === 'STOPPED', ...opts });
