#!/usr/bin/env node
// Real-database tests for F-03 on a PostgreSQL 17 server: migrations from empty, the catalog checks,
// the spike-style checks of ARCHITECTURE 38.1 that one container can run, and TC-AU-04.
//
//   EHR_TEST_ADMIN_URL=postgres://postgres@localhost:5432/postgres  node --test db/tools/db-test.mjs
//
// The URL must name a superuser on a throwaway server (the CI container, trust authentication, synthetic
// data only). Each run creates and drops its own databases. Missing configuration FAILS the run; nothing skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate, MigrationError } from '../../packages/kernel/dist/db/migrate/index.js';
import { runChecks } from './catalog-check.mjs';
import { connect, requireEnv } from './pg.mjs';

const adminUrl = requireEnv('EHR_TEST_ADMIN_URL');
const here = fileURLToPath(new URL('.', import.meta.url));
const fixtures = join(here, '../../packages/kernel/src/db/migrate/fixtures');
const ORG = '00000000-0000-7000-8000-0000000000a1';
const ORG2 = '00000000-0000-7000-8000-0000000000a2';
const P1 = '00000000-0000-7000-8000-0000000000b1';
const P2 = '00000000-0000-7000-8000-0000000000b2';
const dbName = `ehr_f03_${process.pid}_${Date.now()}`;
const dbName2 = `${dbName}_runner`;

const urlFor = (user, database) => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};
const rejectsCode = (promise, code, what) =>
  assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `${what}: expected SQLSTATE ${code}, got ${e.code} (${e.message})`);
    return true;
  });

/** Runs fn as `role` in a transaction with transaction-local settings; always rolls back. */
async function as(role, settings, fn, database = dbName) {
  const c = await connect(urlFor(role, database), `test-${role}`);
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(settings))
      await c.query('SELECT set_config($1, $2, true)', [k, v]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}
const count = async (c, table) =>
  Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
const run = (command, database) =>
  execFileSync(process.execPath, [join(here, 'migrate.mjs'), command], {
    env: {
      PATH: process.env.PATH,
      EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl).username, database),
      EHR_DB_MIGRATE_URL: urlFor('app_owner', database),
    },
    encoding: 'utf8',
  });

let admin;
before(async () => {
  admin = await connect(adminUrl, 'test-admin');
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName2}`);
});
after(async () => {
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName2} WITH (FORCE)`);
  await admin?.end();
});

describe('migrations from empty on PostgreSQL 17', () => {
  let adminDb;
  before(async () => {
    const major = (await admin.query('SHOW server_version_num')).rows[0].server_version_num;
    assert.ok(
      Number(major) >= 170000 && Number(major) < 180000,
      `PostgreSQL 17 required, got ${major}`,
    );
    run('bootstrap', dbName);
    run('bootstrap', dbName); // idempotent
    const out = run('migrate', dbName);
    assert.match(out, /0001_kernel_schema_and_helpers\.sql/);
    adminDb = await connect(urlFor(new URL(adminUrl).username, dbName), 'test-admin-db');
  });
  after(() => adminDb?.end());

  test('a second run applies nothing', () => {
    assert.deepEqual(JSON.parse(run('migrate', dbName).trim().split('\n').pop()).applied, []);
  });

  test('catalog checks M-1..M-5 and the role checks all pass', async () => {
    const report = await runChecks(adminDb);
    const failed = report.filter((c) => c.status === 'fail');
    assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
    assert.ok(report.length >= 18, `only ${report.length} checks ran`);
  });

  test('role-level settings are stored and visible to a new session', async () => {
    const show = async (role, name) =>
      as(role, {}, async (c) => (await c.query(`SHOW ${name}`)).rows[0][name]);
    assert.equal(await show('app_api', 'transaction_timeout'), '1min');
    assert.equal(await show('app_api', 'statement_timeout'), '15s');
    assert.equal(await show('app_worker', 'transaction_timeout'), '1min');
    assert.equal(await show('app_worker', 'statement_timeout'), '50s');
    assert.equal(await show('audit_archiver', 'transaction_timeout'), '1min');
  });

  test('the runner tracker is not reachable by application roles', async () => {
    await rejectsCode(
      as('app_api', {}, (c) => c.query('SELECT 1 FROM migration.schema_migration')),
      '42501',
      'app_api tracker',
    );
  });
});

