// Real-database tests for BE-01 (audit module, API side) on PostgreSQL 17 with the roles and migrations of the real
// pipeline: TC-AU-01..07 automated parts, TC-AU-04 corrected per SA-TC-06, BTG, scope and role boundaries.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/audit/audit.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KernelDb } from '@ehr/kernel';
import type { ScopeSettings, Tx } from '@ehr/kernel';
import {
  AuditEnvelopeError,
  AuditService,
  ExportRateLimitedError,
  ExportTooLargeError,
  SelfReviewError,
  type AuditEnvelope,
} from './index.js';

// `pg` has no type declarations in this workspace.
const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;

const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
// Source and compiled files sit at different depths: walk up to the repository root (it holds db/tools/migrate.mjs).
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be01_api_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

const ORG = '00000000-0000-7000-8000-0000000000a1';
const ORG2 = '00000000-0000-7000-8000-0000000000a2';
const DOC_P = '00000000-0000-7000-8000-0000000000c1';
const DOC_PERSON = '00000000-0000-7000-8000-0000000000d1';
const CMP_P = '00000000-0000-7000-8000-0000000000c2';
const CMP_PERSON = '00000000-0000-7000-8000-0000000000d2';
const OTHER_P = '00000000-0000-7000-8000-0000000000c3';
const PAT1 = '00000000-0000-7000-8000-0000000000e1';
const PAT2 = '00000000-0000-7000-8000-0000000000e2';
const REQ = (n: number): string => `00000000-0000-7000-8000-00000000f${String(n).padStart(3, '0')}`;

const doctor: ScopeSettings = {
  audience: 'staff',
  realm: 'google',
  orgId: ORG,
  principalId: DOC_P,
  personId: DOC_PERSON,
};
const compliance: ScopeSettings = {
  audience: 'staff',
  realm: 'admin_pool',
  orgId: ORG,
  principalId: CMP_P,
  personId: CMP_PERSON,
  phiAccess: 'limited',
  complianceScopes: ['audit_events', 'btg_grants'],
};

const rejectsCode = (p: Promise<unknown>, code: string, what: string): Promise<void> =>
  assert.rejects(p, (e: { code?: string; message?: string }) => {
    assert.equal(e.code, code, `${what}: expected SQLSTATE ${code}, got ${e.code} (${e.message})`);
    return true;
  });

class FakeQueue {
  enqueued: { job: string; payload: Record<string, unknown>; key?: string }[] = [];
  published: { event: string; payload: Record<string, unknown> }[] = [];
  enqueue(
    _tx: Tx,
    job: string,
    payload: Record<string, unknown>,
    o: { jobKey?: string } = {},
  ): Promise<void> {
    this.enqueued.push({ job, payload, ...(o.jobKey === undefined ? {} : { key: o.jobKey }) });
    return Promise.resolve();
  }
  publish(_tx: Tx, event: string, payload: Record<string, unknown>): Promise<string[]> {
    this.published.push({ event, payload });
    return Promise.resolve([]);
  }
}

