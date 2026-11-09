import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowed } from '../lib/aws.mjs';
import { choosePitrTime, staleTargets, targetIdentifier, MIN_AGE_SECONDS } from '../lib/plan.mjs';
import { checkRestoreRecord } from '../lib/record.mjs';
import { restoreArgs, planRestore } from '../start-restore.mjs';
import { taskVerdict } from '../run-checks.mjs';
import { deleteArgs } from '../teardown.mjs';

const good = () =>
  restoreArgs({
    source: 'ehr-prod', target: 'rt-20261109-1-1', mode: 'pitr', time: new Date('2026-11-08T10:00:00Z'), subnetGroup: 'rt-sg',
    securityGroup: 'sg-1', kmsKey: 'arn:aws:kms:us-east-2:1:key/k', instanceClass: 'db.r6g.large', runId: '1', ageSeconds: 3600, requestedEpoch: 1,
  });

test('the restore call the script builds passes its own allow-list', () => {
  const a = good();
  assert.doesNotThrow(() => assertAllowed(a.map((x) => x)));
});

test('allow-list refuses a restore that is public, IAM-enabled, untagged or outside the prefix', () => {
  const a = good();
  const without = (flag) => a.filter((x) => x !== flag);
  assert.throws(() => assertAllowed(without('--no-publicly-accessible')), /publicly/);
  assert.throws(() => assertAllowed(without('--no-enable-iam-database-authentication')), /IAM/);
  assert.throws(() => assertAllowed(a.filter((x) => x !== 'Key=purpose,Value=restore-test')), /tagged/);
  const renamed = [...a];
  renamed[renamed.indexOf('--target-db-instance-identifier') + 1] = 'ehr-prod-copy';
  assert.throws(() => assertAllowed(renamed), /must start with "rt-"/);
});

test('allow-list refuses everything outside the restore test', () => {
  for (const args of [
    ['iam', 'create-role'], ['ecs', 'register-task-definition'], ['ecs', 'execute-command'], ['rds', 'modify-db-instance'],
    ['rds', 'restore-db-instance-from-db-snapshot'], ['s3api', 'put-object'], ['secretsmanager', 'get-secret-value'], ['ssm', 'put-parameter'],
  ]) assert.throws(() => assertAllowed(args), /never run/, args.join(' '));
  assert.throws(() => assertAllowed(['ecs', 'run-task', '--overrides', '{}']), /overrides/);
  assert.throws(() => assertAllowed(['ssm', 'get-parameter', '--name', '/approved/release']), /only \/approved\/restore-test/);
  assert.throws(() => assertAllowed(['s3api', 'get-object', '--bucket', 'b', '--key', 'documents/patient.pdf']), /result documents/);
  assert.throws(() => assertAllowed(['s3api', 'get-object', '--bucket', 'b', '--key', 'restore-test/results/../../x.json']), /result documents/);
  assert.doesNotThrow(() => assertAllowed(['s3api', 'get-object', '--bucket', 'b', '--key', 'restore-test/results/20261109-1-1.json']));
});

test('delete is limited to rt- targets, without final snapshot, with automated backups removed', () => {
  assert.doesNotThrow(() => assertAllowed(deleteArgs('rt-20261109-1-1')));
  assert.throws(() => assertAllowed(deleteArgs('ehr-production')), /not a restore-test target/);
  assert.throws(() => assertAllowed(['rds', 'delete-db-instance', '--db-instance-identifier', 'rt-1', '--delete-automated-backups']), /final snapshot/);
});

test('PITR time is inside the last 7 days, the restorable range, and not in the last 5 minutes', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const latest = '2026-11-09T11:59:00Z';
  const lowest = choosePitrTime({ latestRestorable: latest, now, rand: () => 0 });
  const highest = choosePitrTime({ latestRestorable: latest, now, rand: (n) => n - 1 });
  assert.equal(lowest.toISOString(), '2026-11-02T12:00:00.000Z');
  assert.equal(highest.getTime(), now.getTime() - MIN_AGE_SECONDS * 1000);
  const earliest = choosePitrTime({ latestRestorable: latest, earliestRestorable: '2026-11-08T00:00:00Z', now, rand: () => 0 });
  assert.equal(earliest.toISOString(), '2026-11-08T00:00:00.000Z');
  assert.throws(() => choosePitrTime({ latestRestorable: undefined, now }), /not available/);
  assert.throws(() => choosePitrTime({ latestRestorable: latest, earliestRestorable: '2026-11-09T11:59:30Z', now }), /empty/);
});