describe('spike-style checks of ARCHITECTURE 38.1 (FORCE RLS, fail closed, role mechanics)', () => {
  before(async () => {
    const a = await connect(urlFor(new URL(adminUrl).username, dbName), 'test-seed');
    try {
      // The superuser bypasses RLS: it is the only way to seed rows without an application path.
      await a.query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, pre_auth) VALUES
         ('10000000-0000-7000-8000-000000000001', $1, 'pre.auth.key', '1', 'int', true),
         ('10000000-0000-7000-8000-000000000002', $1, 'other.key', '2', 'int', false),
         ('10000000-0000-7000-8000-000000000003', $2, 'other.org.key', '3', 'int', false)`,
        [ORG, ORG2],
      );
      await a.query(
        `INSERT INTO kernel.idempotency_key (organisation_id, principal_id, route_template, key, request_hash, state, expires_at) VALUES
         ($1, $2, '/x', '20000000-0000-7000-8000-000000000001', decode(repeat('00', 32), 'hex'), 'completed', now() - interval '1 hour')`,
        [ORG, P1],
      );
    } finally {
      await a.end();
    }
  });
  const staffAdmin = {
    'app.org_id': ORG,
    'app.audience': 'staff',
    'app.realm': 'admin_pool',
    'app.principal_id': P1,
  };
  const newSetting = (org, preAuth, key) => [
    `30000000-0000-7000-8000-${String(Math.abs(key.length * 7919)).padStart(12, '0')}`,
    org,
    key,
    preAuth,
  ];
  // N-3 (migration 0953): app_api holds no INSERT on pre_auth, so a false value is left to the default; a true value
  // names the column and is refused (column grant for app_api, policy for everyone else).
  const insertSetting = (c, [id, org, key, preAuth]) =>
    preAuth
      ? c.query(
          "INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, pre_auth) VALUES ($1, $2, $3, '1', 'int', true)",
          [id, org, key],
        )
      : c.query(
          "INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES ($1, $2, $3, '1', 'int')",
          [id, org, key],
        );

  test('FORCE RLS: the table owner cannot insert, and its UPDATE changes 0 rows (SBR-17)', async () => {
    await as('app_owner', { 'app.org_id': ORG, 'app.audience': 'system' }, async (c) => {
      await rejectsCode(
        insertSetting(c, newSetting(ORG, false, 'owner.insert')),
        '42501',
        'owner insert',
      );
    });
    await as(
      'app_owner',
      { 'app.org_id': ORG, 'app.audience': 'staff', 'app.realm': 'admin_pool' },
      async (c) => {
        const r = await c.query("UPDATE kernel.setting SET value = '9'");
        assert.equal(r.rowCount, 0, 'owner UPDATE under FORCE must report 0 rows');
        assert.equal(await count(c, 'kernel.setting'), 0);
      },
    );
  });

  test('a missing setting returns 0 rows on every kernel table (fail closed)', async () => {
    await as('app_api', {}, async (c) => {
      for (const t of ['idempotency_key', 'setting', 'reference_data_version', 'rate_counter'])
        assert.equal(await count(c, `kernel.${t}`), 0, t);
    });
    await as('app_worker', {}, async (c) => {
      for (const t of ['idempotency_key', 'setting', 'reference_data_version', 'rate_counter'])
        assert.equal(await count(c, `kernel.${t}`), 0, t);
    });
  });

  test('setting: admin_pool staff reads and writes its organisation; WITH CHECK refuses everything else', async () => {
    await as('app_api', staffAdmin, async (c) => {
      assert.equal(await count(c, 'kernel.setting'), 2, 'own organisation only');
      await insertSetting(c, newSetting(ORG, false, 'admin.ok'));
      await c.query('SAVEPOINT s');
      await rejectsCode(
        insertSetting(c, newSetting(ORG, true, 'admin.pre')),
        '42501',
        'admin may not set pre_auth',
      );
      await c.query('ROLLBACK TO s');
      await rejectsCode(
        insertSetting(c, newSetting(ORG2, false, 'admin.org2')),
        '42501',
        'other organisation',
      );
      await c.query('ROLLBACK TO s');
      const upd = await c.query("UPDATE kernel.setting SET value = '5' WHERE pre_auth");
      assert.equal(upd.rowCount, 0, 'admin cannot change pre_auth rows');
    });
    for (const s of [
      { ...staffAdmin, 'app.realm': 'google' },
      { ...staffAdmin, 'app.audience': 'patient' },
    ]) {
      await as('app_api', s, async (c) => {
        assert.equal(await count(c, 'kernel.setting'), 2, 'authenticated audiences read');
        await rejectsCode(
          insertSetting(c, newSetting(ORG, false, 'denied')),
          '42501',
          JSON.stringify(s),
        );
      });
    }
  });

  test('audience anonymous reads only pre_auth settings and nothing in idempotency_key', async () => {
    await as('app_api', { 'app.org_id': ORG, 'app.audience': 'anonymous' }, async (c) => {
      const r = await c.query('SELECT key FROM kernel.setting');
      assert.deepEqual(
        r.rows.map((x) => x.key),
        ['pre.auth.key'],
      );
      assert.equal(await count(c, 'kernel.idempotency_key'), 0);
      await c.query(
        "INSERT INTO kernel.rate_counter (organisation_id, key, window_start, count) VALUES ($1, 'k', now(), 1)",
        [ORG],
      );
      assert.equal(await count(c, 'kernel.rate_counter'), 1);
      await rejectsCode(
        c.query(
          "INSERT INTO kernel.rate_counter (organisation_id, key, window_start, count) VALUES ($1, 'k2', now(), 1)",
          [ORG2],
        ),
        '42501',
        'rate counter other organisation',
      );
    });
  });

  test('app_api cannot act as audience system; app_worker can, within its job scope', async () => {
    await as(
      'app_api',
      { 'app.org_id': ORG, 'app.audience': 'system', 'app.job_scope': 'org' },
      async (c) => {
        assert.equal(await count(c, 'kernel.setting'), 0);
        assert.equal(await count(c, 'kernel.idempotency_key'), 0);
      },
    );
    await as(
      'app_worker',
      { 'app.org_id': ORG, 'app.audience': 'system', 'app.job_scope': 'org' },
      async (c) => {
        assert.equal(await count(c, 'kernel.setting'), 2);
        const del = await c.query('DELETE FROM kernel.idempotency_key WHERE expires_at < now()');
        assert.equal(del.rowCount, 1, 'purge job deletes the expired key');
      },
    );
    await as(
      'app_worker',
      { 'app.org_id': ORG, 'app.audience': 'system', 'app.job_scope': 'patients' },
      async (c) => {
        assert.equal(await count(c, 'kernel.idempotency_key'), 0, 'a per-patient job cannot purge');
      },
    );
  });

  test('idempotency_key: a principal sees only its own keys; updates bump row_version', async () => {
    const mine = {
      'app.org_id': ORG,
      'app.audience': 'staff',
      'app.realm': 'google',
      'app.principal_id': P1,
    };
    await as('app_api', mine, async (c) => {
      assert.equal(await count(c, 'kernel.idempotency_key'), 1);
      await c.query("UPDATE kernel.idempotency_key SET state = 'completed', response_status = 201");
      const r = await c.query('SELECT row_version, updated_at FROM kernel.idempotency_key');
      assert.equal(String(r.rows[0].row_version), '2');
      assert.ok(r.rows[0].updated_at);
    });
    await as('app_api', { ...mine, 'app.principal_id': P2 }, async (c) =>
      assert.equal(await count(c, 'kernel.idempotency_key'), 0),
    );
  });

  test('reporting_ro is refused on the kernel tables (M-4)', async () => {
    await rejectsCode(
      as('reporting_ro', { 'app.org_id': ORG }, (c) => c.query('SELECT 1 FROM kernel.setting')),
      '42501',
      'reporting_ro',
    );
  });

  test('role switching: app_api reaches only identity_signin_ro, which holds no table right', async () => {
    await as('app_api', { 'app.org_id': ORG }, async (c) => {
      await c.query('SAVEPOINT s');
      for (const role of [
        'directory_ro',
        'patient_scope_owner',
        'scheduling_booking_owner',
        'queue_owner',
        'app_owner',
      ]) {
        await rejectsCode(c.query(`SET LOCAL ROLE ${role}`), '42501', `app_api SET ROLE ${role}`);
        await c.query('ROLLBACK TO s');
      }
      await c.query('SET LOCAL ROLE identity_signin_ro');
      await rejectsCode(
        c.query('SELECT 1 FROM kernel.setting'),
        '42501',
        'identity_signin_ro on kernel.setting',
      );
    });
    await as('app_worker', {}, async (c) => {
      await rejectsCode(
        c.query('SET LOCAL ROLE identity_signin_ro'),
        '42501',
        'app_worker is a member of nothing',
      );
    });
  });

  test('app_owner holds SET but not INHERIT on directory_ro: it can switch but gains no rights', async () => {
    await as('app_owner', {}, async (c) => {
      const r = await c.query(
        `SELECT pg_has_role('app_owner', 'directory_ro', 'SET') AS can_set, pg_has_role('app_owner', 'directory_ro', 'USAGE') AS inherits,
                pg_has_role('app_owner', 'patient_scope_owner', 'USAGE') AS inherits2`,
      );
      assert.deepEqual(r.rows[0], { can_set: true, inherits: false, inherits2: false });
    });
  });

  test('function ownership transfer needs SET membership and CREATE on the schema (21.2 point 1)', async () => {
    await as('app_owner', {}, async (c) => {
      await c.query('CREATE SCHEMA f03_fn');
      await c.query('CREATE FUNCTION f03_fn.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
      await c.query('SAVEPOINT s');
      await rejectsCode(
        c.query('ALTER FUNCTION f03_fn.f() OWNER TO patient_scope_owner'),
        '42501',
        'no CREATE on schema',
      );
      await c.query('ROLLBACK TO s');
      await c.query('GRANT CREATE ON SCHEMA f03_fn TO patient_scope_owner, identity_signin_ro');
      await c.query('SAVEPOINT s');
      await rejectsCode(
        c.query('ALTER FUNCTION f03_fn.f() OWNER TO identity_signin_ro'),
        '42501',
        'no SET membership',
      );
      await c.query('ROLLBACK TO s');
      await c.query('ALTER FUNCTION f03_fn.f() OWNER TO patient_scope_owner');
      const o = await c.query(
        "SELECT pg_get_userbyid(proowner) AS o FROM pg_proc WHERE oid = 'f03_fn.f()'::regprocedure",
      );
      assert.equal(o.rows[0].o, 'patient_scope_owner');
    });
  });

  test('SELECT ... FOR KEY SHARE needs UPDATE rights: a SELECT-only role is refused', async () => {
    const o = await connect(urlFor('app_owner', dbName), 'test-owner');
    try {
      await o.query('CREATE SCHEMA f03_lock');
      await o.query('CREATE TABLE f03_lock.root (id uuid PRIMARY KEY)');
      await o.query('GRANT USAGE ON SCHEMA f03_lock TO app_api');
      await o.query('GRANT SELECT ON f03_lock.root TO app_api');
      await as('app_api', {}, async (c) => {
        await c.query('SELECT id FROM f03_lock.root');
        await rejectsCode(
          c.query('SELECT id FROM f03_lock.root FOR KEY SHARE'),
          '42501',
          'FOR KEY SHARE',
        );
      });
    } finally {
      await o.query('DROP SCHEMA f03_lock CASCADE');
      await o.end();
    }
  });

  test('an owner-rights view returns 0 rows under FORCE; a security_invoker view returns the caller rows (M-4)', async () => {
    const o = await connect(urlFor('app_owner', dbName), 'test-owner');
    const a = await connect(adminUrl.replace(/\/[^/]*$/, `/${dbName}`), 'test-admin-view');
    try {
      await o.query('CREATE SCHEMA f03_view');
      await o.query('CREATE TABLE f03_view.t (organisation_id uuid NOT NULL, v int)');
      await o.query('ALTER TABLE f03_view.t ENABLE ROW LEVEL SECURITY');
      await o.query('ALTER TABLE f03_view.t FORCE ROW LEVEL SECURITY');
      await o.query(
        "CREATE POLICY p ON f03_view.t FOR SELECT TO app_api USING (organisation_id = (SELECT kernel.uuid1('app.org_id')))",
      );
      await o.query('CREATE VIEW f03_view.owner_rights AS SELECT * FROM f03_view.t');
      await o.query(
        'CREATE VIEW f03_view.invoker WITH (security_invoker = true) AS SELECT * FROM f03_view.t',
      );
      await o.query('GRANT USAGE ON SCHEMA f03_view TO app_api');
      await o.query(
        'GRANT SELECT ON f03_view.t, f03_view.owner_rights, f03_view.invoker TO app_api',
      );
      await a.query('INSERT INTO f03_view.t VALUES ($1, 1)', [ORG]);
      await as('app_api', { 'app.org_id': ORG }, async (c) => {
        assert.equal(await count(c, 'f03_view.invoker'), 1);
        assert.equal(await count(c, 'f03_view.owner_rights'), 0);
      });
      const bad = (await runChecks(a)).find((x) => x.id === 'M-4-views');
      assert.equal(bad.status, 'fail', 'the catalog check must flag the owner-rights view');
      assert.deepEqual(bad.violations, [{ view: 'f03_view.owner_rights' }]);
    } finally {
      await o.query('DROP SCHEMA f03_view CASCADE');
      await o.end();
      await a.end();
    }
  });

  test('negative control: the catalog checks fail on a table without FORCE and on a policy TO PUBLIC', async () => {
    const a = await connect(adminUrl.replace(/\/[^/]*$/, `/${dbName}`), 'test-admin-neg');
    try {
      await a.query('CREATE SCHEMA f03_neg');
      await a.query('CREATE TABLE f03_neg.t (organisation_id uuid)');
      await a.query('ALTER TABLE f03_neg.t ENABLE ROW LEVEL SECURITY');
      await a.query('CREATE POLICY p ON f03_neg.t USING (true)'); // no TO clause: PUBLIC
      const r = await runChecks(a);
      assert.equal(r.find((x) => x.id === 'M-1').status, 'fail');
      assert.equal(r.find((x) => x.id === 'M-2').status, 'fail');
    } finally {
      await a.query('DROP SCHEMA f03_neg CASCADE');
      await a.end();
    }
  });
});

describe('SEC03-F13 / F09 catalog negative controls', () => {
  const status = (r, id) => r.find((x) => x.id === id).status;
  const withAdmin = async (fn) => {
    const a = await connect(adminUrl.replace(/\/[^/]*$/, `/${dbName}`), 'test-sec03-neg');
    try {
      return await fn(a);
    } finally {
      await a.end();
    }
  };
  test('the positive baseline: the four new checks pass on the migrated database', async () => {
    await withAdmin(async (a) => {
      const r = await runChecks(a);
      for (const id of [
        'M-5-patient-guard',
        'M-5-setting-grants',
        'M-5-hidden-columns',
        'M-5-policy-tautology',
      ])
        assert.equal(status(r, id), 'pass', JSON.stringify(r.find((x) => x.id === id).violations));
    });
  });
  test('M-5-policy-tautology fails on a policy comparing a column with itself (F01)', async () => {
    await withAdmin(async (a) => {
      await a.query('CREATE SCHEMA f13_neg');
      await a.query('CREATE TABLE f13_neg.t (patient_id uuid)');
      await a.query(
        'CREATE POLICY p ON f13_neg.t FOR SELECT TO app_api USING (EXISTS (SELECT 1 FROM f13_neg.t s WHERE (s.patient_id = s.patient_id)))',
      );
      try {
        assert.equal(status(await runChecks(a), 'M-5-policy-tautology'), 'fail');
      } finally {
        await a.query('DROP SCHEMA f13_neg CASCADE');
      }
    });
  });
  // HEAAA-310 A5: the three mutations run on the original table and on clinical.note (a table moved to the single guard by 2200).
  for (const [t, trg] of [
    ['patient.patient_contact', 'patient_contact_guard_open'],
    ['clinical.note', 'note_guard_open'],
  ]) {
    test(`M-5-patient-guard fails when the guard trigger is disabled, AFTER, or INSERT-only (${t})`, async () => {
      await withAdmin(async (a) => {
        await a.query(`ALTER TABLE ${t} DISABLE TRIGGER ${trg}`);
        try {
          assert.equal(status(await runChecks(a), 'M-5-patient-guard'), 'fail', 'disabled');
        } finally {
          await a.query(`ALTER TABLE ${t} ENABLE TRIGGER ${trg}`);
        }
        for (const [name, def] of [
          ['AFTER', 'AFTER INSERT OR UPDATE'],
          ['INSERT-only', 'BEFORE INSERT'],
        ]) {
          await a.query(`DROP TRIGGER ${trg} ON ${t}`);
          await a.query(
            `CREATE TRIGGER ${trg} ${def} ON ${t} FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient()`,
          );
          try {
            assert.equal(status(await runChecks(a), 'M-5-patient-guard'), 'fail', name);
          } finally {
            await a.query(`DROP TRIGGER ${trg} ON ${t}`);
            await a.query(
              `CREATE TRIGGER ${trg} BEFORE INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient()`,
            );
          }
        }
        assert.equal(status(await runChecks(a), 'M-5-patient-guard'), 'pass', 'restored');
      });
    });
  }
  test('M-5-setting-grants fails when app_api can write pre_auth or UPDATE every column (N-3)', async () => {
    await withAdmin(async (a) => {
      for (const grant of ['INSERT (pre_auth)', 'UPDATE (pre_auth)', 'UPDATE']) {
        await a.query(`GRANT ${grant} ON kernel.setting TO app_api`);
        try {
          assert.equal(status(await runChecks(a), 'M-5-setting-grants'), 'fail', grant);
        } finally {
          await a.query(`REVOKE ${grant} ON kernel.setting FROM app_api`);
          await a.query('GRANT UPDATE (value) ON kernel.setting TO app_api');
        }
      }
      assert.equal(status(await runChecks(a), 'M-5-setting-grants'), 'pass', 'restored');
    });
  });
  test('M-5-hidden-columns fails when an application role can read occupancy created_by (F09)', async () => {
    await withAdmin(async (a) => {
      await a.query('GRANT SELECT (created_by) ON scheduling.slot_occupancy TO app_api');
      try {
        assert.equal(status(await runChecks(a), 'M-5-hidden-columns'), 'fail');
      } finally {
        await a.query('REVOKE SELECT (created_by) ON scheduling.slot_occupancy FROM app_api');
      }
      assert.equal(status(await runChecks(a), 'M-5-hidden-columns'), 'pass', 'restored');
    });
  });
});

describe('R-timeouts negative control (F03-R1-02)', () => {
  for (const bad of ['0s', '0ms', '0000ms', '61s', '120s']) {
    test(`R-timeouts fails when an audit-writing role has transaction_timeout = ${bad}`, async () => {
      const a = await connect(adminUrl.replace(/\/[^/]*$/, `/${dbName}`), 'test-timeout-neg');
      try {
        await a.query(`ALTER ROLE app_api SET transaction_timeout = '${bad}'`);
        const r = await runChecks(a);
        assert.equal(r.find((x) => x.id === 'R-timeouts').status, 'fail');
      } finally {
        await a.query(`ALTER ROLE app_api SET transaction_timeout = '60s'`);
        await a.end();
      }
    });
  }
});

describe('TC-AU-04 (ARCHITECTURE 21.5, SAR-10; step 2 per SA-TC-06)', () => {
  // The audit schema is a later ticket. This fixture reproduces only the trigger contract: it checks the
  // SETTING of transaction_timeout, not elapsed time. Test bound B = 5 s; production bound = 60 s.
  let a;
  before(async () => {
    a = await connect(adminUrl.replace(/\/[^/]*$/, `/${dbName}`), 'test-au04');
    await a.query(`CREATE ROLE au04_dba LOGIN`);
    await a.query(`GRANT CONNECT ON DATABASE ${dbName} TO au04_dba`);
    await a.query(`CREATE SCHEMA au04`);
    await a.query(`CREATE FUNCTION au04.require_bounded_tx() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t interval := current_setting('transaction_timeout')::interval; b interval := TG_ARGV[0]::interval;
      BEGIN
        IF t <= interval '0' OR t > b THEN RAISE EXCEPTION 'unbounded audit transaction' USING ERRCODE = 'PA001'; END IF;
        RETURN NEW;
      END $$`);
    for (const [table, bound] of [
      ['event_b', '5s'],
      ['event_prod', '60s'],
    ]) {
      await a.query(`CREATE TABLE au04.${table} (id serial PRIMARY KEY)`);
      await a.query(
        `CREATE TRIGGER bounded BEFORE INSERT ON au04.${table} FOR EACH ROW EXECUTE FUNCTION au04.require_bounded_tx('${bound}')`,
      );
      await a.query(`GRANT INSERT, SELECT ON au04.${table} TO au04_dba, app_api, app_worker`);
      await a.query(
        `GRANT USAGE, SELECT ON SEQUENCE au04.${table}_id_seq TO au04_dba, app_api, app_worker`,
      );
    }
    await a.query('GRANT USAGE ON SCHEMA au04 TO au04_dba, app_api, app_worker, app_owner');
    // deliberately NO INSERT grant for app_owner on au04.*
  });
  after(async () => {
    await a?.query('DROP SCHEMA IF EXISTS au04 CASCADE');
    await a?.query('DROP OWNED BY au04_dba');
    await a?.query('DROP ROLE IF EXISTS au04_dba');
    await a?.end();
  });
  const rows = async (t) =>
    Number((await a.query(`SELECT count(*) AS n FROM au04.${t}`)).rows[0].n);

  test('step 1: transaction_timeout unset (0) -> refused PA001, no row', async () => {
    await rejectsCode(
      as('au04_dba', {}, (c) => c.query('INSERT INTO au04.event_b DEFAULT VALUES')),
      'PA001',
      'step 1',
    );
    assert.equal(await rows('event_b'), 0);
  });
  test('step 2 (SA-TC-06): B + 1 s -> refused PA001, no row', async () => {
    await rejectsCode(
      as('au04_dba', {}, async (c) => {
        await c.query("SET LOCAL transaction_timeout = '6s'");
        await c.query('INSERT INTO au04.event_b DEFAULT VALUES');
      }),
      'PA001',
      'step 2',
    );
    assert.equal(await rows('event_b'), 0);
  });
  test('step 3: app_owner -> privilege error 42501 raised before the trigger, no row', async () => {
    await rejectsCode(
      as('app_owner', {}, async (c) => {
        await c.query("SET LOCAL transaction_timeout = '5s'"); // a valid bound: only the grant can refuse
        await c.query('INSERT INTO au04.event_b DEFAULT VALUES');
      }),
      '42501',
      'step 3',
    );
    assert.equal(await rows('event_b'), 0);
  });
  test('step 4 (positive control): at or below the bound -> accepted and written', async () => {
    const c = await connect(urlFor('au04_dba', dbName), 'test-au04-pos');
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL transaction_timeout = '5s'");
      await c.query('INSERT INTO au04.event_b DEFAULT VALUES');
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    assert.equal(await rows('event_b'), 1);
  });
  test('production shape: the role-level 60 s of app_api and app_worker is accepted, 120 s is refused', async () => {
    for (const role of ['app_api', 'app_worker']) {
      const c = await connect(urlFor(role, dbName), `test-au04-${role}`);
      try {
        await c.query('INSERT INTO au04.event_prod DEFAULT VALUES'); // autocommit; role default applies
      } finally {
        await c.end();
      }
      await rejectsCode(
        as(role, {}, async (x) => {
          await x.query("SET LOCAL transaction_timeout = '120s'");
          await x.query('INSERT INTO au04.event_prod DEFAULT VALUES');
        }),
        'PA001',
        `${role} 120 s`,
      );
    }
    assert.equal(await rows('event_prod'), 2);
  });
});

describe('the runner against a real database', () => {
  let dir;
  let owner;
  before(async () => {
    run('bootstrap', dbName2);
    dir = mkdtempSync(join(tmpdir(), 'f03-runner-'));
    cpSync(
      join(fixtures, 'out-of-order/0001_create_widget.sql'),
      join(dir, '0001_create_widget.sql'),
    );
    cpSync(join(fixtures, 'out-of-order/0003_add_flag.sql'), join(dir, '0003_add_flag.sql'));
    owner = await connect(urlFor('app_owner', dbName2), 'test-runner');
  });
  after(async () => {
    await owner?.end();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('applies 0001 and 0003, then rejects 0002 as out of order and leaves the schema untouched', async () => {
    const first = await migrate(owner, { dir });
    assert.deepEqual(first.applied, ['0001_create_widget.sql', '0003_add_flag.sql']);
    cpSync(join(fixtures, 'out-of-order/0002_add_note.sql'), join(dir, '0002_add_note.sql'));
    await assert.rejects(
      migrate(owner, { dir }),
      (e) => e instanceof MigrationError && e.code === 'OUT_OF_ORDER',
    );
    const cols = await owner.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'fixture' AND table_name = 'widget'",
    );
    assert.ok(!cols.rows.some((r) => r.column_name === 'note'), '0002 must not have been applied');
    const tracked = await owner.query(
      'SELECT version FROM migration.schema_migration ORDER BY version',
    );
    assert.deepEqual(
      tracked.rows.map((r) => r.version),
      [1, 3],
    );
  });

  test('a migration that fails at run time rolls back with its tracker row', async () => {
    rmSync(join(dir, '0002_add_note.sql'));
    writeFileSync(
      join(dir, '0004_dup.sql'),
      '-- migration-class: expand\nCREATE TABLE fixture.half (id int);\nALTER TABLE fixture.widget ADD COLUMN flag boolean NOT NULL DEFAULT false;\n',
    );
    await rejectsCode(migrate(owner, { dir }), '42701', 'duplicate column');
    const half = await owner.query("SELECT to_regclass('fixture.half') AS t");
    assert.equal(half.rows[0].t, null, 'the first statement of the failed file was rolled back');
    const tracked = await owner.query(
      'SELECT version FROM migration.schema_migration ORDER BY version',
    );
    assert.deepEqual(
      tracked.rows.map((r) => r.version),
      [1, 3],
    );
  });
});

// INT02-F02 (HEAAA-186), ruling HEAAA-190, ARCHITECTURE 21.2 point 5 and 21.6 (A-3): one merge write guard for every module.
describe('the single merge write guard (T1-T4 of HEAAA-190, extended by HEAAA-310)', () => {
  const MERGED = '00000000-0000-7000-8000-0000000000c1';
  const OPEN = '00000000-0000-7000-8000-0000000000c2';
  const RACE = '00000000-0000-7000-8000-0000000000c3';
  const RACE_TARGET = '00000000-0000-7000-8000-0000000000c4';
  const ROW = '00000000-0000-7000-8000-0000000000d1';
  const guarded = [
    'scheduling.slot_reservation',
    'documents.document',
    'documents.document_version',
    'documents.legal_hold',
    'documents.deletion_request',
    'scheduling.check_in',
    'scheduling.queue_entry',
    'scheduling.waitlist_entry',
    'scheduling.waitlist_offer',
    'telehealth.video_session',
    'telehealth.participant',
    'telehealth.join_token',
    'telehealth.location_confirmation',
    'notifications.staff_alert',
    'notifications.staff_alert_event',
    // HEAAA-310 (INT03-F03): the 18 M4 tables, moved to the single guard by 2200.
    'clinical.problem',
    'clinical.allergy',
    'clinical.medication_statement',
    'clinical.vital_sign',
    'clinical.questionnaire_response',
    'clinical.triage_assessment',
    'clinical.referral',
    'clinical.consent_exception',
    'clinical.follow_up',
    'clinical.encounter',
    'clinical.note',
    'clinical.note_cosign',
    'clinical.note_addendum',
    'privacy.request',
    'privacy.export_package',
    'messaging.thread',
    'messaging.message',
    'messaging.task',
  ];
  const insertPatient = (c, id, org, extra = '') =>
    c.query(
      `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via${extra ? ', status, merged_into' : ''})
       VALUES ($1, $2, $3, 'Guard', 'Test', '1980-01-01', 'NY', 'front_desk'${extra})`,
      [id, org, `MRN-${id.slice(-7).replace(/\D/g, '1').padStart(7, '1')}`],
    );
  let adm;
  let db3;
  const adminName = () => new URL(adminUrl).username;
  before(async () => {
    adm = await connect(urlFor(adminName(), dbName), 'test-guard-admin');
    await adm.query(
      "INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York') ON CONFLICT DO NOTHING",
      [ORG],
    );
  });
  after(async () => {
    await adm
      ?.query('DELETE FROM patient.patient WHERE id = ANY($1)', [[RACE, RACE_TARGET]])
      .catch(() => undefined);
    await adm?.end();
    if (db3) await admin?.query(`DROP DATABASE IF EXISTS ${db3} WITH (FORCE)`);
  });

  /** Inside one rolled-back transaction as the superuser: a context for the guard, a merged patient and an open one. */
  async function inGuardTxn(fn, { org = ORG, audience = 'system' } = {}) {
    const c = await connect(urlFor(adminName(), dbName), 'test-guard-txn');
    try {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', [
        'app.org_id',
        ORG,
        'app.audience',
        audience,
      ]);
      // A bare row must reach the merge guard: switch off the other row triggers that run before it (the guard itself stays).
      for (const t of guarded) {
        const others = await c.query(
          `SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal
             AND t.tgfoid <> 'patient.guard_open_patient()'::regprocedure`,
          [t],
        );
        for (const r of others.rows)
          await c.query(`ALTER TABLE ${t} DISABLE TRIGGER "${r.tgname}"`);
      }
      await insertPatient(c, OPEN, ORG);
      await insertPatient(c, MERGED, ORG, `, 'merged', '${OPEN}'`);
      await c.query('SELECT set_config($1, $2, true)', ['app.org_id', org]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  const hasId = new Map();
  const attempt = async (c, table, patient, org = ORG) => {
    if (!hasId.has(table)) {
      const [schema, name] = table.split('.');
      const r = await adm.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'id'",
        [schema, name],
      );
      hasId.set(table, r.rowCount > 0);
    }
    const withId = hasId.get(table);
    await c.query('SAVEPOINT s');
    try {
      await c.query(
        withId
          ? `INSERT INTO ${table} (id, organisation_id, patient_id) VALUES ($1, $2, $3)`
          : `INSERT INTO ${table} (organisation_id, patient_id) VALUES ($1, $2)`,
        withId ? [ROW, org, patient] : [org, patient],
      );
      return 'inserted';
    } catch (e) {
      return e.code;
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
  };

  test('T1: a write naming a merged patient is refused with PM001 on every guarded table', async () => {
    await inGuardTxn(async (c) => {
      for (const t of guarded) assert.equal(await attempt(c, t, MERGED), 'PM001', t);
    });
  });

  test('T1: an open patient passes the guard (any later refusal is another check) on every guarded table', async () => {
    await inGuardTxn(async (c) => {
      for (const t of guarded) {
        const code = await attempt(c, t, OPEN);
        assert.ok(!['PM001', 'PM008'].includes(code), `${t}: ${code}`);
      }
    });
  });

  test('T1: a write naming a patient of another organisation is refused (42501 or PM008)', async () => {
    await inGuardTxn(
      async (c) => {
        for (const t of guarded) {
          const code = await attempt(c, t, OPEN, ORG);
          assert.ok(['42501', 'PM008'].includes(code), `${t}: ${code}`);
        }
      },
      { org: ORG2 },
    );
  });

  test('T2: app_owner holds no EXECUTE on the guard, the ten refused functions are gone, all 33 tables carry the trigger', async () => {
    const acl = await adm.query(
      `SELECT count(*)::int AS n FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
       WHERE p.oid = 'patient.guard_open_patient()'::regprocedure AND r.rolname = 'app_owner'`,
    );
    assert.equal(acl.rows[0].n, 0);
    for (const t of [
      'documents.guard_open_patient',
      'telehealth.guard_open_patient',
      'scheduling.flow_guard_open_patient',
      'scheduling.guard_open_patient',
      'scheduling.guard_open_patient_at_commit',
      'clinical.guard_open_patient',
      'clinical.frontdoor_guard_open_patient',
      'clinical.notes_guard_open_patient',
      'privacy.guard_open_patient',
      'messaging.guard_open_patient',
      'messaging.is_creator',
    ]) {
      const f = await adm.query(
        "SELECT count(*)::int AS n FROM pg_proc WHERE oid::regproc::text = $1 OR (pronamespace::regnamespace::text || '.' || proname) = $1",
        [t],
      );
      assert.equal(f.rows[0].n, 0, `${t} must not exist`);
    }
    const trig = await adm.query(
      `SELECT c.oid::regclass::text AS tbl FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND t.tgfoid = 'patient.guard_open_patient()'::regprocedure AND t.tgenabled = 'O'
         AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16`,
    );
    const have = new Set(trig.rows.map((r) => r.tbl));
    for (const t of guarded) assert.ok(have.has(t), `${t} lacks the trigger`);
    const defs = await adm.query(
      `SELECT count(*)::int AS n FROM pg_proc WHERE prosecdef AND pronamespace::regnamespace::text IN ('scheduling','documents','telehealth','clinical','privacy','messaging') AND proname LIKE '%guard_open_patient%'`,
    );
    assert.equal(defs.rows[0].n, 0);
    const { definerInventory } = await import('./catalog-lists.mjs');
    assert.equal(
      definerInventory.length,
      27,
      'definerInventory has the 23 entries of A-3, the two messaging predicates and the two referral definers of the two A-4 amendments',
    );
  });

  test('T5: privacy.incident_patient is exempt: no guard trigger, and a merged-ID link is not refused with PM001', async () => {
    const { patientGuardExempt } = await import('./catalog-lists.mjs');
    assert.ok(patientGuardExempt.includes('privacy.incident_patient'));
    const trig = await adm.query(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'privacy.incident_patient'::regclass AND NOT tgisinternal
         AND tgfoid = 'patient.guard_open_patient()'::regprocedure`,
    );
    assert.equal(trig.rows[0].n, 0);
    // inGuardTxn only disables triggers on `guarded`, so disable incident_patient_guard (its only BEFORE INSERT trigger) here.
    await inGuardTxn(async (c) => {
      await c.query('ALTER TABLE privacy.incident_patient DISABLE TRIGGER incident_patient_guard');
      const code = await attempt(c, 'privacy.incident_patient', MERGED);
      assert.notEqual(code, 'PM001', 'a merged ID is not refused by the merge guard');
    });
  });

  test('T6: patient_scope_owner holds no CREATE on clinical or privacy and no USAGE on privacy (USAGE on clinical only by A-4); the 18 M4 guard triggers keep their names', async () => {
    for (const schema of ['clinical', 'privacy'])
      for (const priv of ['USAGE', 'CREATE']) {
        const r = await adm.query('SELECT has_schema_privilege($1, $2, $3) AS ok', [
          'patient_scope_owner',
          schema,
          priv,
        ]);
        // A-4 (HEAAA-325 rev e3fa32f4, migration 2300): patient_scope_owner holds USAGE on clinical (and only USAGE, and only column
        // SELECT on two tables, checked by the T-RA-29 test) so that its referral-scope policies and the origin guard can read them.
        const allowed = schema === 'clinical' && priv === 'USAGE';
        assert.equal(r.rows[0].ok, allowed, `${schema} ${priv}`);
      }
    const names = {
      'clinical.problem': 'problem_guard_open',
      'clinical.allergy': 'allergy_guard_open',
      'clinical.medication_statement': 'medication_guard_open',
      'clinical.vital_sign': 'vital_sign_guard_open',
      'clinical.questionnaire_response': 'questionnaire_response_guard_open',
      'clinical.triage_assessment': 'triage_assessment_guard_open',
      'clinical.referral': 'referral_guard_open',
      'clinical.consent_exception': 'consent_exception_guard_open',
      'clinical.follow_up': 'follow_up_guard_open',
      'clinical.encounter': 'encounter_guard_open',
      'clinical.note': 'note_guard_open',
      'clinical.note_cosign': 'note_cosign_guard_open',
      'clinical.note_addendum': 'note_addendum_guard_open',
      'privacy.request': 'request_guard_open',
      'privacy.export_package': 'export_package_guard_open',
      'messaging.thread': 'thread_guard_open',
      'messaging.message': 'message_guard_open',
      'messaging.task': 'task_guard_open',
    };
    for (const [tbl, name] of Object.entries(names)) {
      const r = await adm.query(
        `SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal
           AND t.tgfoid = 'patient.guard_open_patient()'::regprocedure`,
        [tbl],
      );
      assert.deepEqual(
        r.rows.map((x) => x.tgname),
        [name],
        tbl,
      );
    }
  });

  test('T3: a merge holding the root lock makes a concurrent reservation write wait; after the commit it gets PM001', async () => {
    await adm.query('SELECT set_config($1, $2, false), set_config($3, $4, false)', [
      'app.org_id',
      ORG,
      'app.audience',
      'system',
    ]);
    await insertPatient(adm, RACE_TARGET, ORG);
    await insertPatient(adm, RACE, ORG);
    const merge = await connect(urlFor(adminName(), dbName), 'test-merge');
    const writer = await connect(urlFor(adminName(), dbName), 'test-writer');
    try {
      for (const c of [merge, writer])
        await c.query('SELECT set_config($1, $2, false), set_config($3, $4, false)', [
          'app.org_id',
          ORG,
          'app.audience',
          'system',
        ]);
      await merge.query('BEGIN');
      await merge.query('SELECT 1 FROM patient.patient WHERE id = $1 FOR UPDATE', [RACE]);
      await writer.query('BEGIN');
      let settled = false;
      const write = writer
        .query(
          'INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id) VALUES ($1, $2, $3)',
          [ROW, ORG, RACE],
        )
        .then(
          () => 'inserted',
          (e) => e.code,
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(settled, false, 'the writer must wait on the root lock');
      await merge.query(
        "UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1",
        [RACE, RACE_TARGET],
      );
      await merge.query('COMMIT');
      assert.equal(await write, 'PM001');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await merge.query('ROLLBACK').catch(() => undefined);
      await writer.end();
      await merge.end();
    }
  });

  test('T4: a file that leaves the guard granted to app_owner is rolled back by the runner post-check, with its tracker row', async () => {
    db3 = `${dbName}_ownerstep`;
    await admin.query(`CREATE DATABASE ${db3}`);
    run('bootstrap', db3);
    const a = await connect(urlFor(adminName(), db3), 'test-ownerstep-admin');
    const dir = mkdtempSync(join(tmpdir(), 'f02-ownerstep-'));
    const owner = await connect(urlFor('app_owner', db3), 'test-ownerstep-owner');
    try {
      await a.query('CREATE SCHEMA patient');
      await a.query('GRANT USAGE ON SCHEMA patient TO app_owner, patient_scope_owner');
      await a.query(
        `CREATE FUNCTION patient.guard_open_patient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      );
      await a.query('ALTER FUNCTION patient.guard_open_patient() OWNER TO patient_scope_owner');
      await a.query('GRANT EXECUTE ON FUNCTION patient.guard_open_patient() TO app_owner');
      writeFileSync(
        join(dir, '0001_marker.sql'),
        '-- migration-class: expand\nCREATE SCHEMA marker_one;\n',
      );
      await assert.rejects(migrate(owner, { dir }), /still holds EXECUTE/);
      assert.equal(
        (await owner.query("SELECT to_regnamespace('marker_one') AS s")).rows[0].s,
        null,
        'the file was rolled back',
      );
      assert.equal(
        (await owner.query('SELECT count(*)::int AS n FROM migration.schema_migration')).rows[0].n,
        0,
      );
      await a.query('REVOKE EXECUTE ON FUNCTION patient.guard_open_patient() FROM app_owner');
      assert.deepEqual((await migrate(owner, { dir })).applied, ['0001_marker.sql']);
      // The owner step itself: grant, a trigger that needs it, revoke; the revoke leaves the trigger firing.
      writeFileSync(
        join(dir, '0002_attach.sql'),
        `-- migration-class: expand
CREATE TABLE marker_one.t (id uuid PRIMARY KEY, organisation_id uuid, patient_id uuid);
SET LOCAL ROLE patient_scope_owner;
GRANT EXECUTE ON FUNCTION patient.guard_open_patient() TO app_owner;
RESET ROLE;
CREATE TRIGGER t_guard_open BEFORE INSERT OR UPDATE ON marker_one.t FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
SET LOCAL ROLE patient_scope_owner;
REVOKE EXECUTE ON FUNCTION patient.guard_open_patient() FROM app_owner;
RESET ROLE;
`,
      );
      assert.deepEqual((await migrate(owner, { dir })).applied, ['0002_attach.sql']);
      const left = await a.query(
        `SELECT count(*)::int AS n FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x JOIN pg_roles r ON r.oid = x.grantee
         WHERE p.oid = 'patient.guard_open_patient()'::regprocedure AND r.rolname = 'app_owner'`,
      );
      assert.equal(left.rows[0].n, 0);
    } finally {
      await owner.end();
      await a.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// INT03-F03 Part B (HEAAA-334), amendment A-4 (HEAAA-332 decision-log rev bf854c3a, ruling HEAAA-310 rev d9504db5): migrations 2203/2204.
// I-10 and I-11 of the ruling and the Cybersecurity tests T-1..T-10 (HEAAA-333 comment 5f4974c6). Seeds are committed (several sessions read
// them) and not removed: this block is last and the database is dropped at the end of the run.
describe('A-4 messaging definers (migrations 2203/2204): T-1..T-10 of Cybersecurity, I-10, I-11', () => {
  const id = (n) => `00000000-0000-7000-8000-0000000a4${String(n).padStart(3, '0')}`;
  const O2 = id(900); // a second organisation
  const LOC = id(1);
  const PAT1 = id(2);
  const S_CREATOR = id(10);
  const S_OWNER = id(11);
  const S_MEMBER = id(12);
  const S_OTHER = id(13);
  const S_ORG2 = id(14);
  const PT_USER = id(15); // patient_pool principal of PAT1
  const PT_PROXY = id(16); // patient_pool principal acting as proxy for PAT1
  const TH_STAFF = id(20); // patient-linked staff thread: owners CREATOR, OWNER; member MEMBER
  const TH_EMPTY = id(21); // staff thread without patient, created by CREATOR, no participant row yet
  const TH_PATSCOPE = id(22); // staff thread about PAT1, created by CREATOR, no participant row yet
  const TH_PATIENT = id(23); // patient thread of PAT1, created by PT_USER; owner PT_USER; proxy has a row
  const TH_ORG2 = id(24); // thread of the other organisation
  const TH_ONE = id(25); // sole owner CREATOR, member MEMBER
  const TH_PXY = id(27); // patient thread created by PT_USER, no participant row yet
  const TH_STAFF2 = id(26); // same organisation, owner S_OTHER only
  const adminName = () => new URL(adminUrl).username;
  let adm;
  const base = (over = {}) => ({
    'app.org_id': ORG,
    'app.audience': 'staff',
    'app.realm': 'google',
    'app.location_ids': LOC,
    ...over,
  });
  const staff = (principal, over = {}) => base({ 'app.principal_id': principal, ...over });
  const code = async (c, sql, params = []) => {
    await c.query('SAVEPOINT a4');
    try {
      const r = await c.query(sql, params);
      return { ok: true, rows: r.rows, rowCount: r.rowCount };
    } catch (e) {
      return { ok: false, code: e.code, message: e.message };
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT a4');
    }
  };
  const setCtx = async (c, settings) => {
    for (const k of [
      'app.org_id',
      'app.principal_id',
      'app.audience',
      'app.realm',
      'app.location_ids',
      'app.patient_ids',
      'app.proxy_patient_ids',
      'app.btg_patient_ids',
    ])
      await c.query('SELECT set_config($1, $2, true)', [k, settings[k] ?? '']);
  };
  const ins = (thread, principal, role, by, org = ORG) =>
    code(
      c_(),
      `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, $4, $5)`,
      [thread, principal, org, role, by],
    );
  let cur;
  const c_ = () => cur;
  const within = async (role, settings, fn) => as(role, settings, async (c) => ((cur = c), fn(c)));

  before(async () => {
    adm = await connect(urlFor(adminName(), dbName), 'test-a4-admin');
    await adm.query('BEGIN');
    await adm.query('SET LOCAL session_replication_role = replica'); // seed rows without the application's triggers and FKs
    await adm.query(
      "INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York') ON CONFLICT DO NOTHING",
      [ORG],
    );
    await adm.query(
      `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code) VALUES ($1, $2, 'A4 clinic', 'clinic', 'America/New_York', 'NY')`,
      [LOC, ORG],
    );
    await adm.query(
      `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
       VALUES ($1, $2, 'MRN-4000001', 'A4', 'Patient', '1980-01-01', 'NY', 'front_desk')`,
      [PAT1, ORG],
    );
    await adm.query(
      'INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1, $2, $3)',
      [PAT1, LOC, ORG],
    );
    for (const [pid, org, realm] of [
      [S_CREATOR, ORG, 'google'],
      [S_OWNER, ORG, 'google'],
      [S_MEMBER, ORG, 'google'],
      [S_OTHER, ORG, 'google'],
      [S_ORG2, O2, 'google'],
      [PT_USER, ORG, 'patient_pool'],
      [PT_PROXY, ORG, 'patient_pool'],
    ]) {
      await adm.query(
        `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, 'A4 person')`,
        [pid, org],
      );
      await adm.query(
        `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject) VALUES ($1, $2, $1, $3, $4)`,
        [pid, org, realm, `a4-${pid}`],
      );
    }
    const th = (tid, org, kind, patient, by, subject) =>
      adm.query(
        `INSERT INTO messaging.thread (id, organisation_id, kind, patient_id, subject, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [tid, org, kind, patient, subject, by],
      );
    await th(TH_STAFF, ORG, 'staff', PAT1, S_CREATOR, 'A4 staff thread');
    await th(TH_EMPTY, ORG, 'staff', null, S_CREATOR, 'A4 empty thread');
    await th(TH_PATSCOPE, ORG, 'staff', PAT1, S_CREATOR, 'A4 patient-scope thread');
    await th(TH_PATIENT, ORG, 'patient', PAT1, PT_USER, 'A4 patient thread');
    await th(TH_ORG2, O2, 'staff', null, S_ORG2, 'A4 other organisation');
    await th(TH_ONE, ORG, 'staff', null, S_CREATOR, 'A4 one owner');
    await th(TH_PXY, ORG, 'patient', PAT1, PT_USER, 'A4 proxy-creator thread');
    await th(TH_STAFF2, ORG, 'staff', null, S_OTHER, 'A4 other owner');
    const part = (tid, pr, role, by, org = ORG) =>
      adm.query(
        `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, $4, $5)`,
        [tid, pr, org, role, by],
      );
    await part(TH_STAFF, S_CREATOR, 'owner', S_CREATOR);
    await part(TH_STAFF, S_OWNER, 'owner', S_CREATOR);
    await part(TH_STAFF, S_MEMBER, 'member', S_CREATOR);
    await part(TH_PATIENT, PT_USER, 'owner', PT_USER);
    await part(TH_PATIENT, PT_PROXY, 'member', PT_USER);
    await part(TH_PATIENT, S_CREATOR, 'member', PT_USER);
    await part(TH_ORG2, S_ORG2, 'owner', S_ORG2, O2);
    await part(TH_ONE, S_CREATOR, 'owner', S_CREATOR);
    await part(TH_ONE, S_MEMBER, 'member', S_CREATOR);
    await part(TH_STAFF2, S_OTHER, 'owner', S_OTHER);
    await adm.query('COMMIT');
  });
  after(() => adm?.end());

  test('I-10: M-5-definer passes with 27 entries (25 of F03B plus the two referral definers of F08d); is_creator does not exist; patient_scope_owner holds only the four participant columns', async () => {
    const report = await runChecks(adm);
    for (const id_ of ['M-5-definer', 'M-5-messaging-definer'])
      assert.equal(report.find((r) => r.id === id_)?.status, 'pass', id_);
    const { definerInventory } = await import('./catalog-lists.mjs');
    assert.equal(definerInventory.length, 27);
    const gone = await adm.query(
      "SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'messaging'::regnamespace AND proname = 'is_creator'",
    );
    assert.equal(gone.rows[0].n, 0);
  });

  test('T-1: under system, anonymous, public, webhook or an unset audience the definers return false for a real owner and never raise; the owner role reads no row', async () => {
    for (const audience of ['system', 'anonymous', 'public', 'webhook', '']) {
      for (const role of ['app_api', 'app_worker']) {
        await within(role, staff(S_OWNER, { 'app.audience': audience }), async (c) => {
          const r = await code(
            c,
            'SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o',
            [TH_STAFF],
          );
          assert.ok(r.ok, `${role}/${audience}: raised ${r.message}`);
          assert.deepEqual(r.rows[0], { p: false, o: false }, `${role}/${audience}`);
        });
      }
      await within(adminName(), staff(S_OWNER, { 'app.audience': audience }), async (c) => {
        await c.query('SET LOCAL ROLE patient_scope_owner');
        const r = await c.query('SELECT count(*)::int AS n FROM messaging.thread_participant');
        assert.equal(r.rows[0].n, 0, `participant_definer_select under audience "${audience}"`);
      });
    }
    // control: the same call under staff is true, so the false above is the audience and not the data
    await within('app_api', staff(S_OWNER), async (c) => {
      const r = await c.query(
        'SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o',
        [TH_STAFF],
      );
      assert.deepEqual(r.rows[0], { p: true, o: true });
    });
  });

  test('T-2: the caller comes only from the settings; a foreign, random, NULL or unset input gives false/NULL, never an error or true', async () => {
    await within('app_api', staff(S_MEMBER), async (c) => {
      const r = await c.query(
        'SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o',
        [TH_STAFF],
      );
      assert.deepEqual(r.rows[0], { p: true, o: false }, 'B is a member, A is the owner');
    });
    await within('app_api', staff(S_OTHER), async (c) => {
      const r = await c.query(
        'SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o',
        [TH_STAFF],
      );
      assert.deepEqual(r.rows[0], { p: false, o: false }, 'an outsider of the same organisation');
    });
    await within('app_api', staff(S_OWNER, { 'app.principal_id': '' }), async (c) => {
      const r = await c.query(
        'SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o',
        [TH_STAFF],
      );
      assert.notEqual(r.rows[0].p, true);
      assert.notEqual(r.rows[0].o, true);
    });
    await within('app_api', staff(S_OWNER, { 'app.org_id': '' }), async (c) => {
      const r = await c.query(
        'SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o',
        [TH_STAFF],
      );
      assert.notEqual(r.rows[0].p, true);
      assert.notEqual(r.rows[0].o, true);
    });
    // a participant of organisation 1 asking for a thread of organisation 2 gets exactly what a random UUID gets
    await within('app_api', staff(S_OWNER), async (c) => {
      const foreign = (
        await c.query('SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o', [
          TH_ORG2,
        ])
      ).rows[0];
      const random = (
        await c.query('SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o', [
          id(999),
        ])
      ).rows[0];
      assert.deepEqual(foreign, { p: false, o: false });
      assert.deepEqual(foreign, random);
      const n = (
        await c.query('SELECT messaging.is_participant(NULL) AS p, messaging.is_owner(NULL) AS o')
      ).rows[0];
      assert.notEqual(n.p, true);
      assert.notEqual(n.o, true);
    });
  });

  test('T-3: patient_scope_owner as SET ROLE: no thread right, only the four participant columns, no write right anywhere, one policy with the principal clause', async () => {
    await within(adminName(), staff(S_OWNER), async (c) => {
      await c.query('SET LOCAL ROLE patient_scope_owner');
      for (const sql of [
        'SELECT * FROM messaging.thread',
        'SELECT subject FROM messaging.thread',
        'SELECT * FROM messaging.thread_participant',
        'SELECT last_read_at FROM messaging.thread_participant',
        'SELECT added_by FROM messaging.thread_participant',
      ]) {
        const r = await code(c, sql);
        assert.equal(r.code, '42501', sql);
      }
      // C-1: the four columns are readable, and only the caller's own rows come back (S_OWNER has two memberships in the seed: none besides TH_STAFF)
      const own = await c.query(
        'SELECT thread_id, principal_id, role FROM messaging.thread_participant ORDER BY thread_id',
      );
      assert.ok(own.rows.length >= 1);
      for (const r of own.rows)
        assert.equal(r.principal_id, S_OWNER, "only the caller's own membership is visible");
      await c.query('RESET ROLE');
    });
    const cols = await adm.query(
      `SELECT a.attname::text AS col FROM pg_attribute a WHERE a.attrelid = 'messaging.thread_participant'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege('patient_scope_owner', a.attrelid, a.attnum, 'SELECT') ORDER BY 1`,
    );
    assert.deepEqual(
      cols.rows.map((r) => r.col),
      ['organisation_id', 'principal_id', 'role', 'thread_id'],
    );
    const tbl = await adm.query(
      `SELECT c.oid::regclass::text AS t, p AS priv FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        WHERE c.relnamespace = 'messaging'::regnamespace AND c.relkind IN ('r','p') AND has_table_privilege('patient_scope_owner', c.oid, p)`,
    );
    assert.deepEqual(tbl.rows, [], 'no table-level privilege remains');
    const colw = await adm.query(
      `SELECT c.oid::regclass::text || '.' || a.attname AS col FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relnamespace = 'messaging'::regnamespace AND c.relkind IN ('r','p') AND has_column_privilege('patient_scope_owner', c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')`,
    );
    assert.deepEqual(colw.rows, [], 'no INSERT/UPDATE/REFERENCES on any messaging column');
    const pol = await adm.query(
      `SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE schemaname = 'messaging' AND 'patient_scope_owner' = ANY (roles) ORDER BY 1, 2`,
    );
    assert.equal(pol.rows.length, 1);
    assert.equal(pol.rows[0].tablename, 'thread_participant');
    assert.equal(pol.rows[0].policyname, 'participant_definer_select');
    assert.match(pol.rows[0].qual, /principal_id = \( SELECT kernel\.uuid1\('app\.principal_id'/);
    const opt = await adm.query(
      `SELECT count(*)::int AS n FROM (SELECT (aclexplode(relacl)).* FROM pg_class WHERE relnamespace = 'messaging'::regnamespace) x WHERE is_grantable
       AND grantee = 'patient_scope_owner'::regrole`,
    );
    assert.equal(opt.rows[0].n, 0, 'no GRANT OPTION');
    const role = await adm.query(
      "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'patient_scope_owner'",
    );
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  });

  test('T-4: membership alone does not widen scope; a removed member loses access at once', async () => {
    // MEMBER has lost staff_scope to PAT1 (location_ids names no location of the patient) and has no break-the-glass grant
    await within('app_api', staff(S_MEMBER, { 'app.location_ids': id(777) }), async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM messaging.thread WHERE id = $1', [TH_STAFF])).rowCount,
        0,
      );
      const u = await code(c, "UPDATE messaging.thread SET status = 'closed' WHERE id = $1", [
        TH_STAFF,
      ]);
      assert.equal(u.rowCount, 0);
    });
    await within('app_api', staff(S_OWNER, { 'app.location_ids': id(777) }), async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM messaging.thread WHERE id = $1', [TH_STAFF])).rowCount,
        0,
        'an owner out of scope sees nothing',
      );
      const u = await code(c, "UPDATE messaging.thread SET status = 'closed' WHERE id = $1", [
        TH_STAFF,
      ]);
      assert.equal(u.rowCount, 0);
    });
    // with scope it works (control); then MEMBER's row is removed (as the administrator: under participant_principal_select an owner sees,
    // so can delete, only their own row, at the base as well) and MEMBER is out in the next statement
    await within(adminName(), staff(S_MEMBER), async (c) => {
      await c.query('SET LOCAL ROLE app_api');
      const p1 = await c.query('SELECT messaging.is_participant($1) AS p', [TH_STAFF]);
      assert.equal(p1.rows[0].p, true);
      const t1 = await c.query('SELECT 1 FROM messaging.thread WHERE id = $1', [TH_STAFF]);
      assert.equal(t1.rowCount, 1, 'control: a member in scope reads the thread');
      await c.query('RESET ROLE');
      const d = await c.query(
        'DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2',
        [TH_STAFF, S_MEMBER],
      );
      assert.equal(d.rowCount, 1);
      await c.query('SET LOCAL ROLE app_api');
      const p2 = await c.query('SELECT messaging.is_participant($1) AS p', [TH_STAFF]);
      assert.equal(p2.rows[0].p, false);
      const t2 = await c.query('SELECT 1 FROM messaging.thread WHERE id = $1', [TH_STAFF]);
      assert.equal(t2.rowCount, 0);
      const m = await code(
        c,
        `INSERT INTO messaging.message (id, organisation_id, thread_id, patient_id, author_principal_id, body) VALUES ($1, $2, $3, $4, $5, 'after removal')`,
        [id(500), ORG, TH_STAFF, PAT1, S_MEMBER],
      );
      assert.equal(m.code, 'PS001', 'message insert after removal is refused by the trigger');
    });
    await within(adminName(), staff(S_MEMBER), async (c) => {
      await c.query(
        'DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2',
        [TH_STAFF, S_MEMBER],
      );
      await c.query('ALTER TABLE messaging.message DISABLE TRIGGER message_guard');
      await c.query('SET LOCAL ROLE app_api');
      const m = await code(
        c,
        `INSERT INTO messaging.message (id, organisation_id, thread_id, patient_id, author_principal_id, body) VALUES ($1, $2, $3, $4, $5, 'after removal')`,
        [id(500), ORG, TH_STAFF, PAT1, S_MEMBER],
      );
      assert.equal(
        m.code,
        '42501',
        'with the trigger off, message_staff_insert (is_participant) refuses',
      );
    });
  });

  test("T-5: the creator path (replacement of is_creator): invoker EXISTS under the thread's own policy", async () => {
    await within('app_api', staff(S_CREATOR), async (c) => {
      cur = c;
      const ok = await ins(TH_EMPTY, S_CREATOR, 'owner', S_CREATOR);
      assert.ok(ok.ok, `creator adds own owner row: ${ok.message}`);
      assert.equal(
        (await ins(TH_PATSCOPE, S_CREATOR, 'owner', S_CREATOR)).ok,
        true,
        'creator in scope of the patient',
      );
      assert.equal(
        (await ins(TH_EMPTY, S_CREATOR, 'member', S_CREATOR)).code,
        '42501',
        'role member for self is refused',
      );
      assert.equal(
        (await ins(TH_EMPTY, S_OWNER, 'owner', S_CREATOR)).code,
        '42501',
        'owner row for another principal by a creator who is not yet an owner',
      );
      assert.equal(
        (await ins(TH_ORG2, S_CREATOR, 'owner', S_CREATOR)).code,
        '42501',
        'thread of another organisation',
      );
    });
    // a creator who lost patient scope to the thread's patient is refused (intended: ARCHITECTURE 22.12 (a); is_creator skipped this)
    await within('app_api', staff(S_CREATOR, { 'app.location_ids': id(777) }), async (c) => {
      cur = c;
      assert.equal(
        (await ins(TH_PATSCOPE, S_CREATOR, 'owner', S_CREATOR)).code,
        '42501',
        'lost scope',
      );
    });
    // a creator outside the google realm is refused
    await within('app_api', staff(S_CREATOR, { 'app.realm': 'admin_pool' }), async (c) => {
      cur = c;
      assert.equal(
        (await ins(TH_EMPTY, S_CREATOR, 'owner', S_CREATOR)).code,
        '42501',
        'realm is not google',
      );
    });
    // The same three refusals at the POLICY (the guard_participant trigger also refuses most of them, because it reads the thread under the
    // caller's rights; with it off, only participant_owner_insert stands). With is_creator (base) the first two were allowed: it skipped the
    // thread's own policy. Intended change, Cybersecurity Q4.
    await within(adminName(), staff(S_CREATOR, { 'app.location_ids': id(777) }), async (c) => {
      await c.query(
        'ALTER TABLE messaging.thread_participant DISABLE TRIGGER thread_participant_guard',
      );
      await c.query('SET LOCAL ROLE app_api');
      cur = c;
      assert.equal(
        (await ins(TH_PATSCOPE, S_CREATOR, 'owner', S_CREATOR)).code,
        '42501',
        'policy: creator lost patient scope',
      );
      await setCtx(c, staff(S_CREATOR, { 'app.realm': 'admin_pool' }));
      assert.equal(
        (await ins(TH_EMPTY, S_CREATOR, 'owner', S_CREATOR)).code,
        '42501',
        'policy: creator outside realm google',
      );
      await setCtx(c, staff(S_CREATOR));
      assert.equal(
        (await ins(TH_PATSCOPE, S_CREATOR, 'owner', S_CREATOR)).ok,
        true,
        'control: with scope the policy passes',
      );
      const pat = {
        'app.org_id': ORG,
        'app.audience': 'patient',
        'app.realm': 'patient_pool',
        'app.principal_id': PT_USER,
        'app.patient_ids': PAT1,
      };
      await setCtx(c, pat);
      assert.equal(
        (await ins(TH_PXY, PT_USER, 'owner', PT_USER)).ok,
        true,
        'control: the patient creator passes',
      );
      await setCtx(c, { ...pat, 'app.proxy_patient_ids': PAT1 });
      assert.equal(
        (await ins(TH_PXY, PT_USER, 'owner', PT_USER)).code,
        '42501',
        'policy: a proxy-audience creator',
      );
    });
    // a non-creator who guesses the thread ID cannot add themselves, with or without a visible creator row
    await within('app_api', staff(S_OTHER), async (c) => {
      cur = c;
      assert.equal((await ins(TH_EMPTY, S_OTHER, 'owner', S_OTHER)).code, '42501');
      assert.equal((await ins(TH_STAFF, S_OTHER, 'owner', S_OTHER)).code, '42501');
      assert.equal((await ins(TH_STAFF, S_OTHER, 'member', S_OTHER)).code, '42501');
    });
    // the creator of a thread in another organisation cannot act on this one
    await within('app_api', staff(S_ORG2, { 'app.org_id': O2 }), async (c) => {
      cur = c;
      assert.equal((await ins(TH_EMPTY, S_ORG2, 'owner', S_ORG2, O2)).code, '42501');
      assert.equal((await ins(TH_EMPTY, S_ORG2, 'owner', S_ORG2, ORG)).code, '42501');
    });
    // the created_by spoof on a thread INSERT is refused by the trigger (PS001) and, with the trigger off, by thread_staff_insert (42501)
    const spoof = `INSERT INTO messaging.thread (id, organisation_id, kind, subject, status, created_by) VALUES ($1, $2, 'staff', 'spoof', 'open', $3)`;
    await within('app_api', staff(S_OTHER), async (c) => {
      assert.equal((await code(c, spoof, [id(501), ORG, S_CREATOR])).code, 'PS001');
    });
    await within(adminName(), staff(S_OTHER), async (c) => {
      await c.query('ALTER TABLE messaging.thread DISABLE TRIGGER thread_guard');
      await c.query('SET LOCAL ROLE app_api');
      assert.equal((await code(c, spoof, [id(501), ORG, S_CREATOR])).code, '42501');
      const ok = await code(c, spoof, [id(501), ORG, S_OTHER]);
      assert.equal(ok.ok, true, 'control: the honest insert passes the policy');
    });
    // DELETE. The trigger messaging.guard_participant reads the thread's owners under the caller's own rights and sees only the caller's row, so
    // through app_api an owner always meets "the last owner stays" (PS001): the same at the base, not changed by 2203. The policy itself is
    // proved with that trigger off: the creator-owner deletes own row (policy true), a member deletes nothing.
    await within('app_api', staff(S_CREATOR), async (c) => {
      const last = await code(
        c,
        'DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2',
        [TH_ONE, S_CREATOR],
      );
      assert.equal(last.code, 'PS001', 'the last owner stays');
    });
    await within(adminName(), staff(S_CREATOR), async (c) => {
      await c.query(
        'ALTER TABLE messaging.thread_participant DISABLE TRIGGER thread_participant_guard',
      );
      await c.query('SET LOCAL ROLE app_api');
      const del = `DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2`;
      assert.equal(
        (await code(c, del, [TH_STAFF, S_CREATOR])).rowCount,
        1,
        'policy: owner row of the creator',
      );
      await setCtx(c, staff(S_MEMBER));
      assert.equal(
        (await code(c, del, [TH_STAFF, S_MEMBER])).rowCount,
        0,
        'policy: a member deletes nothing',
      );
      await setCtx(c, staff(S_OTHER));
      assert.equal(
        (await code(c, del, [TH_STAFF2, S_OTHER])).rowCount,
        1,
        'policy: an owner who is the creator of another thread',
      );
      await setCtx(c, staff(S_CREATOR, { 'app.realm': 'admin_pool' }));
      assert.equal(
        (await code(c, del, [TH_ONE, S_CREATOR])).rowCount,
        1,
        'is_owner path does not check realm (unchanged)',
      );
    });
  });

  test('T-6: patient and proxy: a proxy reads and updates nothing; a patient cannot add a staff owner to a staff thread; ineligible participants are refused', async () => {
    const pat = (principal, over = {}) => ({
      'app.org_id': ORG,
      'app.audience': 'patient',
      'app.realm': 'patient_pool',
      'app.principal_id': principal,
      'app.patient_ids': PAT1,
      ...over,
    });
    await within('app_api', pat(PT_USER), async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM messaging.thread WHERE id = $1', [TH_PATIENT])).rowCount,
        1,
        'the patient reads own thread',
      );
    });
    await within('app_api', pat(PT_PROXY, { 'app.proxy_patient_ids': PAT1 }), async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM messaging.thread WHERE id = $1', [TH_PATIENT])).rowCount,
        0,
        'proxy has a participant row but reads nothing',
      );
      assert.equal(
        (await c.query('SELECT messaging.is_participant($1) AS p', [TH_PATIENT])).rows[0].p,
        true,
        'the row exists; the thread policy denies',
      );
      const u = await code(c, "UPDATE messaging.thread SET status = 'closed' WHERE id = $1", [
        TH_PATIENT,
      ]);
      assert.equal(u.rowCount, 0);
    });
    await within('app_api', pat(PT_USER), async (c) => {
      cur = c;
      assert.equal(
        (await ins(TH_STAFF, S_OTHER, 'owner', PT_USER)).code,
        '42501',
        'a patient adds a staff owner to a staff thread',
      );
      const kind = await ins(TH_PATIENT, S_OTHER, 'member', PT_USER);
      assert.equal(
        kind.code,
        'PS001',
        'S_OTHER is not a listed clinician (participant not eligible)',
      );
    });
  });

  test('T-7: owner and member rules; no cross-thread, no cross-organisation power', async () => {
    await within('app_api', staff(S_MEMBER), async (c) => {
      cur = c;
      assert.equal(
        (await ins(TH_STAFF, S_OTHER, 'member', S_MEMBER)).code,
        '42501',
        'a member cannot add',
      );
      const d = await code(
        c,
        'DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2',
        [TH_STAFF, S_OWNER],
      );
      assert.equal(d.rowCount, 0, 'a member cannot delete');
      const p = await code(
        c,
        "UPDATE messaging.thread_participant SET role = 'owner' WHERE thread_id = $1 AND principal_id = $2",
        [TH_STAFF, S_MEMBER],
      );
      assert.equal(p.code, '42501', 'a member cannot promote (no UPDATE grant on role)');
      const last = await code(
        c,
        'DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2',
        [TH_ONE, S_CREATOR],
      );
      assert.equal(last.rowCount, 0, 'a member cannot delete the last owner');
    });
    await within('app_api', staff(S_OWNER), async (c) => {
      cur = c;
      assert.equal((await ins(TH_STAFF, S_OTHER, 'member', S_OWNER)).ok, true, 'an owner adds');
      assert.equal(
        (await ins(TH_STAFF2, S_MEMBER, 'member', S_OWNER)).code,
        '42501',
        'an owner of X adds on Y (same organisation)',
      );
      const d = await code(
        c,
        'DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2',
        [TH_STAFF2, S_OTHER],
      );
      assert.equal(d.rowCount, 0, 'an owner of X deletes on Y');
    });
    await within('app_api', staff(S_ORG2, { 'app.org_id': O2 }), async (c) => {
      cur = c;
      assert.equal(
        (await ins(TH_STAFF, S_OTHER, 'member', S_ORG2, ORG)).code,
        '42501',
        'cross-organisation owner',
      );
      const d = await code(c, 'DELETE FROM messaging.thread_participant WHERE thread_id = $1', [
        TH_STAFF,
      ]);
      assert.equal(d.rowCount, 0);
    });
  });

  test('T-8: every messaging statement class under staff, patient and system runs without "infinite recursion detected in policy"; the definers are not inlined; row_security on as the table owner', async () => {
    const errors = [];
    const classes = (th) => [
      ['thread select', 'SELECT id FROM messaging.thread'],
      [
        'thread insert',
        `INSERT INTO messaging.thread (id, organisation_id, kind, subject, status, created_by) VALUES ('${id(600)}', '${ORG}', 'staff', 's', 'open', current_setting('app.principal_id', true)::uuid)`,
      ],
      ['thread update', `UPDATE messaging.thread SET status = 'closed' WHERE id = '${th}'`],
      ['participant select', 'SELECT thread_id FROM messaging.thread_participant'],
      [
        'participant insert',
        `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ('${th}', '${S_OTHER}', '${ORG}', 'member', current_setting('app.principal_id', true)::uuid)`,
      ],
      [
        'participant delete',
        `DELETE FROM messaging.thread_participant WHERE thread_id = '${th}' AND principal_id = '${S_MEMBER}'`,
      ],
      [
        'message insert',
        `INSERT INTO messaging.message (id, organisation_id, thread_id, patient_id, author_principal_id, body) VALUES ('${id(601)}', '${ORG}', '${th}', NULL, current_setting('app.principal_id', true)::uuid, 'x')`,
      ],
      ['message select', 'SELECT id FROM messaging.message'],
    ];
    const audiences = [
      ['app_api', staff(S_OWNER), TH_STAFF2],
      [
        'app_api',
        {
          'app.org_id': ORG,
          'app.audience': 'patient',
          'app.realm': 'patient_pool',
          'app.principal_id': PT_USER,
          'app.patient_ids': PAT1,
        },
        TH_PATIENT,
      ],
      [
        'app_worker',
        { 'app.org_id': ORG, 'app.audience': 'system', 'app.job_scope': 'org' },
        TH_STAFF,
      ],
    ];
    let ran = 0;
    for (const [role, settings, th] of audiences)
      await within(role, settings, async (c) => {
        for (const [name, sql] of classes(th)) {
          const r = await code(c, sql);
          ran += 1;
          if (!r.ok && /infinite recursion/i.test(r.message))
            errors.push(`${role}/${settings['app.audience']}/${name}: ${r.message}`);
        }
      });
    assert.equal(ran, 24);
    assert.deepEqual(errors, []);
    await within('app_api', staff(S_OWNER), async (c) => {
      const plan = (
        await c.query('EXPLAIN (VERBOSE, COSTS OFF) SELECT id FROM messaging.thread')
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      assert.match(
        plan,
        /messaging\.is_participant\(/,
        'the definer appears as a function call in the plan, not expanded',
      );
      assert.doesNotMatch(
        plan,
        /Seq Scan on messaging\.thread_participant/,
        "its body is not expanded into the caller's plan",
      );
    });
    // forced as the table owner: FORCE ROW LEVEL SECURITY applies to it, and no recursion arises
    await within('app_owner', staff(S_OWNER), async (c) => {
      await c.query('SET LOCAL row_security = on');
      const r = await code(c, 'SELECT id FROM messaging.thread');
      assert.ok(r.ok || !/infinite recursion/i.test(r.message), r.message);
      const p = await code(c, 'SELECT thread_id FROM messaging.thread_participant');
      assert.ok(p.ok || !/infinite recursion/i.test(p.message), p.message);
    });
  });

  test('T-9: catalog guards: is_creator absent (also from pg_depend and pg_policies), exactly two definers in messaging, attributes pinned, search_path not overridable', async () => {
    const f = await adm.query(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'is_creator'",
    );
    assert.equal(f.rows[0].n, 0);
    const dangling = await adm.query(
      `SELECT count(*)::int AS n FROM pg_depend d WHERE d.refclassid = 'pg_proc'::regclass AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = d.refobjid)`,
    );
    assert.equal(dangling.rows[0].n, 0);
    const pol = await adm.query(
      "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'messaging' AND (qual LIKE '%is_creator%' OR with_check LIKE '%is_creator%')",
    );
    assert.equal(pol.rows[0].n, 0);
    const defs = await adm.query(
      `SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.pronamespace = 'messaging'::regnamespace AND p.prosecdef ORDER BY 1`,
    );
    assert.deepEqual(
      defs.rows.map((r) => r.f),
      ['messaging.is_owner(uuid)', 'messaging.is_participant(uuid)'],
    );
    const { messagingDefinerAttributes } = await import('./catalog-lists.mjs');
    for (const [sig, want] of Object.entries(messagingDefinerAttributes)) {
      const r = await adm.query(
        `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, provolatile, proconfig, (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(proacl) a) AS acl,
                pg_get_function_arguments(oid) AS args, prorettype::regtype::text AS ret
           FROM pg_proc WHERE oid = $1::regprocedure`,
        [sig],
      );
      assert.deepEqual(
        {
          owner: r.rows[0].owner,
          secdef: r.rows[0].prosecdef,
          volatile: r.rows[0].provolatile,
          config: r.rows[0].proconfig,
          acl: r.rows[0].acl,
        },
        { ...want, acl: [...want.acl].sort() },
        sig,
      );
      assert.match(r.rows[0].args, /^p_thread uuid$/);
      assert.equal(r.rows[0].ret, 'boolean');
    }
    await within('app_api', staff(S_OWNER), async (c) => {
      const before = (
        await c.query('SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o', [
          TH_STAFF,
        ])
      ).rows[0];
      await c.query('SET LOCAL search_path = public');
      await code(
        c,
        'CREATE TEMP TABLE thread_participant (thread_id uuid, organisation_id uuid, principal_id uuid, role text)',
      );
      const after = (
        await c.query('SELECT messaging.is_participant($1) AS p, messaging.is_owner($1) AS o', [
          TH_STAFF,
        ])
      ).rows[0];
      assert.deepEqual(after, before);
      assert.deepEqual(after, { p: true, o: true });
    });
  });

  test('T-10 upgrade path: with 2203 applied and 2204 not, nothing depends on is_creator and messaging works; 2204 then applies; 2204 without 2203 fails (no CASCADE) and leaves the function', async () => {
    const all = readdirSync(join(here, '../migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const mk = (files) => {
      const d = mkdtempSync(join(tmpdir(), 'a4-mig-'));
      for (const f of files) cpSync(join(here, '../migrations', f), join(d, f));
      return d;
    };
    const upto2202 = all.filter((f) => f < '2203');
    const dbs = [`${dbName}_a4a`, `${dbName}_a4b`];
    const dirs = [];
    try {
      for (const d of dbs) {
        await admin.query(`CREATE DATABASE ${d}`);
        run('bootstrap', d);
      }
      // (a) 2203 only
      const dirA = mk([...upto2202, '2203_messaging_participant_policies_invoker_creator.sql']);
      dirs.push(dirA);
      const ownerA = await connect(urlFor('app_owner', dbs[0]), 'test-a4a');
      try {
        const r1 = await migrate(ownerA, { dir: dirA });
        assert.ok(r1.applied.includes('2203_messaging_participant_policies_invoker_creator.sql'));
        const still = await ownerA.query(
          "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'is_creator'",
        );
        assert.equal(
          still.rows[0].n,
          1,
          'is_creator still exists after 2203 (contract comes later)',
        );
        const dep = await ownerA.query(
          `SELECT count(*)::int AS n FROM pg_depend d WHERE d.refobjid = 'messaging.is_creator(uuid)'::regprocedure AND d.classid = 'pg_policy'::regclass`,
        );
        assert.equal(dep.rows[0].n, 0, 'no policy depends on is_creator after 2203');
        const pol = await ownerA.query(
          "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'messaging' AND (qual LIKE '%is_creator%' OR with_check LIKE '%is_creator%')",
        );
        assert.equal(pol.rows[0].n, 0);
        cpSync(
          join(here, '../migrations/2204_drop_messaging_is_creator.sql'),
          join(dirA, '2204_drop_messaging_is_creator.sql'),
        );
        const r2 = await migrate(ownerA, { dir: dirA });
        assert.deepEqual(r2.applied, ['2204_drop_messaging_is_creator.sql']);
        const gone = await ownerA.query(
          "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'is_creator'",
        );
        assert.equal(gone.rows[0].n, 0);
      } finally {
        await ownerA.end();
      }
      // (b) 2204 on a database where two policies still reference the function
      const dirB = mk([...upto2202, '2204_drop_messaging_is_creator.sql']);
      dirs.push(dirB);
      const ownerB = await connect(urlFor('app_owner', dbs[1]), 'test-a4b');
      try {
        await rejectsCode(
          migrate(ownerB, { dir: dirB }),
          '2BP01',
          '2204 without 2203 (dependent policies, no CASCADE)',
        );
        const stays = await ownerB.query(
          "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'is_creator'",
        );
        assert.equal(stays.rows[0].n, 1, 'the function is still there');
        const tracked = await ownerB.query(
          'SELECT count(*)::int AS n FROM migration.schema_migration WHERE version = 2204',
        );
        assert.equal(tracked.rows[0].n, 0, 'the tracker row rolled back with the file');
      } finally {
        await ownerB.end();
      }
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
      for (const d of dbs) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    }
  });
});
