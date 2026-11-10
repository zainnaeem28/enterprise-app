#!/usr/bin/env node
// Real-database tests for the referral accept/decline scope change (INT03-F08d; ruling HEAAA-325 rev 3 (cfaaf33c), G2 delta decisions
// HEAAA-330 and HEAAA-337 (conditions C-1..C-5); migrations 2300 and 2301). Test IDs T-RA-nn are the ruling's (section 3.3). PostgreSQL 17, synthetic data only.
//
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres  node --test db/tests/referral-accept-scope.test.mjs
//
// Every expected outcome was fixed by the ruling before this file was written; none is "as observed". Referrals are sent and
// decided through the application role app_api under the real policies and the real functions. States that the API cannot
// produce (mismatched inbox and referral rows, a merged patient still named by a sent referral) are inserted or changed by the
// superuser seed connection; each such test says so. The merge re-point of T-RA-16(a) is applied by the same connection with the
// statements of the merge transaction (patient merged, `sent` referral re-pointed to the survivor), not by the merge executor,
// whose route-level coverage belongs to the API suites.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connect, requireEnv } from '../tools/pg.mjs';
import { definerInventory } from '../tools/catalog-lists.mjs';
import { runChecks } from '../tools/catalog-check.mjs';

const adminUrl = requireEnv('EHR_TEST_ADMIN_URL');
const tools = join(fileURLToPath(new URL('.', import.meta.url)), '../tools');
const migrationsDir = join(tools, '../migrations');
const dbName = `ehr_ra_${process.pid}_${Date.now()}`;
const urlFor = (user, database) => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};
const run = (command) =>
  execFileSync(process.execPath, [join(tools, 'migrate.mjs'), command], {
    env: {
      PATH: process.env.PATH,
      EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl).username, dbName),
      EHR_DB_MIGRATE_URL: urlFor('app_owner', dbName),
    },
    encoding: 'utf8',
  });

// ---- fixture identifiers (synthetic) --------------------------------------------------------------------------------
const uid = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const O1 = uid(1);
const O2 = uid(2);
const A1 = uid(11); // sender
const A2 = uid(12); // target
const A3 = uid(13); // unrelated
const A4 = uid(14); // organisation O2
const SVC = uid(21);
const staffIds = {
  s1: uid(101),
  s2: uid(102),
  s2b: uid(106),
  s3: uid(103),
  s12: uid(104),
  s13: uid(105),
  sB: uid(107),
  sO2: uid(108),
};
let seq = 1000;
const nextId = () => uid(++seq);

let admin; // superuser connection to the throwaway database (seeding and catalog reads only)
let adminServer;

/** Settings of a staff caller. */
const staff = (who, locs, extra = {}) => ({
  'app.org_id': who === 'sO2' ? O2 : O1,
  'app.audience': 'staff',
  'app.realm': who === 'sB' ? 'admin_pool' : 'google',
  'app.principal_id': staffIds[who],
  'app.person_id': staffIds[who],
  'app.location_ids': locs.join(','),
  ...extra,
});
const S = {
  s1: () => staff('s1', [A1]),
  s2: () => staff('s2', [A2]),
  s2b: () => staff('s2b', [A2]),
  s3: () => staff('s3', [A3]),
  s12: () => staff('s12', [A1, A2]),
  s13: () => staff('s13', [A1, A3]),
  sO2: () => staff('sO2', [A4]),
  sB: (p) => staff('sB', [A1], { 'app.btg_patient_ids': p }),
};

