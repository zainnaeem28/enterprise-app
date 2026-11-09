import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbAvailable, pollUntil, taskStopped } from '../lib/wait.mjs';

const fake = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
};

test('polls until available, then returns', async () => {
  const seq = ['creating', 'backing-up', 'available'];
  let i = 0;
  const s = await dbAvailable(async () => ({ DBInstances: [{ DBInstanceStatus: seq[i++] }] }), { timeoutSeconds: 600, intervalSeconds: 30, ...fake() });
  assert.equal(s, 'available');
  assert.equal(i, 3);
});

test('a failed restore status stops at once and a deadline is a named failure', async () => {
  await assert.rejects(dbAvailable(async () => ({ DBInstances: [{ DBInstanceStatus: 'incompatible-restore' }] }), { timeoutSeconds: 600, ...fake() }), /incompatible-restore/);
  await assert.rejects(dbAvailable(async () => ({ DBInstances: [{ DBInstanceStatus: 'creating' }] }), { timeoutSeconds: 120, intervalSeconds: 30, ...fake() }), /timed out after 120 s/);
});

test('task polling returns the stopped task and times out otherwise', async () => {
  const states = [{ lastStatus: 'RUNNING' }, { lastStatus: 'STOPPED', containers: [{ exitCode: 0 }] }];
  let i = 0;
  const t = await taskStopped(async () => ({ tasks: [states[i++]] }), { timeoutSeconds: 600, intervalSeconds: 6, ...fake() });
  assert.equal(t.containers[0].exitCode, 0);
  await assert.rejects(pollUntil(async () => 1, { done: () => false, timeoutSeconds: 10, intervalSeconds: 6, ...fake() }), /timed out/);
});
