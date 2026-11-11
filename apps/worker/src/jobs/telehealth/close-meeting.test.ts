// `telehealth.close_meeting` (DL-1 contract, HEAAA-916) against the in-memory video vendor stub: the ended session's room is closed once
// and the close audited under the patient whose scope found the room; a vendor that no longer has the meeting counts as closed; a
// vendor error retries and the last failed attempt is the job_dead line the alarm filters on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from 'graphile-worker';
import { createLogger } from '@ehr/kernel';
import { wrapTask } from '../../runner.js';
import { AdapterFailure } from '../integration-core/errors.js';
import type { FakeVideoTransport } from './fake-transport.js';
import { runCloseMeeting } from './close-meeting.js';
import { createTelehealthTasks } from './index.js';
import { ids, world } from './unit-world.js';

const { RID, PID, SID, SURVIVOR } = ids;

const payload = { sessionId: SID, patientId: PID };
const ends = (t: FakeVideoTransport) => t.calls.filter((c) => c.op === 'end').length;

test('an invalid payload throws', async () => {
  const w = world();
  await assert.rejects(runCloseMeeting(w.deps, { sessionId: 'x', patientId: PID }));
  await assert.rejects(runCloseMeeting(w.deps, { sessionId: SID }));
  await assert.rejects(runCloseMeeting(w.deps, { reservationId: RID, patientId: PID }));
});

test('an ended session with a room is closed at the vendor once and the close is audited', async () => {
  const w = world();
  assert.equal(await runCloseMeeting(w.deps, payload, 'telehealth.close_meeting:5'), 'closed');
  assert.equal(w.transport.meetings.get(SID)?.ended, true);
  assert.deepEqual(w.state.audits, [{ scope: PID, sid: SID, jobId: 'telehealth.close_meeting:5' }]);
});

test('a session that is not ended, or has no room, gives nothing and no vendor call', async () => {
  const w = world({ session: 'live', owner: 'nobody' });
  assert.equal(await runCloseMeeting(w.deps, payload), 'nothing');
  assert.equal(ends(w.transport), 0);
  assert.deepEqual(w.state.audits, []);
});

test('a room the vendor no longer has counts as closed', async () => {
  const w = world();
  w.transport.endMeeting = () => Promise.reject(new AdapterFailure(false, 404, 'not_found'));
  assert.equal(await runCloseMeeting(w.deps, payload), 'closed');
  assert.equal(w.state.audits.length, 1);
});

test('merged patient: the room is found under the survivor and the audit transaction opens under the survivor, not the payload patient', async () => {
  const w = world({ owner: SURVIVOR });
  assert.equal(await runCloseMeeting(w.deps, payload), 'closed');
  assert.deepEqual(w.state.scopes, [[PID], [SURVIVOR], [SURVIVOR]]);
  assert.deepEqual(w.state.audits, [
    { scope: SURVIVOR, sid: SID, jobId: 'telehealth.close_meeting' },
  ]);
});

test('an audit that finds no row in scope throws so the queue retries', async () => {
  const w = world({ auditFindsRow: false });
  await assert.rejects(runCloseMeeting(w.deps, payload));
  assert.equal(w.transport.meetings.get(SID)?.ended, true); // the vendor close is idempotent: a retry is safe
});

test('vendor errors retry, and the last failed attempt is the job_dead line the alarm filters on', async () => {
  const w = world();
  w.transport.unavailable = true;
  const task = createTelehealthTasks(w.deps)['telehealth.close_meeting'] as Task;
  for (const attempts of [1, 8]) {
    const out: string[] = [];
    const log = createLogger({ sink: (l) => out.push(l) });
    await assert.rejects(async () => {
      await wrapTask(
        'telehealth.close_meeting',
        task,
        log,
      )(payload, { job: { id: '7', attempts, max_attempts: 8 } } as never);
    });
    const dead = out
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'job_dead');
    assert.equal(dead.length, attempts === 8 ? 1 : 0);
    if (attempts === 8) assert.equal(dead[0]?.jobType, 'telehealth.close_meeting');
  }
  assert.deepEqual(w.state.audits, []);
  w.transport.unavailable = false;
  assert.equal(await runCloseMeeting(w.deps, payload), 'closed');
});
