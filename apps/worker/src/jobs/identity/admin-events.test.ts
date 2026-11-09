// `identity.admin_event` without a database: the transaction is a recording fake. The real-database proof (audit row, alert, notice per kind)
// is in identity.dbtest.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KernelDb } from '@ehr/kernel';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAdminEvent, type ComplianceAlertInput } from './admin-events.js';
import { ADMIN_EVENT_KINDS } from './jobs.js';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const P = '00000000-0000-7000-8000-0000000000b1';

const RUN = '00000000-0000-7000-8000-0000000000d1';
const RUN_ROW = {
  mode: 'create',
  run_ref: 'gh-run-42',
  ticket_ref: 'CHG-1',
  token_expires_at: new Date('2026-11-09T12:30:00Z'),
  principal_ids: [P, '00000000-0000-7000-8000-0000000000b2'],
};

function harness(activeCredentials = 2, runRow: unknown = undefined) {
  const sql: string[] = [];
  const alerts: ComplianceAlertInput[] = [];
  const notices: Record<string, unknown>[] = [];
  const db = {
    withScope: (_s: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: (text: string) => {
          sql.push(text);
          if (text.includes('count(*)'))
            return Promise.resolve({ rows: [{ n: activeCredentials }] });
          if (text.includes('identity.bootstrap_run'))
            return Promise.resolve({ rows: runRow === undefined ? [] : [runRow] });
          return Promise.resolve({ rows: [] });
        },
      }),
  } as unknown as KernelDb;
  return {
    sql,
    alerts,
    notices,
    deps: {
      db,
      orgId: ORG,
      alerts: {
        raise: (_tx: unknown, i: ComplianceAlertInput) => {
          alerts.push(i);
          return Promise.resolve();
        },
      },
      notice: {
        notify: (n: Record<string, unknown>) => {
          notices.push(n);
          return Promise.resolve();
        },
      },
    },
  };
}

test('credential_enrolled: audit row, alert and notice', async () => {
  const h = harness();
  const r = await runAdminEvent(
    h.deps as never,
    { kind: 'credential_enrolled', principalId: P },
    'j',
    'ref',
  );
  assert.deepEqual(r, { audited: true, alerted: true, activeCredentials: null });
  assert.ok(h.sql.some((s) => s.includes('INSERT INTO audit.event')));
  assert.equal(h.alerts[0]?.type, 'privileged_change');
  assert.equal(h.alerts[0]?.severity, 'high');
  assert.equal(h.notices.length, 1);
});

test('counter_regression with one key left is critical', async () => {
  const h = harness(1);
  const r = await runAdminEvent(
    h.deps as never,
    { kind: 'counter_regression', principalId: P },
    'j',
    'ref',
  );
  assert.equal(r.activeCredentials, 1);
  assert.equal(h.alerts[0]?.severity, 'critical');
});

test('credential_revoked with two live keys stays high; with fewer than two it is critical', async () => {
  const two = harness(2);
  await runAdminEvent(two.deps as never, { kind: 'credential_revoked', principalId: P }, 'j', 'r');
  assert.equal(two.alerts[0]?.severity, 'high');
  const none = harness(0);
  await runAdminEvent(none.deps as never, { kind: 'credential_revoked', principalId: P }, 'j', 'r');
  assert.equal(none.alerts[0]?.severity, 'critical');
});

test('a role_change_requested is neither audited nor alerted here (the API wrote its audit row)', async () => {
  const h = harness();
  const r = await runAdminEvent(
    h.deps as never,
    { kind: 'role_change_requested', principalId: P },
    'j',
    'r',
  );
  assert.deepEqual(r, { audited: false, alerted: false, activeCredentials: null });
  assert.equal(h.alerts.length, 0);
  assert.equal(h.notices.length, 0);
});

test('handle_failures writes a denied audit row', async () => {
  const h = harness();
  await runAdminEvent(h.deps as never, { kind: 'handle_failures', principalId: P }, 'j', 'r');
  assert.ok(h.sql.some((s) => s.includes('audit.event')));
});

test('a failing notice fails the job (retry, then dead-letter) instead of passing silently', async () => {
  const h = harness();
  const deps = {
    ...h.deps,
    notice: { notify: () => Promise.reject(new Error('no mail channel')) },
  };
  await assert.rejects(
    runAdminEvent(deps as never, { kind: 'credential_enrolled', principalId: P }, 'j', 'r'),
  );
});

test('bad payloads are refused', async () => {
  const h = harness();
  await assert.rejects(runAdminEvent(h.deps as never, { kind: 'nope', principalId: P }, 'j', 'r'));
  await assert.rejects(
    runAdminEvent(h.deps as never, { kind: 'credential_enrolled', principalId: 'x' }, 'j', 'r'),
  );
});

test('bootstrap_run (INT04-F02b): reads the run row, raises one high privileged_change alert, sends one notice with the run facts, writes no audit row', async () => {
  const h = harness(2, RUN_ROW);
  const r = await runAdminEvent(h.deps as never, { kind: 'bootstrap_run', runId: RUN }, 'j', 'ref');
  assert.deepEqual(r, { audited: false, alerted: true, activeCredentials: null });
  assert.ok(!h.sql.some((s) => s.includes('INSERT INTO audit.event')));
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0]?.type, 'privileged_change');
  assert.equal(h.alerts[0]?.severity, 'high');
  assert.equal(h.alerts[0]?.resourceId, RUN);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.notices[0], {
    kind: 'bootstrap_run',
    jobRef: 'ref',
    run: {
      mode: 'create',
      runId: RUN,
      runRef: 'gh-run-42',
      ticketRef: 'CHG-1',
      tokenExpiresAt: '2026-11-09T12:30:00.000Z',
      principalIds: RUN_ROW.principal_ids,
    },
  });
});

test('bootstrap_run: a missing run row or a bad run id throws, so the job retries and nothing is sent', async () => {
  const none = harness(2, undefined);
  await assert.rejects(
    runAdminEvent(none.deps as never, { kind: 'bootstrap_run', runId: RUN }, 'j', 'r'),
    /not found/,
  );
  assert.equal(none.notices.length, 0);
  assert.equal(none.alerts.length, 0);
  const bad = harness(2, RUN_ROW);
  await assert.rejects(
    runAdminEvent(bad.deps as never, { kind: 'bootstrap_run', runId: 'x' }, 'j', 'r'),
    /bad runId/,
  );
});

test("the worker's ADMIN_EVENT_KINDS equal the API's (apps/api/dist must be built)", async () => {
  const url = pathToFileURL(
    fileURLToPath(
      new URL('../../../../api/dist/src/modules/identity/admin/jobs.js', import.meta.url),
    ),
  ).href;
  const api = ((await import(url)) as { ADMIN_EVENT_KINDS: readonly string[] }).ADMIN_EVENT_KINDS;
  assert.deepEqual([...api], [...ADMIN_EVENT_KINDS]);
  assert.ok(ADMIN_EVENT_KINDS.includes('bootstrap_run'));
});
