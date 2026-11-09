// `identity.admin_event` without a database: the transaction is a recording fake. The real-database proof (audit row, alert, notice per kind)
// is in identity.dbtest.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KernelDb } from '@ehr/kernel';
import { runAdminEvent, type ComplianceAlertInput } from './admin-events.js';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const P = '00000000-0000-7000-8000-0000000000b1';

function harness(activeCredentials = 2) {
  const sql: string[] = [];
  const alerts: ComplianceAlertInput[] = [];
  const notices: { kind: string; principalId: string }[] = [];
  const db = {
    withScope: (_s: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: (text: string) => {
          sql.push(text);
          if (text.includes('count(*)'))
            return Promise.resolve({ rows: [{ n: activeCredentials }] });
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
        notify: (n: { kind: string; principalId: string }) => {
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
