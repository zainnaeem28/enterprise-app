// Real-database tests for BE-21 (reporting: operations read models and dashboard feed) on PostgreSQL 17 with the real roles, migrations
// 2100-2101, the real Nest application and identity guard and the real queue. Covers: the refresh of every model from real sources, replace
// semantics, concurrent refreshes, rollback on a failed refresh, the feed by route (200/401/403), row-level security for the admin API, the
// worker and `reporting_ro` (C0/C1 only, M-4), and the absence of PHI in the models and the feed.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/reporting/reporting.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ScopeSettings } from '@ehr/kernel';
import { FEED_STALE_AFTER_S, readOpsFeed } from './feed.js';
import type { OpsFeed } from './feed.js';
import { REFRESH_OPS_JOB, REPORTING_JOBS } from './jobs.js';
import { refreshScope, runRefreshOps } from './refresh.js';
import { ORG, ORG2, pg, saWrite, setupReporting, uuid } from './testkit.js';
import type { ReportingKit } from './testkit.js';

const OPS_TABLES = [
  'ops_integration_health',
  'ops_queue',
  'ops_calendar_staleness',
  'ops_alert_backlog',
] as const;
const ALL_TABLES = [...OPS_TABLES, 'compliance_btg_summary'] as const;

describe('reporting (BE-21) on PostgreSQL 17', () => {
  let t: ReportingKit;
  let seq = 0;
  before(async () => {
    t = await setupReporting('reporting');
  });
  after(async () => {
    await t.close();
  });

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    t.k.q<T>(sql, params);
  const refresh = (stale = 15) =>
    runRefreshOps({ db: t.k.wdb, staleMinutes: () => Promise.resolve(stale) }, ORG);
  const adminScope = (extra: Partial<ScopeSettings> = {}): ScopeSettings => ({
    audience: 'staff',
    realm: 'admin_pool',
    orgId: ORG,
    principalId: t.admin.seeded.principalId,
    personId: t.admin.seeded.personId,
    ...extra,
  });
  const asReportingRo = async <T>(
    org: string | undefined,
    fn: (c: { query(sql: string): Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>,
    audience: string | null = 'system',
  ): Promise<T> => {
    const c = new pg.Client({ connectionString: t.k.urlFor('reporting_ro') });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (org !== undefined) await c.query(`SELECT set_config('app.org_id', '${org}', true)`);
      if (audience !== null)
        await c.query(`SELECT set_config('app.audience', '${audience}', true)`);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  };

  async function mkConnection(kind: string, health: string, org = ORG): Promise<string> {
    const cid = uuid();
    await saWrite(
      t.k,
      `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, enabled, health, health_changed_at)
       VALUES ($1, $2, $3, 'acme', true, $4, now() - interval '3 minutes')`,
      [cid, org, kind, health],
    );
    return cid;
  }
  async function mkCall(cid: string, outcome: string, ago: string): Promise<void> {
    await saWrite(
      t.k,
      `INSERT INTO integration_core.outbound_call (id, organisation_id, connection_id, operation, attempt, outcome, at)
       VALUES ($1, $2, $3, 'send', 1, $4, now() - $5::interval)`,
      [uuid(), ORG, cid, outcome, ago],
    );
  }
  async function mkJob(
    task: string,
    state: 'ready' | 'running' | 'running_last' | 'failed' | 'dead',
    payload: object = {},
  ): Promise<void> {
    const key = `${task}:${++seq}`;
    await q(
      `SELECT queue.add_job($1, $2::json, job_key := $3, max_attempts := 3, run_at := now() - interval '2 minutes')`,
      [task, JSON.stringify(payload), key],
    );
    const set =
      state === 'running'
        ? "locked_at = now(), locked_by = 'w1'"
        : state === 'running_last'
          ? "locked_at = now(), locked_by = 'w2', attempts = max_attempts"
          : state === 'failed'
            ? 'attempts = 1'
            : state === 'dead'
              ? 'attempts = max_attempts'
              : 'attempts = 0';
    await q(`UPDATE queue._private_jobs SET ${set} WHERE key = $1`, [key]);
  }

  test('job type: system job, org scope, every minute, not enqueueable by the API', async () => {
    assert.deepEqual(
      REPORTING_JOBS.map((j) => [j.name, j.jobScope, j.jobClass, j.carriesPatientIds]),
      [[REFRESH_OPS_JOB, 'org', 'system', false]],
    );
    const r = await q<{ job_class: string; api_enqueue: boolean }>(
      `SELECT job_class, api_enqueue FROM queue_api.task_type WHERE task_identifier = $1`,
      [REFRESH_OPS_JOB],
    );
    assert.deepEqual(r, [{ job_class: 'system', api_enqueue: false }]);
  });

  test('before the first refresh the feed is empty and marked stale', async () => {
    const feed = await t.k.db.withScope(adminScope(), (tx) => readOpsFeed(tx, false));
    assert.equal(feed.generatedAt, null);
    assert.equal(feed.stale, true);
    assert.deepEqual(feed.integrations, []);
    assert.equal(feed.summary.deadLetters, 0);
  });

  describe('refresh from real sources', () => {
    let down: string;
    let ok: string;
    before(async () => {
      down = await mkConnection('sms', 'down');
      ok = await mkConnection('email', 'ok');
      // `down`: 2 failures + 1 ok in the last 5 minutes; one more failure 30 minutes ago (counts in the hour only); a rejected call counts nowhere.
      await mkCall(down, 'error', '1 minute');
      await mkCall(down, 'timeout', '2 minutes');
      await mkCall(down, 'ok', '4 minutes');
      await mkCall(down, 'error', '30 minutes');
      await mkCall(down, 'rejected', '1 minute');
      await mkCall(down, 'pending', '1 minute');
      await mkCall(ok, 'ok', '10 seconds');
      await mkCall(ok, 'ok', '2 hours');
      // another organisation's connection must not appear
      await mkConnection('push', 'ok', ORG2);

      await mkJob('notifications.send', 'ready');
      await mkJob('notifications.send', 'running');
      await mkJob('notifications.send', 'running_last', { connectionId: down });
      await mkJob('notifications.send', 'failed');
      await mkJob('notifications.send', 'dead', { connectionId: down });
      await mkJob('notifications.send', 'dead', { connectionId: down });
      await mkJob('scheduling.expire_holds', 'ready');

      // calendars: one fresh, one stale
      for (const [p, ago] of [
        [t.doctor.seeded.principalId, '2 minutes'],
        [t.admin.seeded.principalId, '3 hours'],
      ] as const)
        await saWrite(
          t.k,
          `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at)
           VALUES ($1, $2, tstzrange(now() + interval '1 day', now() + interval '1 day 1 hour'), 'google', $3, now() - $4::interval)`,
          [ORG, p, Buffer.from(randomHash()), ago],
        );

      // alerts: two open (one older), one escalated, one acknowledged (excluded)
      const staff = t.doctor.seeded.principalId;
      const alert = async (
        type: string,
        sev: string,
        status: string,
        age: string,
        patient: string | null,
      ) =>
        saWrite(
          t.k,
          `INSERT INTO notifications.staff_alert (id, organisation_id, type, severity, patient_id, resource_type, resource_id, target_kind,
             target_principal_ids, status, escalation_level, escalate_at, acknowledged_by, acknowledged_at, created_at)
           VALUES ($1, $2, $3, $4, $5, 'thing', $1, 'principal', ARRAY[$6::uuid], $7, $8,
             NULL, $9, $10, now() - $11::interval)`,
          [
            uuid(),
            ORG,
            type,
            sev,
            patient,
            staff,
            status,
            status === 'escalated' ? 1 : 0,
            status === 'acknowledged' ? staff : null,
            status === 'acknowledged' ? new Date() : null,
            age,
          ],
        );
      await alert('integration_down', 'high', 'open', '5 minutes', null);
      await alert('integration_down', 'high', 'open', '20 minutes', null);
      await alert('audit_anchor_mismatch', 'critical', 'escalated', '1 hour', null);
      await alert('scope_drift', 'low', 'acknowledged', '1 hour', null);
    });

    test('the integration health model shows circuit state, error rates, last success and dead letters', async () => {
      const r = await refresh();
      assert.equal(r.integrations, 2);
      const rows = await q<Record<string, unknown>>(
        `SELECT * FROM reporting.ops_integration_health ORDER BY kind`,
      );
      assert.equal(rows.length, 2, "ORG-2's connection is not in the model");
      const d = rows.find((x) => x['connection_id'] === down) as Record<string, unknown>;
      assert.equal(d['circuit_state'], 'open');
      assert.equal(d['health'], 'down');
      assert.deepEqual(
        [d['calls_5m'], d['failures_5m'], Number(d['error_rate_5m'])],
        [3, 2, 0.6667],
      );
      assert.deepEqual([d['calls_1h'], d['failures_1h'], Number(d['error_rate_1h'])], [4, 3, 0.75]);
      assert.equal(d['dead_letters'], 2);
      assert.ok(d['last_success_at'] instanceof Date);
      const o = rows.find((x) => x['connection_id'] === ok) as Record<string, unknown>;
      assert.equal(o['circuit_state'], 'closed');
      assert.deepEqual([o['calls_5m'], o['failures_5m'], Number(o['error_rate_5m'])], [1, 0, 0]);
      assert.equal(o['calls_1h'], 1);
      assert.equal(o['dead_letters'], 0);
    });

    test('the queue model counts ready, running, failed and dead per job type', async () => {
      const rows = await q<Record<string, unknown>>(
        `SELECT task_identifier, ready, running, failed, dead, oldest_ready_age_s FROM reporting.ops_queue ORDER BY task_identifier`,
      );
      const n = rows.find((x) => x['task_identifier'] === 'notifications.send') as Record<
        string,
        unknown
      >;
      assert.deepEqual([n['ready'], n['running'], n['failed'], n['dead']], [1, 2, 1, 2]);
      assert.ok(Number(n['oldest_ready_age_s']) >= 119);
      const s = rows.find((x) => x['task_identifier'] === 'scheduling.expire_holds') as Record<
        string,
        unknown
      >;
      assert.deepEqual([s['ready'], s['running'], s['failed'], s['dead']], [1, 0, 0, 0]);
    });

    test('the calendar model flags the stale clinician by calendar_stale_minutes', async () => {
      const rows = await q<{ stale: boolean; stale_after_minutes: number }>(
        `SELECT stale, stale_after_minutes FROM reporting.ops_calendar_staleness ORDER BY stale`,
      );
      assert.deepEqual(rows, [
        { stale: false, stale_after_minutes: 15 },
        { stale: true, stale_after_minutes: 15 },
      ]);
    });

    test('the alert backlog groups open and escalated alerts and leaves acknowledged ones out', async () => {
      const rows = await q<Record<string, unknown>>(
        `SELECT alert_type, severity, status, alerts, oldest_age_s FROM reporting.ops_alert_backlog ORDER BY alert_type`,
      );
      assert.equal(rows.length, 2);
      const a = rows.find((x) => x['alert_type'] === 'integration_down') as Record<string, unknown>;
      assert.deepEqual([a['severity'], a['status'], a['alerts']], ['high', 'open', 2]);
      assert.ok(Number(a['oldest_age_s']) >= 1199);
      const e = rows.find((x) => x['alert_type'] === 'audit_anchor_mismatch') as Record<
        string,
        unknown
      >;
      assert.deepEqual([e['severity'], e['status'], e['alerts']], ['critical', 'escalated', 1]);
    });

    test('the compliance summary always has its six zero-or-more rows', async () => {
      const rows = await q<{ metric: string; age_bucket: string; grants: number }>(
        `SELECT metric, age_bucket, grants FROM reporting.compliance_btg_summary ORDER BY metric, age_bucket`,
      );
      assert.equal(rows.length, 5);
      assert.ok(rows.every((r) => r.grants === 0));
    });

    test('break-the-glass grants are counted by state and age', async () => {
      const mk = (ago: string, review: string, revoked: boolean, expiresIn: string) =>
        saWrite(
          t.k,
          `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason,
             opened_at, expires_at, revoked_at, review_status)
           VALUES ($1, $2, $3, $4, 'google', $5, 'synthetic reason for test', now() - $6::interval, now() + $7::interval,
             CASE WHEN $8 THEN now() END, $9)`,
          [
            uuid(),
            ORG,
            t.doctor.seeded.principalId,
            t.doctor.seeded.personId,
            uuid(),
            ago,
            expiresIn,
            revoked,
            review,
          ],
        );
      await mk('2 hours', 'pending', false, '1 hour');
      await mk('3 days', 'pending', false, '1 hour');
      await mk('10 days', 'pending', true, '-1 day');
      await mk('10 days', 'justified', false, '-1 day');
      await refresh();
      const rows = await q<{ metric: string; age_bucket: string; grants: number }>(
        `SELECT metric, age_bucket, grants FROM reporting.compliance_btg_summary ORDER BY metric, age_bucket`,
      );
      const m = Object.fromEntries(rows.map((r) => [`${r.metric}/${r.age_bucket}`, r.grants]));
      assert.deepEqual(m, {
        'open_grants/all': 2,
        'pending_reviews/1d_to_7d': 1,
        'pending_reviews/all': 3,
        'pending_reviews/gt_7d': 1,
        'pending_reviews/lt_1d': 1,
      });
    });

    test('the models are replaced as a whole: what no longer exists disappears, what changed is updated', async () => {
      // A connection is never deleted by the application; the foreign-key check on secret_ref needs a right app_owner does not hold, so the
      // row is removed with triggers and constraints off (superuser, test only) to prove the model drops what the source no longer has.
      await t.k.sa.query('BEGIN');
      await t.k.sa.query('SET LOCAL session_replication_role = replica');
      await t.k.sa.query('DELETE FROM integration_core.connection WHERE id = $1', [down]);
      await t.k.sa.query('COMMIT');
      await q(
        `DELETE FROM queue._private_jobs WHERE task_id IN (SELECT id FROM queue._private_tasks WHERE identifier = 'scheduling.expire_holds')`,
      );
      await refresh();
      assert.deepEqual(
        (
          await q<{ connection_id: string }>(
            `SELECT connection_id FROM reporting.ops_integration_health`,
          )
        ).map((r) => r.connection_id),
        [ok],
      );
      assert.equal(
        (
          await q(
            `SELECT 1 FROM reporting.ops_queue WHERE task_identifier = 'scheduling.expire_holds'`,
          )
        ).length,
        0,
      );
      const stamps = await q<{ n: number }>(
        `SELECT count(DISTINCT refreshed_at)::int AS n FROM (
           SELECT refreshed_at FROM reporting.ops_integration_health UNION ALL SELECT refreshed_at FROM reporting.ops_queue
           UNION ALL SELECT refreshed_at FROM reporting.ops_calendar_staleness UNION ALL SELECT refreshed_at FROM reporting.ops_alert_backlog
           UNION ALL SELECT refreshed_at FROM reporting.compliance_btg_summary) s`,
      );
      assert.equal(stamps[0]?.n, 1, 'one transaction stamped every model');
    });

    test('concurrent refreshes serialise and leave one consistent set', async () => {
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => refresh()));
      assert.ok(
        results.every((r) => r.status === 'fulfilled'),
        JSON.stringify(results.filter((r) => r.status === 'rejected')),
      );
      assert.equal((await q(`SELECT 1 FROM reporting.ops_integration_health`)).length, 1);
      assert.equal(
        (
          await q<{ n: number }>(
            `SELECT count(DISTINCT refreshed_at)::int AS n FROM reporting.ops_queue`,
          )
        )[0]?.n,
        1,
      );
    });

    test('a failed refresh (missing or invalid setting) rolls back and leaves the previous models untouched', async () => {
      const before = await q(`SELECT * FROM reporting.ops_queue ORDER BY task_identifier`);
      await assert.rejects(
        runRefreshOps({ db: t.k.wdb, staleMinutes: () => Promise.resolve(0) }, ORG),
        /calendar_stale_minutes/,
      );
      await assert.rejects(
        runRefreshOps(
          { db: t.k.wdb, staleMinutes: () => Promise.reject(new Error('setting missing')) },
          ORG,
        ),
        /setting missing/,
      );
      assert.deepEqual(
        await q(`SELECT * FROM reporting.ops_queue ORDER BY task_identifier`),
        before,
      );
    });
  });

  describe('the operations feed (GET /api/v1/admin/reports/ops)', () => {
    before(async () => {
      await refresh();
    });

    test('an org admin sees dead letters, circuit state and the alert backlog; no compliance section', async () => {
      const r = await t.get(t.admin);
      assert.equal(r.status, 200, r.body);
      assert.equal(r.headers['cache-control'], 'no-store');
      const f = r.json() as unknown as OpsFeed;
      assert.equal(f.stale, false);
      assert.equal(f.summary.deadLetters, 2);
      assert.equal(f.summary.alertBacklog, 3);
      assert.equal(f.summary.staleCalendars, 1);
      assert.equal(f.integrations.length, 1);
      assert.equal(f.integrations[0]?.circuitState, 'closed');
      assert.ok(
        f.alertBacklog.some((a) => a.type === 'audit_anchor_mismatch' && a.status === 'escalated'),
      );
      assert.equal('compliance' in f, false);
    });

    test('a compliance officer also gets the break-the-glass summary', async () => {
      const r = await t.get(t.compliance);
      assert.equal(r.status, 200, r.body);
      const f = r.json() as unknown as OpsFeed;
      assert.equal(f.compliance?.btg.length, 5);
      assert.equal(f.compliance?.btg.find((b) => b.metric === 'open_grants')?.grants, 2);
    });

    test('the feed turns stale when the models are older than three minutes', async () => {
      await q(
        `UPDATE reporting.ops_integration_health SET refreshed_at = now() - interval '${FEED_STALE_AFTER_S + 60} seconds'`,
      );
      await q(
        `UPDATE reporting.ops_queue SET refreshed_at = now() - interval '${FEED_STALE_AFTER_S + 60} seconds'`,
      );
      await q(
        `UPDATE reporting.ops_calendar_staleness SET refreshed_at = now() - interval '${FEED_STALE_AFTER_S + 60} seconds'`,
      );
      await q(
        `UPDATE reporting.ops_alert_backlog SET refreshed_at = now() - interval '${FEED_STALE_AFTER_S + 60} seconds'`,
      );
      const f = (await t.get(t.admin)).json() as unknown as OpsFeed;
      assert.equal(f.stale, true);
      await refresh();
      assert.equal(((await t.get(t.admin)).json() as unknown as OpsFeed)['stale'], false);
    });

    test('refused without a session (401), for a staff doctor (403), and for an admin role without reporting.ops.read (403)', async () => {
      assert.equal((await t.get(undefined)).status, 401);
      assert.equal((await t.get(t.doctor)).status, 403);
      assert.equal((await t.get(t.noPerm)).status, 403);
    });

    test('the feed carries no patient data: no patient ID of any alert or grant appears', async () => {
      await saWrite(
        t.k,
        `INSERT INTO notifications.staff_alert (id, organisation_id, type, severity, patient_id, resource_type, resource_id, target_kind, target_principal_ids, status)
         VALUES ($1, $2, 'red_flag', 'critical', $3, 'thing', $1, 'principal', ARRAY[$4::uuid], 'open')`,
        [uuid(), ORG, CANARY_PATIENT, t.doctor.seeded.principalId],
      );
      await refresh();
      for (const s of [t.admin, t.compliance])
        assert.ok(!(await t.get(s)).body.includes(CANARY_PATIENT));
      const cols = await q<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'reporting'
           AND (column_name ~ 'patient|person|principal|name|email|payload|last_error|error_text|error_message|reason|resource' AND column_name <> 'clinician_principal_id')`,
      );
      assert.deepEqual(cols, []);
    });
  });

  describe('row-level security and grants (M-1..M-4)', () => {
    test('every reporting table is under FORCE ROW LEVEL SECURITY and owned by app_owner', async () => {
      const rows = await q<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
      }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind IN ('r','p') ORDER BY 1`,
      );
      assert.equal(rows.length, ALL_TABLES.length);
      for (const r of rows)
        assert.deepEqual(
          [r.relrowsecurity, r.relforcerowsecurity, r.owner],
          [true, true, 'app_owner'],
        );
    });

    test('no policy is for PUBLIC and none matches the anonymous or public audience', async () => {
      const pol = await q<{ policyname: string; roles: string[]; qual: string }>(
        `SELECT policyname, roles::text[] AS roles, qual FROM pg_policies WHERE schemaname = 'reporting'`,
      );
      assert.ok(pol.length >= 10);
      for (const p of pol) {
        assert.ok(!p.roles.includes('public'), p.policyname);
        assert.ok(
          p.roles.every((r) => ['app_api', 'app_worker', 'reporting_ro'].includes(r)),
          p.policyname,
        );
      }
    });

    test('app_api: a staff caller outside the admin realm, an unscoped caller and another organisation read nothing', async () => {
      const read = (scope: ScopeSettings) =>
        t.k.db.withScope(scope, async (tx) =>
          Promise.all(
            ALL_TABLES.map(
              async (n) => (await tx.query(`SELECT 1 FROM reporting.${n}`)).rows.length,
            ),
          ),
        );
      assert.ok(
        (await read(adminScope({ phiAccess: 'limited', complianceScopes: ['btg_grants'] }))).every(
          (n) => n > 0,
        ),
      );
      assert.deepEqual(
        await read({ audience: 'staff', realm: 'google', orgId: ORG, locationIds: [] }),
        [0, 0, 0, 0, 0],
      );
      assert.deepEqual(await read(adminScope({ orgId: ORG2 })), [0, 0, 0, 0, 0]);
      assert.deepEqual(
        await read({ audience: 'patient', realm: 'patient_pool', orgId: ORG, patientIds: [] }),
        [0, 0, 0, 0, 0],
      );
      // the compliance summary needs the slice AND limited PHI access
      assert.equal((await read(adminScope()))[4], 0);
      assert.equal(
        (await read(adminScope({ phiAccess: 'limited', complianceScopes: ['audit_events'] })))[4],
        0,
      );
      assert.ok(
        ((await read(adminScope({ phiAccess: 'limited', complianceScopes: ['btg_grants'] })))[4] ??
          0) > 0,
      );
    });

    test('app_api cannot write any model', async () => {
      for (const sql of [
        `INSERT INTO reporting.ops_queue (organisation_id, task_identifier, ready, running, failed, dead, refreshed_at) VALUES ('${ORG}', 'x.y', 0, 0, 0, 0, now())`,
        `UPDATE reporting.ops_queue SET dead = 0`,
        `DELETE FROM reporting.ops_queue`,
      ])
        await assert.rejects(
          t.k.db.withScope(adminScope(), (tx) => tx.query(sql)),
          (e: { code?: string }) => e.code === '42501',
        );
    });

    test('app_worker writes only as an organisation-scope system job of its own organisation', async () => {
      const ins = `INSERT INTO reporting.ops_queue (organisation_id, task_identifier, ready, running, failed, dead, refreshed_at) VALUES ($1, 'x.y', 0, 0, 0, 0, now())`;
      await assert.rejects(
        t.k.wdb.withScope({ ...refreshScope(ORG), jobScope: 'patients', jobPatientIds: [] }, (tx) =>
          tx.query(ins, [ORG]),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        t.k.wdb.withScope(refreshScope(ORG), (tx) => tx.query(ins, [ORG2])),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        t.k.wdb.withScope(adminScope(), (tx) => tx.query(ins, [ORG])),
        (e: { code?: string }) => e.code === '42501',
      );
    });

    test('reporting_ro reads the four operations tables of its organisation only', async () => {
      for (const n of OPS_TABLES) {
        const own = await asReportingRo(
          ORG,
          async (c) => (await c.query(`SELECT * FROM reporting.${n}`)).rows.length,
        );
        assert.ok(own > 0, n);
        assert.equal(
          await asReportingRo(
            ORG2,
            async (c) => (await c.query(`SELECT * FROM reporting.${n}`)).rows.length,
          ),
          0,
          n,
        );
        assert.equal(
          await asReportingRo(
            undefined,
            async (c) => (await c.query(`SELECT * FROM reporting.${n}`)).rows.length,
          ),
          0,
          n,
        );
        for (const aud of [null, 'anonymous', 'public', 'staff', 'patient'])
          assert.equal(
            await asReportingRo(
              ORG,
              async (c) => (await c.query(`SELECT * FROM reporting.${n}`)).rows.length,
              aud,
            ),
            0,
            `${n} as audience ${aud}`,
          );
      }
      assert.ok(
        (await asReportingRo(
          ORG,
          async (c) => (await c.query(`SELECT * FROM reporting.ops_queue`)).rows.length,
        )) > 0,
      );
      assert.ok(
        (await asReportingRo(
          ORG,
          async (c) =>
            (await c.query(`SELECT * FROM reporting.ops_integration_health`)).rows.length,
        )) > 0,
      );
    });

    test('reporting_ro is refused on the compliance summary, on every PHI and operational source table and on writes', async () => {
      const refused = [
        'reporting.compliance_btg_summary',
        'audit.btg_grant',
        'audit.event',
        'patient.patient',
        'identity.principal',
        'identity.session',
        'notifications.staff_alert',
        'integration_core.connection',
        'integration_core.outbound_call',
        'scheduling.busy_block',
        'kernel.setting',
        'queue.jobs',
      ];
      for (const tbl of refused)
        await assert.rejects(
          asReportingRo(ORG, (c) => c.query(`SELECT * FROM ${tbl}`)),
          (e: { code?: string }) => e.code === '42501' || e.code === '3F000',
          tbl,
        );
      for (const n of ALL_TABLES)
        for (const sql of [
          `INSERT INTO reporting.${n} SELECT * FROM reporting.${n}`,
          `UPDATE reporting.${n} SET refreshed_at = now()`,
          `DELETE FROM reporting.${n}`,
        ])
          await assert.rejects(
            asReportingRo(ORG, (c) => c.query(sql)),
            (e: { code?: string }) => e.code === '42501',
            sql,
          );
    });

    test('reporting_ro holds nothing outside the reporting operations tables (privilege listing)', async () => {
      const rows = await q<{ object: string }>(
        `SELECT c.oid::regclass::text AS object FROM pg_class c
         WHERE c.relkind IN ('r','p','v','m','S','f') AND c.relnamespace::regnamespace::text !~ '^(pg_|information_schema)'
           AND (has_table_privilege('reporting_ro', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                           AND has_column_privilege('reporting_ro', c.oid, a.attnum, 'SELECT,INSERT,UPDATE,REFERENCES')))
         ORDER BY 1`,
      );
      assert.deepEqual(
        rows.map((r) => r.object),
        OPS_TABLES.map((n) => `reporting.${n}`).sort(),
      );
    });
  });
});

const CANARY_PATIENT = '00000000-0000-7000-8000-00000000c0de';
const randomHash = (): string =>
  `hash-${Math.random().toString(36).slice(2)}-${Date.now()}-padding`;