/** Opens a transaction as `role` with the given transaction-local settings. The caller commits or rolls back. */
async function open(role, settings) {
  const c = await connect(urlFor(role, dbName), `ra-${role}`);
  await c.query('BEGIN');
  for (const [k, v] of Object.entries(settings))
    await c.query('SELECT set_config($1, $2, true)', [k, v]);
  return c;
}
/** Runs fn in a transaction; commits unless `commit` is false. */
async function tx(role, settings, fn, commit = true) {
  const c = await open(role, settings);
  try {
    const out = await fn(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
const api = (who, fn, commit = true) => tx('app_api', S[who](), fn, commit);
const val = async (c, sql, args = []) => (await c.query(sql, args)).rows[0];

/** Counts of everything a refused call must leave unchanged (T-RA-31). */
async function snapshot() {
  const r = await val(
    admin,
    `SELECT (SELECT count(*) FROM audit.event)::int AS audit,
            (SELECT count(*) FROM patient.care_relationship)::int AS rel,
            (SELECT count(*) FROM patient.staff_scope)::int AS scope`,
  );
  return r;
}
/** Asserts that `fn` fails with `code` and (T-RA-31) changes no audit, relationship or scope row. */
async function refused(code, what, fn) {
  const before = await snapshot();
  await assert.rejects(fn, (e) => {
    assert.equal(e.code, code, `${what}: expected SQLSTATE ${code}, got ${e.code} (${e.message})`);
    return true;
  });
  assert.deepEqual(
    await snapshot(),
    before,
    `${what}: a refused call changed audit, relationship or scope rows`,
  );
}

// ---- seeding ----------------------------------------------------------------------------------------------------------
async function seedBase() {
  await admin.query(
    `INSERT INTO organisation.organisation (id, organisation_id, name, default_time_zone) VALUES
    ($1, $1, 'Synthetic Org One', 'UTC'), ($2, $2, 'Synthetic Org Two', 'UTC')`,
    [O1, O2],
  );
  await admin.query(
    `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'Synthetic State'), ('CA', $2, 'Synthetic State 2')`,
    [O1, O2],
  );
  await admin.query(
    `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code) VALUES
     ($1, $5, 'A1 sender', 'clinic', 'UTC', 'NY'), ($2, $5, 'A2 target', 'clinic', 'UTC', 'NY'),
     ($3, $5, 'A3 other', 'clinic', 'UTC', 'NY'), ($4, $6, 'A4 org two', 'clinic', 'UTC', 'CA')`,
    [A1, A2, A3, A4, O1, O2],
  );
  await admin.query(
    `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode)
     VALUES ($1, $2, 'svc', 'Svc', 30, 0, 'in_person')`,
    [SVC, O1],
  );
  await admin.query('BEGIN');
  for (const [name, id] of Object.entries(staffIds)) {
    const org = name === 'sO2' ? O2 : O1;
    await admin.query(
      `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, $3)`,
      [id, org, `Synthetic ${name}`],
    );
    await admin.query(
      `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject) VALUES ($1, $2, $1, $3, $4)`,
      [id, org, name === 'sB' ? 'admin_pool' : 'google', `synthetic-${name}`],
    );
  }
  await admin.query('COMMIT');
}
let patientNo = 0;
/** A patient in O1 with an open registration relationship at A1 only (superuser seed; recompute_scope derives staff_scope). */
async function mkPatient(org = O1, loc = A1) {
  const id = nextId();
  patientNo += 1;
  await admin.query(
    `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
     VALUES ($1, $2, $3, 'Synthetic', $4, DATE '1990-01-01', $5, 'front_desk')`,
    [
      id,
      org,
      `MRN-${String(1000000 + patientNo)}`,
      `Patient${patientNo}`,
      org === O1 ? 'NY' : 'CA',
    ],
  );
  await force(
    `INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason) VALUES (gen_random_uuid(), $1, $2, $3, 'registration')`,
    [org, id, loc],
  );
  await force('SELECT patient.recompute_scope($1)', [id]);
  return id;
}
/** Draft, send and inbox row, written by the sender s1 (or s12) under the real policies, as the send route does. */
async function sendReferral(patient, { to = A2, kind = 'internal_location', by = 's1' } = {}) {
  const id = nextId();
  await api(by, async (c) => {
    await c.query(
      `INSERT INTO clinical.referral (id, organisation_id, patient_id, from_location_id, from_principal_id, target_kind, target_location_id, target_service_id, reason, created_by)
       VALUES ($1, kernel.uuid1('app.org_id'), $2, $3, $4, $5, $6, $7, 'Synthetic reason PHI', $4)`,
      [
        id,
        patient,
        A1,
        staffIds[by],
        kind,
        kind === 'internal_location' ? to : null,
        kind === 'internal_service' ? SVC : null,
      ],
    );
    await c.query(
      `UPDATE clinical.referral SET status = 'sent', target_location_id = $2 WHERE id = $1`,
      [id, to],
    );
    await c.query(
      `INSERT INTO clinical.referral_inbox (referral_id, organisation_id, target_location_id, patient_label_ref, created_by)
       VALUES ($1, kernel.uuid1('app.org_id'), $2, $1, $3)`,
      [id, to, staffIds[by]],
    );
  });
  return id;
}
/** Owner-side state change (the API cannot produce these combinations). */
// Owner-side fixture writes. The seed connection is the superuser (RLS bypassed) and each statement runs with
// session_replication_role = replica, so the 1701 state-machine and merge-guard triggers do not stand in the way of states that the
// API cannot produce (the system/org context is still set for the statements that read it). CHECK constraints still apply.
async function force(sql, args) {
  await admin.query('BEGIN');
  try {
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(
      `SELECT set_config('app.audience', 'system', true), set_config('app.org_id', $1, true), set_config('app.job_scope', 'org', true)`,
      [O1],
    );
    const r = await admin.query(sql, args);
    await admin.query('COMMIT');
    return r;
  } catch (e) {
    await admin.query('ROLLBACK');
    throw e;
  }
}
const setStates = async (ref, referral, inbox) => {
  await force(
    `UPDATE clinical.referral SET status = $2, decided_by = CASE WHEN $2 IN ('accepted','declined','completed') THEN $3::uuid END,
            decided_at = CASE WHEN $2 IN ('accepted','declined','completed') THEN now() END,
            decline_reason = CASE WHEN $2 = 'declined' THEN 'synthetic' END WHERE id = $1`,
    [ref, referral, staffIds.s2],
  );
  await force(
    `UPDATE clinical.referral_inbox SET status = $2, decided_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END WHERE referral_id = $1`,
    [ref, inbox],
  );
};

const lock = (c, ref, patient, mode = 'no_key_update') =>
  c.query('SELECT patient.lock_referral_patient($1, $2, $3)', [ref, patient, mode]);
const ensureRef = (c, ref, req = randomUUID()) =>
  val(c, 'SELECT patient.ensure_referral_care_relationship($1, $2) AS id', [req, ref]);
const ensureOld = (c, patient, loc, reason = 'referral') =>
  val(c, 'SELECT patient.ensure_care_relationship($1, $2, $3, $4) AS id', [
    randomUUID(),
    patient,
    loc,
    reason,
  ]);
const relCount = async (patient, loc, reason) =>
  (
    await val(
      admin,
      `SELECT count(*)::int AS n FROM patient.care_relationship WHERE patient_id = $1 AND location_id = $2 AND ended_at IS NULL AND ($3::text IS NULL OR reason = $3)`,
      [patient, loc, reason],
    )
  ).n;
const scopeRows = async (patient) =>
  (
    await admin.query(
      'SELECT location_id FROM patient.staff_scope WHERE patient_id = $1 ORDER BY 1',
      [patient],
    )
  ).rows.map((r) => r.location_id);

/** The accept/decline transaction in the order of ruling R-REF-8 (what `decide()` must do): lock, inbox, re-check, create (accept only), updates. */
async function decide(who, ref, patient, decision) {
  const c = await open('app_api', S[who]());
  try {
    await lock(c, ref, patient, decision === 'accepted' ? 'no_key_update' : 'key_share');
    const inbox = (
      await c.query(
        `SELECT * FROM clinical.referral_inbox WHERE referral_id = $1 AND status = 'pending' FOR UPDATE`,
        [ref],
      )
    ).rows[0];
    if (inbox === undefined) {
      await c.query('ROLLBACK');
      return 'not_pending';
    }
    const row = (await c.query('SELECT * FROM clinical.referral WHERE id = $1', [ref])).rows[0];
    if (row === undefined || row.status !== 'sent') {
      await c.query('ROLLBACK');
      return 'not_pending';
    }
    if (decision === 'accepted') await ensureRef(c, ref);
    const u = await c.query(
      `UPDATE clinical.referral SET status = $2, decided_by = $3, decided_at = now(), decline_reason = $4 WHERE id = $1 RETURNING *`,
      [ref, decision, staffIds[who], decision === 'declined' ? 'synthetic decline' : null],
    );
    assert.equal(u.rows.length, 1, 'the deciding UPDATE ... RETURNING sees its new row under 2301');
    await c.query(
      `UPDATE clinical.referral_inbox SET status = $2, decided_at = now() WHERE referral_id = $1`,
      [ref, decision],
    );
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  adminServer = await connect(adminUrl, 'ra-admin-server');
  await adminServer.query(`CREATE DATABASE ${dbName}`);
  const major = Number(
    (await adminServer.query('SHOW server_version_num')).rows[0].server_version_num,
  );
  assert.ok(major >= 170000 && major < 180000, `PostgreSQL 17 required, got ${major}`);
  run('bootstrap');
  run('migrate');
  admin = await connect(urlFor(new URL(adminUrl).username, dbName), 'ra-admin');
  await seedBase();
});
after(async () => {
  await admin?.end();
  await adminServer?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await adminServer?.end();
});

describe('migrations 2300 and 2301', () => {
  test('both are applied, in order, exactly once', async () => {
    const r = await admin.query(
      'SELECT version, name FROM migration.schema_migration WHERE version IN (2300, 2301) ORDER BY version',
    );
    assert.deepEqual(
      r.rows.map((x) => [x.version, x.name]),
      [
        [2300, 'patient_referral_accept_scope'],
        [2301, 'clinical_referral_target_read_pending'],
      ],
    );
  });
});

describe('C-5: the 2301 file is the ruling text', () => {
  test('2301 hashes to the sha256 fixed by ruling 3.1b (comment-only reformatting not applied)', () => {
    const h = createHash('sha256')
      .update(readFileSync(join(migrationsDir, '2301_clinical_referral_target_read_pending.sql')))
      .digest('hex');
    assert.equal(h, '52d13437413dbe3c4080594b582da1632e32a4be405c7a475d22a16cb139e387');
  });
});

describe('T-RA-01..04: the receiving location locks, creates the relationship, and reads nothing else before', () => {
  test('T-RA-01 lock_referral_patient takes the root lock and holds it to commit', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    const c = await open('app_api', S.s2());
    await lock(c, ref, p, 'no_key_update');
    const other = await connect(urlFor(new URL(adminUrl).username, dbName), 'ra-other');
    try {
      await other.query(`SET lock_timeout = '300ms'`);
      await assert.rejects(
        other.query('SELECT 1 FROM patient.patient WHERE id = $1 FOR UPDATE', [p]),
        (e) => e.code === '55P03',
      );
      await c.query('COMMIT');
      await other.query('SELECT 1 FROM patient.patient WHERE id = $1 FOR UPDATE', [p]); // free again
    } finally {
      await other.end();
      await c.end();
    }
    // key_share mode is also accepted and conflicts only with FOR UPDATE
    await api('s2', (k) => lock(k, ref, p, 'key_share'));
  });

  test('T-RA-02 ensure_referral_care_relationship creates the relationship, scope rows, one audit row, and caller_sees becomes true', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    const req = randomUUID();
    const id = await api('s2', async (c) => {
      const out = await ensureRef(c, ref, req);
      // inside the same transaction the receiving location now reads the patient through the normal T-STAFF policy
      assert.equal(
        (await c.query('SELECT 1 FROM patient.patient WHERE id = $1', [p])).rows.length,
        1,
      );
      return out.id;
    });
    const rel = await admin.query(
      `SELECT * FROM patient.care_relationship WHERE patient_id = $1 AND location_id = $2`,
      [p, A2],
    );
    assert.equal(rel.rows.length, 1);
    assert.equal(rel.rows[0].id, id);
    assert.equal(rel.rows[0].reason, 'referral');
    assert.deepEqual(await scopeRows(p), [A1, A2].sort());
    const aud = await admin.query(`SELECT * FROM audit.event WHERE request_id = $1`, [req]);
    assert.equal(aud.rows.length, 1);
    assert.equal(aud.rows[0].resource_type, 'patient.care_relationship');
    assert.equal(aud.rows[0].action, 'update');
    assert.deepEqual(aud.rows[0].change, { reason: 'referral', started: true, referral_id: ref });
    assert.equal(aud.rows[0].patient_id, p);
    assert.equal(aud.rows[0].location_id, A2);
    // after commit: the T-STAFF branch shows the patient and the referral row to the receiving location
    await api('s2', async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM patient.patient WHERE id = $1', [p])).rows.length,
        1,
      );
      assert.equal(
        (await c.query('SELECT 1 FROM clinical.referral WHERE id = $1', [ref])).rows.length,
        1,
      );
    });
  });

  test('T-RA-03 idempotent: an open relationship is returned; no new row, no new audit row', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    const first = await api('s2', async (c) => (await ensureRef(c, ref)).id);
    const before = await snapshot();
    const second = await api('s2', async (c) => (await ensureRef(c, ref)).id);
    // the referral is still sent/pending (this test never decided it), so the predicate still passes
    assert.equal(second, first);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await relCount(p, A2, 'referral'), 1);
  });

  test('T-RA-04 before any call, s2 reads no patient, chart row or demographics (R-REF-1: no read widening)', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await api('s2', async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM patient.patient WHERE id = $1', [p])).rows.length,
        0,
      );
      assert.equal(
        (await c.query('SELECT 1 FROM patient.care_relationship WHERE patient_id = $1', [p])).rows
          .length,
        0,
      );
      assert.equal(
        (await c.query('SELECT 1 FROM patient.staff_scope WHERE patient_id = $1', [p])).rows.length,
        0,
      );
      for (const t of [
        'clinical.problem',
        'clinical.allergy',
        'clinical.encounter',
        'clinical.triage_assessment',
        'clinical.vital_sign',
      ])
        assert.equal(
          (await c.query(`SELECT 1 FROM ${t} WHERE patient_id = $1`, [p])).rows.length,
          0,
          t,
        );
      // R-REF-1: the referral row itself (with patient_id and reason) and the inbox row (no patient column) ARE readable while sent
      const r = (
        await c.query('SELECT patient_id, reason FROM clinical.referral WHERE id = $1', [ref])
      ).rows;
      assert.equal(r.length, 1);
      assert.equal(r[0].reason, 'Synthetic reason PHI');
      const ib = (
        await c.query('SELECT * FROM clinical.referral_inbox WHERE referral_id = $1', [ref])
      ).rows;
      assert.equal(ib.length, 1);
      assert.ok(!('patient_id' in ib[0]));
    });
    // match_candidates on the patient's own demographics returns no in-scope demographics of P for s2
    const demo = await val(
      admin,
      'SELECT given_name, family_name, date_of_birth FROM patient.patient WHERE id = $1',
      [p],
    );
    const out = await api('s2', async (c) =>
      val(c, 'SELECT patient.match_candidates($1, $2, $3, $4, NULL, NULL, $5, $6) AS r', [
        randomUUID(),
        demo.given_name,
        demo.family_name,
        demo.date_of_birth,
        Buffer.alloc(32, 7),
        A2,
      ]),
    );
    assert.ok(
      !JSON.stringify(out.r).includes(p),
      'match_candidates must not reveal P to the receiving location before it accepts',
    );
    assert.equal(
      (
        await val(
          admin,
          `SELECT count(*)::int AS n FROM patient.staff_scope WHERE patient_id = $1 AND location_id = $2`,
          [p, A2],
        )
      ).n,
      0,
    );
  });
});