describe('audit module on PostgreSQL 17 (BE-01)', () => {
  let admin: {
    query(s: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  };
  let pool: { connect(): Promise<never>; end(): Promise<void> };
  let db: KernelDb;
  const queue = new FakeQueue();
  const denialAlerts: (string | null)[] = [];
  const logs: string[] = [];
  const audit = new AuditService({
    queue: queue as never,
    logger: { error: (m: string) => logs.push(m) } as never,
    onDenialWriteFailure: (i) => denialAlerts.push(i.requestId),
  });

  const adminCount = async (where = 'true'): Promise<number> =>
    Number((await admin.query(`SELECT count(*) AS n FROM audit.event WHERE ${where}`)).rows[0]?.n);

  before(async () => {
    const a = new pg.Client({ connectionString: adminUrl }).on('error', () => undefined);
    await a.connect();
    await a.query(`CREATE DATABASE ${dbName}`);
    await a.end();
    const env = {
      PATH: process.env.PATH,
      EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl).username),
      EHR_DB_MIGRATE_URL: urlFor('app_owner'),
    };
    for (const cmd of ['bootstrap', 'migrate'])
      execFileSync(process.execPath, [`${root}db/tools/migrate.mjs`, cmd], {
        env,
        stdio: 'inherit',
      });
    admin = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) }).on(
      'error',
      () => undefined,
    );
    await (admin as never as { connect(): Promise<void> }).connect();
    // Fault injection for TC-AU-02/03: a trigger that fails the audit insert while the session flag is on.
    await admin.query(`CREATE FUNCTION public.audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('test.audit_fault', true) = 'on' THEN RAISE EXCEPTION 'injected audit failure' USING ERRCODE = 'XX000'; END IF;
        RETURN NEW;
      END $$`);
    await admin.query(
      `CREATE TRIGGER aaa_fault BEFORE INSERT ON audit.event FOR EACH ROW EXECUTE FUNCTION public.audit_fault()`,
    );
    pool = new pg.Pool({ connectionString: urlFor('app_api'), max: 6 }).on(
      'error',
      () => undefined,
    );
    db = new KernelDb(pool as never);
  });
  after(async () => {
    await pool?.end();
    await admin?.end();
    const a = new pg.Client({ connectionString: adminUrl }).on('error', () => undefined);
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  const envelope = (n: number, over: Partial<AuditEnvelope> = {}): AuditEnvelope => ({
    requestId: REQ(n),
    action: 'view',
    resourceType: 'clinical.note',
    resourceId: PAT2,
    patientId: PAT1,
    ip: '203.0.113.7',
    userAgent: 'test-agent/1.0',
    ...over,
  });

  describe('TC-AU-01: record() writes the envelope in the caller transaction', () => {
    test('actor, realm, audience and organisation come from the scope, not from the caller', async () => {
      const id = await db.withScope(doctor, (tx) => audit.record(tx, envelope(1)));
      const r = (await admin.query(`SELECT * FROM audit.event WHERE event_id = $1`, [id])).rows[0];
      assert.ok(r);
      assert.equal(r.actor_principal_id, DOC_P);
      assert.equal(r.actor_person_id, DOC_PERSON);
      assert.equal(r.realm, 'google');
      assert.equal(r.audience, 'staff');
      assert.equal(r.organisation_id, ORG);
      assert.equal(r.action, 'view');
      assert.equal(r.outcome, 'allowed');
      assert.equal(r.denial_reason, null);
      assert.equal(r.ip, '203.0.113.7');
      assert.equal(r.patient_id, PAT1);
      assert.equal(r.request_id, REQ(1));
      // No clinical values anywhere in the row: the envelope has no field that could carry them.
      assert.ok(!('body' in r) && !('value' in r));
    });

    test('rolls back with the caller: a failed business transaction leaves no audit row', async () => {
      const before = await adminCount(`request_id = '${REQ(2)}'`);
      await assert.rejects(
        db.withScope(doctor, async (tx) => {
          await audit.record(tx, envelope(2));
          throw new Error('business failure after the audit insert');
        }),
      );
      assert.equal(await adminCount(`request_id = '${REQ(2)}'`), before);
    });

    test('print, search, export, download and update actions are all accepted; the closed list refuses others', async () => {
      await db.withScope(doctor, async (tx) => {
        for (const [i, action] of (
          ['search', 'print', 'download', 'update', 'sign'] as const
        ).entries())
          await audit.record(tx, envelope(10 + i, { action }));
      });
      await assert.rejects(
        db.withScope(doctor, (tx) => audit.record(tx, envelope(3, { action: 'delete' as never }))),
        AuditEnvelopeError,
      );
      await assert.rejects(
        db.withScope(doctor, (tx) => audit.record(tx, envelope(3, { action: 'denied' as never }))),
        AuditEnvelopeError,
      );
    });

    test('envelope rules: reason required for export and BTG, request or job id required, secrets only as version ids', async () => {
      const bad = async (e: AuditEnvelope, field: string): Promise<void> => {
        await assert.rejects(
          db.withScope(doctor, (tx) => audit.record(tx, e)),
          (err: AuditEnvelopeError) => {
            assert.ok(err instanceof AuditEnvelopeError);
            assert.ok(err.fields.includes(field), `${field} in ${err.fields.join(',')}`);
            return true;
          },
        );
      };
      await bad(envelope(4, { action: 'export' }), 'reason');
      await bad(envelope(4, { action: 'btg_open', reason: '  ' }), 'reason');
      await bad({ ...envelope(4), requestId: null }, 'jobId');
      await bad(envelope(4, { change: { apiKey: 'sk-live-123' } }), 'change');
      await bad(envelope(4, { change: { nested: { client_secret: 'x' } } }), 'change');
      await bad(envelope(4, { ip: 'not-an-ip' }), 'ip');
      await bad(envelope(4, { reason: 'x'.repeat(501) }), 'reason');
      await bad(envelope(4, { patientId: 'nope' }), 'patientId');
      // A worker job has no request id; secrets as version ids are accepted.
      await db.withScope({ audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }, () =>
        Promise.resolve(),
      );
      await db.withScope(doctor, (tx) =>
        audit.record(tx, {
          ...envelope(4, {
            action: 'config_change',
            change: { secretVersionId: 'v-123', before: 1, after: 2 },
          }),
        }),
      );
    });

    test('RLS: another organisation, the anonymous audience and a missing scope cannot write', async () => {
      await rejectsCode(
        db.withScope({ ...doctor, orgId: ORG2 }, (tx) =>
          tx.query(
            `INSERT INTO audit.event (event_id, organisation_id, request_id, realm, audience, action, resource_type, outcome)
             VALUES (gen_random_uuid(), $1, $2, 'google', 'staff', 'view', 'x.y', 'allowed')`,
            [ORG, REQ(5)],
          ),
        ),
        '42501',
        'cross-organisation insert',
      );
      await rejectsCode(
        db.withScope({ audience: 'anonymous', realm: 'none', orgId: ORG }, (tx) =>
          audit.record(tx, envelope(5)),
        ),
        '42501',
        'anonymous insert',
      );
      await rejectsCode(
        db.withScope({ audience: 'public', orgId: ORG, realm: 'none' }, (tx) =>
          audit.record(tx, envelope(5)),
        ),
        '42501',
        'public insert',
      );
    });

    test('concurrent writers do not wait on each other: 40 records over 6 connections all commit', async () => {
      const before = await adminCount(
        `request_id::text LIKE '00000000-0000-7000-8000-00000000f9%'`,
      );
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          db.withScope(doctor, (tx) => audit.record(tx, envelope(900 + i))),
        ),
      );
      assert.equal(
        await adminCount(`request_id::text LIKE '00000000-0000-7000-8000-00000000f9%'`),
        before + 40,
      );
    });
  });

  describe('TC-AU-02: an audit failure rolls the business change back', () => {
    const settingKey = 'tc_au_02';
    const writeSetting = (tx: Tx, key: string): Promise<unknown> =>
      tx.query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, $2, '1'::jsonb, 'test')`,
        [ORG, key],
      );
    test('with injection: the change and the read both fail and nothing persists; without: both commit', async () => {
      await assert.rejects(
        db.withScope(compliance, async (tx) => {
          await tx.query(`SELECT set_config('test.audit_fault', 'on', true)`);
          await writeSetting(tx, settingKey);
          await audit.record(
            tx,
            envelope(20, { action: 'update', resourceType: 'kernel.setting' }),
          );
        }),
        (e: { code?: string }) => e.code === 'XX000',
      );
      assert.equal(
        (
          await admin.query(`SELECT count(*)::int AS n FROM kernel.setting WHERE key = $1`, [
            settingKey,
          ])
        ).rows[0]?.n,
        0,
      );
      await db.withScope(compliance, async (tx) => {
        await writeSetting(tx, settingKey);
        await audit.record(tx, envelope(21, { action: 'update', resourceType: 'kernel.setting' }));
      });
      assert.equal(
        (
          await admin.query(`SELECT count(*)::int AS n FROM kernel.setting WHERE key = $1`, [
            settingKey,
          ])
        ).rows[0]?.n,
        1,
      );
      assert.equal(await adminCount(`request_id = '${REQ(21)}'`), 1);
    });
  });

  describe('TC-AU-03: the denial path', () => {
    test('a denial is written in a separate transaction with its reason', async () => {
      const res = await audit.recordDenied(db, doctor, {
        requestId: REQ(30),
        resourceType: 'patient.patient',
        resourceId: PAT2,
        denialReason: 'not_visible',
        ip: '203.0.113.9',
      });
      assert.deepEqual(res, { recorded: true });
      const r = (
        await admin.query(
          `SELECT action, outcome, denial_reason FROM audit.event WHERE request_id = $1`,
          [REQ(30)],
        )
      ).rows[0];
      assert.deepEqual(
        { ...r },
        { action: 'denied', outcome: 'denied', denial_reason: 'not_visible' },
      );
    });

    test('the business transaction can roll back first and the denial row still persists', async () => {
      await assert.rejects(
        db.withScope(doctor, async () => {
          throw new Error('policy refused');
        }),
      );
      const res = await audit.recordDenied(db, doctor, {
        requestId: REQ(31),
        resourceType: 'patient.patient',
        denialReason: 'forbidden',
      });
      assert.equal(res.recorded, true);
    });

    test('if the denial write fails: no throw (fail closed), logged by class, operations alert hook called', async () => {
      const alertsBefore = denialAlerts.length;
      // A role-level setting reaches only NEW connections, so the injected write runs on a fresh pool.
      await admin.query(`ALTER ROLE app_api SET test.audit_fault = 'on'`);
      const fresh = new pg.Pool({ connectionString: urlFor('app_api'), max: 1 }).on(
        'error',
        () => undefined,
      );
      let res;
      try {
        res = await audit.recordDenied(new KernelDb(fresh as never), doctor, {
          requestId: REQ(33),
          resourceType: 'patient.patient',
          denialReason: 'forbidden',
        });
      } finally {
        await admin.query(`ALTER ROLE app_api RESET test.audit_fault`);
        await fresh.end();
      }
      assert.equal(res.recorded, false);
      assert.equal(denialAlerts.length, alertsBefore + 1);
      assert.equal(denialAlerts.at(-1), REQ(33));
      assert.ok(logs.includes('audit denial write failed'));
      assert.equal(await adminCount(`request_id = '${REQ(33)}'`), 0);
    });

    test('an envelope that is itself invalid is reported the same way: never thrown to the denial path', async () => {
      const res = await audit.recordDenied(db, doctor, {
        requestId: REQ(34),
        resourceType: 'NOT VALID',
        denialReason: 'forbidden',
      });
      assert.equal(res.recorded, false);
    });
  });

  describe('TC-AU-04 (corrected per SA-TC-06): unbounded transactions are refused', () => {
    const insertAs = async (user: string, timeout: string | null): Promise<void> => {
      const c = new pg.Client({ connectionString: urlFor(user) }).on('error', () => undefined);
      await c.connect();
      try {
        await c.query('BEGIN');
        if (timeout !== null) await c.query(`SET LOCAL transaction_timeout = '${timeout}'`);
        await c.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'staff', true)`,
          [ORG],
        );
        await c.query(
          `INSERT INTO audit.event (event_id, organisation_id, request_id, realm, audience, action, resource_type, outcome)
           VALUES (gen_random_uuid(), $1, $2, 'google', 'staff', 'view', 'x.y', 'allowed')`,
          [ORG, REQ(40)],
        );
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    test('step 1: transaction_timeout unset (0) -> PA001, no row', async () => {
      await rejectsCode(insertAs('app_api', '0'), 'PA001', 'unset');
      assert.equal(await adminCount(`request_id = '${REQ(40)}'`), 0);
    });
    test('step 2: above the bound (61 s, and 120 s) -> PA001, no row', async () => {
      await rejectsCode(insertAs('app_api', '61s'), 'PA001', '61 s');
      await rejectsCode(insertAs('app_api', '120s'), 'PA001', '120 s');
      assert.equal(await adminCount(`request_id = '${REQ(40)}'`), 0);
    });
    test('step 3: app_owner -> privilege error 42501 (no INSERT grant), raised before the trigger', async () => {
      await rejectsCode(insertAs('app_owner', '60s'), '42501', 'app_owner');
      assert.equal(await adminCount(`request_id = '${REQ(40)}'`), 0);
    });
    test('step 4 (positive control): at or below the bound -> written; the role-level 60 s of app_api works as set', async () => {
      await insertAs('app_api', '60s');
      assert.equal(await adminCount(`request_id = '${REQ(40)}'`), 1);
      await insertAs('app_api', '5s');
      assert.equal(await adminCount(`request_id = '${REQ(40)}'`), 2);
      await insertAs('app_api', null); // role-level transaction_timeout = 60 s from the bootstrap
      assert.equal(await adminCount(`request_id = '${REQ(40)}'`), 3);
    });
  });

  describe('TC-AU-05: nobody can UPDATE or DELETE an audit row', () => {
    const attempt = async (
      user: string,
      sql: string,
      settings: Record<string, string> = {},
    ): Promise<{ code?: string; message: string }> => {
      const c = new pg.Client({ connectionString: urlFor(user) }).on('error', () => undefined);
      await c.connect();
      try {
        await c.query('BEGIN');
        for (const [k, v] of Object.entries(settings))
          await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
        await c.query(sql);
        return { message: 'statement succeeded' };
      } catch (e) {
        return e as { code?: string; message: string };
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    const scopeSettings = {
      'app.org_id': ORG,
      'app.audience': 'staff',
      'app.realm': 'admin_pool',
      'app.phi_access': 'limited',
      'app.compliance_scopes': 'audit_events,btg_grants',
    };
    for (const table of ['audit.event', 'audit.anchor']) {
      for (const user of ['app_api', 'app_worker', 'app_owner', 'audit_archiver', 'reporting_ro']) {
        test(`${user} cannot UPDATE or DELETE ${table} (privilege error 42501)`, async () => {
          for (const sql of [
            table === 'audit.event'
              ? `UPDATE audit.event SET reason = 'x'`
              : `UPDATE audit.anchor SET row_count = 0`,
            `DELETE FROM ${table}`,
          ]) {
            const r = await attempt(user, sql, scopeSettings);
            assert.equal(r.code, '42501', `${user}: ${sql}: ${r.message}`);
          }
        });
      }
    }
    test('even a superuser is refused by the trigger: UPDATE, DELETE, TRUNCATE on the table and on a partition', async () => {
      const su = new URL(adminUrl).username;
      // A row far in the future lands in the default partition, so its triggers have a row to refuse.
      await db.withScope(doctor, (tx) =>
        tx.query(
          `INSERT INTO audit.event (event_id, occurred_at, organisation_id, request_id, realm, audience, action, resource_type, outcome)
           VALUES (gen_random_uuid(), '2035-01-01T00:00:00Z', $1, $2, 'google', 'staff', 'view', 'x.y', 'allowed')`,
          [ORG, REQ(45)],
        ),
      );
      assert.equal(
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM audit.event_default WHERE request_id = $1`,
            [REQ(45)],
          )
        ).rows[0]?.n,
        1,
      );
      for (const sql of [
        `UPDATE audit.event SET reason = 'tampered'`,
        `DELETE FROM audit.event`,
        `TRUNCATE audit.event`,
        `UPDATE audit.event_y2026m11 SET reason = 'tampered'`,
        `DELETE FROM audit.event_y2026m11`,
        `TRUNCATE audit.event_y2026m11`,
        `UPDATE audit.event_default SET reason = 'tampered'`,
        `TRUNCATE audit.anchor`,
      ]) {
        const r = await attempt(su, sql);
        assert.equal(r.code, '42501', `${sql}: ${r.message}`);
        assert.match(r.message, /append-only/, sql);
      }
    });
    test('no role has INSERT/UPDATE/DELETE/TRUNCATE on any partition; app_owner has no privilege at all on the audit tables', async () => {
      const rows = (
        await admin.query(
          `SELECT c.oid::regclass::text AS t, r.rolname, p AS privilege
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN pg_roles r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
            WHERE n.nspname = 'audit' AND c.relkind IN ('r','p')
              AND r.rolname IN ('app_owner','app_api','app_worker','audit_archiver','reporting_ro')
              AND has_table_privilege(r.oid, c.oid, p)
              AND (c.relispartition OR r.rolname IN ('app_owner','audit_archiver','reporting_ro'))`,
        )
      ).rows;
      assert.deepEqual(rows, []);
    });
    test('the BTG grant is never deleted and its fixed columns never change (trigger, whoever asks)', async () => {
      const su = new URL(adminUrl).username;
      const g = await db.withScope(doctor, (tx) =>
        audit.openBtg(tx, {
          requestId: REQ(50),
          patientId: PAT1,
          reason: 'Emergency cover for the on-call patient',
        }),
      );
      const del = await attempt(su, `DELETE FROM audit.btg_grant WHERE id = '${g.grantId}'`);
      assert.equal(del.code, '42501');
      const upd = await attempt(
        su,
        `UPDATE audit.btg_grant SET patient_id = '${PAT2}' WHERE id = '${g.grantId}'`,
      );
      assert.equal(upd.code, 'PS001');
      const upd2 = await attempt(
        'app_api',
        `UPDATE audit.btg_grant SET reason = 'edited after the fact' WHERE id = '${g.grantId}'`,
        { ...scopeSettings },
      );
      assert.equal(upd2.code, '42501', 'column-level grant: only review_status and revoked_at');
    });
  });

  describe('BTG: grants, activeBtgGrants, review', () => {
    let grantId = '';
    test('openBtg writes the grant, the btg_open audit row (with reason and grant id) and publishes audit.btg_opened', async () => {
      queue.published.length = 0;
      const g = await db.withScope(doctor, (tx) =>
        audit.openBtg(tx, {
          requestId: REQ(60),
          patientId: PAT2,
          reason: 'Covering an unassigned patient in the ward',
          ip: '203.0.113.5',
          userAgent: 'ua',
        }),
      );
      grantId = g.grantId;
      assert.ok(g.expiresAt.getTime() - Date.now() > 3.9 * 3600 * 1000);
      assert.ok(g.expiresAt.getTime() - Date.now() <= 4 * 3600 * 1000 + 5000);
      const ev = (await admin.query(`SELECT * FROM audit.event WHERE request_id = $1`, [REQ(60)]))
        .rows[0];
      assert.equal(ev?.action, 'btg_open');
      assert.equal(ev?.btg_grant_id, grantId);
      assert.equal(ev?.patient_id, PAT2);
      assert.equal(ev?.reason, 'Covering an unassigned patient in the ward');
      assert.deepEqual(
        queue.published.map((p) => p.event),
        ['audit.btg_opened'],
      );
      assert.equal(queue.published[0]?.payload.grantId, grantId);
    });
    test('a reason shorter than 10 characters is refused; a trainee-style scope without a person is refused', async () => {
      await assert.rejects(
        db.withScope(doctor, (tx) =>
          audit.openBtg(tx, { requestId: REQ(61), patientId: PAT2, reason: 'too short' }),
        ),
        AuditEnvelopeError,
      );
      const { personId: _p, ...noPerson } = doctor;
      void _p;
      await assert.rejects(
        db.withScope(noPerson, (tx) =>
          audit.openBtg(tx, {
            requestId: REQ(61),
            patientId: PAT2,
            reason: 'long enough reason here',
          }),
        ),
        (e: { code?: string }) => e.code === 'auth.forbidden',
      );
    });
    test('a principal cannot open a grant for someone else (policy WITH CHECK)', async () => {
      await rejectsCode(
        db.withScope(doctor, (tx) =>
          tx.query(
            `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason, expires_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'google', $4, 'opened for another principal', now() + interval '1 hour')`,
            [ORG, OTHER_P, DOC_PERSON, PAT2],
          ),
        ),
        '42501',
        'grant for another principal',
      );
    });
    test('activeBtgGrants: the holder sees its active grants; others see none; expired and revoked are excluded', async () => {
      await admin.query(
        `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason, opened_at, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'google', $4, 'expired grant for the test', now() - interval '5 hours', now() - interval '1 hour')`,
        [ORG, DOC_P, DOC_PERSON, PAT1],
      );
      await admin.query(
        `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason, expires_at, revoked_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'google', $4, 'revoked grant for the test', now() + interval '2 hours', now())`,
        [ORG, DOC_P, DOC_PERSON, PAT1],
      );
      const mine = await db.withScope(doctor, (tx) => audit.activeBtgGrants(tx, DOC_P));
      assert.ok(mine.some((g) => g.grantId === grantId && g.patientId === PAT2));
      assert.ok(mine.every((g) => g.expiresAt.getTime() > Date.now()));
      assert.equal(
        mine.filter((g) => g.patientId === PAT1).length,
        1,
        'only the open grant of PAT1 from the first test',
      );
      const others = await db.withScope({ ...doctor, principalId: OTHER_P }, (tx) =>
        audit.activeBtgGrants(tx, DOC_P),
      );
      assert.deepEqual(others, [], 'T-PRINCIPAL: another principal cannot read the holder grants');
      const anon = await db.withScope({ audience: 'anonymous', realm: 'none', orgId: ORG }, (tx) =>
        audit.activeBtgGrants(tx, DOC_P),
      );
      assert.deepEqual(anon, []);
    });
    test('review: self-review refused (403 audit.self_review) in the service and by the database trigger', async () => {
      const selfScope: ScopeSettings = { ...compliance, principalId: DOC_P, personId: DOC_PERSON };
      await assert.rejects(
        db.withScope(selfScope, (tx) =>
          audit.reviewBtg(tx, { requestId: REQ(70), grantId, outcome: 'justified' }),
        ),
        SelfReviewError,
      );
      await rejectsCode(
        db.withScope(selfScope, (tx) =>
          tx.query(
            `INSERT INTO audit.btg_review (grant_id, organisation_id, reviewer_person_id, outcome) VALUES ($1, $2, $3, 'justified')`,
            [grantId, ORG, DOC_PERSON],
          ),
        ),
        '23514',
        'trigger reviewer = holder',
      );
    });
    test('review: a staff principal without the btg_grants slice cannot review or see the grant', async () => {
      await assert.rejects(
        db.withScope({ ...doctor, principalId: OTHER_P, personId: CMP_PERSON }, (tx) =>
          audit.reviewBtg(tx, { requestId: REQ(71), grantId, outcome: 'justified' }),
        ),
        (e: { code?: string }) => e.code === 'kernel.not_found',
      );
    });
    test('review: the compliance reviewer records the outcome once; a second review is an invalid transition', async () => {
      await db.withScope(compliance, (tx) =>
        audit.reviewBtg(tx, {
          requestId: REQ(72),
          grantId,
          outcome: 'not_justified',
          note: 'no care relationship',
        }),
      );
      const g = (
        await admin.query(`SELECT review_status, row_version FROM audit.btg_grant WHERE id = $1`, [
          grantId,
        ])
      ).rows[0];
      assert.equal(g?.review_status, 'not_justified');
      assert.equal(Number(g?.row_version), 2);
      assert.equal(
        await adminCount(
          `request_id = '${REQ(72)}' AND action = 'btg_review' AND btg_grant_id = '${grantId}'`,
        ),
        1,
      );
      await assert.rejects(
        db.withScope(compliance, (tx) =>
          audit.reviewBtg(tx, { requestId: REQ(73), grantId, outcome: 'justified' }),
        ),
        (e: { code?: string }) => e.code === 'audit.invalid_transition',
      );
    });
  });

  describe('TC-AU-06: the compliance viewer', () => {
    test('shows who, what, when, from where; no PHI columns; audits the query itself; 31-day cap; slice-only', async () => {
      const from = new Date(Date.now() - 3600_000);
      const to = new Date(Date.now() + 3600_000);
      const res = await db.withScope(compliance, (tx) =>
        audit.searchEvents(tx, { requestId: REQ(80), filter: { from, to, patientId: PAT1 } }),
      );
      assert.ok(res.events.length > 0);
      const e = res.events[0];
      assert.ok(e);
      for (const k of ['actorPersonId', 'action', 'occurredAt', 'ip', 'userAgent', 'resourceType'])
        assert.ok(k in e, k);
      assert.ok(res.events.every((x) => x.patientId === PAT1));
      assert.equal(
        await adminCount(
          `request_id = '${REQ(80)}' AND action = 'view' AND resource_type = 'audit.event'`,
        ),
        1,
      );
      await assert.rejects(
        db.withScope(compliance, (tx) =>
          audit.searchEvents(tx, {
            requestId: REQ(81),
            filter: { from: new Date(Date.now() - 32 * 86400_000), to },
          }),
        ),
        AuditEnvelopeError,
      );
      // A staff principal without the slice sees nothing at all (RLS), not even its own events.
      const none = await db.withScope(doctor, (tx) =>
        audit.searchEvents(tx, { requestId: REQ(82), filter: { from, to } }),
      );
      assert.deepEqual(none.events, []);
      // Admin realm without phi_access=limited, or with another slice, sees nothing.
      for (const s of [
        { ...compliance, phiAccess: 'off' as const },
        { ...compliance, complianceScopes: ['btg_grants'] },
      ]) {
        const r = await db.withScope(s, (tx) =>
          audit.searchEvents(tx, { requestId: REQ(83), filter: { from, to } }),
        );
        assert.deepEqual(r.events, []);
      }
    });
  });

  describe('TC-AU-07: export request is size limited, queued, audited', () => {
    test('over the limit -> 422 audit.export_too_large; within -> job row, export audit row with reason, chunk 0 enqueued', async () => {
      const from = new Date(Date.now() - 86400_000);
      const to = new Date(Date.now() + 3600_000);
      const total = await adminCount();
      await admin.query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'audit_export_max_rows', '5'::jsonb, 'int')`,
        [ORG],
      );
      assert.ok(total > 5);
      await assert.rejects(
        db.withScope(compliance, (tx) =>
          audit.requestExport(tx, {
            requestId: REQ(90),
            filter: { from, to },
            reason: 'annual review',
            elevationId: REQ(91),
          }),
        ),
        ExportTooLargeError,
      );
      assert.equal(
        (await admin.query(`SELECT count(*)::int AS n FROM audit.export_job`)).rows[0]?.n,
        0,
      );
      queue.enqueued.length = 0;
      const { exportId } = await db.withScope(compliance, (tx) =>
        audit.requestExport(tx, {
          requestId: REQ(92),
          filter: { from, to, patientId: PAT2, action: 'btg_open' },
          reason: 'accounting of disclosures',
          elevationId: REQ(91),
        }),
      );
      const job = (await admin.query(`SELECT * FROM audit.export_job WHERE id = $1`, [exportId]))
        .rows[0];
      assert.equal(job?.status, 'queued');
      assert.equal(job?.requested_by_person_id, CMP_PERSON);
      assert.equal(job?.chunks_done, 0);
      const ev = (
        await admin.query(
          `SELECT action, reason, resource_id FROM audit.event WHERE request_id = $1`,
          [REQ(92)],
        )
      ).rows[0];
      assert.deepEqual(
        { ...ev },
        { action: 'export', reason: 'accounting of disclosures', resource_id: exportId },
      );
      assert.deepEqual(queue.enqueued, [
        {
          job: 'audit.export',
          payload: { exportId, organisationId: ORG, chunk: 0 },
          key: `${exportId}:0`,
        },
      ]);
    });
    test('QA-EXEC-F10 / TC-SEC-20: a person is held to audit_export_max_per_hour; parallel requests cannot all pass; a refusal creates no job and enqueues nothing; an export older than an hour does not count', async () => {
      const from = new Date(Date.now() - 86400_000);
      const to = new Date(Date.now() + 3600_000);
      const mine = async (): Promise<number> =>
        Number(
          (
            await admin.query(
              `SELECT count(*)::int AS n FROM audit.export_job WHERE requested_by_person_id = $1 AND created_at > now() - interval '1 hour'`,
              [CMP_PERSON],
            )
          ).rows[0]?.n,
        );
      const ask = (i: number) =>
        db.withScope(compliance, (tx) =>
          audit.requestExport(tx, {
            requestId: REQ(100 + i),
            filter: { from, to, patientId: PAT2, action: 'btg_open' },
            reason: 'rate limit test',
            elevationId: REQ(91),
          }),
        );
      await admin.query(
        `DELETE FROM kernel.setting WHERE key = 'audit_export_max_rows' AND location_id IS NULL`,
      );
      const before = await mine();
      await admin.query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'audit_export_max_per_hour', $2::jsonb, 'int')`,
        [ORG, String(before + 2)],
      );
      try {
        // five at once against room for two: exactly two are accepted
        const out = await Promise.allSettled([1, 2, 3, 4, 5].map(ask));
        assert.equal(out.filter((o) => o.status === 'fulfilled').length, 2);
        for (const o of out.filter((x) => x.status === 'rejected'))
          assert.ok((o as PromiseRejectedResult).reason instanceof ExportRateLimitedError);
        assert.equal(await mine(), before + 2);
        queue.enqueued.length = 0;
        const refused = await ask(9).then(
          () => null,
          (e: unknown) => e,
        );
        assert.ok(refused instanceof ExportRateLimitedError);
        assert.deepEqual(
          [(refused as ExportRateLimitedError).status, (refused as ExportRateLimitedError).code],
          [429, 'kernel.rate_limited'],
        );
        assert.equal(await mine(), before + 2, 'no job for a refused request');
        assert.deepEqual(queue.enqueued, [], 'nothing enqueued for a refused request');
        // an export older than an hour does not count
        await admin.query(
          `UPDATE audit.export_job SET created_at = now() - interval '2 hours' WHERE id IN (SELECT id FROM audit.export_job WHERE requested_by_person_id = $1 ORDER BY created_at DESC LIMIT 1)`,
          [CMP_PERSON],
        );
        await ask(10);
        assert.equal(await mine(), before + 2);
      } finally {
        await admin.query(
          `DELETE FROM kernel.setting WHERE key = 'audit_export_max_per_hour' AND location_id IS NULL`,
        );
      }
    });
    test('a principal without the audit_events slice cannot create an export job; the time range is required', async () => {
      await rejectsCode(
        db.withScope(doctor, (tx) =>
          tx.query(
            `INSERT INTO audit.export_job (id, organisation_id, requested_by_person_id, reason, filter, elevation_id)
             VALUES (gen_random_uuid(), $1, $2, 'r', '{"from":"a","to":"b"}', gen_random_uuid())`,
            [ORG, DOC_PERSON],
          ),
        ),
        '42501',
        'export without slice',
      );
      await rejectsCode(
        db.withScope(compliance, (tx) =>
          tx.query(
            `INSERT INTO audit.export_job (id, organisation_id, requested_by_person_id, reason, filter, elevation_id)
             VALUES (gen_random_uuid(), $1, $2, 'r', '{"from":"a"}', gen_random_uuid())`,
            [ORG, CMP_PERSON],
          ),
        ),
        '23514',
        'filter without range',
      );
    });
  });

  describe('disclosuresFor and the schema as seen by the pipeline', () => {
    test('disclosuresFor pages by (occurred_at, event_id) for a system scope and refuses bad input', async () => {
      const sys: ScopeSettings = {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'org',
      };
      // app_api cannot be `system`: use the worker pool.
      const wpool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 2 }).on(
        'error',
        () => undefined,
      );
      try {
        const wdb = new KernelDb(wpool as never);
        const p1 = await wdb.withScope(sys, (tx) => audit.disclosuresFor(tx, [PAT1], { limit: 3 }));
        assert.equal(p1.events.length, 3);
        assert.ok(p1.next);
        const p2 = await wdb.withScope(sys, (tx) =>
          audit.disclosuresFor(tx, [PAT1], { limit: 3, after: p1.next as never }),
        );
        assert.ok(p2.events.every((e) => !p1.events.some((x) => x.eventId === e.eventId)));
        await assert.rejects(
          wdb.withScope(sys, (tx) => audit.disclosuresFor(tx, [])),
          AuditEnvelopeError,
        );
        // An API staff transaction without the slice sees no events through the same call.
        const none = await db.withScope(doctor, (tx) => audit.disclosuresFor(tx, [PAT1]));
        assert.deepEqual(none.events, []);
      } finally {
        await wpool.end();
      }
    });
    test('the audit tables are partitioned by month and the default partition exists', async () => {
      const r = (
        await admin.query(
          `SELECT count(*) FILTER (WHERE pg_get_expr(c.relpartbound, c.oid) LIKE 'FOR VALUES%')::int AS monthly,
                  count(*) FILTER (WHERE pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT')::int AS dflt
             FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'audit.event'::regclass`,
        )
      ).rows[0];
      assert.equal(r?.monthly, 14);
      assert.equal(r?.dflt, 1);
    });
  });
});