test('latest mode restores to LatestRestorableTime and reports the data age', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const p = planRestore({ instance: { LatestRestorableTime: '2026-11-09T11:57:00Z' }, mode: 'latest', now });
  assert.equal(p.ageSeconds, 180);
  assert.ok(good().includes('Key=restore-age-seconds,Value=3600'));
  assert.ok(restoreArgs({ source: 's', target: 'rt-1', mode: 'latest', subnetGroup: 'g', securityGroup: 's', kmsKey: 'k', instanceClass: 'c', runId: '1', ageSeconds: 1, requestedEpoch: 1 }).includes('--use-latest-restorable-time'));
});

test('target identifiers are rt-prefixed and reject odd run ids', () => {
  assert.equal(targetIdentifier({ now: new Date('2026-11-09T00:00:00Z'), runId: '42', attempt: '2' }), 'rt-20261109-42-2');
  assert.throws(() => targetIdentifier({ runId: 'abc' }), /cannot build/);
});

test('stale sweep selects only old, tagged, rt- instances', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const tag = [{ Key: 'purpose', Value: 'restore-test' }];
  const list = [
    { DBInstanceIdentifier: 'rt-old', InstanceCreateTime: '2026-11-08T11:00:00Z', TagList: tag },
    { DBInstanceIdentifier: 'rt-new', InstanceCreateTime: '2026-11-09T11:00:00Z', TagList: tag },
    { DBInstanceIdentifier: 'rt-untagged', InstanceCreateTime: '2026-11-01T00:00:00Z', TagList: [] },
    { DBInstanceIdentifier: 'ehr-production', InstanceCreateTime: '2026-01-01T00:00:00Z', TagList: tag },
  ];
  assert.deepEqual(staleTargets(list, { now }), ['rt-old']);
});

test('record check: valid, expired, wrong environment, wrong action, other record kinds', () => {
  const rec = (o = {}) => JSON.stringify({ state: 'approved', environment: 'production', permitted_actions: ['restore-test'], approvals: ['a'], not_before: '2026-11-01T00:00:00Z', expires: '2027-10-31T00:00:00Z', ...o });
  const now = new Date('2026-11-09T00:00:00Z');
  assert.deepEqual(checkRestoreRecord(rec(), { now }), []);
  assert.match(checkRestoreRecord(rec({ expires: '2026-11-08T00:00:00Z' }), { now }).join(), /expired/);
  assert.match(checkRestoreRecord(rec({ environment: 'staging' }), { now }).join(), /environment/);
  assert.match(checkRestoreRecord(rec({ permitted_actions: ['migrate', 'rollout'] }), { now }).join(), /permitted_actions/);
  assert.match(checkRestoreRecord(rec({ state: 'empty' }), { now }).join(), /not "approved"/);
  assert.match(checkRestoreRecord(rec({ expires: '2030-01-01T00:00:00Z' }), { now }).join(), /one year/);
  assert.match(checkRestoreRecord('not json', { now }).join(), /not valid JSON/);
});

test('task verdict: exit 0 only', () => {
  assert.equal(taskVerdict({ containers: [{ exitCode: 0 }] }).ok, true);
  assert.equal(taskVerdict({ containers: [{ exitCode: 1 }] }).ok, false);
  assert.equal(taskVerdict({ containers: [{}] }).ok, false);
  assert.equal(taskVerdict({ containers: [] }).ok, false);
  assert.equal(taskVerdict(undefined).ok, false);
});

test('consecutive failures: two in a row stop releases; a success resets; manual runs and cancellations do not count', async () => {
  const { consecutiveFailures } = await import('../consecutive-failures.mjs');
  const r = (conclusion, day, event = 'schedule') => ({ conclusion, createdAt: `2026-11-${day}T00:00:00Z`, event });
  assert.deepEqual(consecutiveFailures([r('failure', '09'), r('failure', '02'), r('success', '01')]), { consecutive: 2, stopReleases: true, examined: 3 });
  assert.equal(consecutiveFailures([r('failure', '09'), r('success', '02'), r('failure', '01')]).stopReleases, false);
  assert.equal(consecutiveFailures([r('failure', '09'), r('failure', '08', 'workflow_dispatch'), r('success', '02')]).consecutive, 1);
  assert.equal(consecutiveFailures([r('failure', '09'), r('cancelled', '08'), r('failure', '02')]).stopReleases, true);
  assert.equal(consecutiveFailures([]).stopReleases, false);
});
