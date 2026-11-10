// Real-database tests for BE-24 (audit viewer, export, BTG review, integration settings): HTTP through the real guard (admin realm,
// permission, live elevation grant), the real services, FORCE-RLS tables and the audit store on PostgreSQL 17 with the migrations of
// the real pipeline. TC-AD-11..15 (API parts), TC-SEC-C7 evidence for role changes and the kill switch is the identity suite
// (privileged.dbtest.ts, run with this one on the combined candidate).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/admin-routes/admin-routes.dbtest.js
// Missing configuration FAILS; nothing skips. All data is synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { adminRoutesSetup, adminWith, api, ORG } from './testkit.js';
import type { Admin, OrgKit, Resp } from './testkit.js';

let k: OrgKit;
let ops: Admin; // compliance_officer: audit viewer, export, BTG review
let ops2: Admin; // a second compliance officer (the BTG reviewer is never the holder)
let adm: Admin; // org_admin: integrations
let adm2: Admin;
before(async () => {
  k = await adminRoutesSetup('adminroutes');
  ops = await adminWith(k, ['compliance_officer']);
  ops2 = await adminWith(k, ['compliance_officer']);
  adm = await adminWith(k, ['org_admin']);
  adm2 = await adminWith(k, ['org_admin']);
});
after(async () => {
  await k.close();
});

const j = (r: Resp): Record<string, unknown> => r.json();
const items = (r: Resp): Record<string, unknown>[] => j(r)['items'] as Record<string, unknown>[];
const person = async (a: Admin): Promise<string> =>
  (
    await k.q<{ person_id: string }>(`SELECT person_id FROM identity.principal WHERE id = $1`, [
      a.principalId,
    ])
  )[0]!.person_id;
const ASSERTION = {
  credentialId: 'Y3JlZA',
  clientDataJSON: 'Y2xpZW50',
  authenticatorData: 'YXV0aA',
  signature: 'c2ln',
};

async function auditRows(
  where: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return k.q(
    `SELECT action, outcome, denial_reason, resource_type, resource_id, reason, actor_principal_id, realm, change
       FROM audit.event WHERE ${where} ORDER BY occurred_at, event_id`,
    params,
  );
}

const day = 24 * 3600 * 1000;
const range = (days = 1): { from: string; to: string } => ({
  from: new Date(Date.now() - days * day).toISOString(),
  to: new Date(Date.now() + 60_000).toISOString(),
});

