import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Tx } from '../scope/with-scope.js';
import { JobRegistry, Queue, QueueError, assertPayloadIsIdsOnly } from './enqueue.js';
import type { QueuePath } from './enqueue.js';
import { syncTaskTypes } from './sync-task-types.js';

const ID = '0192e0a0-0000-7000-8000-000000000001';

function setup(path: QueuePath = 'api'): {
  q: Queue;
  calls: { sql: string; params: unknown[] }[];
  tx: Tx;
} {
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
  return { q: new Queue(reg, path), calls, tx };
}

test('api path enqueues only through queue_api.enqueue on the caller transaction handle', async () => {
  const { q, calls, tx } = setup('api');
  await q.enqueue(
    tx,
    'notifications.send_message',
    { notificationId: ID, patientId: ID },
    { jobKey: 'k1' },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /queue_api\.enqueue/);
  assert.doesNotMatch(calls[0]!.sql, /queue\.add_job/);
  assert.equal(calls[0]!.params[3], 'k1', 'the namespace prefix is added by the database wrapper');
});

test('worker path calls queue.add_job with the type attempt limit and the namespaced job key', async () => {
  const { q, calls, tx } = setup('worker');
  await q.enqueue(tx, 'notifications.send_message', { notificationId: ID }, { jobKey: 'k1' });
  assert.match(calls[0]!.sql, /queue\.add_job/);
  assert.equal(calls[0]!.params[3], 5);
  assert.equal(calls[0]!.params[4], 'notifications.send_message:k1');
});

test('system and data_repair types, and bad job keys, never reach the api path', async () => {
  const reg = new JobRegistry();
  reg.defineJob({
    name: 'ops.repair',
    maxAttempts: 1,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'data_repair',
  });
  assert.throws(
    () =>
      reg.defineJob({
        name: 'ops.bad',
        maxAttempts: 1,
        onMerged: 'none',
        carriesPatientIds: false,
        jobScope: 'org',
        jobClass: 'system',
        apiEnqueue: true,
      }),
    QueueError,
  );
  const { calls, tx } = setup();
  await assert.rejects(new Queue(reg, 'api').enqueue(tx, 'ops.repair', {}), QueueError);
  await assert.rejects(
    setup().q.enqueue(tx, 'notifications.send_message', {}, { jobKey: 'bad key!' }),
    QueueError,
  );
  assert.equal(calls.length, 0);
});

test('syncTaskTypes upserts every registered type in a stable order and never deletes', async () => {
  const { tx, calls } = setup();
  const reg = new JobRegistry();
  reg.defineJob({
    name: 'b.two',
    maxAttempts: 2,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
  });
  reg.defineJob({
    name: 'a.one',
    maxAttempts: 4,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'handler',
  });
  assert.equal(await syncTaskTypes(tx, reg), 2);
  assert.deepEqual(
    calls.map((c) => c.params[0]),
    ['a.one', 'b.two'],
  );
  assert.ok(calls.every((c) => /ON CONFLICT/.test(c.sql) && !/DELETE/i.test(c.sql)));
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
  assert.throws(() => new Queue(reg, 'api', 'queue; DROP'), QueueError);
});

test('SEC03-F07: the registry can declare on_merged = fail; a patient-carrying type must declare resolve or fail', () => {
  const reg = new JobRegistry();
  reg.defineJob({
    name: 'patient.example_fail',
    maxAttempts: 1,
    onMerged: 'fail',
    carriesPatientIds: true,
    jobScope: 'patients',
  });
  assert.equal(reg.get('patient.example_fail').onMerged, 'fail');
  assert.throws(
    () =>
      reg.defineJob({
        name: 'patient.example_none',
        maxAttempts: 1,
        onMerged: 'none',
        carriesPatientIds: true,
        jobScope: 'patients',
      }),
    QueueError,
  );
});
