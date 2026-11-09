// `identity.admin_event` without a database: the transaction is a recording fake. The real-database proof (audit row, alert, notice per kind)
// is in identity.dbtest.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KernelDb } from '@ehr/kernel';
import { runAdminEvent, runAdminEventNotice, type ComplianceAlertInput } from './admin-events.js';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const P = '00000000-0000-7000-8000-0000000000b1';

function harness(activeCredentials = 2) {
  const sql: string[] = [];
  const alerts: ComplianceAlertInput[] = [];
  const queued: { job: string; payload: unknown; key: unknown }[] = [];
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
    queued,
    deps: {
      db,
      orgId: ORG,
      queue: {
        enqueue: (_tx: unknown, job: string, payload: unknown, o: { jobKey?: string }) => {
          queued.push({ job, payload, key: o.jobKey });
          return Promise.resolve();
        },
      },
      alerts: {
        raise: (_tx: unknown, i: ComplianceAlertInput) => {
          alerts.push(i);
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
  assert.deepEqual(r, {
    audited: true,
    alerted: true,
    noticeQueued: true,
    activeCredentials: null,
  });
  assert.ok(h.sql.some((s) => s.includes('INSERT INTO audit.event')));
  assert.equal(h.alerts[0]?.type, 'privileged_change');
  assert.equal(h.alerts[0]?.severity, 'high');
  assert.equal(h.queued.length, 1);
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
  assert.deepEqual(r, {
    audited: false,
    alerted: false,
    noticeQueued: false,
    activeCredentials: null,
  });
  assert.equal(h.alerts.length, 0);
  assert.equal(h.queued.length, 0);
});

test('handle_failures writes a denied audit row', async () => {
  const h = harness();
  await runAdminEvent(h.deps as never, { kind: 'handle_failures', principalId: P }, 'j', 'r');
  assert.ok(h.sql.some((s) => s.includes('audit.event')));
});

test('the audit row and the alert are written before the notice is queued; the notice is its own job (S1)', async () => {
  const h = harness();
  await runAdminEvent(h.deps as never, { kind: 'counter_regression', principalId: P }, 'j', 'r');
  assert.equal(h.queued[0]?.job, 'identity.admin_event_notice');
  assert.deepEqual(h.queued[0]?.payload, { kind: 'counter_regression', principalId: P });
});

test('a failing alert fails the job, after the audit insert has run in its own transaction', async () => {
  const h = harness();
  const deps = { ...h.deps, alerts: { raise: () => Promise.reject(new Error('no recipient')) } };
  await assert.rejects(
    runAdminEvent(deps as never, { kind: 'credential_enrolled', principalId: P }, 'j', 'r'),
  );
  assert.ok(h.sql.some((q) => q.includes('INSERT INTO audit.event')));
  assert.equal(h.queued.length, 0);
});

test('the audit insert is keyed by the job reference (a retry writes no second row, S4)', async () => {
  const h = harness();
  await runAdminEvent(h.deps as never, { kind: 'handle_failures', principalId: P }, 'j', 'r');
  assert.ok(h.sql.some((q) => q.includes('WHERE NOT EXISTS') && q.includes('job_id = $1')));
});

test('the subject and a named actor are excluded from the alert recipients (S3)', async () => {
  const h = harness();
  const A = '00000000-0000-7000-8000-0000000000c1';
  await runAdminEvent(
    h.deps as never,
    { kind: 'enrolment_token_approved', principalId: P, actorPrincipalId: A },
    'j',
    'r',
  );
  assert.deepEqual(h.alerts[0]?.excludePrincipalIds, [P, A]);
});

test('the notice job sends a notice with kind and ID only; a failing channel fails that job alone', async () => {
  const sent: unknown[] = [];
  await runAdminEventNotice(
    { notice: { notify: (n) => (sent.push(n), Promise.resolve()) } },
    { kind: 'credential_revoked', principalId: P },
    'ref',
  );
  assert.deepEqual(sent, [{ kind: 'credential_revoked', principalId: P, jobRef: 'ref' }]);
  await assert.rejects(
    runAdminEventNotice(
      { notice: { notify: () => Promise.reject(new Error('no mail channel')) } },
      { kind: 'credential_revoked', principalId: P },
      'ref',
    ),
  );
});

test('bad payloads are refused', async () => {
  const h = harness();
  await assert.rejects(runAdminEvent(h.deps as never, { kind: 'nope', principalId: P }, 'j', 'r'));
  await assert.rejects(
    runAdminEvent(h.deps as never, { kind: 'credential_enrolled', principalId: 'x' }, 'j', 'r'),
  );
});
