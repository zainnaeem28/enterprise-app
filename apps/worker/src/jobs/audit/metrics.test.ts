import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KernelDb, Logger, Queue } from '@ehr/kernel';
import { createAuditTasks } from './index.js';
import { emfMetricSink } from './metrics.js';

test('emfMetricSink writes one CloudWatch EMF line with a number and no identifier', () => {
  const lines: string[] = [];
  emfMetricSink(
    (l) => lines.push(l),
    'EHR/Test',
    () => 1,
  )?.gauge('AuditAnchorLateSeconds', 42);
  const o = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(o['AuditAnchorLateSeconds'], 42);
  assert.deepEqual(Object.keys(o).sort(), ['AuditAnchorLateSeconds', '_aws']);
});

// The anchor task emits the gauge on every outcome (R1, HEAAA-432 D-3): anchored, up_to_date and locked.
function run(outcome: 'anchored' | 'up_to_date' | 'locked') {
  const gauges: [string, number][] = [];
  const db = {
    withScope: (_s: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: (text: string) => {
          if (text.includes('pg_try_advisory_xact_lock'))
            return Promise.resolve({ rows: [{ ok: outcome !== 'locked' }] });
          if (
            text.includes('FROM audit.anchor WHERE organisation_id = $1::uuid ORDER BY to_ts DESC')
          )
            return Promise.resolve({
              rows: [
                {
                  id: '1',
                  hash: Buffer.alloc(32),
                  row_count: 0,
                  from_text: '2026-01-01T00:00:00.000000Z',
                  to_text: new Date(Date.now() + 3_600_000).toISOString().replace('Z', '000Z'),
                  from_ts: new Date(),
                  to_ts: new Date(),
                },
              ],
            });
          if (text.includes('AS late')) return Promise.resolve({ rows: [{ late: 301.5 }] });
          return Promise.resolve({ rows: [{ t: null, n: '0' }] });
        },
      }),
  } as unknown as KernelDb;
  const tasks = createAuditTasks({
    db,
    queue: {} as Queue,
    sink: {} as never,
    archive: {} as never,
    orgId: '00000000-0000-7000-8000-0000000000a1',
    log: { warn: () => undefined, error: () => undefined } as unknown as Logger,
    metrics: { gauge: (n, v) => gauges.push([n, v]) },
  });
  return { gauges, task: tasks['audit.anchor'] as (p: unknown, h: unknown) => Promise<void> };
}

for (const outcome of ['up_to_date', 'locked'] as const)
  test(`audit.anchor emits AuditAnchorLateSeconds on a ${outcome} run`, async () => {
    const { gauges, task } = run(outcome);
    await task({}, {});
    assert.deepEqual(gauges, [['AuditAnchorLateSeconds', 301.5]]);
  });