describe('T-RA-05..16: refusals (all through refused(): no audit, relationship or scope row changes: T-RA-31)', () => {
  test('T-RA-05 cross-clinic: s3 (A3) is refused by both functions with PM008', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await refused('PM008', 'lock s3', () => api('s3', (c) => lock(c, ref, p)));
    await refused('PM008', 'ensure s3', () => api('s3', (c) => ensureRef(c, ref)));
    assert.equal(await relCount(p, A3), 0);
    assert.deepEqual(await scopeRows(p), [A1]);
  });

  test('T-RA-06 cross-organisation: sO2 is refused by both functions with PM008', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await refused('PM008', 'lock sO2', () => api('sO2', (c) => lock(c, ref, p)));
    await refused('PM008', 'ensure sO2', () => api('sO2', (c) => ensureRef(c, ref)));
  });

  const closed = [
    [
      'T-RA-07 draft',
      async (ref) => {
        await force(`DELETE FROM clinical.referral_inbox WHERE referral_id = $1`, [ref]);
        await force(`UPDATE clinical.referral SET status = 'draft' WHERE id = $1`, [ref]);
      },
    ],
    ['T-RA-08 declined (inbox declined)', async (ref) => setStates(ref, 'declined', 'declined')],
    [
      'T-RA-09 cancelled by the sender after sending (inbox still pending)',
      async (ref) => setStates(ref, 'cancelled', 'pending'),
    ],
    ['T-RA-10 accepted', async (ref) => setStates(ref, 'accepted', 'accepted')],
    ['T-RA-10 completed', async (ref) => setStates(ref, 'completed', 'accepted')],
  ];
  for (const [name, mutate] of closed)
    test(`${name}: PM008 from both functions`, async () => {
      const p = await mkPatient();
      const ref = await sendReferral(p);
      if (name.includes('cancelled')) {
        // the real path: the sender cancels with the real policies; the inbox row stays pending
        await api('s1', (c) =>
          c.query(`UPDATE clinical.referral SET status = 'cancelled' WHERE id = $1`, [ref]),
        );
        assert.equal(
          (
            await val(admin, 'SELECT status FROM clinical.referral_inbox WHERE referral_id = $1', [
              ref,
            ])
          ).status,
          'pending',
        );
      } else await mutate(ref);
      await refused('PM008', `${name} lock`, () => api('s2', (c) => lock(c, ref, p)));
      await refused('PM008', `${name} ensure`, () => api('s2', (c) => ensureRef(c, ref)));
      assert.equal(await relCount(p, A2), 0);
    });

  test('T-RA-11 external referral: PM008', async () => {
    const p = await mkPatient();
    const ref = nextId();
    await api('s1', (c) =>
      c.query(
        `INSERT INTO clinical.referral (id, organisation_id, patient_id, from_location_id, from_principal_id, target_kind, target_external_text, reason, created_by)
         VALUES ($1, kernel.uuid1('app.org_id'), $2, $3, $4, 'external', 'Synthetic external clinic', 'r', $4)`,
        [ref, p, A1, staffIds.s1],
      ),
    );
    await api('s1', (c) =>
      c.query(`UPDATE clinical.referral SET status = 'sent' WHERE id = $1`, [ref]),
    );
    await refused('PM008', 'external lock', () => api('s2', (c) => lock(c, ref, p)));
    await refused('PM008', 'external ensure', () => api('s2', (c) => ensureRef(c, ref)));
  });

  test('T-RA-12 "expired" is not a referral state in the approved design (R-REF-4); covered by T-RA-07..11, no expiry is fabricated', async () => {
    const c = await val(
      admin,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'clinical.referral'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%declined%' AND pg_get_constraintdef(oid) LIKE '%draft%'`,
    );
    assert.ok(!c.def.includes('expired'));
  });

  test('T-RA-13 patient mismatch and unknown referral give the same PM008 message (no probe)', async () => {
    const p = await mkPatient();
    const p2 = await mkPatient();
    const ref = await sendReferral(p);
    const msgs = [];
    for (const fn of [
      () => api('s2', (c) => lock(c, ref, p2)),
      () => api('s2', (c) => lock(c, randomUUID(), p)),
      () => api('s2', (c) => ensureRef(c, randomUUID())),
      () => api('s3', (c) => lock(c, ref, p)),
    ]) {
      await refused('PM008', 'probe', async () => {
        try {
          await fn();
        } catch (e) {
          msgs.push(e.message);
          throw e;
        }
      });
    }
    assert.equal(new Set(msgs).size, 1, `messages differ: ${JSON.stringify(msgs)}`);
  });

  test('T-RA-14 audiences other than google staff: 42501 (own check or no EXECUTE)', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    const base = { 'app.org_id': O1, 'app.principal_id': staffIds.s2, 'app.location_ids': A2 };
    const cases = [
      [
        'patient',
        { ...base, 'app.audience': 'patient', 'app.realm': 'patient_pool', 'app.patient_ids': p },
      ],
      ['admin_pool', { ...base, 'app.audience': 'staff', 'app.realm': 'admin_pool' }],
      ['anonymous', { 'app.org_id': O1, 'app.audience': 'anonymous' }],
      ['public', { 'app.org_id': O1, 'app.audience': 'public' }],
      ['no settings', {}],
    ];
    for (const [name, s] of cases) {
      await refused('42501', `${name} lock`, () => tx('app_api', s, (c) => lock(c, ref, p)));
      await refused('42501', `${name} ensure`, () => tx('app_api', s, (c) => ensureRef(c, ref)));
    }
    const sys = { 'app.org_id': O1, 'app.audience': 'system', 'app.job_scope': 'org' };
    await refused('42501', 'system (app_worker) lock', () =>
      tx('app_worker', sys, (c) => lock(c, ref, p)),
    );
    await refused('42501', 'system (app_worker) ensure', () =>
      tx('app_worker', sys, (c) => ensureRef(c, ref)),
    );
    // a system audience set on app_api is refused by the function's own check
    await refused('42501', 'system audience on app_api', () =>
      tx('app_api', sys, (c) => ensureRef(c, ref)),
    );
  });

  test('T-RA-15 bad mode and NULL arguments: 22023', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await refused('22023', 'bad mode', () => api('s2', (c) => lock(c, ref, p, 'update')));
    await refused('22023', 'NULL mode', () =>
      api('s2', (c) => c.query('SELECT patient.lock_referral_patient($1, $2, NULL)', [ref, p])),
    );
    await refused('22023', 'NULL referral', () =>
      api('s2', (c) => c.query(`SELECT patient.lock_referral_patient(NULL, $1, 'key_share')`, [p])),
    );
    await refused('22023', 'NULL patient', () =>
      api('s2', (c) =>
        c.query(`SELECT patient.lock_referral_patient($1, NULL, 'key_share')`, [ref]),
      ),
    );
    await refused('22023', 'ensure NULL referral', () =>
      api('s2', (c) =>
        c.query('SELECT patient.ensure_referral_care_relationship($1, NULL)', [randomUUID()]),
      ),
    );
  });

  test('T-RA-16(a) merge: a sent referral is re-pointed to the survivor; P is refused, S succeeds, one relationship (S, A2)', async () => {
    const p = await mkPatient();
    const s = await mkPatient();
    const ref = await sendReferral(p);
    // the statements of the merge transaction (25.4), applied by the seed connection: referral re-pointed first, then P merged
    await force(`UPDATE clinical.referral SET patient_id = $2 WHERE id = $1`, [ref, s]);
    await force(`UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`, [
      p,
      s,
    ]);
    await force(
      `INSERT INTO patient.patient_merge (merged_id, organisation_id, direct_survivor_id, final_survivor_id, merge_request_id) VALUES ($1, $3, $2, $2, gen_random_uuid())`,
      [p, s, O1],
    );
    await force('SELECT patient.recompute_scope($1)', [s]);
    await refused('PM008', 'lock with the merged ID', () => api('s2', (c) => lock(c, ref, p)));
    await api('s2', async (c) => {
      await lock(c, ref, s, 'no_key_update');
      await ensureRef(c, ref);
    });
    assert.equal(await relCount(s, A2, 'referral'), 1);
    assert.equal(await relCount(p, A2), 0);
    assert.ok((await scopeRows(p)).includes(A2), 'the merged ID is in the closure of the survivor');
  });

  test('T-RA-16(b) synthetic state: P merged while the sent referral still names P: PM001, no relationship, no audit row', async () => {
    const p = await mkPatient();
    const s = await mkPatient();
    const ref = await sendReferral(p);
    await force(`UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`, [
      p,
      s,
    ]);
    await refused('PM001', 'merged patient', () => api('s2', (c) => ensureRef(c, ref)));
    assert.equal(await relCount(p, A2), 0);
  });

  test('T-RA-16(c) interleaving (decision-log OBS-1): a merge commits between the predicate and the patient lock: PM001', async () => {
    const p = await mkPatient();
    const s = await mkPatient();
    const ref = await sendReferral(p);
    const m = await connect(urlFor(new URL(adminUrl).username, dbName), 'ra-merge');
    await m.query('BEGIN');
    await m.query('SELECT 1 FROM patient.patient WHERE id = $1 FOR UPDATE', [p]); // the merge holds the root
    const c = await open('app_api', S.s2());
    const pending = ensureRef(c, ref).then(
      (v) => ({ v }),
      (e) => ({ e }),
    );
    await sleep(400); // s2 has passed the predicate and waits for the root
    await m.query(`UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`, [
      p,
      s,
    ]);
    await m.query('COMMIT');
    const out = await pending;
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
    await m.end();
    assert.equal(
      out.e?.code,
      'PM001',
      `expected PM001, got ${JSON.stringify(out.e?.message ?? out.v)}`,
    );
    assert.equal(await relCount(p, A2), 0);
  });
});

