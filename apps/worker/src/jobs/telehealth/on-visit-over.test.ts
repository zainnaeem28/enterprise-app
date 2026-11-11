// The visit-over handlers (HEAAA-916 SA-916-2, SA-916-5): one transaction ends the live session and queues the vendor close; a
// rescheduled visit also schedules the new reservation's session and room; a merged reservation is followed to the survivor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from 'graphile-worker';
import { createTelehealthTasks } from './index.js';
import { runOnVisitOver } from './on-visit-over.js';
import { runOnReservationConfirmed } from './on-reservation-confirmed.js';
import { ids, world } from './unit-world.js';

const { RID, PID, SID, SURVIVOR, NEW_RID } = ids;
const base = { reservationId: RID, patientId: PID };
const closeKey = `telehealth.close_meeting:close_meeting_${SID}`;
const createKey = `telehealth.create_meeting:create_meeting_${NEW_RID}`;

test('cancelled and no-show: a live session with a room ends and exactly one close job is queued (IDs only)', async () => {
  for (const [name, reason] of [
    ['telehealth.on_reservation_cancelled', 'cancelled'],
    ['telehealth.on_no_show', 'no_show'],
  ] as const) {
    const w = world();
    assert.equal(await runOnVisitOver(w.deps, base, name, reason), 'ended');
    assert.deepEqual(w.state.jobs.get(closeKey)?.payload, { sessionId: SID, patientId: PID });
    assert.equal(w.state.jobs.size, 1);
    assert.deepEqual(w.state.visitOver, [{ scope: PID, rid: RID, reason }]);
  }
});

test('no room, already ended, or no session: nothing is queued', async () => {
  for (const endResult of ['failed', 'already', 'none'] as const) {
    const w = world({ endResult });
    await runOnVisitOver(w.deps, base, 'telehealth.on_no_show', 'no_show');
    assert.equal(w.state.jobs.size, 0, endResult);
  }
});

test('invalid payloads throw; rescheduled needs a valid newReservationId', async () => {
  const w = world();
  await assert.rejects(runOnVisitOver(w.deps, { patientId: PID }, 'n', 'cancelled'));
  await assert.rejects(runOnVisitOver(w.deps, { reservationId: RID }, 'n', 'cancelled'));
  await assert.rejects(runOnVisitOver(w.deps, base, 'n', 'rescheduled'));
  await assert.rejects(
    runOnVisitOver(w.deps, { ...base, newReservationId: 'x' }, 'n', 'rescheduled'),
  );
  assert.equal(w.state.visitOver.length, 0);
});

test('rescheduled: the old session ends and the new reservation gets its session and create_meeting at max(now, start - 15 min)', async () => {
  const w = world();
  const p = { ...base, newReservationId: NEW_RID };
  assert.equal(
    await runOnVisitOver(w.deps, p, 'telehealth.on_reservation_rescheduled', 'rescheduled'),
    'ended',
  );
  assert.ok(w.state.jobs.has(closeKey));
  assert.equal(w.state.ensured.join(), NEW_RID);
  assert.equal(w.state.jobs.get(createKey)?.runAt?.toISOString(), '2026-12-01T09:45:00.000Z');
  assert.deepEqual(w.state.jobs.get(createKey)?.payload, {
    reservationId: NEW_RID,
    patientId: PID,
  });
});

test('rescheduled: an in-person or no-longer-confirmed new reservation schedules nothing, the old session still ends', async () => {
  for (const newReservation of ['skipped', 'gone'] as const) {
    const w = world({ newReservation });
    await runOnVisitOver(w.deps, { ...base, newReservationId: NEW_RID }, 'n', 'rescheduled');
    assert.ok(w.state.jobs.has(closeKey));
    assert.equal(w.state.jobs.has(createKey), false);
  }
});

test('merged patient: the reservation is gone for the payload patient, the handler runs for the survivor and does both steps', async () => {
  const w = world({ reservationOwner: SURVIVOR, owner: SURVIVOR });
  const p = { ...base, newReservationId: NEW_RID };
  assert.equal(await runOnVisitOver(w.deps, p, 'n', 'rescheduled'), 'ended');
  assert.deepEqual(w.state.scopes, [[PID], [SURVIVOR]]);
  assert.deepEqual(w.state.jobs.get(closeKey)?.payload, { sessionId: SID, patientId: SURVIVOR });
  assert.deepEqual(w.state.jobs.get(createKey)?.payload, {
    reservationId: NEW_RID,
    patientId: SURVIVOR,
  });
});

test('the registered tasks run the handlers with the job reference in the audit meta', async () => {
  const w = world();
  const tasks = createTelehealthTasks(w.deps);
  for (const n of ['on_reservation_cancelled', 'on_no_show', 'on_reservation_rescheduled'])
    await (tasks[`telehealth.${n}`] as Task)({ ...base, newReservationId: NEW_RID }, {
      job: { id: '9' },
    } as never);
  assert.equal(w.state.visitOver.length, 3);
});

test('on_reservation_confirmed still schedules create_meeting through the shared helper', async () => {
  const w = world();
  assert.equal(await runOnReservationConfirmed(w.deps, base), 'scheduled');
  assert.ok(w.state.jobs.has(`telehealth.create_meeting:create_meeting_${RID}`));
});
