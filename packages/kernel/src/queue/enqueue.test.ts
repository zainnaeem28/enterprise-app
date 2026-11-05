import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Tx } from '../scope/with-scope.js';
import { JobRegistry, Queue, QueueError, assertPayloadIsIdsOnly } from './enqueue.js';

const ID = '0192e0a0-0000-7000-8000-000000000001';

function setup(): { q: Queue; calls: { sql: string; params: unknown[] }[]; tx: Tx } {
  const reg = new JobRegistry();
  reg.defineJob({
    name: 'notifications.send_message',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
  });
  reg.defineJob({
    name: 'notifications.on_reservation_confirmed',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
  });
  reg.defineJob({
    name: 'calendar_sync.on_reservation_confirmed',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
  });
  reg.registerHandler('scheduling.reservation_confirmed', 'notifications');
  reg.registerHandler('scheduling.reservation_confirmed', 'calendar_sync');
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx = new Tx(
    {
      query: async (sql: string, params?: unknown[]) => (
        calls.push({ sql, params: params ?? [] }),
        { rows: [] }
      ),
      release() {},
    },
    { audience: 'staff' },
  );
  return { q: new Queue(reg), calls, tx };
}

test('enqueue goes through the caller transaction handle with the type attempt limit', async () => {
  const { q, calls, tx } = setup();
  await q.enqueue(tx, 'notifications.send_message', { notificationId: ID, patientId: ID });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /queue\.add_job/);
  assert.equal(calls[0]!.params[3], 5);
});

test('publish fans out one job per registered handler, in a stable order', async () => {
  const { q, calls, tx } = setup();
  const names = await q.publish(tx, 'scheduling.reservation_confirmed', { reservationId: ID });
  assert.deepEqual(names, [
    'calendar_sync.on_reservation_confirmed',
    'notifications.on_reservation_confirmed',
  ]);
  assert.equal(calls.length, 2);
});

test('payloads are IDs and scope keys only', () => {
  assertPayloadIsIdsOnly({ patientIds: [ID], jobScope: 'org', attempt: 2, flag: true });
  for (const bad of [
    { name: 'Jane Doe' },
    { note: 'a@b.example' },
    { dob: '1980-02-29' },
    { x: { y: { z: { w: { v: 1 } } } } },
  ])
    assert.throws(() => assertPayloadIsIdsOnly(bad), QueueError);
});

test('a PHI payload never reaches the database', async () => {
  const { q, calls, tx } = setup();
  await assert.rejects(
    q.enqueue(tx, 'notifications.send_message', { body: 'Jane Doe has diabetes' }),
    QueueError,
  );
  assert.equal(calls.length, 0);
});

test('job types: patient IDs require on_merged, duplicates and unknown types refused', () => {
  const reg = new JobRegistry();
  assert.throws(
    () =>
      reg.defineJob({
        name: 'a.b',
        maxAttempts: 3,
        onMerged: 'none',
        carriesPatientIds: true,
        jobScope: 'patients',
      }),
    /on_merged/,
  );
  reg.defineJob({
    name: 'a.b',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
  });
  assert.throws(
    () =>
      reg.defineJob({
        name: 'a.b',
        maxAttempts: 3,
        onMerged: 'none',
        carriesPatientIds: false,
        jobScope: 'org',
      }),
    /already/,
  );
  assert.throws(() => reg.get('x.y'), /unknown/);
  assert.throws(() => new Queue(reg, 'queue; DROP'), QueueError);
});
