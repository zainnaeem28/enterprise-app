import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from 'graphile-worker';
import { createLogger } from '@ehr/kernel';
import { wrapTask } from './runner.js';

async function lines(attempts: number, maxAttempts: number): Promise<Record<string, unknown>[]> {
  const out: string[] = [];
  const log = createLogger({ sink: (l) => out.push(l) });
  const task: Task = async () => {
    throw new Error('patient Jane Doe 1980-01-01');
  };
  const helpers = { job: { id: '42', attempts, max_attempts: maxAttempts } };
  await assert.rejects(async () =>
    wrapTask('telehealth.close_meeting', task, log)({}, helpers as never),
  );
  return out.map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('the last failed attempt logs one job_dead line with id and type only', async () => {
  const dead = (await lines(8, 8)).filter((l) => l.event === 'job_dead');
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.jobType, 'telehealth.close_meeting');
  assert.equal(dead[0]?.job, '42');
  assert.ok(!JSON.stringify(dead[0]).includes('Jane'));
});

test('a failure with attempts left is not a dead job', async () => {
  assert.equal((await lines(3, 8)).filter((l) => l.event === 'job_dead').length, 0);
});
