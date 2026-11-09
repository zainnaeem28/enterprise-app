#!/usr/bin/env node
// SEC03-F01 retest as a CI database test: the T-STAFF row-visibility matrix of the SEC-03 assessment (section 8.2) and the
// three SQL statements of F01, run as app_api against a database migrated from empty, plus the catalog check of F13 item 4
// (no policy compares a column with itself) and parity of migration 0705 with its generator.
//
//   EHR_TEST_ADMIN_URL=postgres://postgres@localhost:5432/postgres  node --test db/tools/staff-rls-matrix-test.mjs
//
// Same conventions as db-test.mjs: superuser URL of a throwaway server, own database created and dropped, nothing skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-staff-policies.mjs';
import { connect, requireEnv } from './pg.mjs';
import { readFileSync } from 'node:fs';

const adminUrl = requireEnv('EHR_TEST_ADMIN_URL');
const here = fileURLToPath(new URL('.', import.meta.url));
const dbName = `ehr_sec03f01_${process.pid}_${Date.now()}`;
const u = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ORG = u(0xa1);
const LOC_A = u(0xa101);
const LOC_B = u(0xa102);
const PAT_A = u(0xb1); // cared for at location A only
const PAT_B = u(0xb2); // cared for at location B only
const PRINCIPAL = u(0xc1);

const urlFor = (user, database) => {
  const x = new URL(adminUrl);
  x.username = user;
  x.password = '';
  x.pathname = `/${database}`;
  return x.toString();
};
const migrateCli = (command) =>
  execFileSync(process.execPath, [join(here, 'migrate.mjs'), command], {
    env: {
      PATH: process.env.PATH,
      EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl).username, dbName),
      EHR_DB_MIGRATE_URL: urlFor('app_owner', dbName),
    },
    encoding: 'utf8',
  });

/** Runs fn as app_api, a staff member of `locations`, in a transaction that is always rolled back. */
async function asStaff(locations, fn) {
  const c = await connect(urlFor('app_api', dbName), 'test-staff');
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries({
      'app.audience': 'staff',
      'app.realm': 'google',
      'app.org_id': ORG,
      'app.principal_id': PRINCIPAL,
      'app.location_ids': locations.join(','),
    }))
      await c.query('SELECT set_config($1, $2, true)', [k, v]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}
const count = async (c, table, patient) =>
  Number(
    (await c.query(`SELECT count(*) AS n FROM ${table} WHERE patient_id = $1`, [patient])).rows[0]
      .n,
  );

// One row per table that carries a T-STAFF read policy on patient_id.
const TABLES = [
  'patient.patient_contact',
  'patient.insurance_coverage',
  'patient.consent',
  'patient.communication_preference',
  'patient.care_relationship',
  'patient.care_team_member',
  'patient.duplicate_flag',
  'identity.patient_link',
  'identity.proxy_grant',
  'notifications.notification',
  // notifications.delivery_receipt: app_api holds no SELECT grant, so its staff policy is unreachable by direct SQL today
  // (reported separately); its predicate is covered by the catalog test below.
];

