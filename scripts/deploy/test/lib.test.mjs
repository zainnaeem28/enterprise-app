import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../../release/lib/hash.mjs';
import { assertAllowed } from '../lib/aws.mjs';
import { checkManifestBytes } from '../lib/manifest-check.mjs';
import { checkRecord, minClientRelease, newMigrations } from '../lib/record.mjs';
import { observationVerdict, stagingOrderErrors, startGate } from '../lib/rollout.mjs';
import { stagingMinClient } from '../lib/staging.mjs';
import { bytesOf, hex, stubManifest, stubRecord } from './helpers.mjs';
import { pickRevision } from '../resolve-taskdefs.mjs';
import { taskOutcome } from '../run-migration.mjs';
import { parseServices, ROLLOUT_ORDER } from '../rollout.mjs';
import { freshnessErrors, snapshotName } from '../backup-gate.mjs';
import { switchPlan } from '../portal-switch.mjs';
import { expectReleaseJson } from '../smoke.mjs';
import { metricQueries, toSample } from '../observe.mjs';
import { hasFailedTarget } from '../rollout.mjs';

const NOW = new Date('2026-11-09T06:00:00Z');
const m = stubManifest();
const h = sha256(bytesOf(m));
const want = {
  environment: 'production',
  manifestHash: h,
  actions: ['rollout', 'smoke'],
  now: NOW,
};

test('manifest bytes: matching hash passes, altered bytes and dry-run mode are refused', () => {
  assert.deepEqual(checkManifestBytes(bytesOf(m), h).errors, []);
  assert.match(
    checkManifestBytes(Buffer.from(bytesOf(m).toString() + ' '), h).errors[0],
    /hash to/,
  );
  const dry = stubManifest();
  dry.mode = 'dry-run';
  assert.ok(
    checkManifestBytes(bytesOf(dry), sha256(bytesOf(dry))).errors.some((e) =>
      /only a published manifest/.test(e),
    ),
  );
  assert.ok(checkManifestBytes(Buffer.from('{'), h).errors.some((e) => /not valid JSON/.test(e)));
});

test('manifest: an unsigned image or a tag reference is refused', () => {
  const x = stubManifest();
  x.images.api.signed = false;
  assert.ok(checkManifestBytes(bytesOf(x), sha256(bytesOf(x))).errors.length > 0);
  const y = stubManifest();
  y.images.api.reference = 'repo/api:latest';
  assert.ok(checkManifestBytes(bytesOf(y), sha256(bytesOf(y))).errors.length > 0);
});

test('record: the good case', () => assert.deepEqual(checkRecord(stubRecord(h), want), []));

test('record: refuses every mismatch (15.3)', () => {
  const bad = (rec, w = want) => checkRecord(rec, w).join(' | ');
  assert.match(bad(stubRecord(hex('0'))), /differs from the record/);
  assert.match(bad(stubRecord(h, { environment: 'staging' })), /environment/);
  assert.match(bad(stubRecord(h, { state: 'empty' })), /not "approved"/);
  assert.match(bad(stubRecord(h, { permitted_actions: ['rollout'] })), /action "smoke"/);
  assert.match(bad(stubRecord(h, { g3_reference: '' })), /g3_reference/);
  assert.match(bad(stubRecord(h), { ...want, now: new Date('2026-11-09T12:00:00Z') }), /expired/);
  assert.match(
    bad(stubRecord(h), { ...want, now: new Date('2026-11-08T23:00:00Z') }),
    /not valid before/,
  );
  assert.match(bad(stubRecord(h, { approvals: [] })), /approver/);
  assert.match(bad(stubRecord(h), { ...want, manifestHash: 'x' }), /64 lowercase hex/);
});

test('record: rollback target rules (15.3, 33-a)', () => {
  const prev = hex('2');
  assert.match(
    checkRecord(stubRecord(h, { first_release: false, previous_manifest: '' }), want).join(),
    /rollback target is missing/,
  );
  assert.match(
    checkRecord(stubRecord(h, { first_release: true, previous_manifest: prev }), want).join(),
    /first_release is true/,
  );
  assert.deepEqual(
    checkRecord(stubRecord(h, { first_release: false, previous_manifest: prev }), {
      ...want,
      previousManifestHash: prev,
    }),
    [],
  );
  assert.match(
    checkRecord(stubRecord(h, { first_release: false, previous_manifest: prev }), {
      ...want,
      previousManifestHash: hex('3'),
    }).join(),
    /differs from the record's/,
  );
  assert.deepEqual(
    checkRecord(stubRecord(h, { first_release: false, previous_manifest: '' }), {
      ...want,
      noRollbackTarget: true,
    }),
    [],
  );
});

