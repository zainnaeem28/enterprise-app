import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRestoreCheck } from '../task/run.mjs';
import * as C from '../task/checks.mjs';
import { validateResult } from '../lib/result.mjs';

const CANARY = 'PHI-CANARY-Jane-Doe';

/** A fake database: answers the task's queries from a table of handlers; records every statement. */
function fakeDb({ failOn, rolesToReset = ['app_api', 'app_worker'], audit = true, anchors, immutableDigest = 'same' } = {}) {
  const log = [];
  const query = async (sql, params) => {
    log.push(sql);
    if (failOn && failOn.test(sql)) {
      const e = new Error(`syntax error near ${CANARY}`);
      e.code = '42601';
      throw e;
    }
    if (/FROM pg_roles WHERE rolcanlogin/.test(sql)) return { rows: rolesToReset.map((rolname) => ({ rolname })) };
    if (/rds_iam/.test(sql) && /count/.test(sql)) return { rows: [{ n: 0 }] };
    if (/rds_iam/.test(sql)) return { rows: [] };
    if (/FROM migration.schema_migration ORDER BY/.test(sql)) return { rows: [{ v: '1', h: 'aa' }, { v: '2', h: 'bb' }] };
    if (/to_regclass\('audit.anchor'\)/.test(sql)) return { rows: [{ ok: audit }] };
    if (/FROM audit.anchor a/.test(sql)) return { rows: anchors ?? [{ id: '1', prev: '00', h: 'h1', n: '5', from_ts: '2026-11-01', to_ts: '2026-11-02', actual: '5' }, { id: '2', prev: 'h1', h: 'h2', n: '3', from_ts: '2026-11-02', to_ts: '2026-11-03', actual: '3' }] };
    if (/to_regclass\(\$1\)/.test(sql)) return { rows: [{ ok: params[0] !== 'kernel.reference_data_version' }] };
    if (/sum\(hashtextextended/.test(sql)) return { rows: [{ n: '10', s: immutableDigest === 'same' ? '123' : '999' }] };
    if (/count\(\*\)::bigint AS n FROM migration.schema_migration/.test(sql)) return { rows: [{ n: '2' }] };
    if (/count\(\*\)::bigint AS n FROM/.test(sql)) return { rows: [{ n: '100' }] };
    return { rows: [] };
  };
  return { log, query, end: async () => {} };
}

function deps(over = {}) {
  const admin = over.admin ?? fakeDb();
  const app = fakeDb();
  const out = { written: [], logs: [], resets: [] };
  let t = 1_000_000;
  return {
    out, admin,
    now: () => (t += 1000),
    log: (m) => out.logs.push(m),
    imageDigest: `sha256:${'b'.repeat(64)}`,
    tables: { sample_modulus: 100, tables: [{ name: 'audit.event', class: 'immutable', pk: 'event_id', ts: 'occurred_at' }, { name: 'kernel.setting', class: 'mutable', pk: null, ts: null, max_drift_ratio: 0.05 }] },
    findTarget: async () => ({ id: 'rt-1', host: 'h', port: 5432, masterUsername: 'ehr_master', tags: { 'restore-run': '20261109-42-1', 'restore-mode': 'latest', 'restore-age-seconds': '120', 'restore-requested-epoch': '900' } }),
    rds: { resetMaster: async (id, pw) => out.resets.push([id, pw]), iamAuthEnabled: async () => false },
    connect: async (_t, user) => (user === 'app_api' ? app : admin),
    runCatalogChecks: async () => [{ id: 'R-roles', title: 't', status: 'pass', violations: [] }, { id: 'M-1', title: 't', status: 'pass', violations: [] }],
    auditVerifier: null,
    baseline: async () => null,
    putResult: async (d) => out.written.push(d),
    ...over,
  };
}

const baselineOf = (over = {}) => ({ watermark: '2026-11-09T00:00:00Z', schema: { migrations: 2, migration_set: null }, tables: { 'audit.event': { count: 100, digest: null }, 'kernel.setting': { count: 100 } }, ...over });

test('credentials are reset before any check, and the result is valid and PHI-free', async () => {
  const d = deps();
  const doc = await runRestoreCheck(d);
  assert.equal(d.out.resets.length, 1);
  assert.match(d.out.resets[0][1], /^[A-Za-z0-9_-]{43}$/);
  const firstCheckQuery = d.admin.log.findIndex((s) => /migration.schema_migration ORDER BY/.test(s));
  const lastReset = d.admin.log.reduce((n, s, i) => (/ALTER ROLE/.test(s) ? i : n), -1);
  assert.ok(lastReset >= 0 && lastReset < firstCheckQuery, 'ALTER ROLE statements come before the first check query');
  assert.deepEqual(validateResult(doc), []);
  assert.equal(d.out.written.length, 1);
  assert.ok(doc.timings_seconds.restore > 0 && doc.timings_seconds.total >= doc.timings_seconds.restore);
  assert.equal(doc.overall, 'partial', 'without a baseline and the Merkle verifier nothing may report pass');
  for (const id of ['schema-version', 'row-counts', 'checksums', 'audit-anchor-chain'])
    assert.equal(doc.checks.find((c) => c.id === id).status, 'partial', id);
  assert.ok(!JSON.stringify(doc).includes('ehr_master'));
});

test('passwords never appear in the result or the logs', async () => {
  const d = deps();
  const doc = await runRestoreCheck(d);
  const pw = d.out.resets[0][1];
  assert.ok(!JSON.stringify(doc).includes(pw));
  assert.ok(!d.out.logs.join('\n').includes(pw));
});

test('a database error is recorded as check_error and its message (which could echo a value) is never logged', async () => {
  const d = deps({ admin: fakeDb({ failOn: /schema_migration ORDER BY/ }) });
  const doc = await runRestoreCheck(d);
  const c = doc.checks.find((x) => x.id === 'schema-version');
  assert.deepEqual([c.status, c.reason], ['fail', 'check_error']);
  assert.equal(doc.overall, 'fail');
  assert.ok(!d.out.logs.join('\n').includes(CANARY));
  assert.ok(!JSON.stringify(doc).includes(CANARY));
  assert.match(d.out.logs.join('\n'), /errored \(42601\)/);
});

test('when the credentials cannot be reset no check is attempted and the run fails', async () => {
  const d = deps({ rds: { resetMaster: async () => { throw Object.assign(new Error('x'), { code: 'AccessDenied' }); }, iamAuthEnabled: async () => false } });
  const doc = await runRestoreCheck(d);
  assert.equal(doc.overall, 'fail');
  assert.equal(doc.checks.find((c) => c.id === 'credentials-reset').reason, 'check_error');
  for (const c of doc.checks.filter((c) => c.id !== 'credentials-reset')) assert.deepEqual([c.status, c.reason], ['fail', 'credentials_not_reset']);
  assert.equal(d.admin.log.length, 0);
});

test('IAM database authentication still enabled fails the credential check', async () => {
  const d = deps({ rds: { resetMaster: async () => {}, iamAuthEnabled: async () => true } });
  const doc = await runRestoreCheck(d);
  assert.equal(doc.checks.find((c) => c.id === 'credentials-reset').reason, 'credentials_not_reset');
  assert.equal(doc.overall, 'fail');
});

test('with a matching baseline and a Merkle verifier every check can pass', async () => {
    const d = deps({
    auditVerifier: { verifyChain: async () => true },
    baseline: async () => {
      // Compute what the fake database reports so the baseline matches it.
      const { createHash } = await import('node:crypto');
      const sha = (s) => createHash('sha256').update(s).digest('hex');
      return baselineOf({ schema: { migrations: 2, migration_set: sha('1:aa\n2:bb') }, tables: { 'audit.event': { count: 100, digest: sha('audit.event:123') }, 'kernel.setting': { count: 98 } } });
    },
  });
  d.tables.tables = d.tables.tables.filter((t) => t.name !== 'kernel.reference_data_version');
  const doc = await runRestoreCheck(d);
  assert.deepEqual(doc.checks.map((c) => [c.id, c.status]).filter(([, s]) => s !== 'pass'), []);
  assert.equal(doc.overall, 'pass');
});

test('immutable mismatch, drift beyond tolerance and a broken anchor chain fail', async () => {
  const sha = async (s) => (await import('node:crypto')).createHash('sha256').update(s).digest('hex');
  const t = { sample_modulus: 100, tables: [{ name: 'audit.event', class: 'immutable', pk: 'event_id', ts: 'occurred_at' }, { name: 'kernel.setting', class: 'mutable', pk: null, ts: null, max_drift_ratio: 0.05 }] };
  const q = fakeDb().query;
  const bad = await C.rowsAndChecksums(q, t, { watermark: null, tables: { 'audit.event': { count: 100, digest: await sha('audit.event:XXX') }, 'kernel.setting': { count: 100 } } });
  assert.deepEqual([bad.status, bad.reason], ['fail', 'immutable_mismatch']);
  const drift = await C.rowsAndChecksums(q, t, { watermark: null, tables: { 'audit.event': { count: 100, digest: await sha('audit.event:123') }, 'kernel.setting': { count: 50 } } });
  assert.deepEqual([drift.status, drift.reason], ['fail', 'mutable_drift_exceeded']);
  const broken = await C.auditAnchorChain(fakeDb({ anchors: [{ id: '1', prev: '00', h: 'h1', n: '5', from_ts: '2026-11-01', to_ts: '2026-11-02', actual: '5' }, { id: '2', prev: 'WRONG', h: 'h2', n: '3', from_ts: '2026-11-02', to_ts: '2026-11-03', actual: '4' }] }).query, { verifyChain: async () => true });
  assert.deepEqual([broken.status, broken.violations], ['fail', 2]);
  const none = await C.auditAnchorChain(fakeDb({ audit: false }).query, null);
  assert.deepEqual([none.status, none.reason], ['fail', 'audit_schema_missing']);
  const missingTable = await C.rowsAndChecksums(q, { sample_modulus: 100, tables: [{ name: 'kernel.reference_data_version', class: 'mutable', pk: null, ts: null, max_drift_ratio: 0 }] }, null);
  assert.deepEqual([missingTable.status, missingTable.reason], ['fail', 'immutable_mismatch']);
});

test('table and role identifiers must be plain; anything else throws before SQL is built', () => {
  assert.throws(() => C.qualified('audit.event; DROP TABLE x'), /schema.table/);
  assert.throws(() => C.qualified('event'), /schema.table/);
  assert.equal(C.qualified('audit.event'), '"audit"."event"');
  assert.throws(() => C.ident('app_api"; DROP ROLE x; --'), /plain identifier/);
});

test('an invalid document is never written', async () => {
  const d = deps({ findTarget: async () => ({ id: 'rt-1', host: 'h', port: 5432, masterUsername: 'm', tags: { 'restore-run': `${CANARY}`, 'restore-mode': 'latest', 'restore-age-seconds': '1', 'restore-requested-epoch': '1' } }) });
  await assert.rejects(runRestoreCheck(d), /refusing to write an invalid result/);
  assert.equal(d.out.written.length, 0);
});