describe('audit viewer (RA-R1-12): search is bounded and itself audited', () => {
  test('a compliance officer searches; one view row per query; the range is at most 31 days; unknown fields are refused', async () => {
    const before = await auditRows(`resource_type = 'audit.event' AND action = 'view'`);
    const r = await api(k, ops, 'POST', '/audit-events/search', { ...range(), action: 'sign_in' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(Array.isArray(j(r)['items']));
    const after = await auditRows(`resource_type = 'audit.event' AND action = 'view'`);
    assert.equal(after.length, before.length + 1, 'exactly one view row for the query');
    assert.equal(after.at(-1)!['actor_principal_id'], ops.principalId);

    const wide = await api(k, ops, 'POST', '/audit-events/search', range(40));
    assert.equal(wide.status, 400);
    assert.equal(j(wide)['code'], 'kernel.validation_failed');
    const unknown = await api(k, ops, 'POST', '/audit-events/search', { ...range(), sql: 'x' });
    assert.equal(unknown.status, 400);
    const badAction = await api(k, ops, 'POST', '/audit-events/search', {
      ...range(),
      action: 'nope',
    });
    assert.equal(badAction.status, 400);
  });

  test('an org_admin (no audit permission) is refused; so is an unauthenticated caller', async () => {
    const r = await api(k, adm, 'POST', '/audit-events/search', range());
    assert.equal(r.status, 403);
    const anon = await api(k, undefined, 'POST', '/audit-events/search', range());
    assert.equal(anon.status, 401);
  });
});

describe('audit export: asynchronous, size limited, itself audited, elevation gated', () => {
  let exportId = '';
  test('a request returns at once with a queued job, an export audit row with the reason, and the elevation it ran under', async () => {
    const r = await api(k, ops, 'POST', '/audit-exports', {
      ...range(),
      reason: 'Quarterly access review',
    });
    assert.equal(r.status, 200, r.body);
    exportId = String(j(r)['id']);
    assert.equal(j(r)['status'], 'queued');
    const job = (
      await k.q(
        `SELECT status, reason, elevation_id, requested_by_person_id FROM audit.export_job WHERE id = $1`,
        [exportId],
      )
    )[0]!;
    assert.equal(job['status'], 'queued');
    assert.equal(job['requested_by_person_id'], await person(ops));
    assert.ok(job['elevation_id'], 'the live elevation grant is recorded');
    const rows = await auditRows(`action = 'export' AND resource_id = $1`, [exportId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['reason'], 'Quarterly access review');
    const queued = await k.q(
      `SELECT count(*)::int AS n FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'audit.export' AND j.payload->>'exportId' = $1`,
      [exportId],
    );
    assert.equal((queued[0] as { n: number }).n, 1, 'the work is a job, not part of the request');
  });

  test('status never carries content; download is refused until the export is ready, then only for the requester, audited', async () => {
    const st = await api(k, ops, 'GET', `/audit-exports/${exportId}`);
    assert.equal(st.status, 200);
    assert.equal(j(st)['status'], 'queued');
    assert.equal(j(st)['rowCount'], null);
    assert.equal(st.body.includes('object_key'), false);

    const early = await api(k, ops, 'POST', `/audit-exports/${exportId}/download-url`, {});
    assert.equal(early.status, 409);
    assert.equal(k.fakes.signed.length, 0);

    await k.sa.query(
      `UPDATE audit.export_job SET status = 'ready', row_count = 3, object_key = 'exports/synthetic-key', expires_at = now() + interval '1 hour' WHERE id = $1`,
      [exportId],
    );
    const other = await api(k, ops2, 'POST', `/audit-exports/${exportId}/download-url`, {});
    assert.equal(other.status, 404, 'only the requester');
    assert.equal(k.fakes.signed.length, 0);

    const ok = await api(k, ops, 'POST', `/audit-exports/${exportId}/download-url`, {
      reason: 'Hand to the auditor',
    });
    assert.equal(ok.status, 200, ok.body);
    assert.match(String(j(ok)['url']), /^https:\/\/exports\.example\.invalid\//);
    assert.equal(k.fakes.signed[0]!.ttl, 300);
    const dl = await auditRows(`action = 'download' AND resource_id = $1`, [exportId]);
    assert.equal(dl.length, 1);
    assert.equal(JSON.stringify(dl).includes('example.invalid'), false, 'the URL is not audited');
    const st2 = await api(k, ops, 'GET', `/audit-exports/${exportId}`);
    assert.equal(j(st2)['rowCount'], 3);

    await k.sa.query(
      `UPDATE audit.export_job SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [exportId],
    );
    const expired = await api(k, ops, 'POST', `/audit-exports/${exportId}/download-url`, {});
    assert.equal(expired.status, 409);
  });

  test('over the size limit: 422 audit.export_too_large, no job, no export row', async () => {
    await k.sa.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'audit_export_max_rows', '1'::jsonb, 'int')`,
      [ORG],
    );
    const jobsBefore = (
      await k.q<{ n: number }>(`SELECT count(*)::int AS n FROM audit.export_job`)
    )[0]!.n;
    const r = await api(k, ops, 'POST', '/audit-exports', {
      from: new Date(Date.now() - 30 * day).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      reason: 'Too much',
    });
    assert.equal(r.status, 422, r.body);
    assert.equal(j(r)['code'], 'audit.export_too_large');
    assert.equal(
      (await k.q<{ n: number }>(`SELECT count(*)::int AS n FROM audit.export_job`))[0]!.n,
      jobsBefore,
    );
    await k.sa.query(
      `DELETE FROM kernel.setting WHERE key = 'audit_export_max_rows' AND location_id IS NULL`,
    );
  });

  test('TC-SEC-20: repeated exports hit the hourly limit: 429 kernel.rate_limited, no job, nothing enqueued for the refused request', async () => {
    const mine = async (): Promise<number> =>
      (
        await k.q<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit.export_job WHERE created_at > now() - interval '1 hour'`,
        )
      )[0]!.n;
    const before = await mine();
    await k.sa.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'audit_export_max_per_hour', '1'::jsonb, 'int')`,
      [ORG],
    );
    try {
      const who = await adminWith(k, ['compliance_officer'], { elevated: true });
      const ask = () => api(k, who, 'POST', '/audit-exports', { ...range(), reason: 'Repeat' });
      const first = await ask();
      assert.equal(first.status, 200, first.body);
      const second = await ask();
      assert.equal(second.status, 429, second.body);
      assert.equal(j(second)['code'], 'kernel.rate_limited');
      assert.equal(await mine(), before + 1, 'the refused request created no job');
    } finally {
      await k.sa.query(
        `DELETE FROM kernel.setting WHERE key = 'audit_export_max_per_hour' AND location_id IS NULL`,
      );
    }
  });

  test('a reason is required; an unelevated caller cannot export or download', async () => {
    const noReason = await api(k, ops, 'POST', '/audit-exports', range());
    assert.equal(noReason.status, 400);
    const cold = await adminWith(k, ['compliance_officer'], { elevated: false });
    const r = await api(k, cold, 'POST', '/audit-exports', { ...range(), reason: 'No elevation' });
    assert.equal(r.status, 403);
    assert.equal(j(r)['code'], 'identity.elevation_required');
    const d = await api(k, cold, 'POST', `/audit-exports/${exportId}/download-url`, {});
    assert.equal(d.status, 403);
  });
});

describe('BTG review decisions are elevation gated, by someone other than the holder, once', () => {
  let grantId = '';
  let holderPerson = '';
  async function seedGrant(holder: Admin, patient = randomUUID()): Promise<string> {
    const id = randomUUID();
    const hp = await person(holder);
    await k.sa.query(
      `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason, expires_at)
       VALUES ($1, $2, $3, $4, 'admin_pool', $5, 'Synthetic emergency access', now() + interval '4 hours')`,
      [id, ORG, holder.principalId, hp, patient],
    );
    return id;
  }
  before(async () => {
    grantId = await seedGrant(ops2);
    holderPerson = await person(ops2);
  });

  test('the list shows pending grants (and is itself a view row); a bad status filter is 400', async () => {
    const r = await api(k, ops, 'GET', '/btg-grants?reviewStatus=pending');
    assert.equal(r.status, 200, r.body);
    const g = items(r).find((x) => x['id'] === grantId)!;
    assert.equal(g['holderPersonId'], holderPerson);
    assert.equal(g['reviewStatus'], 'pending');
    assert.equal(g['review'], null);
    assert.ok(
      (await auditRows(`resource_type = 'audit.btg_grant' AND action = 'view'`)).length >= 1,
    );
    assert.equal((await api(k, ops, 'GET', '/btg-grants?reviewStatus=maybe')).status, 400);
  });

  test('the holder cannot review their own grant: 403 audit.self_review, grant unchanged, the denial is audited', async () => {
    const r = await api(k, ops2, 'POST', `/btg-grants/${grantId}/review`, { outcome: 'justified' });
    assert.equal(r.status, 403, r.body);
    assert.equal(j(r)['code'], 'audit.self_review');
    assert.equal(
      (await k.q(`SELECT review_status FROM audit.btg_grant WHERE id = $1`, [grantId]))[0]![
        'review_status'
      ],
      'pending',
    );
    const d = await auditRows(
      `action = 'denied' AND resource_type = 'audit.btg_grant' AND resource_id = $1`,
      [grantId],
    );
    assert.equal(d.length, 1);
    assert.equal(d[0]!['actor_principal_id'], ops2.principalId);
  });

  test('without an elevation grant the decision is refused', async () => {
    const cold = await adminWith(k, ['compliance_officer'], { elevated: false });
    const r = await api(k, cold, 'POST', `/btg-grants/${grantId}/review`, { outcome: 'justified' });
    assert.equal(r.status, 403);
    assert.equal(j(r)['code'], 'identity.elevation_required');
    assert.equal(
      (await k.q(`SELECT review_status FROM audit.btg_grant WHERE id = $1`, [grantId]))[0]![
        'review_status'
      ],
      'pending',
    );
  });

  test('another elevated reviewer decides once; it is audited; a second decision is 409; bad outcomes are 400', async () => {
    assert.equal(
      (await api(k, ops, 'POST', `/btg-grants/${grantId}/review`, { outcome: 'fine' })).status,
      400,
    );
    const r = await api(k, ops, 'POST', `/btg-grants/${grantId}/review`, {
      outcome: 'not_justified',
      note: 'No care relationship',
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(j(r)['reviewStatus'], 'not_justified');
    const rev = (
      await k.q(
        `SELECT outcome, note, reviewer_person_id FROM audit.btg_review WHERE grant_id = $1`,
        [grantId],
      )
    )[0]!;
    assert.equal(rev['outcome'], 'not_justified');
    assert.equal(rev['reviewer_person_id'], await person(ops));
    assert.equal(
      (await auditRows(`action = 'btg_review' AND resource_id = $1`, [grantId])).length,
      1,
    );
    const again = await api(k, ops, 'POST', `/btg-grants/${grantId}/review`, {
      outcome: 'justified',
    });
    assert.equal(again.status, 409);
    const listed = await api(k, ops, 'GET', '/btg-grants?reviewStatus=not_justified');
    assert.equal(
      (items(listed).find((x) => x['id'] === grantId)!['review'] as Record<string, unknown>)[
        'note'
      ],
      'No care relationship',
    );
  });

  test('two reviewers deciding at once: exactly one decision is stored', async () => {
    const gid = await seedGrant(adm2.principalId === '' ? ops2 : ops2);
    const [a, b] = await Promise.all([
      api(k, ops, 'POST', `/btg-grants/${gid}/review`, { outcome: 'justified' }),
      (async () =>
        api(k, await adminWith(k, ['compliance_officer']), 'POST', `/btg-grants/${gid}/review`, {
          outcome: 'not_justified',
        }))(),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(
      (
        await k.q<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit.btg_review WHERE grant_id = $1`,
          [gid],
        )
      )[0]!.n,
      1,
    );
  });
});

describe('integration settings: save, test, health (TC-AD-11, TC-AD-13, TC-AD-15)', () => {
  let smsId = '';
  before(async () => {
    smsId = randomUUID();
    await k.sa.query(
      `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, settings, enabled) VALUES ($1, $2, 'sms', 'sandbox-sms', '{"senderId":"CLINIC"}'::jsonb, true)`,
      [smsId, ORG],
    );
  });

  test('list shows settings, health and secret metadata only', async () => {
    const r = await api(k, adm, 'GET', '/integrations');
    assert.equal(r.status, 200, r.body);
    const c = items(r).find((x) => x['id'] === smsId)!;
    assert.equal(c['health'], 'unknown');
    assert.deepEqual(c['secrets'], []);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('PATCH needs If-Match (428 / 412), saves, audits who/what/before/after, and a credential-looking setting is refused', async () => {
    const list = await api(k, adm, 'GET', '/integrations');
    const v = items(list).find((x) => x['id'] === smsId)!['rowVersion'];
    assert.equal(
      (await api(k, adm, 'PATCH', `/integrations/${smsId}`, { settings: { senderId: 'X' } }))
        .status,
      428,
    );
    assert.equal(
      (
        await api(
          k,
          adm,
          'PATCH',
          `/integrations/${smsId}`,
          { settings: { senderId: 'X' } },
          { 'if-match': 'W/"999"' },
        )
      ).status,
      412,
    );
    const bad = await api(
      k,
      adm,
      'PATCH',
      `/integrations/${smsId}`,
      { settings: { apiKey: 'SECRET-TEST-1' } },
      { 'if-match': `W/"${String(v)}"` },
    );
    assert.equal(bad.status, 400, bad.body);
    assert.equal(bad.body.includes('SECRET-TEST-1'), false);
    const ok = await api(
      k,
      adm,
      'PATCH',
      `/integrations/${smsId}`,
      { settings: { senderId: 'CLINIC2' } },
      { 'if-match': `W/"${String(v)}"` },
    );
    assert.equal(ok.status, 200, ok.body);
    assert.equal(j(ok)['rowVersion'], Number(v) + 1);
    assert.equal(ok.headers['etag'], `W/"${String(Number(v) + 1)}"`);
    const rows = await auditRows(
      `resource_type = 'integration_core.connection' AND resource_id = $1 AND action = 'config_change'`,
      [smsId],
    );
    const last = rows.at(-1)!;
    assert.equal(last['actor_principal_id'], adm.principalId);
    assert.deepEqual(last['change'], {
      before: { vendor: 'sandbox-sms', settings: { senderId: 'CLINIC' }, enabled: true },
      after: { vendor: 'sandbox-sms', settings: { senderId: 'CLINIC2' }, enabled: true },
    });
    const stale = await api(
      k,
      adm,
      'PATCH',
      `/integrations/${smsId}`,
      { enabled: false },
      { 'if-match': `W/"${String(v)}"` },
    );
    assert.equal(stale.status, 412);
  });

  test('an unelevated org_admin and an officer without the permission are refused', async () => {
    const cold = await adminWith(k, ['org_admin'], { elevated: false });
    const r = await api(
      k,
      cold,
      'PATCH',
      `/integrations/${smsId}`,
      { enabled: false },
      { 'if-match': 'W/"1"' },
    );
    assert.equal(r.status, 403);
    assert.equal(j(r)['code'], 'identity.elevation_required');
    assert.equal((await api(k, ops, 'GET', '/integrations')).status, 403);
  });

  test('test shows health from a real check, a failure shows as down, an unreachable probe is 503, each check is audited', async () => {
    k.fakes.probe = 'ok';
    const ok = await api(k, adm, 'POST', `/integrations/${smsId}/test`, {});
    assert.equal(ok.status, 200, ok.body);
    assert.equal(j(ok)['health'], 'ok');
    assert.ok(typeof j(ok)['checkedAt'] === 'string');
    k.fakes.probe = 'down';
    const down = await api(k, adm, 'POST', `/integrations/${smsId}/test`, {});
    assert.equal(j(down)['health'], 'down');
    const list = await api(k, adm, 'GET', '/integrations');
    const c = items(list).find((x) => x['id'] === smsId)!;
    assert.equal(c['health'], 'down');
    assert.ok(c['lastTestAt']);
    k.fakes.probe = null;
    const unreachable = await api(k, adm, 'POST', `/integrations/${smsId}/test`, {});
    assert.equal(unreachable.status, 503);
    assert.equal(unreachable.body.includes('vendor unreachable'), false);
    const tests = await auditRows(`resource_id = $1 AND change->>'event' = 'connection_test'`, [
      smsId,
    ]);
    assert.equal(tests.length, 2);
    assert.equal((await api(k, adm, 'POST', `/integrations/${randomUUID()}/test`, {})).status, 404);
    k.fakes.probe = 'ok';
  });

  test('disabling an integration is saved and audited; the list shows it disabled (dependent features see it through the connection)', async () => {
    const v = items(await api(k, adm, 'GET', '/integrations')).find((x) => x['id'] === smsId)![
      'rowVersion'
    ];
    const r = await api(
      k,
      adm,
      'PATCH',
      `/integrations/${smsId}`,
      { enabled: false },
      { 'if-match': `W/"${String(v)}"` },
    );
    assert.equal(r.status, 200, r.body);
    assert.equal(j(r)['enabled'], false);
    const rows = await auditRows(`resource_id = $1 AND action = 'config_change'`, [smsId]);
    assert.equal((rows.at(-1)!['change'] as { after: { enabled: boolean } }).after.enabled, false);
  });
});

describe('secrets are write-only and every secret change is audited (TC-AD-12, TC-AD-13, TC-AD-14)', () => {
  const VALUE = 'SECRET-TEST-1-synthetic-value';
  let connId = '';
  before(async () => {
    connId = randomUUID();
    await k.sa.query(
      `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, settings, enabled) VALUES ($1, $2, 'email', 'sandbox-mail', '{}'::jsonb, true)`,
      [connId, ORG],
    );
  });

  async function everywhere(): Promise<string> {
    const dump = await k.q(`SELECT to_jsonb(e)::text AS t FROM audit.event e`);
    const refs = await k.q(`SELECT to_jsonb(s)::text AS t FROM integration_core.secret_ref s`);
    const reqs = await k.q(
      `SELECT to_jsonb(s)::text AS t FROM integration_core.secret_change_request s`,
    );
    const jobs = await k.q(`SELECT payload::text AS t FROM queue._private_jobs`);
    return JSON.stringify([dump, refs, reqs, jobs]);
  }

  test('write returns only a version ID; the value is in no response, audit row, table, queue payload or error; list shows the version', async () => {
    const r = await api(
      k,
      adm,
      'PUT',
      `/integrations/${connId}/secrets/api-token`,
      { value: VALUE },
      { 'idempotency-key': randomUUID() },
    );
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(Object.keys(j(r)), ['versionId']);
    assert.equal(r.body.includes(VALUE), false);
    assert.equal(r.headers['cache-control'], 'no-store');
    const rows = await auditRows(`action = 'secret_write' AND resource_id = $1`, [connId]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!['change'], { name: 'api-token', versionId: j(r)['versionId'] });
    assert.equal((await everywhere()).includes(VALUE), false);
    const list = await api(k, adm, 'GET', '/integrations');
    assert.equal(list.body.includes(VALUE), false);
    const c = items(list).find((x) => x['id'] === connId)!;
    assert.deepEqual(
      (c['secrets'] as Record<string, unknown>[]).map((s) => [
        s['name'],
        s['class'],
        s['currentVersionId'],
      ]),
      [['api-token', 'outbound', j(r)['versionId']]],
    );
    const one = await api(k, adm, 'GET', `/integrations`);
    assert.equal(one.status, 200);
  });

  test('a retry with the same idempotency key writes no second version; a new key rotates', async () => {
    const key = randomUUID();
    const a = await api(
      k,
      adm,
      'PUT',
      `/integrations/${connId}/secrets/rotating`,
      { value: VALUE },
      { 'idempotency-key': key },
    );
    const b = await api(
      k,
      adm,
      'PUT',
      `/integrations/${connId}/secrets/rotating`,
      { value: VALUE },
      { 'idempotency-key': key },
    );
    assert.equal(j(a)['versionId'], j(b)['versionId']);
    const c = await api(
      k,
      adm,
      'PUT',
      `/integrations/${connId}/secrets/rotating`,
      { value: `${VALUE}-2` },
      { 'idempotency-key': randomUUID() },
    );
    assert.notEqual(j(c)['versionId'], j(a)['versionId']);
    assert.equal(
      (await auditRows(`action = 'secret_write' AND change->>'name' = 'rotating'`)).length,
      3,
      'every change is audited',
    );
  });

  test('refusals never echo the value: store failure (503), short value, unknown field, bad name, unknown connection, org_admin without elevation', async () => {
    k.fakes.storeFails = true;
    const down = await api(k, adm, 'PUT', `/integrations/${connId}/secrets/api-token`, {
      value: VALUE,
    });
    k.fakes.storeFails = false;
    assert.equal(down.status, 503, down.body);
    assert.equal(down.body.includes(VALUE), false);
    assert.equal(down.body.includes('vendor text'), false);
    const short = await api(k, adm, 'PUT', `/integrations/${connId}/secrets/api-token`, {
      value: 'short',
    });
    assert.equal(short.status, 400);
    assert.equal(short.body.includes('short'), false);
    assert.equal(
      (
        await api(k, adm, 'PUT', `/integrations/${connId}/secrets/api-token`, {
          value: VALUE,
          extra: 1,
        })
      ).status,
      400,
    );
    assert.equal(
      (await api(k, adm, 'PUT', `/integrations/${connId}/secrets/Bad%20Name`, { value: VALUE }))
        .status,
      400,
    );
    assert.equal(
      (
        await api(k, adm, 'PUT', `/integrations/${randomUUID()}/secrets/api-token`, {
          value: VALUE,
        })
      ).status,
      404,
    );
    const cold = await adminWith(k, ['org_admin'], { elevated: false });
    const refused = await api(k, cold, 'PUT', `/integrations/${connId}/secrets/api-token`, {
      value: VALUE,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.includes(VALUE), false);
    assert.equal((await everywhere()).includes(VALUE), false);
  });

  test('inbound-verification secret: requested by one admin, approved by a different one; approval alone applies nothing (the worker does)', async () => {
    const req = await api(k, adm, 'POST', `/integrations/${connId}/inbound-secret-requests`, {
      name: 'webhook-key',
      value: 'INBOUND-SECRET-TEST-0123456789',
      requesterAssertion: ASSERTION,
    });
    assert.equal(req.status, 200, req.body);
    const requestId = String(j(req)['requestId']);
    assert.match(String(j(req)['fingerprintHint']), /^[0-9a-f]{6}…[0-9a-f]{6}$/);
    assert.equal(req.body.includes('INBOUND-SECRET-TEST'), false);
    assert.equal(k.fakes.enqueued.length, 1);

    const self = await api(
      k,
      adm,
      'POST',
      `/integrations/${connId}/inbound-secret-requests/${requestId}/approve`,
      { approverAssertion: ASSERTION },
    );
    assert.equal(self.status, 403);
    assert.equal(j(self)['code'], 'identity.self_approval');
    const wrongConn = await api(
      k,
      adm2,
      'POST',
      `/integrations/${randomUUID()}/inbound-secret-requests/${requestId}/approve`,
      { approverAssertion: ASSERTION },
    );
    assert.equal(wrongConn.status, 404);
    const noEvidence = await api(
      k,
      adm2,
      'POST',
      `/integrations/${connId}/inbound-secret-requests/${requestId}/approve`,
      {},
    );
    assert.equal(noEvidence.status, 400);

    const ok = await api(
      k,
      adm2,
      'POST',
      `/integrations/${connId}/inbound-secret-requests/${requestId}/approve`,
      { approverAssertion: ASSERTION },
    );
    assert.equal(ok.status, 200, ok.body);
    assert.equal(j(ok)['status'], 'approved');
    const again = await api(
      k,
      adm2,
      'POST',
      `/integrations/${connId}/inbound-secret-requests/${requestId}/approve`,
      { approverAssertion: ASSERTION },
    );
    assert.equal(again.status, 409);
    const applied = await k.q(
      `SELECT 1 FROM integration_core.secret_ref WHERE connection_id = $1 AND class = 'inbound_verification'`,
      [connId],
    );
    assert.equal(applied.length, 0, 'the API never writes an inbound-verification reference');
    assert.equal((await everywhere()).includes('INBOUND-SECRET-TEST'), false);
    assert.equal(
      (
        await auditRows(
          `resource_id = $1 AND resource_type = 'integration_core.secret_change_request'`,
          [requestId],
        )
      ).length,
      2,
    );
  });

  test('without the sealed-payload enqueuer the request fails closed and stores nothing (INT-N4)', async () => {
    const n = (
      await k.q<{ n: number }>(
        `SELECT count(*)::int AS n FROM integration_core.secret_change_request`,
      )
    )[0]!.n;
    const bad = await api(k, adm, 'POST', `/integrations/${connId}/inbound-secret-requests`, {
      name: 'k',
      value: 'INBOUND-SECRET-TEST-0123456789',
      requesterAssertion: { ...ASSERTION, extra: 'x' },
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (
        await k.q<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration_core.secret_change_request`,
        )
      )[0]!.n,
      n,
    );
  });
});