test('min_client_release: previous released number, or own for the first release; hand edits refused', () => {
  const rec = stubRecord(h, { first_release: false, previous_manifest: hex('2') });
  assert.equal(
    minClientRelease({ record: rec, manifest: m, previousManifest: stubManifest({ number: 20 }) }),
    20,
  );
  assert.equal(minClientRelease({ record: stubRecord(h), manifest: m }), 24);
  assert.throws(() => minClientRelease({ record: rec, manifest: m }), /not available/);
  assert.throws(
    () =>
      minClientRelease({
        record: stubRecord(h),
        manifest: m,
        previousManifest: stubManifest({ number: 20 }),
      }),
    /first release/,
  );
  assert.throws(
    () =>
      minClientRelease({
        record: rec,
        manifest: m,
        previousManifest: stubManifest({ number: 20 }),
        override: 23,
      }),
    /refused/,
  );
  assert.throws(
    () =>
      minClientRelease({
        record: rec,
        manifest: m,
        previousManifest: stubManifest({ number: 30 }),
      }),
    /below 24/,
  );
});

test('new migrations: only additions; an edited applied migration is refused', () => {
  const a = stubManifest({ number: 20, migrations: [['0001.sql', hex('1')]] });
  const b = stubManifest({
    number: 24,
    migrations: [
      ['0001.sql', hex('1')],
      ['0002.sql', hex('2')],
    ],
  });
  assert.deepEqual(
    newMigrations(b, a).map((f) => f.name),
    ['0002.sql'],
  );
  assert.equal(newMigrations(a, a).length, 0);
  assert.equal(newMigrations(b, undefined).length, 2);
  const edited = stubManifest({ number: 24, migrations: [['0001.sql', hex('9')]] });
  assert.throws(() => newMigrations(edited, a), /edited after release/);
});

test('start gate and rollback exemption (DPR-05, DPR-20)', () => {
  assert.deepEqual(startGate({ api: 6, worker: 3 }), []);
  assert.equal(startGate({ api: 7, worker: 3 }).length, 1);
  assert.equal(startGate({ api: 8, worker: 4 }).length, 2);
  assert.deepEqual(startGate({ api: 8, worker: 4, isRollback: true }), []);
});

test('observation verdict: 5 consecutive minutes, per condition (9.2)', () => {
  const ok = { errorRatePct: 0.1, p95LatencySeconds: 0.2, unhealthyHosts: 0, alarmsInAlarm: [] };
  const bad = { ...ok, errorRatePct: 2 };
  assert.equal(observationVerdict([...Array(10).fill(ok)]).abort, false);
  assert.equal(observationVerdict([ok, bad, bad, bad, bad, ok, bad, bad, bad, bad]).abort, false);
  assert.equal(observationVerdict([ok, bad, bad, bad, bad, bad]).abort, true);
  assert.match(
    observationVerdict(Array(5).fill({ ...ok, alarmsInAlarm: ['audit-write-failures'] }))
      .reasons[0],
    /alarm/,
  );
  assert.equal(observationVerdict(Array(5).fill({ ...ok, p95LatencySeconds: 1.5 })).abort, true);
  assert.equal(observationVerdict(Array(5).fill({ ...ok, unhealthyHosts: 1 })).abort, true);
});

test('staging floor (DPR-33, 33-b)', () => {
  assert.equal(stagingMinClient({ manifestNumber: 24, deployedNumber: null }).value, 24);
  assert.equal(stagingMinClient({ manifestNumber: 25, deployedNumber: 24 }).value, 24);
  assert.equal(
    stagingMinClient({ manifestNumber: 24, deployedNumber: 24, storedForManifest: 22 }).value,
    22,
  );
  assert.throws(() => stagingMinClient({ manifestNumber: 24, deployedNumber: 24 }), /missing/);
  assert.throws(
    () => stagingMinClient({ manifestNumber: 20, deployedNumber: 24 }),
    /not a rollback rehearsal/,
  );
  assert.equal(
    stagingMinClient({
      manifestNumber: 20,
      deployedNumber: 24,
      storedForManifest: 18,
      rollbackRehearsal: true,
    }).value,
    18,
  );
  assert.equal(stagingOrderErrors({ deployedNumber: 24, manifestNumber: 20 }).length, 1);
});

test('aws wrapper: read-only mode and the permanent refusals', () => {
  assert.doesNotThrow(() => assertAllowed(['cloudwatch', 'get-metric-data'], true));
  assert.doesNotThrow(() => assertAllowed(['ecs', 'describe-services'], true));
  for (const bad of [
    ['ecs', 'update-service'],
    ['ecs', 'run-task'],
    ['ssm', 'put-parameter'],
    ['s3', 'sync'],
    ['cloudfront', 'create-invalidation'],
  ])
    assert.throws(() => assertAllowed(bad, true), /read-only mode/, bad.join(' '));
  assert.throws(() => assertAllowed(['ecs', 'register-task-definition'], false), /never run/);
  assert.throws(() => assertAllowed(['ecs', 'execute-command'], false), /never run/);
  assert.throws(() => assertAllowed(['iam', 'create-role'], false), /no IAM call/);
  assert.throws(() => assertAllowed(['ecs', 'run-task', '--overrides', '{}'], false), /overrides/);
});

