import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLines, runOnce, runTaskArgs } from '../run-task.mjs';
import { cleanup } from '../cleanup.mjs';

const cfg = {
  env: 'staging',
  runId: '99',
  cluster: 'c',
  taskDefinitionArn: 'arn:td',
  subnets: ['s1', 's2'],
  securityGroup: 'sg',
  container: 'bootstrap',
  logGroup: 'g',
  logStreamPrefix: 'p',
};

test('RunTask has no overrides, no exec, and the task definition ARN from configuration', () => {
  const a = runTaskArgs(cfg);
  assert.ok(!a.some((x) => /overrides/.test(x)));
  assert.ok(a.includes('--no-enable-execute-command'));
  assert.equal(a[a.indexOf('--task-definition') + 1], 'arn:td');
  assert.match(a.join(' '), /assignPublicIp=DISABLED/);
});
test('runOnce returns the container exit code and fails on a RunTask failure or a timeout', async () => {
  const calls = [];
  const call = (argv) => {
    calls.push(argv[1]);
    if (argv[1] === 'run-task') return { tasks: [{ taskArn: 'arn:aws:ecs:r:1:task/c/abc' }] };
    return { tasks: [{ lastStatus: 'STOPPED', containers: [{ name: 'bootstrap', exitCode: 3 }] }] };
  };
  assert.deepEqual(await runOnce(cfg, { call, wait: async () => {} }), {
    taskId: 'abc',
    exitCode: 3,
    stoppedReason: '',
  });
  await assert.rejects(
    runOnce(cfg, { call: () => ({ failures: [{ reason: 'MISSING' }] }) }),
    /RunTask failed: MISSING/,
  );
  const never = (argv) =>
    argv[1] === 'run-task'
      ? { tasks: [{ taskArn: 'a/b' }] }
      : { tasks: [{ lastStatus: 'RUNNING' }] };
  await assert.rejects(
    runOnce(cfg, { call: never, wait: async () => {}, timeoutSeconds: 20 }),
    /did not stop/,
  );
});
test('log reading follows the forward token and stops when it repeats', () => {
  const pages = [
    { events: [{ message: 'a' }], nextForwardToken: 't1' },
    { events: [{ message: 'b' }], nextForwardToken: 't2' },
    { events: [], nextForwardToken: 't2' },
  ];
  let i = 0;
  assert.deepEqual(readLines(cfg, 'abc', { call: () => pages[i++] }), ['a', 'b']);
});

const names = ['bootstrap/staging/token/slot-1', 'bootstrap/staging/token/slot-2'];
test('cleanup waits for the expiry, force-deletes, and confirms every secret is gone', async () => {
  let t = 1000;
  const waits = [];
  const log = [];
  const call = (argv) => {
    log.push(argv[1]);
    if (argv[1] === 'describe-secret') {
      const e = new Error('x');
      e.stderr = 'ResourceNotFoundException';
      throw e;
    }
    assert.ok(argv.includes('--force-delete-without-recovery'));
    return {};
  };
  const failed = await cleanup({
    env: 'staging',
    names,
    waitUntil: 200_000,
    now: () => t,
    wait: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    call,
  });
  assert.deepEqual(failed, []);
  assert.ok(waits.length >= 4 && waits.every((w) => w <= 60_000) && t >= 200_000);
  assert.deepEqual(log, ['delete-secret', 'describe-secret', 'delete-secret', 'describe-secret']);
});
test('cleanup reports a secret that cannot be deleted or still exists, and treats not-found as done', async () => {
  const call = (argv) => {
    if (argv[1] === 'delete-secret' && argv.includes(names[0])) throw new Error('AccessDenied');
    if (argv[1] === 'describe-secret') return {}; // still there
    return {};
  };
  assert.deepEqual(await cleanup({ env: 'staging', names, call }), names);
  const nf = () => {
    const e = new Error('x');
    e.stderr = 'ResourceNotFoundException';
    throw e;
  };
  assert.deepEqual(await cleanup({ env: 'staging', names, call: nf }), []);
});