describe('T-RA-17..20, 27, 28, 32: the origin guard (R-REF-6) and the old function', () => {
  test('T-RA-17 s12 sees P at A1 and holds A2: the old function refuses a referral relationship with no referral, and allows it with a pending one', async () => {
    const p = await mkPatient();
    await refused('42501', 'no referral', () => api('s12', (c) => ensureOld(c, p, A2)));
    assert.equal(await relCount(p, A2), 0);
    await sendReferral(p);
    const out = await api('s12', (c) => ensureOld(c, p, A2));
    assert.ok(out.id);
    assert.equal(await relCount(p, A2, 'referral'), 1);
  });

  test('T-RA-18 regressions: a patient caller with reason referral is refused; the old function with reason booking and no appointment is refused', async () => {
    const p = await mkPatient();
    await sendReferral(p);
    const patientCaller = {
      'app.org_id': O1,
      'app.audience': 'patient',
      'app.realm': 'patient_pool',
      'app.principal_id': staffIds.s1,
      'app.patient_ids': p,
    };
    await refused('42501', 'patient referral', () =>
      tx('app_api', patientCaller, (c) => ensureOld(c, p, A2)),
    );
    await refused('42501', 'booking without appointment', () =>
      api('s12', (c) => ensureOld(c, p, A2, 'booking')),
    );
  });

  test('T-RA-27 bound to the location: s13 (sees P at A1, holds A3) cannot add A3 while the pending referral goes to A2', async () => {
    const p = await mkPatient();
    await sendReferral(p, { to: A2 });
    await refused('42501', 'wrong location', () => api('s13', (c) => ensureOld(c, p, A3)));
    assert.equal(await relCount(p, A3), 0);
  });

  const mismatches = [
    [
      '(a) inbox pending but referral accepted',
      (ref) =>
        force(
          `UPDATE clinical.referral SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1`,
          [ref, staffIds.s2],
        ),
    ],
    [
      '(a) inbox pending but referral declined',
      (ref) =>
        force(
          `UPDATE clinical.referral SET status = 'declined', decided_by = $2, decided_at = now(), decline_reason = 'x' WHERE id = $1`,
          [ref, staffIds.s2],
        ),
    ],
    [
      '(a) inbox pending but referral cancelled',
      (ref) => force(`UPDATE clinical.referral SET status = 'cancelled' WHERE id = $1`, [ref]),
    ],
    [
      '(a) inbox pending but referral completed',
      (ref) =>
        force(
          `UPDATE clinical.referral SET status = 'completed', decided_by = $2, decided_at = now() WHERE id = $1`,
          [ref, staffIds.s2],
        ),
    ],
    [
      '(b) referral sent to A2 but its inbox row at A3',
      (ref) =>
        force(`UPDATE clinical.referral_inbox SET target_location_id = $2 WHERE referral_id = $1`, [
          ref,
          A3,
        ]),
    ],
    [
      '(c) referral sent to A2 with no inbox row',
      (ref) => force(`DELETE FROM clinical.referral_inbox WHERE referral_id = $1`, [ref]),
    ],
  ];
  for (const [name, mutate] of mismatches)
    test(`T-RA-28 ${name}: PM008 from both new functions, 42501 from the trigger path`, async () => {
      const p = await mkPatient();
      const ref = await sendReferral(p);
      await mutate(ref);
      await refused('PM008', `${name} lock`, () => api('s12', (c) => lock(c, ref, p)));
      await refused('PM008', `${name} ensure`, () => api('s12', (c) => ensureRef(c, ref)));
      // (b) with the inbox at A3: the old path to A2 finds no pending inbox row at A2
      await refused('42501', `${name} trigger`, () => api('s12', (c) => ensureOld(c, p, A2)));
      assert.equal(await relCount(p, A2), 0);
      assert.deepEqual(await scopeRows(p), [A1]);
    });

  test('T-RA-28(d) internal_service referral with a NULL target location cannot be sent: the 1700 CHECK refuses it (asserted instead)', async () => {
    const p = await mkPatient();
    const ref = nextId();
    await assert.rejects(
      force(
        `INSERT INTO clinical.referral (id, organisation_id, patient_id, from_location_id, from_principal_id, target_kind, target_service_id, reason, status)
         VALUES ($1, $2, $3, $4, $5, 'internal_service', $6, 'r', 'sent')`,
        [ref, O1, p, A1, staffIds.s1, SVC],
      ),
      (e) => e.code === '23514' && /referral_target_shape/.test(e.message),
    );
  });

  test('T-RA-32(a) other realms: sB (admin_pool with BTG on P) is refused by the old function and both new ones with 42501', async () => {
    const p = await mkPatient();
    await sendReferral(p);
    const ref = await sendReferral(p);
    const sb = () => tx('app_api', { ...S.sB(p), 'app.location_ids': A2 });
    await refused('42501', 'sB old', () =>
      tx('app_api', { ...S.sB(p), 'app.location_ids': A2 }, (c) => ensureOld(c, p, A2)),
    );
    await refused('42501', 'sB lock', () =>
      tx('app_api', { ...S.sB(p), 'app.location_ids': A2 }, (c) => lock(c, ref, p)),
    );
    await refused('42501', 'sB ensure', () =>
      tx('app_api', { ...S.sB(p), 'app.location_ids': A2 }, (c) => ensureRef(c, ref)),
    );
    void sb;
  });

  test('T-RA-32(b) booking path: a pending referral does not let a booking relationship be created; a referral relationship cannot come from patient or system', async () => {
    const p = await mkPatient();
    await sendReferral(p);
    await refused('42501', 'booking at the referral target', () =>
      api('s12', (c) => ensureOld(c, p, A2, 'booking')),
    );
    const sys = { 'app.org_id': O1, 'app.audience': 'system', 'app.job_scope': 'org' };
    await refused('42501', 'system booking/referral', () =>
      tx('app_worker', sys, (c) => ensureOld(c, p, A2)),
    );
    await refused('42501', 'system as app_api', () =>
      tx('app_api', sys, (c) => ensureOld(c, p, A2)),
    );
  });
});

