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
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const insertSetting = (c, row) =>
    c.query(
      "INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, pre_auth) VALUES ($1, $2, $3, '1', 'int', $4)",
      row,
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