test('task definitions: exactly one revision may match the manifest digest', () => {
  const describe = (arn) => ({
    containerDefinitions: [{ image: arn.endsWith(':2') ? 'img@sha256:x' : 'img@sha256:old' }],
  });
  assert.equal(pickRevision(['a:1', 'a:2'], describe, 'img@sha256:x'), 'a:2');
  assert.throws(() => pickRevision(['a:1'], describe, 'img@sha256:x'), /exactly one is required/);
  assert.throws(() => pickRevision(['a:2', 'b:2'], describe, 'img@sha256:x'), /2 active/);
});

test('migration task outcome', () => {
  assert.equal(taskOutcome({ lastStatus: 'RUNNING' }).done, false);
  assert.equal(taskOutcome({ lastStatus: 'STOPPED', containers: [{ exitCode: 0 }] }).ok, true);
  assert.match(
    taskOutcome({ lastStatus: 'STOPPED', containers: [{ exitCode: 3 }] }).reason,
    /exited 3/,
  );
  assert.match(
    taskOutcome({ lastStatus: 'STOPPED', containers: [{}], stoppedReason: 'oom' }).reason,
    /without an exit code/,
  );
  assert.equal(taskOutcome(undefined).ok, false);
});

test('rollout: worker before api; services need a revisioned ARN', () => {
  assert.deepEqual(ROLLOUT_ORDER, ['worker', 'api']);
  const arn = 'arn:aws:ecs:us-east-1:123456789012:task-definition/ehr-api:7';
  assert.equal(parseServices([`worker=w:${arn}`, `api=a:${arn}`]).api.taskdef, arn);
  assert.throws(() => parseServices([`worker=w:${arn}`]), /api=/);
  assert.throws(
    () => parseServices(['worker=w:ehr-worker', `api=a:${arn}`]),
    /task-definition ARN/,
  );
});

test('backup gate, portal switch, smoke, observe helpers', () => {
  assert.deepEqual(freshnessErrors({ LatestRestorableTime: '2026-11-09T05:50:00Z' }, 30, NOW), []);
  assert.match(
    freshnessErrors({ LatestRestorableTime: '2026-11-09T04:00:00Z' }, 30, NOW)[0],
    /min old/,
  );
  assert.match(freshnessErrors({}, 30, NOW)[0], /LatestRestorableTime/);
  assert.equal(snapshotName('a'.repeat(40)), 'release-aaaaaaaaaaaa-pre-migration');
  const p = switchPlan({ sha: 'a'.repeat(40), portal: 'staff' });
  assert.deepEqual(p.invalidate, ['/staff/index.html', '/staff/release.json']);
  assert.throws(() => switchPlan({ sha: 'abc', portal: 'staff' }), /40 hex/);
  assert.throws(() => expectReleaseJson({ release_number: 23, git_sha12: 'x' }, 24), /expected 24/);
  assert.doesNotThrow(() =>
    expectReleaseJson({ release_number: 24, git_sha12: 'aaaaaaaaaaaa' }, 24),
  );
  assert.equal(metricQueries('app/x/y', 'targetgroup/t/1').length, 4);
  const s = toSample(
    [
      { Id: 'req', Timestamps: ['2026-01-01T00:05:00Z'], Values: [200] },
      { Id: 'e5', Timestamps: ['2026-01-01T00:05:00Z'], Values: [4] },
      { Id: 'p95', Timestamps: ['2026-01-01T00:05:00Z'], Values: [0.4] },
      { Id: 'unh', Timestamps: ['2026-01-01T00:05:00Z'], Values: [0] },
    ],
    [],
    new Date('2026-01-01T00:06:00Z'),
  );
  assert.equal(s.errorRatePct, 2);
  // F-02: a 5xx burst 4 minutes ago must not be counted against the current minute
  const old = toSample(
    [
      {
        Id: 'req',
        Timestamps: ['2026-01-01T00:05:00Z', '2026-01-01T00:04:00Z'],
        Values: [200, 200],
      },
      { Id: 'e5', Timestamps: ['2026-01-01T00:01:00Z'], Values: [90] },
      { Id: 'p95', Timestamps: ['2026-01-01T00:05:00Z'], Values: [0.2] },
      { Id: 'unh', Timestamps: [], Values: [] },
    ],
    [],
    new Date('2026-01-01T00:06:00Z'),
  );
  assert.equal(old.errorRatePct, 0);
  // no recent datapoint at all: all zeros
  assert.equal(
    toSample(
      [{ Id: 'req', Timestamps: ['2026-01-01T00:00:00Z'], Values: [5] }],
      [],
      new Date('2026-01-01T00:06:00Z'),
    ).errorRatePct,
    0,
  );
  // F-03: circuit-breaker rollback shape - old revision PRIMARY, target FAILED
  assert.equal(
    hasFailedTarget(
      [
        { status: 'PRIMARY', taskDefinition: 'arn:old', rolloutState: 'COMPLETED' },
        { status: 'ACTIVE', taskDefinition: 'arn:new', rolloutState: 'FAILED' },
      ],
      'arn:new',
    ),
    true,
  );
  assert.equal(
    hasFailedTarget(
      [{ status: 'PRIMARY', taskDefinition: 'arn:new', rolloutState: 'IN_PROGRESS' }],
      'arn:new',
    ),
    false,
  );
});