let admin;
let db;
before(async () => {
  admin = await connect(adminUrl, 'test-admin');
  await admin.query(`CREATE DATABASE ${dbName}`);
  migrateCli('bootstrap');
  migrateCli('migrate');
  db = await connect(urlFor(new URL(adminUrl).username, dbName), 'test-seed');
  // The superuser seeds without an application path; triggers and FKs are skipped, the rows are synthetic.
  await db.query(`SET session_replication_role = replica`);
  const q = (sql, p) => db.query(sql, p);
  for (const [id, n] of [
    [PAT_A, 'A'],
    [PAT_B, 'B'],
  ])
    await q(
      `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
       VALUES ($1, $2, $3, $4, 'Matrix', '1980-01-01', 'CA', 'front_desk')`,
      [id, ORG, `MRN-${n === 'A' ? '1000001' : '1000002'}`, `Pat${n}`],
    );
  await q(
    `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1,$2,$5),($3,$4,$5)`,
    [PAT_A, LOC_A, PAT_B, LOC_B, ORG],
  );
  let seq = 0x1000;
  for (const [p, loc] of [
    [PAT_A, LOC_A],
    [PAT_B, LOC_B],
  ]) {
    const n = () => u(seq++);
    await q(
      `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) VALUES ($1,$2,$3,'emergency','Contact')`,
      [n(), ORG, p],
    );
    await q(
      `INSERT INTO patient.insurance_coverage (id, organisation_id, patient_id, payer_name, member_id) VALUES ($1,$2,$3,'Payer','MEMBER-1')`,
      [n(), ORG, p],
    );
    await q(
      `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language) VALUES ($1,$2,$3,'treatment',1,'en')`,
      [n(), ORG, p],
    );
    await q(
      `INSERT INTO patient.communication_preference (patient_id, organisation_id, channels, language) VALUES ($1,$2,ARRAY['email'],'en')`,
      [p, ORG],
    );
    await q(
      `INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason) VALUES ($1,$2,$3,$4,'registration')`,
      [n(), ORG, p, loc],
    );
    await q(
      `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) VALUES ($1,$2,$3,$4,'clinician')`,
      [n(), ORG, p, PRINCIPAL],
    );
    await q(
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1,$2,$3,'self')`,
      [n(), p, ORG],
    );
    await q(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name) VALUES ($1,$2,$3,$4,'parent','Pat')`,
      [n(), ORG, n(), p],
    );
    const nid = n();
    await q(
      `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, template_key, template_version, channel, dedupe_key, patient_id, status) VALUES ($1,$2,'patient','t',1,'email',$3,$4,'queued')`,
      [nid, ORG, `matrix:${nid}`, p],
    );
    await q(
      `INSERT INTO notifications.delivery_receipt (id, organisation_id, notification_id, status, received_at, vendor_event_id, patient_id) VALUES ($1,$2,$3,'delivered',now(),$4,$5)`,
      [n(), ORG, nid, `v-${nid}`, p],
    );
  }
  // Duplicate flag A -> B (candidate side is B).
  await q(
    `INSERT INTO patient.duplicate_flag (id, organisation_id, patient_id, candidate_patient_id, strength, source) VALUES ($1,$2,$3,$4,'probable','front_desk')`,
    [u(0x2000), ORG, PAT_A, PAT_B],
  );
});
after(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.end();
});

