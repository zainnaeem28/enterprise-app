// Milestone M4 registration in the worker (INT03-F01): every M4 job type is defined and has a handler in the composed task table, each
// crontab entry names a task that exists, and the worker's copy of each job list equals the API's (apps/api/dist must be built, as for
// compose.dbtest.ts). No database: the ports that need infrastructure or the API refuse, which is what the table holds until they exist.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createLogger, Queue } from '@ehr/kernel';
import type { JobType, KernelConfig } from '@ehr/kernel';
import { composeTasks, PortNotConfiguredError } from './compose.js';
import { buildWorkerRegistry, WORKER_CRONTAB, WORKER_JOBS } from './job-registry.js';
import { unhandledJobTypes } from './runner.js';

const M4 = [
  'clinical.terminology_load',
  'clinical.on_alert_unacknowledged',
  'clinical.note_sign_reminder',
  'messaging.on_correction_requested',
  'privacy.assemble_export',
  'privacy.check_legal_holds',
  'privacy.expire_packages',
  'reporting.refresh_ops',
];
const ORG = '00000000-0000-7000-8000-0000000000a1';

const table = () => {
  const registry = buildWorkerRegistry();
  return {
    registry,
    tasks: composeTasks({
      cfg: { organisationId: ORG } as unknown as KernelConfig,
      pool: {
        query: () => Promise.reject(new Error('no database')),
        on: () => undefined,
        end: () => Promise.resolve(),
      },
      log: createLogger({ sink: () => undefined }),
      registry,
      queue: new Queue(registry, 'worker'),
    }),
  };
};

test('every M4 job type is defined in the worker registry and has a handler in the composed table', () => {
  const { registry, tasks } = table();
  const defined = registry.list().map((j) => j.name);
  for (const n of M4) {
    assert.ok(defined.includes(n), `${n} not defined`);
    assert.equal(typeof tasks[n], 'function', `${n} has no handler`);
  }
  assert.deepEqual(unhandledJobTypes(registry, tasks), []);
  assert.deepEqual(Object.keys(tasks).sort(), WORKER_JOBS.map((j) => j.name).sort());
});

test('negative control: a table without the M4 handlers reports them unhandled', () => {
  const { registry, tasks } = table();
  const without = Object.fromEntries(Object.entries(tasks).filter(([k]) => !M4.includes(k)));
  assert.deepEqual(unhandledJobTypes(registry, without).sort(), [...M4].sort());
});

test('the crontab holds the privacy expiry and the operations refresh, each with a handler', () => {
  const { tasks } = table();
  const entries = WORKER_CRONTAB.split('\n');
  assert.deepEqual(entries, [
    '50 3 * * * privacy.expire_packages',
    '* * * * * reporting.refresh_ops',
  ]);
  for (const e of entries) assert.equal(typeof tasks[e.split(/\s+/)[5] as string], 'function', e);
});

test('without the API ports and infrastructure the M4 handlers refuse (nothing pretends to work)', async () => {
  const { tasks } = table();
  const h = { job: { id: '1', attempts: 1, max_attempts: 3 } } as never;
  const id = '00000000-0000-7000-8000-000000000001';
  const run = (n: string, p: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve((tasks[n] as (p: unknown, h: never) => unknown)(p, h));
  await assert.rejects(run('reporting.refresh_ops', {}), PortNotConfiguredError);
  await assert.rejects(
    run('messaging.on_correction_requested', { requestId: id, patientId: id }),
    PortNotConfiguredError,
  );
  await assert.rejects(run('privacy.assemble_export', { packageId: id }), PortNotConfiguredError);
  await assert.rejects(run('clinical.terminology_load', { dataset: 'x', version: 'y' }));
});

const API_JOB_LISTS: [string, string, readonly string[]][] = [
  ['clinical/chart/jobs.js', 'CLINICAL_CHART_JOBS', ['clinical.terminology_load']],
  ['clinical/frontdoor/jobs.js', 'FRONTDOOR_JOBS', ['clinical.on_alert_unacknowledged']],
  ['clinical/notes/jobs.js', 'NOTES_JOBS', ['clinical.note_sign_reminder']],
  ['messaging/jobs.js', 'MESSAGING_JOBS', ['messaging.on_correction_requested']],
  [
    'privacy/jobs.js',
    'PRIVACY_JOBS',
    ['privacy.assemble_export', 'privacy.check_legal_holds', 'privacy.expire_packages'],
  ],
  ['reporting/jobs.js', 'REPORTING_JOBS', ['reporting.refresh_ops']],
];

for (const [file, exportName, names] of API_JOB_LISTS)
  test(`the worker's ${names.join(', ')} equal the API's ${exportName}`, async () => {
    const url = pathToFileURL(
      new URL(`../../api/dist/src/modules/${file}`, import.meta.url).pathname,
    ).href;
    const api = ((await import(url)) as Record<string, readonly JobType[]>)[
      exportName
    ] as readonly JobType[];
    const mine = WORKER_JOBS.filter((j) => names.includes(j.name));
    assert.deepEqual(mine, [...api]);
  });