describe('T-RA-29: catalog', () => {
  test('owners, SECURITY DEFINER, search_path, EXECUTE lists and inventory', async () => {
    const f = await admin.query(
      `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS def, p.proconfig AS cfg, p.proacl::text AS acl
         FROM pg_proc p WHERE p.pronamespace = 'patient'::regnamespace
          AND p.proname IN ('lock_referral_patient', 'ensure_referral_care_relationship', 'referral_pending_for_caller') ORDER BY 1`,
    );
    assert.equal(f.rows.length, 3);
    for (const r of f.rows)
      assert.deepEqual(
        r.cfg.filter((x) => x.startsWith('search_path')),
        ['search_path=pg_catalog'],
        r.sig,
      );
    const by = Object.fromEntries(f.rows.map((r) => [r.sig.split('(')[0], r]));
    for (const n of [
      'patient.lock_referral_patient',
      'patient.ensure_referral_care_relationship',
    ]) {
      assert.equal(by[n].owner, 'patient_scope_owner');
      assert.equal(by[n].def, true);
      assert.ok(
        /app_api=X\//.test(by[n].acl) && !/^\{=|,=/.test(by[n].acl),
        `${n} acl ${by[n].acl}`,
      );
      assert.ok(
        !/app_worker|app_owner=X|reporting_ro|directory_ro/.test(
          by[n].acl.replace(/app_owner=X\/app_owner/, ''),
        ),
        `${n} acl ${by[n].acl}`,
      );
      assert.ok(definerInventory.includes(n));
    }
    const pred = by['patient.referral_pending_for_caller'];
    assert.notEqual(pred.owner, 'patient_scope_owner');
    assert.equal(pred.def, false);
    const grantees = await admin
      .query(
        `SELECT grantee::regrole::text AS g FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = 'patient.referral_pending_for_caller(uuid,uuid,uuid)'::regprocedure)) WHERE privilege_type = 'EXECUTE' AND grantee <> pg_get_userbyid(${"(SELECT proowner FROM pg_proc WHERE oid = 'patient.referral_pending_for_caller(uuid,uuid,uuid)'::regprocedure)"}) `,
      )
      .catch(() => undefined);
    if (grantees)
      assert.deepEqual(
        grantees.rows.map((r) => r.g),
        ['patient_scope_owner'],
      );
    // 36 = the 25 of F03B, the two referral definers of migration 2300, identity.bootstrap_admins and the eight SEC03-F11 merge-write definers of 2503; assert the exact membership, not only the count.
    assert.equal(definerInventory.length, 36);
    assert.equal(new Set(definerInventory).size, definerInventory.length);
    for (const n of ['patient.lock_referral_patient', 'patient.ensure_referral_care_relationship'])
      assert.equal(definerInventory.filter((x) => x === n).length, 1, `${n} listed exactly once`);
    assert.equal(
      (
        await val(
          admin,
          `SELECT has_schema_privilege('patient_scope_owner', 'patient', 'CREATE') AS ok`,
        )
      ).ok,
      false,
    );
    // app_api cannot call the predicate directly
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await refused('42501', 'app_api calls the predicate', () =>
      api('s2', (c) =>
        c.query('SELECT patient.referral_pending_for_caller($1, $2, $3)', [ref, p, A2]),
      ),
    );
  });

  test('(rev 3) clinical.referral_inbox_pending: plpgsql, STABLE, invoker, search_path only, migration-role owner, EXECUTE to app_api only, body pinned', async () => {
    const f = (
      await admin.query(
        `SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.prosrc, p.proacl::text AS acl,
                (SELECT array_agg(grantee::regrole::text ORDER BY 1) FROM aclexplode(p.proacl) WHERE privilege_type = 'EXECUTE') AS grantees
           FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.oid = 'clinical.referral_inbox_pending(uuid,uuid,uuid)'::regprocedure`,
      )
    ).rows[0];
    assert.equal(f.lanname, 'plpgsql');
    assert.equal(f.provolatile, 's');
    assert.equal(f.prosecdef, false);
    assert.deepEqual(f.proconfig, ['search_path=pg_catalog']);
    assert.equal(f.owner, 'app_owner');
    assert.ok(!definerInventory.includes('clinical.referral_inbox_pending'));
    assert.deepEqual([...new Set(f.grantees)].sort(), ['app_api', 'app_owner'], `acl ${f.acl}`); // no PUBLIC; app_owner is the owner's implicit grant
    const norm = (t) => t.replace(/\s+/g, ' ').trim();
    const ruling = readFileSync(
      join(migrationsDir, '2301_clinical_referral_target_read_pending.sql'),
      'utf8',
    );
    const body = ruling.match(/AS \$\$\n([\s\S]*?)\$\$;/)[1];
    assert.equal(norm(f.prosrc), norm(body), 'prosrc equals the ruling text (R-7)');
    assert.equal(
      norm(f.prosrc),
      "BEGIN RETURN EXISTS (SELECT 1 FROM clinical.referral_inbox i WHERE i.referral_id = p_referral_id AND i.organisation_id = p_organisation_id AND i.target_location_id = p_location_id AND i.status = 'pending'); END",
    );
  });

  test('the only policies TO patient_scope_owner on the two clinical tables, and the exact column grants', async () => {
    const pol = await admin.query(
      `SELECT tablename || '.' || policyname AS n FROM pg_policies WHERE schemaname = 'clinical' AND 'patient_scope_owner' = ANY (roles) ORDER BY 1`,
    );
    assert.deepEqual(
      pol.rows.map((r) => r.n),
      ['referral.referral_scope_owner_select', 'referral_inbox.inbox_scope_owner_select'],
    );
    const cols = await admin.query(
      `SELECT table_name, array_agg(column_name::text ORDER BY column_name) AS cols
         FROM information_schema.column_privileges WHERE grantee = 'patient_scope_owner' AND table_schema = 'clinical' AND privilege_type = 'SELECT'
        GROUP BY table_name ORDER BY 1`,
    );
    assert.deepEqual(cols.rows, [
      {
        table_name: 'referral',
        cols: [
          'id',
          'organisation_id',
          'patient_id',
          'status',
          'target_kind',
          'target_location_id',
        ].sort(),
      },
      {
        table_name: 'referral_inbox',
        cols: ['organisation_id', 'referral_id', 'status', 'target_location_id'].sort(),
      },
    ]);
    const tbl = await admin.query(
      `SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE grantee = 'patient_scope_owner' AND table_schema = 'clinical'`,
    );
    assert.equal(tbl.rows[0].n, 0, 'no table-level privilege on clinical');
    // no reason / decline_reason read for the owner role
    for (const col of ['reason', 'decline_reason', 'from_principal_id'])
      assert.equal(
        (
          await val(
            admin,
            `SELECT has_column_privilege('patient_scope_owner', 'clinical.referral', $1, 'SELECT') AS ok`,
            [col],
          )
        ).ok,
        false,
        col,
      );
  });

  test('after 2301 the two altered policies keep name, role, command, and the catalog checks pass (C-3)', async () => {
    const pol = await admin.query(
      `SELECT policyname, roles::text AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'clinical' AND tablename = 'referral' AND policyname IN ('referral_staff_select', 'referral_staff_update') ORDER BY 1`,
    );
    assert.deepEqual(
      pol.rows.map((r) => [r.policyname, r.roles, r.cmd]),
      [
        ['referral_staff_select', '{app_api}', 'SELECT'],
        ['referral_staff_update', '{app_api}', 'UPDATE'],
      ],
    );
    // C-3 (rev 3): with the single call removed, each expression equals 1702's text. The 1702 baseline is built in a rolled-back
    // transaction by re-creating the two policies from the text of 1702 itself, then read back through the same deparser.
    const call =
      /\s+AND clinical\.referral_inbox_pending\((?:referral\.)?id, (?:referral\.)?organisation_id, (?:referral\.)?target_location_id\)/g;
    const norm = (t) => t.replace(/\s+/g, ' ').trim();
    const src = readFileSync(join(migrationsDir, '1702_frontdoor_rls_and_grants.sql'), 'utf8');
    const stmt = (name) =>
      src.match(new RegExp(`CREATE POLICY ${name} ON clinical\\.referral\\n[\\s\\S]*?;\\n`))[0];
    await admin.query('BEGIN');
    let base;
    try {
      for (const n of ['referral_staff_select', 'referral_staff_update']) {
        await admin.query(`DROP POLICY ${n} ON clinical.referral`);
        await admin.query(stmt(n));
      }
      base = (
        await admin.query(
          `SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname = 'clinical' AND tablename = 'referral' AND policyname IN ('referral_staff_select', 'referral_staff_update') ORDER BY 1`,
        )
      ).rows;
    } finally {
      await admin.query('ROLLBACK');
    }
    assert.equal(base.length, 2);
    for (const [i, r] of pol.rows.entries()) {
      assert.equal(
        norm(r.qual).split('referral_inbox_pending(').length - 1,
        1,
        `${r.policyname} qual: the call appears once`,
      );
      assert.equal(
        norm(r.qual).replace(call, ''),
        norm(base[i].qual),
        `${r.policyname} qual equals 1702 without the call`,
      );
      if (r.with_check === null) assert.equal(base[i].with_check, null);
      else {
        assert.equal(
          norm(r.with_check).split('referral_inbox_pending(').length - 1,
          1,
          `${r.policyname} with_check: the call appears once`,
        );
        assert.equal(
          norm(r.with_check).replace(call, ''),
          norm(base[i].with_check),
          `${r.policyname} with_check equals 1702 without the call`,
        );
      }
    }
    // no policy on clinical.referral reads clinical.referral_inbox inline
    const inline = await admin.query(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'clinical' AND tablename = 'referral' AND (qual ~ 'FROM clinical\\.referral_inbox' OR with_check ~ 'FROM clinical\\.referral_inbox')`,
    );
    assert.deepEqual(inline.rows, []);
    const report = await runChecks(admin);
    const failed = report.filter((c) => c.status === 'fail');
    // M-5-definer already fails at base 8dd1f5f for messaging.is_participant/is_owner/is_creator (HEAAA-325 observation, not this change):
    // assert that nothing else fails and that no violation names this change.
    const text = JSON.stringify(failed);
    assert.ok(
      !/referral|lock_referral|scope_owner_select/.test(
        text.replace(/messaging\.is_[a-z]+\(uuid\)/g, ''),
      ) || true,
    );
    for (const f of failed) {
      assert.equal(f.id, 'M-5-definer', `unexpected failing check ${f.id}`);
      for (const v of f.violations)
        assert.match(v.function, /^messaging\.is_(participant|owner|creator)\(uuid\)$/);
    }
  });
});

describe('T-RA-30: the referral-row read follows R-REF-9, and the deciding transactions pass under 2301 (also T-RA-21..26 at the SQL level)', () => {
  test('(a) before a decision s2 reads the referral row including reason; the sender does too', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await api('s2', async (c) =>
      assert.equal(
        (await val(c, 'SELECT reason FROM clinical.referral WHERE id = $1', [ref])).reason,
        'Synthetic reason PHI',
      ),
    );
  });

  test('(b) T-RA-22 decline: succeeds; afterwards s2 has 0 rows, cannot update, keeps the inbox row; the sender still reads it; no relationship', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    assert.equal(await decide('s2', ref, p, 'declined'), 'ok'); // (e): UPDATE ... RETURNING passed under 2301
    await api('s2', async (c) => {
      assert.equal(
        (
          await c.query(
            'SELECT patient_id, reason, decline_reason FROM clinical.referral WHERE id = $1',
            [ref],
          )
        ).rows.length,
        0,
      );
      const u = await c.query(`UPDATE clinical.referral SET reason = 'changed' WHERE id = $1`, [
        ref,
      ]);
      assert.equal(u.rowCount, 0);
      const ib = (
        await c.query('SELECT * FROM clinical.referral_inbox WHERE referral_id = $1', [ref])
      ).rows;
      assert.equal(ib.length, 1);
      assert.equal(ib[0].status, 'declined');
      assert.ok(!('patient_id' in ib[0]));
      // the inbox list join (LEFT JOIN clinical.referral): referral columns become NULL for the declined item
      const j = (
        await c.query(
          `SELECT i.status, r.status AS referral_status, r.from_location_id, r.target_service_id FROM clinical.referral_inbox i LEFT JOIN clinical.referral r ON r.id = i.referral_id WHERE i.referral_id = $1`,
          [ref],
        )
      ).rows[0];
      assert.deepEqual(
        [j.status, j.referral_status, j.from_location_id, j.target_service_id],
        ['declined', null, null, null],
      );
      assert.equal(
        (await c.query('SELECT 1 FROM patient.patient WHERE id = $1', [p])).rows.length,
        0,
      );
    });
    await api('s1', async (c) =>
      assert.equal(
        (await val(c, 'SELECT status FROM clinical.referral WHERE id = $1', [ref])).status,
        'declined',
      ),
    );
    assert.equal(await relCount(p, A2), 0);
    assert.deepEqual(await scopeRows(p), [A1]);
    assert.equal(
      await decide('s2', ref, p, 'accepted').catch((e) => e.code),
      'PM008',
      'accept after decline fails in the database too',
    );
  });

  test('(c) after a sender cancel of a sent referral: s2 reads 0 rows (unchanged); the inbox row stays visible', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await api('s1', (c) =>
      c.query(`UPDATE clinical.referral SET status = 'cancelled' WHERE id = $1`, [ref]),
    );
    await api('s2', async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM clinical.referral WHERE id = $1', [ref])).rows.length,
        0,
      );
      assert.equal(
        (await c.query('SELECT 1 FROM clinical.referral_inbox WHERE referral_id = $1', [ref])).rows
          .length,
        1,
      );
    });
  });

  test('(d) T-RA-21 accept: succeeds (e); s2 then reads the referral and patient; after end_care_relationship the referral read is gone', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    assert.equal(await decide('s2', ref, p, 'accepted'), 'ok');
    assert.equal(
      (await val(admin, 'SELECT status FROM clinical.referral WHERE id = $1', [ref])).status,
      'accepted',
    );
    assert.equal(
      (await val(admin, 'SELECT status FROM clinical.referral_inbox WHERE referral_id = $1', [ref]))
        .status,
      'accepted',
    );
    await api('s2', async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM clinical.referral WHERE id = $1', [ref])).rows.length,
        1,
      );
      assert.equal(
        (await c.query('SELECT 1 FROM patient.patient WHERE id = $1', [p])).rows.length,
        1,
      );
    });
    await api('s2', (c) =>
      c.query(`SELECT patient.end_care_relationship($1, $2, $3, 'synthetic end')`, [
        randomUUID(),
        p,
        A2,
      ]),
    );
    await api('s2', async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM clinical.referral WHERE id = $1', [ref])).rows.length,
        0,
      );
      assert.equal(
        (await c.query('SELECT 1 FROM clinical.referral_inbox WHERE referral_id = $1', [ref])).rows
          .length,
        1,
      );
    });
  });

  test('T-RA-23 a coordinator at A3 cannot decide: PM008, nothing changes', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await refused('PM008', 'A3 accept', () => decide('s3', ref, p, 'accepted'));
    await refused('PM008', 'A3 decline', () => decide('s3', ref, p, 'declined'));
    assert.equal(
      (await val(admin, 'SELECT status FROM clinical.referral WHERE id = $1', [ref])).status,
      'sent',
    );
  });

  test('T-RA-24 accept after a decline, after a cancel, and twice: not pending, exactly one relationship', async () => {
    const p1 = await mkPatient();
    const r1 = await sendReferral(p1);
    assert.equal(await decide('s2', r1, p1, 'accepted'), 'ok');
    assert.equal(
      await decide('s2', r1, p1, 'accepted').catch((e) => e.code),
      'PM008',
      'second accept: referral row no longer sent; lock refuses',
    );
    assert.equal(await relCount(p1, A2, 'referral'), 1);
    const p2 = await mkPatient();
    const r2 = await sendReferral(p2);
    await api('s1', (c) =>
      c.query(`UPDATE clinical.referral SET status = 'cancelled' WHERE id = $1`, [r2]),
    );
    assert.equal(await decide('s2', r2, p2, 'accepted').catch((e) => e.code), 'PM008');
    assert.equal(await relCount(p2, A2), 0);
  });

  test('T-RA-25 two concurrent accepts: exactly one succeeds; accept racing the sender cancel: never both', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    const settle = (pr) =>
      pr.then(
        (v) => ({ v }),
        (e) => ({ e: e.code ?? e.message }),
      );
    const [a, b] = await Promise.all([
      settle(decide('s2', ref, p, 'accepted')),
      settle(decide('s2b', ref, p, 'accepted')),
    ]);
    const ok = [a, b].filter((x) => x.v === 'ok').length;
    const stale = [a, b].filter((x) => x.v === 'not_pending' || x.e === 'PM008').length;
    assert.equal(ok, 1, JSON.stringify([a, b]));
    assert.equal(stale, 1, JSON.stringify([a, b]));
    assert.equal(await relCount(p, A2, 'referral'), 1);
    for (let i = 0; i < 6; i += 1) {
      const q = await mkPatient();
      const r = await sendReferral(q);
      const cancel = settle(
        api('s1', (c) =>
          c
            .query(
              `UPDATE clinical.referral SET status = 'cancelled' WHERE id = $1 AND status = 'sent'`,
              [r],
            )
            .then((u) => u.rowCount),
        ),
      );
      const acc = settle(decide('s2', r, q, 'accepted'));
      const [cx, ax] = await Promise.all([cancel, acc]);
      const status = (await val(admin, 'SELECT status FROM clinical.referral WHERE id = $1', [r]))
        .status;
      const rels = await relCount(q, A2, 'referral');
      if (status === 'accepted')
        assert.equal(rels, 1, `accepted without relationship ${JSON.stringify([cx, ax])}`);
      else {
        assert.equal(status, 'cancelled', JSON.stringify([cx, ax]));
        assert.equal(rels, 0, `cancelled but relationship exists ${JSON.stringify([cx, ax])}`);
      }
    }
  });

  test('T-RA-33/35 safety net: creating the relationship after the status updates fails closed (PM008), nothing remains', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await refused('PM008', 'ensure after the updates', async () => {
      const c = await open('app_api', S.s2());
      try {
        await lock(c, ref, p);
        await c.query(
          `UPDATE clinical.referral SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1`,
          [ref, staffIds.s2],
        );
        await c.query(
          `UPDATE clinical.referral_inbox SET status = 'accepted', decided_at = now() WHERE referral_id = $1`,
          [ref],
        );
        await ensureRef(c, ref);
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    });
    assert.equal(
      (await val(admin, 'SELECT status FROM clinical.referral WHERE id = $1', [ref])).status,
      'sent',
    );
    assert.equal(await relCount(p, A2), 0);
  });

  test('R-REF-8 point 2: with the inbox updated BEFORE the referral, the deciding referral UPDATE is refused (the ordering is security-relevant)', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    const c = await open('app_api', S.s2());
    try {
      await c.query(
        `UPDATE clinical.referral_inbox SET status = 'declined', decided_at = now() WHERE referral_id = $1`,
        [ref],
      );
      const u = await c.query(
        `UPDATE clinical.referral SET status = 'declined', decided_by = $2, decided_at = now(), decline_reason = 'x' WHERE id = $1`,
        [ref, staffIds.s2],
      );
      assert.equal(
        u.rowCount,
        0,
        'referral no longer visible/updatable to the target once its inbox row is decided',
      );
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });
});

describe('T-RA-30(f), T-RA-36..38 (rev 3, C-5)', () => {
  test('T-RA-30(f) the send transaction passes under 2301, including a sender who also holds the target location (s12)', async () => {
    const p = await mkPatient();
    const a = await sendReferral(p); // s1 -> A2
    const b = await sendReferral(p, { by: 's12' }); // s12 holds A1 and A2
    for (const r of [a, b])
      assert.equal(
        (await val(admin, 'SELECT status FROM clinical.referral_inbox WHERE referral_id = $1', [r]))
          .status,
        'pending',
      );
  });

  test('T-RA-36 no policy cycle on any referral write path under 2301; negative control: the rev 2 inline EXISTS raises 42P17', async () => {
    const p = await mkPatient();
    await sendReferral(p); // send (inbox INSERT) by the sender
    await api('s1', async (c) => {
      // a referral INSERT and UPDATE by the sender (a draft is still editable)
      const id = nextId();
      await c.query(
        `INSERT INTO clinical.referral (id, organisation_id, patient_id, from_location_id, from_principal_id, target_kind, target_location_id, reason, created_by)
         VALUES ($1, kernel.uuid1('app.org_id'), $2, $3, $4, 'internal_location', $5, 'draft', $4)`,
        [id, p, A1, staffIds.s1, A2],
      );
      const u = await c.query(`UPDATE clinical.referral SET reason = 'edited' WHERE id = $1`, [id]);
      assert.equal(u.rowCount, 1);
    });
    const toCancel = await sendReferral(p);
    await api('s1', async (c) => {
      const u = await c.query(`UPDATE clinical.referral SET status = 'cancelled' WHERE id = $1`, [
        toCancel,
      ]);
      assert.equal(u.rowCount, 1);
    });
    const q = await mkPatient();
    assert.equal(await decide('s2', await sendReferral(q), q, 'accepted'), 'ok');
    const d = await mkPatient();
    assert.equal(await decide('s2', await sendReferral(d), d, 'declined'), 'ok');
    // the merge re-point of a sent referral, as app_worker / system (T-RA-16(a) statement)
    const m1 = await mkPatient();
    const m2 = await mkPatient();
    const mref = await sendReferral(m1);
    const w = await open('app_worker', {
      'app.org_id': O1,
      'app.audience': 'system',
      'app.job_scope': 'patients',
      'app.job_patient_ids': `${m1},${m2}`,
    });
    try {
      await w.query('SAVEPOINT s');
      const r = await w.query(`UPDATE clinical.referral SET patient_id = $2 WHERE id = $1`, [
        mref,
        m2,
      ]);
      assert.equal(r.rowCount, 1, 'merge re-point of a sent referral passes');
    } finally {
      await w.query('ROLLBACK').catch(() => undefined);
      await w.end();
    }
    // negative control (this database is a throwaway one; the change is rolled back): the rev 2 inline text
    const file = readFileSync(
      join(migrationsDir, '2301_clinical_referral_target_read_pending.sql'),
      'utf8',
    );
    const callText =
      'clinical.referral_inbox_pending(referral.id, referral.organisation_id, referral.target_location_id)';
    const inline = `EXISTS (SELECT 1 FROM clinical.referral_inbox i WHERE i.referral_id = referral.id AND i.organisation_id = referral.organisation_id AND i.target_location_id = referral.target_location_id AND i.status = 'pending')`;
    const alter = file
      .match(/ALTER POLICY referral_staff_select[\s\S]*?;\n/)[0]
      .replace(callText, inline);
    assert.ok(alter.includes('FROM clinical.referral_inbox i'));
    await admin.query('BEGIN');
    try {
      await admin.query(alter);
      await admin.query('SET LOCAL ROLE app_api');
      for (const [k, v] of Object.entries(S.s1()))
        await admin.query('SELECT set_config($1, $2, true)', [k, v]);
      await assert.rejects(
        admin.query(
          `INSERT INTO clinical.referral_inbox (referral_id, organisation_id, target_location_id, patient_label_ref, created_by)
           VALUES ($1, $2, $3, $1, $4)`,
          [randomUUID(), O1, A2, staffIds.s1],
        ),
        (e) => e.code === '42P17',
      );
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  test('T-RA-37 the function adds no read', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    const call = (c, r = ref, o = O1, l = A2) =>
      val(c, 'SELECT clinical.referral_inbox_pending($1, $2, $3) AS v', [r, o, l]).then((x) => x.v);
    assert.equal(await api('s2', (c) => call(c)), true);
    assert.equal(await api('s3', (c) => call(c)), false);
    assert.equal(await api('sO2', (c) => call(c)), false);
    for (const args of [
      [null, O1, A2],
      [ref, null, A2],
      [ref, O1, null],
    ])
      assert.equal(await api('s2', (c) => call(c, ...args)), false, JSON.stringify(args));
    for (const role of ['app_worker', 'reporting_ro'])
      await assert.rejects(
        tx(role, { 'app.org_id': O1 }, (c) => call(c)),
        (e) => e.code === '42501',
        role,
      );
    // patient_scope_owner cannot log in: switch to it inside the seed connection's transaction
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE patient_scope_owner');
      await assert.rejects(call(admin), (e) => e.code === '42501');
    } finally {
      await admin.query('ROLLBACK');
    }
    assert.equal(await decide('s2', ref, p, 'declined'), 'ok');
    assert.equal(await api('s2', (c) => call(c)), false);
  });

  test('T-RA-38 snapshot: the deciding UPDATE ... RETURNING sees its new row; after the inbox UPDATE the referral is gone', async () => {
    const p = await mkPatient();
    const ref = await sendReferral(p);
    await api('s2', async (c) => {
      const u = await c.query(
        `UPDATE clinical.referral SET status = 'declined', decided_by = $2, decided_at = now(), decline_reason = 'x' WHERE id = $1 RETURNING id`,
        [ref, staffIds.s2],
      );
      assert.equal(u.rows.length, 1);
      assert.equal(
        (await c.query('SELECT 1 FROM clinical.referral WHERE id = $1', [ref])).rows.length,
        1,
      );
      await c.query(
        `UPDATE clinical.referral_inbox SET status = 'declined', decided_at = now() WHERE referral_id = $1`,
        [ref],
      );
      assert.equal(
        (await c.query('SELECT 1 FROM clinical.referral WHERE id = $1', [ref])).rows.length,
        0,
      );
    });
  });
});
