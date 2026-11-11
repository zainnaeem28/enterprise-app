// Milestone M4 registration in the worker (INT03-F01): every M4 job type is defined and has a handler in the composed task table, each
// crontab entry names a task that exists, and the worker's copy of each job list equals the API's (apps/api/dist must be built, as for
// compose.dbtest.ts). No database: the ports that need infrastructure or the API refuse, which is what the table holds until they exist.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createLogger, JobRegistry, Queue } from '@ehr/kernel';
import type { JobType, KernelConfig } from '@ehr/kernel';
import { composeTasks, PortNotConfiguredError } from './compose.js';
import { buildWorkerRegistry, WORKER_CRONTAB, WORKER_JOBS } from './job-registry.js';
import { parseCrontab } from 'graphile-worker';
import { fromCrontabTaskId, unhandledJobTypes } from './runner.js';

const M4 = [
  'clinical.terminology_load',
  'clinical.on_alert_unacknowledged',
  'clinical.on_questionnaire_red_flag',
  'clinical.note_sign_reminder',
  'messaging.on_correction_requested',
  'notifications.escalate_alert',
  'privacy.assemble_export',
  'privacy.check_legal_holds',
  'privacy.execute_deletion',
  'privacy.send_deletion_statement',
  'privacy.expire_packages',
  'privacy.retention_purge',
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

test('the crontab holds the privacy expiry and retention, the operations refresh and the audit anchor jobs, each with a handler (SEC05-F01)', () => {
  const { tasks } = table();
  const entries = WORKER_CRONTAB.split('\n');
  assert.deepEqual(entries, [
    '50 3 * * * privacy/expire_packages',
    '10 4 * * * privacy/retention_purge',
    '* * * * * reporting/refresh_ops',
    '* * * * * audit/anchor',
    '* * * * * audit/archive_anchors',
    '10 3 * * * audit/verify_anchors',
  ]);
  for (const e of entries)
    assert.equal(typeof tasks[fromCrontabTaskId(e.split(/\s+/)[5] as string)], 'function', e);
});

test('INT03-F11: graphile-worker parseCrontab accepts WORKER_CRONTAB and every entry maps to a registered task', () => {
  const { registry, tasks } = table();
  const items = parseCrontab(WORKER_CRONTAB);
  assert.equal(items.length, 6);
  const registered = registry.list().map((j) => j.name);
  for (const item of items) {
    const name = fromCrontabTaskId(item.task);
    assert.ok(registered.includes(name), `${item.task} -> ${name} is not a registered job type`);
    assert.equal(typeof tasks[name], 'function', name);
  }
});

test('INT03-F11 negative control: a dotted task id is rejected by the real parser', () => {
  assert.throws(() => parseCrontab('* * * * * reporting.refresh_ops'), /Invalid command/);
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
  [
    'clinical/frontdoor/jobs.js',
    'FRONTDOOR_JOBS',
    ['clinical.on_alert_unacknowledged', 'clinical.on_questionnaire_red_flag'],
  ],
  ['clinical/notes/jobs.js', 'NOTES_JOBS', ['clinical.note_sign_reminder']],
  [
    'notifications/alerts/jobs.js',
    'ALERT_JOBS',
    [
      'notifications.escalate_alert',
      'notifications.on_btg_opened',
      'notifications.on_anchor_mismatch',
      'notifications.on_kill_switch_used',
    ],
  ],
  ['identity/admin/jobs.js', 'IDENTITY_ADMIN_JOBS', ['identity.admin_event']],
  ['messaging/jobs.js', 'MESSAGING_JOBS', ['messaging.on_correction_requested']],
  [
    'privacy/jobs.js',
    'PRIVACY_JOBS',
    [
      'privacy.assemble_export',
      'privacy.check_legal_holds',
      'privacy.execute_deletion',
      'privacy.send_deletion_statement',
      'privacy.expire_packages',
      'privacy.retention_purge',
    ],
  ],
  ['reporting/jobs.js', 'REPORTING_JOBS', ['reporting.refresh_ops']],
  ['patient/jobs.js', 'PATIENT_JOBS', ['patient.verify_staff_scope', 'patient.purge_match_checks']],
  ['patient/merge/jobs.js', 'MERGE_JOBS', ['patient.execute_merge']],
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

test('every event the API or the worker publishes has at least one handler registered (SEC05-F03)', () => {
  const { registry } = table();
  for (const e of ['audit.btg_opened', 'audit.anchor_mismatch', 'identity.kill_switch_used'])
    assert.deepEqual(registry.handlersOf(e), ['notifications'], e);
  for (const j of WORKER_JOBS.filter((x) => x.jobClass === 'handler'))
    assert.ok(
      registry.list().some((x) => x.name === j.name),
      j.name,
    );
});

test('every admin job is registered with a handler in the composed table (INT04-F02)', () => {
  const { registry, tasks } = table();
  for (const n of [
    'identity.admin_event',
    'audit.anchor',
    'audit.archive_anchors',
    'audit.verify_anchors',
    'audit.export',
    'integration_core.apply_secret',
    'notifications.on_btg_opened',
    'notifications.on_anchor_mismatch',
    'notifications.on_kill_switch_used',
  ]) {
    if (!registry.list().some((j) => j.name === n)) continue;
    assert.equal(typeof tasks[n], 'function', n);
  }
  assert.deepEqual(unhandledJobTypes(registry, tasks), []);
});

test('every job type the API path may publish exists in the worker registry, with the same definition (F01-R1)', async () => {
  const url = pathToFileURL(
    new URL('../../api/dist/src/composition.js', import.meta.url).pathname,
  ).href;
  const api = ((await import(url)) as { API_PATH_JOBS: readonly JobType[] }).API_PATH_JOBS;
  const reg = new JobRegistry();
  for (const j of api) reg.defineJob(j);
  const publishable = new Set(
    reg
      .list()
      .filter((j) => j.apiEnqueue)
      .map((j) => j.name),
  );
  const mine = new Map(WORKER_JOBS.map((j) => [j.name, j]));
  const missing = api
    .filter((j) => publishable.has(j.name) && !mine.has(j.name))
    .map((j) => j.name);
  assert.deepEqual(missing, []);
  assert.ok(publishable.has('patient.execute_merge'));
  assert.ok(publishable.has('notifications.escalate_alert'));
  for (const j of api) if (mine.has(j.name)) assert.deepEqual(mine.get(j.name), j, j.name);
});
