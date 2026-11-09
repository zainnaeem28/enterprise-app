// TC-AU-01..10 (TEST-CASES 9.2). ENV-INT/ci: real API, real worker, real PostgreSQL 17 roles and triggers. Fault injection is a
// trigger the test installs on the throwaway database and removes again; no product code or configuration is changed.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { login, sql, until, uuid, ORG, state, closeAdmin, asRole, injectFault, newPatient, assign, principalId } from './lib/world.mjs';
import { adminClient, elevate } from './lib/admin.mjs';

after(() => closeAdmin());
const PAT01 = '00000000-0000-7000-8000-000000100003'; // patientId(1)
const pid = (n) => `00000000-0000-7000-8000-${String(100000 + n * 3).padStart(12, '0')}`;
const PROBE = `qa05.probe.${Math.random().toString(36).slice(2, 8)}`;
const dayWindow = () => ({ from: new Date(Date.now() - 3600e3).toISOString(), to: new Date(Date.now() + 3600e3).toISOString() });

describe('TC-AU', () => {
  test('setup: STF-DR-A1 is on the care team of PAT-01 (assignment rule, BQ-5)', async () => {
    await assign(pid(1), principalId('STF-DR-A1'));
  });

  test('TC-AU-01 chart view and patient search each create an audit event with user, time, IP/device and no clinical values', async () => {
    const dr = await login('staff', 'STF-DR-A1');
    const fd = await login('staff', 'STF-FD-A');
    const before = new Date(Date.now() - 1000).toISOString();
    const view = await dr.get(`/api/v1/patients/${pid(1)}/chart-summary`, { headers: { 'user-agent': 'qa05-audit-probe' } });
    assert.equal(view.status, 200, `chart view ${view.status} ${view.text.slice(0, 200)}`);
    const srch = await fd.post('/api/v1/patients/search', { name: 'Patient 01' });
    assert.equal(srch.status, 200, `search ${srch.status} ${srch.text.slice(0, 200)}`);
    const rows = await until(async () => {
      const r = await sql(`SELECT action, resource_type, actor_principal_id, occurred_at, ip, user_agent, change, patient_id, realm, audience FROM audit.event WHERE occurred_at >= $1 AND actor_principal_id = ANY($2) ORDER BY occurred_at`, [before, [dr.session.principalId, fd.session.principalId]]);
      return r.rows.some((x) => x.action === 'view') && r.rows.some((x) => x.action === 'search') ? r.rows : null;
    });
    assert.ok(rows, 'a view event and a search event were written');
    for (const e of rows.filter((x) => ['view', 'search'].includes(x.action))) {
      assert.ok(e.occurred_at && e.actor_principal_id && e.ip, 'user, time and IP are recorded: ' + JSON.stringify({ a: e.action, rt: e.resource_type, ip: e.ip, actor: e.actor_principal_id }));
      const flat = JSON.stringify(e.change ?? {});
      assert.doesNotMatch(flat, /Test Patient|allerg|penicillin|1980-01-01/i, 'the change carries no clinical or demographic values');
    }
    const v = rows.find((x) => x.action === 'view');
    assert.equal(v.patient_id, pid(1));
    assert.equal(v.user_agent, 'qa05-audit-probe');
  });

  test('TC-AU-01b chart export and print each create an audit event', { skip: 'NOT TESTABLE: the API has no chart export or print route in R1 (probed chart-export, chart-print, export: 404); the view and search half is TC-AU-01. Recorded as a coverage gap, not a pass' }, () => {});

  test('TC-AU-02 audit insert failure: the read fails and the change rolls back; with the fault removed it works', async () => {
    const dr = await login('staff', 'STF-DR-A1');
    const remove = await injectFault('audit.event', 'true', 'qa05 audit insert failure');
    let failedRead;
    try {
      failedRead = await dr.get(`/api/v1/patients/${pid(1)}/chart-summary`);
    } finally {
      await remove();
    }
    assert.ok(failedRead.status >= 500, `the read is refused when its audit row cannot be written (got ${failedRead.status})`);
    assert.doesNotMatch(failedRead.text, /Test Patient|1980/, 'no PHI in the failure body');
    const ok = await dr.get(`/api/v1/patients/${pid(1)}/chart-summary`);
    assert.equal(ok.status, 200, 'with the injection removed the same read succeeds');
  });

  test('TC-AU-03 denial-write failure: the caller still gets the denial (fail closed) and the failure is logged', async () => {
    const fd = await login('staff', 'STF-FD-A');
    const outside = pid(20);
    // a patient registered only at B1 (outside STF-FD-A's scope)
    const { addPatient } = await import('./lib/seed.mjs');
    const { sqlTx } = await import('./lib/world.mjs');
    await sqlTx((c) => addPatient(c, 20, { locations: ['00000000-0000-7000-8000-000000000201'] })).catch(() => {});
    const logPath = new URL('../../../reports/qa05/logs/api.log', import.meta.url);
    const count = () => (readFileSync(logPath, 'utf8').match(/audit denial write failed/g) ?? []).length;
    const logged0 = count();
    const remove = await injectFault('audit.event', `NEW.action = 'denied'`, 'qa05 denial write failure');
    let r;
    try {
      r = await fd.get(`/api/v1/patients/${outside}`);
    } finally {
      await remove();
    }
    assert.equal(r.status, 404, 'the caller still gets the denial');
    assert.ok(await until(() => count() > logged0, { timeoutMs: 5000, everyMs: 200 }), 'the API log records "audit denial write failed" (the alert half of the case is not observable in ci: no alert sink)');
  });

  test('TC-AU-04 audit.require_bounded_tx: unset and over-bound refused (PA001), app_owner has no INSERT (42501), at-bound succeeds', async () => {
    const ins = (c) =>
      c.query(
        `INSERT INTO audit.event (event_id, organisation_id, request_id, realm, audience, action, resource_type, outcome) VALUES ($1,$2,$3,'google','staff','view',$4,'allowed')`,
        [uuid(), ORG, uuid(), PROBE],
      );
    const scope = (c) => c.query(`SELECT set_config('app.org_id',$1,true), set_config('app.audience','staff',true)`, [ORG]);
    const attempt = async (role, timeoutSql) =>
      asRole(role, async (c) => {
        await c.query('BEGIN');
        try {
          if (timeoutSql) await c.query(timeoutSql);
          await scope(c);
          await ins(c);
          await c.query('COMMIT');
          return { ok: true };
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          return { ok: false, code: e.code };
        }
      });
    assert.deepEqual(await attempt('app_api', `SET LOCAL transaction_timeout = 0`), { ok: false, code: 'PA001' }, 'step 1: timeout unset is refused by the trigger');
    assert.deepEqual(await attempt('app_api', `SET LOCAL transaction_timeout = '61s'`), { ok: false, code: 'PA001' }, 'step 2: above the 60 s bound is refused');
    assert.deepEqual(await attempt('app_api', `SET LOCAL transaction_timeout = '120s'`), { ok: false, code: 'PA001' }, 'the 2-minute anchor watermark is not the bound');
    const owner = await attempt('app_owner', `SET LOCAL transaction_timeout = '30s'`);
    assert.deepEqual(owner, { ok: false, code: '42501' }, 'step 3: app_owner has no INSERT grant; refused before the trigger');
    assert.deepEqual(await attempt('app_api', `SET LOCAL transaction_timeout = '60s'`), { ok: true }, 'step 4 positive control: at the bound succeeds');
    const n = await sql(`SELECT count(*)::int n FROM audit.event WHERE resource_type=$1`, [PROBE]);
    assert.equal(n.rows[0].n, 1, 'exactly the positive-control row exists; refused attempts wrote nothing');
    // The same four steps on RDS (role-level transaction_timeout is Unverified there) belong to ENV-INT/staging: not run here.
  });

  test('TC-AU-05 nobody can edit or delete audit rows: not via API routes, not as any app_* role (the attempt is refused)', async () => {
    const adm = await adminClient('ADM-1');
    await elevate(adm);
    for (const [m, p] of [['DELETE', '/api/v1/admin/audit-events/x'], ['PATCH', '/api/v1/admin/audit-events/x'], ['PUT', '/api/v1/admin/audit-events/x']]) {
      const r = await adm.call(m, p, { body: {} });
      assert.ok([404, 405].includes(r.status), `${m} ${p} is not available (${r.status})`);
    }
    const some = (await sql(`SELECT event_id, occurred_at FROM audit.event LIMIT 1`)).rows[0];
    for (const role of ['app_api', 'app_worker', 'app_owner']) {
      for (const stmt of [`UPDATE audit.event SET reason='x' WHERE event_id='${some.event_id}'`, `DELETE FROM audit.event WHERE event_id='${some.event_id}'`, 'TRUNCATE audit.event']) {
        const res = await asRole(role, async (c) => {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.org_id',$1,true), set_config('app.audience','system',true)`, [ORG]);
          try {
            await c.query(stmt);
            await c.query('ROLLBACK');
            return 'allowed';
          } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            return e.code;
          }
        });
        assert.equal(res, '42501', `${role}: ${stmt.split(' ')[0]} is refused (got ${res})`);
      }
    }
  });

  test('TC-AU-06 audit viewer: filters who/what/when, required fields shown, no PHI', async () => {
    const cmp = await adminClient('CMP-1');
    await elevate(cmp);
    const dr = await login('staff', 'STF-DR-A1');
    await dr.get(`/api/v1/patients/${pid(1)}/chart-summary`);
    const w = dayWindow();
    const all = await cmp.post('/api/v1/admin/audit-events/search', { ...w });
    assert.equal(all.status, 200, `viewer ${all.status} ${all.text.slice(0, 200)}`);
    assert.ok(all.json.items.length > 0);
    const e = all.json.items.find((x) => x.action === 'view');
    assert.ok(e, 'a view event is listed');
    for (const f of ['occurredAt', 'action', 'resourceType']) assert.ok(f in e, `field ${f} is present`);
    assert.doesNotMatch(JSON.stringify(all.json), /Test Patient|1980-01-01|"givenName"/, 'no PHI in the viewer');
    const byAction = await cmp.post('/api/v1/admin/audit-events/search', { ...w, action: 'view' });
    assert.ok(byAction.json.items.every((x) => x.action === 'view'), 'filter by action');
    const byPatient = await cmp.post('/api/v1/admin/audit-events/search', { ...w, patientId: pid(1) });
    assert.ok(byPatient.json.items.every((x) => x.patientId === pid(1) || x.patient_id === pid(1)), 'filter by patient');
    const tooWide = await cmp.post('/api/v1/admin/audit-events/search', { from: new Date(Date.now() - 40 * 86400e3).toISOString(), to: new Date().toISOString() });
    assert.ok([400, 422].includes(tooWide.status), `more than 31 days is refused (${tooWide.status})`);
  });

  test('TC-AU-07 audit export is an asynchronous, size-limited, audited job', async () => {
    const cmp = await adminClient('CMP-1');
    await elevate(cmp);
    const w = dayWindow();
    const noElev = await (async () => {
      const other = await adminClient('CMP-2');
      return other.post('/api/v1/admin/audit-exports', { ...w, reason: 'qa05 without elevation' });
    })();
    assert.equal(noElev.status, 403, 'an export without a live elevation grant is refused');
    const req = await cmp.post('/api/v1/admin/audit-exports', { ...w, reason: 'QA-05 TC-AU-07 export check' });
    assert.equal(req.status, 200, `export request ${req.status} ${req.text.slice(0, 200)}`);
    assert.equal(req.json.status, 'queued');
    const logged = await sql(`SELECT count(*)::int n FROM audit.event WHERE action='export' AND resource_type LIKE 'audit%'`);
    assert.ok(logged.rows[0].n >= 1, 'the export request is itself audited');
    const status = await cmp.get(`/api/v1/admin/audit-exports/${req.json.id}`);
    assert.equal(status.status, 200);
    assert.ok(['queued', 'running', 'ready', 'failed'].includes(status.json.status));
    // size limit: audit_export_max_rows
    const prev = await sql(`SELECT value FROM kernel.setting WHERE key='audit_export_max_rows' AND location_id IS NULL`);
    await sql(`UPDATE kernel.setting SET value='1'::jsonb WHERE key='audit_export_max_rows' AND location_id IS NULL`);
    try {
      const big = await cmp.post('/api/v1/admin/audit-exports', { ...w, reason: 'QA-05 size limit' });
      assert.equal(big.status, 422, 'over the limit is refused');
      assert.match(big.json?.code ?? '', /export_too_large/);
    } finally {
      if (prev.rows[0]) await sql(`UPDATE kernel.setting SET value=$1::jsonb WHERE key='audit_export_max_rows' AND location_id IS NULL`, [JSON.stringify(prev.rows[0].value)]);
    }
  });

  test('TC-AU-07b the export reaches ready and the requester downloads it', { skip: 'BLOCKED: the audit export sink (object store, infrastructure) is not provisioned in ENV-INT/ci; the worker\'s sink is a refusing port, so the job ends failed. Needs the staging object store' }, () => {});

  test('TC-AU-08 tampering with a stored audit row is detected by the anchor verification', { skip: 'BLOCKED: audit.verify_anchors treats the Object Lock archive as the authority (INT04-F10 D-2); the archive store is infrastructure that does not exist in ENV-INT/ci' }, () => {});

  test('TC-AU-09 retention value and archive job [OPS]', { skip: 'BLOCKED: audit/clinical retention period not decided at G2 (open decision); type OPS: DevOps evidence' }, () => {});

  test('TC-AU-10 duplicate of TC-PERF-04: no result of its own', { skip: 'n/a: owned by TC-PERF-04 (ENV-LOAD, not provisioned)' }, () => {});
});