describe("SEC03-F01: T-STAFF policies scope child rows to the staff member's locations", () => {
  test('control: staff of A read every child table row of patient A (seed is visible)', async () => {
    await asStaff([LOC_A], async (c) => {
      for (const t of TABLES)
        assert.ok((await count(c, t, PAT_A)) >= 1, `${t}: staff of A must see A's row`);
    });
  });

  test('staff of location B read 0 rows of patient A in every child table', async () => {
    await asStaff([LOC_B], async (c) => {
      for (const t of TABLES) {
        const expected = t === 'patient.duplicate_flag' ? 1 : 0; // the flag names B as the candidate: visible by design (F10a)
        assert.equal(await count(c, t, PAT_A), expected, `${t}: staff of B reading patient A`);
      }
      assert.equal(
        await count(c, 'patient.patient_contact', PAT_B),
        1,
        'staff of B still read their own patient',
      );
    });
  });

  test('staff of location A read 0 rows of patient B in every child table', async () => {
    await asStaff([LOC_A], async (c) => {
      for (const t of TABLES) {
        const expected = 0;
        assert.equal(await count(c, t, PAT_B), expected, `${t}: staff of A reading patient B`);
      }
    });
  });

  test('F01 statement 1-2: consent and insurance of patient A are not readable by staff of B', async () => {
    await asStaff([LOC_B], async (c) => {
      assert.equal(
        (await c.query(`SELECT id, status FROM patient.consent WHERE patient_id = $1`, [PAT_A]))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await c.query(
            `SELECT payer_name, member_id FROM patient.insurance_coverage WHERE patient_id = $1`,
            [PAT_A],
          )
        ).rowCount,
        0,
      );
    });
  });

  test('F01 statement 3 and the other writes: staff of B change 0 rows of patient A', async () => {
    await asStaff([LOC_B], async (c) => {
      const withdrawn = await c.query(
        `UPDATE patient.consent SET status = 'withdrawn' WHERE patient_id = $1 RETURNING status`,
        [PAT_A],
      );
      assert.equal(withdrawn.rowCount, 0, 'consent withdrawal across clinics');
      assert.equal(
        (await c.query(`DELETE FROM patient.patient_contact WHERE patient_id = $1`, [PAT_A]))
          .rowCount,
        0,
        'contact delete',
      );
      assert.equal(
        (
          await c.query(`UPDATE patient.patient_contact SET name = 'x' WHERE patient_id = $1`, [
            PAT_A,
          ])
        ).rowCount,
        0,
        'contact update',
      );
      assert.equal(
        (
          await c.query(
            `UPDATE patient.insurance_coverage SET payer_name = 'x' WHERE patient_id = $1`,
            [PAT_A],
          )
        ).rowCount,
        0,
        'insurance update',
      );
      assert.equal(
        (
          await c.query(
            `UPDATE patient.care_team_member SET to_date = current_date, end_reason = 'staff' WHERE patient_id = $1`,
            [PAT_A],
          )
        ).rowCount,
        0,
        'care team update',
      );
      assert.equal(
        (
          await c.query(
            `UPDATE notifications.notification SET status = 'cancelled' WHERE patient_id = $1`,
            [PAT_A],
          )
        ).rowCount,
        0,
        'notification cancel',
      );
    });
  });

  test('inserts for patient A by staff of B are refused by row-level security (42501)', async () => {
    await asStaff([LOC_B], async (c) => {
      await c.query('SAVEPOINT s');
      await assert.rejects(
        c.query(
          `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) VALUES ($1,$2,$3,'emergency','Evil')`,
          [u(0x3001), ORG, PAT_A],
        ),
        (e) => e.code === '42501',
      );
    });
  });

  test('control: staff of A still delete a contact of their own patient', async () => {
    await asStaff([LOC_A], async (c) => {
      assert.equal(
        (await c.query(`DELETE FROM patient.patient_contact WHERE patient_id = $1`, [PAT_A]))
          .rowCount,
        1,
      );
    });
  });

  test('catalog check (F13 item 4): no policy compares a column with itself', async () => {
    const r = await db.query(
      `SELECT schemaname, tablename, policyname FROM pg_policies
        WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '\\((\\w+)\\.(\\w+) = \\1\\.\\2\\)'`,
    );
    assert.deepEqual(r.rows, []);
  });

  test("all 21 rewritten policies reference the table's own patient_id column", async () => {
    const r = await db.query(
      `SELECT schemaname, tablename, policyname FROM pg_policies
        WHERE policyname ~ '_staff_(select|insert|update|delete|cancel)$' AND schemaname IN ('patient', 'identity', 'notifications')
          AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'staff_scope'
          AND tablename NOT IN ('patient', 'patient_merge')
          AND coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ ('s\\.patient_id = ' || tablename || '\\.patient_id')`,
    );
    assert.deepEqual(r.rows, []);
    const n = await db.query(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname IN ('patient', 'identity', 'notifications')
        AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ ('s\\.patient_id = ' || tablename || '\\.patient_id')`,
    );
    assert.equal(n.rows[0].n, 21);
  });

  test('migration 0705 equals the output of its generator (one template)', () => {
    assert.equal(
      readFileSync(join(here, '../migrations/0705_patient_staff_policy_qualify.sql'), 'utf8'),
      generate(),
    );
  });
});

// SEC05-F04 / INT04-F10 D-5 (HEAAA-432): `notifications.staff_scope_allows_patient` is the T-STAFF predicate (migration 2406),
// not the 1201 stub. Run on the migrations exactly as shipped: nothing in this file replaces the function.
describe('SEC05-F04: red-flag alerts follow patient.staff_scope on the unmodified migrations', () => {
  const DOC_IN = u(0xd1); // doctor at location A, targeted
  const DOC_OUT = u(0xd2); // doctor at location B, also targeted by the same alert
  const NURSE = u(0xd3); // nurse at location A, creates a red flag
  const ALERT = u(0xe1);

  async function asPrincipal(principal, locations, fn, btg = []) {
    const c = await connect(urlFor('app_api', dbName), 'test-alert');
    try {
      await c.query('BEGIN');
      for (const [k, v] of Object.entries({
        'app.audience': 'staff',
        'app.realm': 'google',
        'app.org_id': ORG,
        'app.principal_id': principal,
        'app.location_ids': locations.join(','),
        'app.btg_patient_ids': btg.join(','),
      }))
        await c.query('SELECT set_config($1, $2, true)', [k, v]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  const visible = async (c) =>
    (await c.query(`SELECT id FROM notifications.staff_alert WHERE id = $1`, [ALERT])).rowCount;
  const acknowledge = (c, principal) =>
    c.query(
      `UPDATE notifications.staff_alert SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), escalate_at = NULL
        WHERE id = $1`,
      [ALERT, principal],
    );

  before(async () => {
    await db.query(
      `INSERT INTO notifications.staff_alert (id, organisation_id, type, severity, patient_id, resource_type, resource_id,
         target_kind, target_principal_ids, created_by)
       VALUES ($1, $2, 'red_flag', 'critical', $3, 'triage_assessment', $4, 'principal', $5, $6)`,
      [ALERT, ORG, PAT_A, u(0xe2), [DOC_IN, DOC_OUT], NURSE],
    );
  });

  test('the function body is not the literal false stub and is the T-STAFF template', async () => {
    const r = await db.query(
      `SELECT prosrc, prosecdef FROM pg_proc WHERE oid = 'notifications.staff_scope_allows_patient(uuid)'::regprocedure`,
    );
    assert.equal(r.rows.length, 1);
    assert.ok(!/^\s*select\s+false\s*;?\s*$/i.test(r.rows[0].prosrc), 'literal false body');
    assert.match(r.rows[0].prosrc, /patient\.staff_scope/);
    assert.equal(r.rows[0].prosecdef, false, 'stays SECURITY INVOKER');
  });

  test('the in-scope doctor sees the red flag and acknowledges it', async () => {
    await asPrincipal(DOC_IN, [LOC_A], async (c) => {
      assert.equal(await visible(c), 1);
      assert.equal((await acknowledge(c, DOC_IN)).rowCount, 1);
      const r = await c.query(
        `SELECT status, acknowledged_by FROM notifications.staff_alert WHERE id = $1`,
        [ALERT],
      );
      assert.deepEqual(r.rows[0], { status: 'acknowledged', acknowledged_by: DOC_IN });
    });
  });

  test('the out-of-scope doctor, although targeted, does not see it and cannot acknowledge it', async () => {
    await asPrincipal(DOC_OUT, [LOC_B], async (c) => {
      assert.equal(await visible(c), 0);
      assert.equal((await acknowledge(c, DOC_OUT)).rowCount, 0);
    });
    const r = await db.query(`SELECT status FROM notifications.staff_alert WHERE id = $1`, [ALERT]);
    assert.equal(r.rows[0].status, 'open', 'no acknowledgement leaked through');
  });

  test('a break-the-glass grant on the patient brings the alert into scope', async () => {
    await asPrincipal(DOC_OUT, [LOC_B], async (c) => assert.equal(await visible(c), 1), [PAT_A]);
  });

  test('realm other than google is not in scope even at the right location', async () => {
    const c = await connect(urlFor('app_api', dbName), 'test-alert-realm');
    try {
      await c.query('BEGIN');
      for (const [k, v] of Object.entries({
        'app.audience': 'staff',
        'app.realm': 'admin_pool',
        'app.org_id': ORG,
        'app.principal_id': DOC_IN,
        'app.location_ids': LOC_A,
      }))
        await c.query('SELECT set_config($1, $2, true)', [k, v]);
      assert.equal(await visible(c), 0);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });

  test('a nurse creates a red flag for a patient in scope and is refused for one out of scope', async () => {
    const insert = (c, id, patient) =>
      c.query(
        `INSERT INTO notifications.staff_alert (id, organisation_id, type, severity, patient_id, resource_type, resource_id,
           target_kind, target_principal_ids, created_by)
         VALUES ($1, $2, 'red_flag', 'critical', $3, 'triage_assessment', $4, 'principal', $5, $6)`,
        [id, ORG, patient, u(0xe3), [DOC_IN], NURSE],
      );
    await asPrincipal(NURSE, [LOC_A], async (c) => {
      assert.equal((await insert(c, u(0xe4), PAT_A)).rowCount, 1);
      await c.query('SAVEPOINT s');
      await assert.rejects(insert(c, u(0xe5), PAT_B), (e) => e.code === '42501');
    });
  });
});
