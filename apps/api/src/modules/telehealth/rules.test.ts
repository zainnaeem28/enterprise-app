import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParticipantRegistries, RegistryError } from '@ehr/kernel';
import { TELEHEALTH_JOBS } from './jobs.js';
import {
  TELEHEALTH_CONFLICT_RULES,
  TELEHEALTH_MERGE_TABLES,
  registerTelehealthParticipants,
  telehealthExportContributor,
  telehealthMergeParticipant,
} from './merge.js';
import {
  hostWindow,
  isStale,
  joinOpensAt,
  meetingDueAt,
  normaliseState,
  parseDeviceCheck,
  patientWindow,
} from './rules.js';
import { TooEarlyError, translateDbError } from './errors.js';

const T = (s: string): Date => new Date(s);
const START = T('2026-11-10T15:00:00Z');
const END = T('2026-11-10T15:30:00Z');

test('TC-TH-05: the join window opens 10 minutes before the start and closes at the end of the slot', () => {
  assert.equal(joinOpensAt(START).toISOString(), '2026-11-10T14:50:00.000Z');
  assert.equal(patientWindow(T('2026-11-10T14:49:59Z'), START, END), 'early');
  assert.equal(patientWindow(T('2026-11-10T14:50:00Z'), START, END), 'open');
  assert.equal(patientWindow(T('2026-11-10T15:29:59Z'), START, END), 'open');
  assert.equal(patientWindow(T('2026-11-10T15:30:00Z'), START, END), 'closed');
  // the host is not cut off at the end of the slot: the visit ends when the host ends it
  assert.equal(hostWindow(T('2026-11-10T14:49:59Z'), START), 'early');
  assert.equal(hostWindow(T('2026-11-10T16:45:00Z'), START), 'open');
});

test('the room is made 15 minutes before the start, or at once when that time has passed', () => {
  assert.equal(
    meetingDueAt(START, T('2026-11-08T00:00:00Z')).toISOString(),
    '2026-11-10T14:45:00.000Z',
  );
  assert.equal(
    meetingDueAt(START, T('2026-11-10T14:55:00Z')).toISOString(),
    '2026-11-10T14:55:00.000Z',
  );
});

test('a session is stale two hours after the end of its slot', () => {
  assert.equal(isStale(T('2026-11-10T17:29:59Z'), END), false);
  assert.equal(isStale(T('2026-11-10T17:30:00Z'), END), true);
});

test('a state is two letters in any case; nothing else is a state', () => {
  assert.equal(normaliseState(' ny '), 'NY');
  for (const bad of ['', 'N', 'NYC', 'N1', '1 ', 12, null, undefined, {}, ['NY']])
    assert.equal(normaliseState(bad), undefined, String(bad));
});

test('a device check is camera, mic and bandwidth, each pass or fail, and nothing else', () => {
  assert.deepEqual(parseDeviceCheck({ camera: 'pass', mic: 'fail', bandwidth: 'pass' }), {
    camera: 'pass',
    mic: 'fail',
    bandwidth: 'pass',
  });
  for (const bad of [
    null,
    [],
    'pass',
    {},
    { camera: 'pass', mic: 'pass' },
    { camera: 'pass', mic: 'pass', bandwidth: 'ok' },
    { camera: 'pass', mic: 'pass', bandwidth: 'pass', label: 'Logitech C920' },
    { camera: true, mic: true, bandwidth: true },
  ])
    assert.equal(parseDeviceCheck(bad), undefined, JSON.stringify(bad));
});

test('a refusal carries a code and the start time only', () => {
  const e = new TooEarlyError('2026-11-10T14:50:00.000Z');
  assert.equal(e.code, 'telehealth.not_admitted');
  assert.equal(e.status, 409);
  assert.equal(e.retryable, true);
  assert.deepEqual(e.extras.errors, [{ path: '/joinOpensAt', code: '2026-11-10T14:50:00.000Z' }]);
  assert.throws(() => translateDbError({ code: 'PS001' }), { code: 'telehealth.session_closed' });
  assert.throws(() => translateDbError({ code: 'PM001' }), { code: 'patient.merged' });
  assert.throws(() => translateDbError({ code: 'PM008' }), { code: 'kernel.not_found' });
  const other = new Error('x');
  assert.throws(
    () => translateDbError(other),
    (e2) => e2 === other,
  );
});

test('the job list is pinned (the worker side pins the same one)', () => {
  assert.deepEqual(
    TELEHEALTH_JOBS.map(
      (j) => `${j.name}|${j.jobClass}|${j.jobScope}|${j.onMerged}|${j.maxAttempts}`,
    ),
    [
      'telehealth.on_reservation_confirmed|handler|patients|resolve|5',
      'telehealth.create_meeting|job|patients|resolve|8',
      'telehealth.close_meeting|job|patients|resolve|8',
      'telehealth.end_stale|system|org|none|3',
    ],
  );
  // every job that carries patient IDs declares what a merge does to it (22.16)
  for (const j of TELEHEALTH_JOBS) if (j.carriesPatientIds) assert.notEqual(j.onMerged, 'none');
});

test('the merge participant registers once, names its four tables and every table is a telehealth one', () => {
  const r = new ParticipantRegistries();
  registerTelehealthParticipants(r);
  assert.deepEqual(
    r.mergeParticipants().map((p) => p.module),
    ['telehealth'],
  );
  assert.deepEqual(
    r.exportContributors().map((c) => c.module),
    ['telehealth'],
  );
  assert.deepEqual(
    [...telehealthMergeParticipant.tables],
    [
      'telehealth.video_session',
      'telehealth.participant',
      'telehealth.join_token',
      'telehealth.location_confirmation',
    ],
  );
  assert.deepEqual([...TELEHEALTH_MERGE_TABLES], [...telehealthMergeParticipant.tables]);
  assert.equal(TELEHEALTH_CONFLICT_RULES.length, 4);
  assert.equal(telehealthExportContributor.module, 'telehealth');
  // a module cannot be registered half, or twice
  assert.throws(() => registerTelehealthParticipants(r), RegistryError);
});
