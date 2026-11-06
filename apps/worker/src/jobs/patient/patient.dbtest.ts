// Real-database tests for BE-08 (patient, worker side) on PostgreSQL 17 with the real roles and migrations: the daily staff-scope
// drift check (SHARED-BOUNDARIES 6.6) reports zero drift on consistent data, finds and repairs a missing and an extra row, and
// writes one summary audit row with the counts only; the hourly purge deletes expired match checks and keeps the live ones.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/jobs/patient/patient.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KernelDb } from '@ehr/kernel';
import { runPurgeMatchChecks, runVerifyStaffScope } from './index.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be08_w_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

const ORG = '00000000-0000-7000-8000-0000000000a1';
const L1 = '00000000-0000-7000-8000-000000000101';
const L2 = '00000000-0000-7000-8000-000000000102';
const P1 = '00000000-0000-7000-8000-0000000000e1';
const P2 = '00000000-0000-7000-8000-0000000000e2';
const PRINCIPAL = '00000000-0000-7000-8000-0000000000c9';
const JOB = '00000000-0000-7000-8000-0000000000f1';

describe('patient on PostgreSQL 17 (BE-08, worker side)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wpool: any;
  let db: KernelDb;
  // The superuser seeds under the system audience, as the API tests' saWrite does.
  const seed = async (sql: string, p: unknown[] = []): Promise<void> => {
    await admin.query(
      `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
      [ORG],
    );
    try {
      await admin.query(sql, p);
    } finally {
      await admin.query(
        `SELECT set_config('app.org_id', '', false), set_config('app.audience', '', false)`,
      );
    }
  };
  const count = async (sql: string, p: unknown[] = []): Promise<number> => {
    const r = await admin.query(sql, p);
    return Number(r.rows[0].n);
  };

  before(async () => {
    const a = new pg.Client({ connectionString: adminUrl });
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
    admin = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    await admin.connect();
    wpool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 4 });
    wpool.on('error', () => undefined);
    db = new KernelDb(wpool);
    await seed(
      `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York')`,
      [ORG],
    );
    for (const [lid, name] of [
      [L1, 'Clinic 1'],
      [L2, 'Clinic 2'],
    ])
      await seed(
        `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active) VALUES ($1, $2, $3, 'clinic', 'America/New_York', 'NY', true)`,
        [lid, ORG, name],
      );
    for (const [pid, n] of [
      [P1, '1000001'],
      [P2, '1000002'],
    ])
      await seed(
        `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via) VALUES ($1,$2,$3,'Worker','Test','1980-01-01','NY','front_desk')`,
        [pid, ORG, `MRN-${n}`],
      );
    await seed(
      `INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason) VALUES (gen_random_uuid(), $1, $2, $3, 'registration')`,
      [ORG, P1, L1],
    );
  });

  after(async () => {
    await wpool?.end();
    await admin?.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  test('verify_staff_scope: a missing row is found and repaired, then the next run reports zero drift; the summary row holds counts only', async () => {
    const first = await runVerifyStaffScope({ db, orgId: ORG, jobId: JOB });
    assert.equal(first.missingRows >= 1, true, 'the seeded care relationship has no scope row yet');
    assert.equal(first.extraRows, 0);
    assert.equal(
      await count(
        `SELECT count(*) n FROM patient.staff_scope WHERE patient_id = $1 AND location_id = $2`,
        [P1, L1],
      ),
      1,
    );
    const second = await runVerifyStaffScope({ db, orgId: ORG, jobId: JOB });
    assert.deepEqual(second, { missingRows: 0, extraRows: 0 });
    const ev = await admin.query(
      `SELECT change FROM audit.event WHERE resource_type = 'patient.staff_scope' AND job_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [JOB],
    );
    assert.deepEqual(ev.rows[0]?.change, { missingRows: 0, extraRows: 0 });
  });

  test('verify_staff_scope: an extra row (a location that does not care for the patient) is found, removed and reported to the alert hook', async () => {
    await seed(
      `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1,$2,$3)`,
      [P2, L2, ORG],
    );
    const alerts: [string, number][] = [];
    const r = await runVerifyStaffScope({
      db,
      orgId: ORG,
      jobId: JOB,
      onDrift: (kind, n) => void alerts.push([kind, n]),
    });
    assert.deepEqual(r, { missingRows: 0, extraRows: 1 });
    assert.deepEqual(alerts, [['extra', 1]]);
    assert.equal(
      await count(`SELECT count(*) n FROM patient.staff_scope WHERE patient_id = $1`, [P2]),
      0,
    );
    assert.deepEqual(await runVerifyStaffScope({ db, orgId: ORG, jobId: JOB }), {
      missingRows: 0,
      extraRows: 0,
    });
  });

  test('a failing alert hook does not undo the repair or fail the job', async () => {
    await seed(
      `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1,$2,$3)`,
      [P2, L2, ORG],
    );
    const r = await runVerifyStaffScope({
      db,
      orgId: ORG,
      jobId: JOB,
      onDrift: () => Promise.reject(new Error('alert path down')),
    });
    assert.equal(r.extraRows, 1);
    assert.equal(
      await count(`SELECT count(*) n FROM patient.staff_scope WHERE patient_id = $1`, [P2]),
      0,
    );
  });

  test('purge_match_checks: expired checks are deleted, live ones stay', async () => {
    const mk = (expires: string) =>
      seed(
        `INSERT INTO patient.match_check (id, organisation_id, principal_id, location_id, values_hash, candidate_refs, candidate_patient_ids, candidate_strengths, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, decode(repeat('ab', 32), 'hex'), '{}', '{}', '{}', ${expires})`,
        [ORG, PRINCIPAL, L1],
      );
    await mk(`now() - interval '1 minute'`);
    await mk(`now() - interval '1 hour'`);
    await mk(`now() + interval '10 minutes'`);
    const r = await runPurgeMatchChecks({ db, orgId: ORG });
    assert.equal(r.deleted, 2);
    assert.equal(await count(`SELECT count(*) n FROM patient.match_check`), 1);
  });
});
