// Real-database tests for BE-03 (organisation module) on PostgreSQL 17 with the roles and migrations of the real pipeline:
// TC-AD-01..03, 06..10 data-level parts, the view/grant catalog tests (ARCHITECTURE 22.5.1, 21.2) and the settings.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/organisation/organisation.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KernelDb } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import {
  NeutralNameRequiredError,
  OrganisationService,
  OrganisationValidationError,
  SETTING_CATALOGUE,
  SettingNotConfiguredError,
} from './index.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;

const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be03_api_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

const ORG = '00000000-0000-7000-8000-0000000000a1';
const ORG2 = '00000000-0000-7000-8000-0000000000a2';
const ADMIN_P = '00000000-0000-7000-8000-0000000000c1';
const DOC_P = '00000000-0000-7000-8000-0000000000c2';
const PAT_P = '00000000-0000-7000-8000-0000000000c3';
const CLIN_A = '00000000-0000-7000-8000-0000000000d1';
const CLIN_B = '00000000-0000-7000-8000-0000000000d2';
const id = (n: number): string => `00000000-0000-7000-8000-00000000b${String(n).padStart(3, '0')}`;
const L_ACTIVE = id(1);
const L_INACTIVE = id(2);
const L_VIRTUAL = id(3);
const S_PLAIN = id(11);
const S_SENS = id(12);
const S_INACTIVE = id(13);
const S_OTHER_ORG = id(14);

const admin: ScopeSettings = {
  audience: 'staff',
  realm: 'admin_pool',
  orgId: ORG,
  principalId: ADMIN_P,
};
const doctor: ScopeSettings = {
  audience: 'staff',
  realm: 'google',
  orgId: ORG,
  principalId: DOC_P,
};
const patient: ScopeSettings = {
  audience: 'patient',
  realm: 'patient_pool',
  orgId: ORG,
  principalId: PAT_P,
};
const publicScope: ScopeSettings = { audience: 'public', orgId: ORG };
const anonymous: ScopeSettings = { audience: 'anonymous', orgId: ORG };
const worker: ScopeSettings = { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' };

const rejectsCode = (p: Promise<unknown>, code: string, what: string): Promise<void> =>
  assert.rejects(p, (e: { code?: string; message?: string }) => {
    assert.equal(e.code, code, `${what}: expected SQLSTATE ${code}, got ${e.code} (${e.message})`);
    return true;
  });

/** The 22.5.1 grant list, per base table: what directory_ro may SELECT, and nothing else. */
const GRANTS: Record<string, string[]> = {
  location: [
    'id',
    'organisation_id',
    'name',
    'kind',
    'time_zone',
    'address',
    'state_code',
    'geo',
    'phone',
    'active',
  ],
  service: ['id', 'organisation_id', 'patient_display_name', 'duration_min', 'mode', 'active'],
  service_location: ['service_id', 'location_id', 'organisation_id'],
  service_clinician: ['service_id', 'clinician_principal_id', 'organisation_id'],
  opening_hours: ['location_id', 'weekday', 'opens', 'closes', 'organisation_id'],
  holiday: ['location_id', 'date', 'name', 'organisation_id'],
  banner: ['id', 'organisation_id', 'message', 'starts_at', 'ends_at', 'surface'],
};
const VIEWS = [
  'public_location',
  'public_service',
  'public_service_location',
  'public_service_clinician',
  'public_opening_hours',
  'public_holiday',
  'public_banner',
];
const TABLES = [
  'organisation',
  'jurisdiction',
  'location',
  'room',
  'opening_hours',
  'holiday',
  'service',
  'service_location',
  'service_clinician',
  'booking_policy',
  'consent_template',
  'questionnaire_template',
  'service_required_consent',
  'feature_flag',
  'banner',
  'operating_state',
];

describe('organisation module on PostgreSQL 17 (BE-03)', () => {
  type Client = {
    query(s: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    connect(): Promise<void>;
    end(): Promise<void>;
  };
  let sa: Client; // superuser, fixtures and catalog reads only
  let apiPool: { end(): Promise<void>; connect(): Promise<never> };
  let workerPool: { end(): Promise<void>; connect(): Promise<never> };
  let db: KernelDb;
  let wdb: KernelDb;
  const org = new OrganisationService();
  const q = <T = Record<string, unknown>>(s: string, p?: unknown[]): Promise<T[]> =>
    sa.query(s, p).then((r) => r.rows as T[]);

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
    sa = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    await sa.connect();
    apiPool = new pg.Pool({ connectionString: urlFor('app_api'), max: 4 });
    workerPool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 2 });
    db = new KernelDb(apiPool as never);
    wdb = new KernelDb(workerPool as never);

    // Fixtures through the superuser (policies are tested separately below).
    await q(
      `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York'), ('CA', $1, 'California'), ('TX', $1, 'Texas')`,
      [ORG],
    );
    await q(
      `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active, phone) VALUES
      ($2, $1, 'Main Clinic', 'clinic', 'America/New_York', 'NY', true, '555-0100'),
      ($3, $1, 'Closed Clinic', 'clinic', 'America/New_York', 'NY', false, null),
      ($4, $1, 'Video Clinic', 'virtual', 'America/Chicago', 'TX', true, null)`,
      [ORG, L_ACTIVE, L_INACTIVE, L_VIRTUAL],
    );
    await q(
      `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, price_cents, currency, fee_cents, condition_revealing, active) VALUES
      ($2, $1, 'General visit', 'General visit', 30, 5, 'either', 12000, 'USD', 2500, false, true),
      ($3, $1, 'Synthetic HIV clinic', 'Specialist consultation', 45, 10, 'in_person', 20000, 'USD', 5000, true, true),
      ($4, $1, 'Retired visit', 'Retired visit', 20, 0, 'in_person', null, null, null, false, false)`,
      [ORG, S_PLAIN, S_SENS, S_INACTIVE],
    );
    await q(
      `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode) VALUES ($2, $1, 'Other org service', 'Other org service', 30, 0, 'video')`,
      [ORG2, S_OTHER_ORG],
    );
    await q(
      `INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES
      ($1, $2, $5), ($1, $2, $6), ($1, $3, $5), ($1, $4, $5)`,
      [ORG, S_PLAIN, S_SENS, S_INACTIVE, L_ACTIVE, L_INACTIVE],
    );
    await q(
      `INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES
      ($1, $2, $4), ($1, $3, $5), ($1, $6, $4)`,
      [ORG, S_PLAIN, S_SENS, CLIN_A, CLIN_B, S_INACTIVE],
    );
    await q(
      `INSERT INTO organisation.opening_hours (organisation_id, location_id, weekday, opens, closes) VALUES
      ($1, $2, 1, '09:00', '12:00'), ($1, $2, 1, '13:00', '17:00'), ($1, $3, 1, '09:00', '17:00')`,
      [ORG, L_ACTIVE, L_INACTIVE],
    );
    await q(
      `INSERT INTO organisation.holiday (id, organisation_id, location_id, date, name) VALUES
      ($2, $1, null, '2026-12-25', 'Christmas Day'), ($3, $1, $4, '2026-07-04', 'Independence Day')`,
      [ORG, id(31), id(32), L_ACTIVE],
    );
    await q(
      `INSERT INTO organisation.banner (id, organisation_id, surface, message, starts_at, ends_at) VALUES
      ($2, $1, 'site', 'Open now', now() - interval '1 hour', now() + interval '1 hour'),
      ($3, $1, 'site', 'Expired', now() - interval '3 hours', now() - interval '2 hours'),
      ($4, $1, 'site', 'Future', now() + interval '2 hours', now() + interval '3 hours'),
      ($5, $1, 'patient', 'Patient only', now() - interval '1 hour', now() + interval '1 hour'),
      ($6, $1, 'staff', 'Staff only', now() - interval '1 hour', now() + interval '1 hour')`,
      [ORG, id(41), id(42), id(43), id(44), id(45)],
    );
  });
  after(async () => {
    await apiPool?.end();
    await workerPool?.end();
    await sa?.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  describe('data model and policies (ARCHITECTURE 22.5)', () => {
    test('the sixteen organisation tables exist, forced RLS, class tag, row_version trigger, policies naming roles', async () => {
      const t = await q<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        comment: string;
      }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, obj_description(c.oid, 'pg_class') AS comment
           FROM pg_class c WHERE c.relnamespace = 'organisation'::regnamespace AND c.relkind = 'r' ORDER BY 1`,
      );
      assert.deepEqual(t.map((x) => x.relname).sort(), [...TABLES].sort());
      for (const x of t) {
        assert.ok(x.relrowsecurity && x.relforcerowsecurity, `${x.relname} RLS forced`);
        assert.match(x.comment, /^class=C[01]/, `${x.relname} class tag`);
      }
      const bumps = await q(`SELECT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
        JOIN pg_proc p ON p.oid = g.tgfoid WHERE c.relnamespace = 'organisation'::regnamespace AND p.proname = 'bump_row_version'`);
      assert.equal(bumps.length, TABLES.length);
      const bad =
        await q(`SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'organisation'
        AND (roles = '{public}' OR 'public' = ANY (roles))`);
      assert.deepEqual(bad, []);
      for (const tb of TABLES) {
        const p = await q(
          `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'organisation' AND tablename = $1`,
          [tb],
        );
        assert.ok(Number(p[0]?.n) >= 4, `${tb} has read and write policies`);
      }
    });

    test('TC-AD-01: an elevated admin creates clinics, rooms, hours, holidays through the module tables; audited fields are set', async () => {
      await db.withScope(admin, async (tx) => {
        await tx.query(
          `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, created_by) VALUES ($1, $2, 'North', 'clinic', 'America/Los_Angeles', 'CA', $3)`,
          [id(51), ORG, ADMIN_P],
        );
        await tx.query(
          `INSERT INTO organisation.room (id, organisation_id, location_id, name) VALUES ($1, $2, $3, 'Room 1')`,
          [id(52), ORG, id(51)],
        );
        await tx.query(
          `INSERT INTO organisation.opening_hours (organisation_id, location_id, weekday, opens, closes) VALUES ($1, $2, 2, '08:00', '16:00')`,
          [ORG, id(51)],
        );
        await tx.query(
          `INSERT INTO organisation.holiday (id, organisation_id, location_id, date, name) VALUES ($1, $2, $3, '2026-11-26', 'Thanksgiving')`,
          [id(53), ORG, id(51)],
        );
        const r = await tx.query(
          `SELECT row_version, created_by FROM organisation.location WHERE id = $1`,
          [id(51)],
        );
        assert.equal(Number(r.rows[0]?.row_version), 1);
        assert.equal(r.rows[0]?.created_by, ADMIN_P);
        await tx.query(`UPDATE organisation.location SET phone = '555-0199' WHERE id = $1`, [
          id(51),
        ]);
        const r2 = await tx.query(
          `SELECT row_version, updated_at FROM organisation.location WHERE id = $1`,
          [id(51)],
        );
        assert.equal(Number(r2.rows[0]?.row_version), 2);
        assert.ok(r2.rows[0]?.updated_at);
      });
      // the same data are visible to staff and to the worker, not to another organisation
      const loc = await db.withScope(doctor, (tx) => org.location(tx, id(51)));
      assert.equal(loc?.name, 'North');
      const other = await db.withScope({ ...doctor, orgId: ORG2 }, (tx) =>
        org.location(tx, id(51)),
      );
      assert.equal(other, null);
    });

    test('TC-AD-06/10: only an admin_pool principal (or the worker for reference data) can write; google staff, patients, public, anonymous cannot', async () => {
      for (const [name, scope] of [
        ['google staff', doctor],
        ['patient', patient],
        ['public', publicScope],
        ['anonymous', anonymous],
      ] as const) {
        await rejectsCode(
          db.withScope(scope, (tx) =>
            tx.query(
              `INSERT INTO organisation.banner (id, organisation_id, surface, message, starts_at, ends_at) VALUES ($1, $2, 'site', 'x', now(), now() + interval '1 hour')`,
              [id(60), ORG],
            ),
          ),
          '42501',
          `${name} banner insert`,
        );
        const upd = await db.withScope(scope, (tx) =>
          tx.query(`UPDATE organisation.location SET active = false WHERE id = $1`, [L_ACTIVE]),
        );
        assert.equal(upd.rowCount, 0, `${name} update changes nothing`);
      }
      // an admin cannot write another organisation's rows
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(
            `INSERT INTO organisation.feature_flag (id, organisation_id, key, enabled) VALUES ($1, $2, 'x', true)`,
            [id(61), ORG2],
          ),
        ),
        '42501',
        'cross-organisation insert',
      );
      // the worker writes reference data only
      await wdb.withScope(worker, (tx) =>
        tx.query(
          `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('WA', $1, 'Washington')`,
          [ORG],
        ),
      );
      await rejectsCode(
        wdb.withScope(worker, (tx) =>
          tx.query(
            `INSERT INTO organisation.feature_flag (id, organisation_id, key, enabled) VALUES ($1, $2, 'w', true)`,
            [id(62), ORG],
          ),
        ),
        '42501',
        'worker feature flag insert',
      );
    });

    test('table constraints: zone, hours, holidays (NULLS NOT DISTINCT), money, states', async () => {
      const run = (sql: string, p: unknown[] = []): Promise<unknown> =>
        db.withScope(admin, (tx) => tx.query(sql, p));
      await rejectsCode(
        run(`UPDATE organisation.location SET time_zone = 'Not/AZone' WHERE id = $1`, [L_ACTIVE]),
        '23514',
        'bad time zone',
      );
      await rejectsCode(
        run(`UPDATE organisation.location SET time_zone = 'EST' WHERE id = $1`, [L_ACTIVE]),
        '23514',
        'abbreviation is not an IANA zone',
      );
      await rejectsCode(
        run(`UPDATE organisation.location SET kind = 'mobile' WHERE id = $1`, [L_ACTIVE]),
        '23514',
        'kind',
      );
      await rejectsCode(
        run(`UPDATE organisation.location SET state_code = 'ZZ' WHERE id = $1`, [L_ACTIVE]),
        '23503',
        'unknown jurisdiction',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.opening_hours (organisation_id, location_id, weekday, opens, closes) VALUES ($1, $2, 3, '17:00', '09:00')`,
          [ORG, L_ACTIVE],
        ),
        '23514',
        'opens < closes',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.opening_hours (organisation_id, location_id, weekday, opens, closes) VALUES ($1, $2, 7, '09:00', '10:00')`,
          [ORG, L_ACTIVE],
        ),
        '23514',
        'weekday 0-6',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.holiday (id, organisation_id, location_id, date, name) VALUES ($1, $2, null, '2026-12-25', 'Dup')`,
          [id(70), ORG],
        ),
        '23505',
        'all-location holiday unique per date',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.room (id, organisation_id, location_id, name) VALUES ($1, $2, $3, 'Room 1')`,
          [id(71), ORG, id(51)],
        ),
        '23505',
        'room name unique per location',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode) VALUES ($1, $2, 'a', 'a', 4, 0, 'video')`,
          [id(72), ORG],
        ),
        '23514',
        'duration 5..480',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode) VALUES ($1, $2, 'a', 'a', 30, 121, 'video')`,
          [id(73), ORG],
        ),
        '23514',
        'buffer 0..120',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, price_cents) VALUES ($1, $2, 'a', 'a', 30, 0, 'video', 100)`,
          [id(74), ORG],
        ),
        '23514',
        'money needs a currency',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.banner (id, organisation_id, surface, message, starts_at, ends_at) VALUES ($1, $2, 'site', 'x', now(), now() - interval '1 hour')`,
          [id(75), ORG],
        ),
        '23514',
        'banner window',
      );
      await rejectsCode(
        run(
          `INSERT INTO organisation.banner (id, organisation_id, surface, message, starts_at, ends_at) VALUES ($1, $2, 'site', $3, now(), now() + interval '1 hour')`,
          [id(76), ORG, 'x'.repeat(501)],
        ),
        '23514',
        'banner message <= 500',
      );
    });

    test('templates: published versions are immutable; a published red-flag questionnaire needs the sign-off note', async () => {
      const doc = id(80);
      await db.withScope(admin, async (tx) => {
        await tx.query(
          `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, body_document_id, status) VALUES ($1, $2, 'treatment', 1, 'en', $3, 'draft')`,
          [id(81), ORG, doc],
        );
        await tx.query(
          `UPDATE organisation.consent_template SET body_document_id = $2 WHERE id = $1`,
          [id(81), id(82)],
        );
        await tx.query(
          `UPDATE organisation.consent_template SET status = 'published' WHERE id = $1`,
          [id(81)],
        );
      });
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(`UPDATE organisation.consent_template SET body_document_id = $2 WHERE id = $1`, [
            id(81),
            doc,
          ]),
        ),
        '42501',
        'edit published',
      );
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(`DELETE FROM organisation.consent_template WHERE id = $1`, [id(81)]),
        ),
        '42501',
        'delete published',
      );
      await db.withScope(admin, (tx) =>
        tx.query(`UPDATE organisation.consent_template SET status = 'retired' WHERE id = $1`, [
          id(81),
        ]),
      );
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(`UPDATE organisation.consent_template SET status = 'published' WHERE id = $1`, [
            id(81),
          ]),
        ),
        '42501',
        'retired is final',
      );
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(
            `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, body_document_id, status) VALUES ($1, $2, 'treatment', 1, 'en', $3, 'draft')`,
            [id(83), ORG, doc],
          ),
        ),
        '23505',
        'key/version/language unique',
      );
      const schema = JSON.stringify({
        questions: [{ id: 'q1', type: 'bool' }],
        red_flag_rules: [{ question: 'q1', equals: true }],
      });
      await db.withScope(admin, (tx) =>
        tx.query(
          `INSERT INTO organisation.questionnaire_template (id, organisation_id, key, version, schema, status) VALUES ($1, $2, 'intake', 1, $3::jsonb, 'draft')`,
          [id(84), ORG, schema],
        ),
      );
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(
            `UPDATE organisation.questionnaire_template SET status = 'published' WHERE id = $1`,
            [id(84)],
          ),
        ),
        '23514',
        'publish red-flag rules without sign-off',
      );
      await db.withScope(admin, (tx) =>
        tx.query(
          `UPDATE organisation.questionnaire_template SET status = 'published', approved_by_note = 'D-12a reviewer: synthetic sign-off' WHERE id = $1`,
          [id(84)],
        ),
      );
      const t = await db.withScope(patient, (tx) => org.questionnaireTemplate(tx, 'intake'));
      assert.equal(t?.version, 1);
      await db.withScope(admin, async (tx) => {
        await tx.query(
          `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, body_document_id, status) VALUES ($1, $2, 'privacy', 1, 'en', $3, 'published'), ($4, $2, 'privacy', 2, 'en', $3, 'published')`,
          [id(85), ORG, doc, id(86)],
        );
        await tx.query(
          `INSERT INTO organisation.service_required_consent (organisation_id, service_id, consent_template_key) VALUES ($1, $2, 'privacy')`,
          [ORG, S_PLAIN],
        );
      });
      const req = await db.withScope(patient, (tx) => org.consentTemplatesRequired(tx, S_PLAIN));
      assert.deepEqual(
        req.map((x) => [x.key, x.version]),
        [['privacy', 2]],
      );
    });

    test('TC-AD-08: a feature flag per location; one row per (key, location) incl. the null location', async () => {
      await db.withScope(admin, async (tx) => {
        await tx.query(
          `INSERT INTO organisation.feature_flag (id, organisation_id, key, location_id, enabled) VALUES ($1, $2, 'patient_messaging', $3, true)`,
          [id(90), ORG, L_ACTIVE],
        );
        await tx.query(
          `INSERT INTO organisation.feature_flag (id, organisation_id, key, location_id, enabled) VALUES ($1, $2, 'patient_messaging', null, false)`,
          [id(91), ORG],
        );
      });
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(
            `INSERT INTO organisation.feature_flag (id, organisation_id, key, location_id, enabled) VALUES ($1, $2, 'patient_messaging', null, true)`,
            [id(92), ORG],
          ),
        ),
        '23505',
        'duplicate org-wide flag',
      );
      const r = await db.withScope(patient, (tx) =>
        tx.query(
          `SELECT location_id, enabled FROM organisation.feature_flag WHERE key = 'patient_messaging' ORDER BY location_id NULLS LAST`,
        ),
      );
      assert.deepEqual(
        r.rows.map((x) => [x.location_id, x.enabled]),
        [
          [L_ACTIVE, true],
          [null, false],
        ],
      );
    });
  });

  describe('settings of 31.4 (no value hard-coded)', () => {
    test('nothing is seeded by migrations; a missing key fails closed', async () => {
      assert.equal(Number((await q(`SELECT count(*)::int AS n FROM kernel.setting`))[0]?.n), 0);
      await assert.rejects(
        db.withScope(admin, (tx) => org.setting(tx, 'hold_minutes')),
        SettingNotConfiguredError,
      );
    });

    test('the worker seeds the catalogue as system; re-seeding inserts nothing and keeps an admin change', async () => {
      const first = await wdb.withScope(worker, (tx) => org.applySettingDefaults(tx, id(100)));
      const seeded = SETTING_CATALOGUE.filter((x) => x.value !== null).map((x) => x.key);
      assert.deepEqual([...first].sort(), [...seeded].sort());
      // the two settings with no proposal are not stored
      assert.ok(
        !first.includes('red_flag_escalation_minutes') && !first.includes('audit_retention_years'),
      );
      assert.deepEqual(await wdb.withScope(worker, (tx) => org.applySettingDefaults(tx)), []);
      await db.withScope(admin, (tx) => org.setSetting(tx, 'hold_minutes', 12));
      assert.deepEqual(await wdb.withScope(worker, (tx) => org.applySettingDefaults(tx)), []);
      assert.equal(await db.withScope(patient, (tx) => org.setting(tx, 'hold_minutes')), 12);
      await db.withScope(admin, (tx) => org.setSetting(tx, 'hold_minutes', 10));
    });

    test('values equal the PRD 7.2 / ARCHITECTURE 31.4 proposals and are read from the table', async () => {
      const want: Record<string, unknown> = {
        hold_minutes: 10,
        reminder_offsets: [48, 4],
        previsit_send_offset: 72,
        waitlist_offer_minutes: { default: 30, within_24h: 15 },
        no_show_grace_min: { default: 15, video: 10 },
        cutoff_hours: 24,
        max_future_per_patient: 3,
        calendar_stale_minutes: 15,
        staff_idle_minutes: 15,
        admin_idle_minutes: 10,
        patient_idle_minutes: 30,
        note_sign_deadline_hours: 24,
        note_sign_max_auth_age: 12,
        elevation_minutes: 15,
        role_request_hours: 24,
        enrolment_token_minutes: 30,
        preregistration_days: 30,
        signin_ip_failures: 50,
        signin_clinic_ip_failures: 200,
        clinic_egress_cidrs: [],
        btg_duration: 4,
        assignment_lookback_months: 24,
        telehealth_licensing_mode: 'refuse',
        upload_max_mb: 20,
        uploads_per_day: 20,
        audit_export_max_rows: 1_000_000,
      };
      for (const [k, v] of Object.entries(want))
        assert.deepEqual(await db.withScope(doctor, (tx) => org.setting(tx, k)), v, k);
      // proof it is read, not remembered: change the stored row directly and read again
      await q(`UPDATE kernel.setting SET value = '99'::jsonb WHERE key = 'calendar_stale_minutes'`);
      assert.equal(
        await db.withScope(doctor, (tx) => org.setting(tx, 'calendar_stale_minutes')),
        99,
      );
      await q(`UPDATE kernel.setting SET value = '15'::jsonb WHERE key = 'calendar_stale_minutes'`);
      await assert.rejects(
        db.withScope(doctor, (tx) => org.setting(tx, 'red_flag_escalation_minutes')),
        SettingNotConfiguredError,
      );
      await assert.rejects(
        db.withScope(doctor, (tx) => org.setting(tx, 'audit_retention_years')),
        SettingNotConfiguredError,
      );
    });

    test('pre_auth keys are readable before sign-in, others are not; the admin API cannot change a pre_auth key', async () => {
      const pre = await db.withScope(anonymous, (tx) =>
        tx.query(`SELECT key FROM kernel.setting ORDER BY key`),
      );
      assert.deepEqual(
        pre.rows.map((x) => x.key),
        SETTING_CATALOGUE.filter((x) => x.preAuth && x.value !== null)
          .map((x) => x.key)
          .sort(),
      );
      await assert.rejects(
        db.withScope(admin, (tx) => org.setSetting(tx, 'staff_idle_minutes', 20)),
      );
    });

    test('a location override wins over the organisation value; invalid values and unknown keys are refused', async () => {
      await db.withScope(admin, (tx) => org.setSetting(tx, 'cutoff_hours', 48, L_VIRTUAL));
      assert.equal(
        await db.withScope(patient, (tx) => org.setting(tx, 'cutoff_hours', L_VIRTUAL)),
        48,
      );
      assert.equal(
        await db.withScope(patient, (tx) => org.setting(tx, 'cutoff_hours', L_ACTIVE)),
        24,
      );
      await assert.rejects(
        db.withScope(admin, (tx) => org.setSetting(tx, 'cutoff_hours', -1)),
        OrganisationValidationError,
      );
      await assert.rejects(
        db.withScope(admin, (tx) => org.setSetting(tx, 'telehealth_licensing_mode', 'maybe')),
        OrganisationValidationError,
      );
      await assert.rejects(
        db.withScope(admin, (tx) => org.setSetting(tx, 'not_a_setting', 1)),
        OrganisationValidationError,
      );
      await rejectsCode(
        db.withScope(doctor, (tx) => org.setSetting(tx, 'cutoff_hours', 12)),
        '42501',
        'google staff cannot change settings',
      );
    });
  });

  describe('booking policy and services (D-3, BR-23)', () => {
    test('TC-AD-03: block-only by default; a fee policy and the fee fields are stored, nothing charges', async () => {
      const none = await db.withScope(patient, (tx) => org.bookingPolicy(tx, S_PLAIN, L_ACTIVE));
      assert.equal(none.configured, false);
      assert.equal(none.lateChange, 'block');
      assert.equal(none.cutoffHours, 24);
      assert.equal(none.maxFuturePerPatient, 3);
      assert.equal(none.holdMinutes, 10);
      assert.equal(none.noShowGraceMin, 15);
      assert.equal(none.noShowGraceVideoMin, 10);
      await db.withScope(admin, (tx) => org.createBookingPolicy(tx, { serviceId: S_PLAIN }));
      const def = await db.withScope(patient, (tx) => org.bookingPolicy(tx, S_PLAIN, L_ACTIVE));
      assert.equal(def.configured, true);
      assert.equal(def.lateChange, 'block');
      const stored = await q(
        `SELECT late_change, cutoff_hours, max_future_per_patient, hold_minutes FROM organisation.booking_policy WHERE service_id = $1`,
        [S_PLAIN],
      );
      assert.deepEqual(stored[0], {
        late_change: 'block',
        cutoff_hours: 24,
        max_future_per_patient: 3,
        hold_minutes: null,
      });
      // a fee policy at one location is accepted and stored
      await db.withScope(admin, (tx) =>
        org.createBookingPolicy(tx, {
          serviceId: S_PLAIN,
          locationId: L_ACTIVE,
          lateChange: 'fee',
          cutoffHours: 12,
        }),
      );
      const fee = await db.withScope(patient, (tx) => org.bookingPolicy(tx, S_PLAIN, L_ACTIVE));
      assert.equal(fee.lateChange, 'fee');
      assert.equal(fee.cutoffHours, 12);
      const other = await db.withScope(patient, (tx) => org.bookingPolicy(tx, S_PLAIN, L_VIRTUAL));
      assert.equal(other.lateChange, 'block');
      // one policy per (service, location), including the null location
      await rejectsCode(
        db.withScope(admin, (tx) => org.createBookingPolicy(tx, { serviceId: S_PLAIN })),
        '23505',
        'duplicate service-wide policy',
      );
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(
            `UPDATE organisation.booking_policy SET late_change = 'charge' WHERE service_id = $1`,
            [S_PLAIN],
          ),
        ),
        '23514',
        'late_change values',
      );
      // fee fields are stored on the service and only stored: no table in the schema records a charge
      const svc = (await db.withScope(doctor, (tx) => org.services(tx))).find(
        (s) => s.id === S_SENS,
      );
      assert.equal(svc?.feeCents, 5000);
      assert.equal(svc?.priceCents, 20000);
      const payTables = await q(
        `SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'organisation'::regnamespace AND c.relkind = 'r' AND c.relname ~* '(payment|charge|invoice|transaction)'`,
      );
      assert.deepEqual(payTables, []);
    });

    test('TC-AD-07: the future-appointment cap is stored per service and read back; a patient reads the policy', async () => {
      await db.withScope(admin, (tx) =>
        org.createBookingPolicy(tx, {
          serviceId: S_SENS,
          maxFuturePerPatient: 1,
          overbookCapPerSession: 2,
          waitlistEnabled: true,
        }),
      );
      const p = await db.withScope(patient, (tx) => org.bookingPolicy(tx, S_SENS, L_ACTIVE));
      assert.equal(p.maxFuturePerPatient, 1);
      assert.equal(p.overbookCapPerSession, 2);
      assert.equal(p.waitlistEnabled, true);
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(
            `UPDATE organisation.booking_policy SET max_future_per_patient = 0 WHERE service_id = $1`,
            [S_SENS],
          ),
        ),
        '23514',
        'cap >= 1',
      );
    });

    test('TC-AD-02: a condition-revealing service needs a different patient-visible name (service rule and database check)', async () => {
      await assert.rejects(
        db.withScope(admin, (tx) =>
          org.createService(tx, {
            internalName: 'Synthetic HIV clinic',
            durationMin: 30,
            bufferMin: 0,
            mode: 'in_person',
            conditionRevealing: true,
          }),
        ),
        NeutralNameRequiredError,
      );
      await assert.rejects(
        db.withScope(admin, (tx) =>
          org.createService(tx, {
            internalName: 'Synthetic HIV clinic',
            patientDisplayName: '  synthetic hiv CLINIC ',
            durationMin: 30,
            bufferMin: 0,
            mode: 'in_person',
            conditionRevealing: true,
          }),
        ),
        NeutralNameRequiredError,
      );
      const sid = await db.withScope(admin, (tx) =>
        org.createService(tx, {
          internalName: 'Synthetic HIV clinic 2',
          patientDisplayName: 'Specialist consultation',
          durationMin: 30,
          bufferMin: 0,
          mode: 'in_person',
          conditionRevealing: true,
          priceCents: 100,
          currency: 'USD',
          feeCents: 50,
        }),
      );
      assert.ok(sid);
      // the database enforces it too, with the module bypassed
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(
            `UPDATE organisation.service SET patient_display_name = internal_name WHERE id = $1`,
            [S_SENS],
          ),
        ),
        '23514',
        'neutral name check',
      );
      await rejectsCode(
        db.withScope(admin, (tx) =>
          tx.query(`UPDATE organisation.service SET condition_revealing = true WHERE id = $1`, [
            S_PLAIN,
          ]),
        ),
        '23514',
        'flagging a service with an identical name',
      );
      // seeded sensitive service: the directory shows the neutral name and never the internal one
      const dir = await db.withScope(patient, (tx) => org.directoryServices(tx));
      const sens = dir.find((s) => s.id === S_SENS);
      assert.equal(sens?.patientDisplayName, 'Specialist consultation');
      assert.ok(!JSON.stringify(dir).includes('HIV'));
      // a non-revealing service defaults its display name to the internal name
      const plain = await db.withScope(admin, (tx) =>
        org.createService(tx, {
          internalName: 'Physiotherapy',
          durationMin: 30,
          bufferMin: 0,
          mode: 'either',
        }),
      );
      assert.equal(
        (await q(`SELECT patient_display_name FROM organisation.service WHERE id = $1`, [plain]))[0]
          ?.patient_display_name,
        'Physiotherapy',
      );
    });
  });

  describe('licensing check (BD-17)', () => {
    test('with no operating state it refuses every video booking; with one it distinguishes licensed from unlicensed', async () => {
      assert.equal(
        await db.withScope(patient, (tx) => org.licensingCheck(tx, ['NY'], 'NY')),
        'refused_not_operating',
      );
      await db.withScope(admin, async (tx) => {
        await tx.query(
          `INSERT INTO organisation.operating_state (organisation_id, jurisdiction_code, telehealth_allowed, effective_from) VALUES ($1, 'NY', true, '2020-01-01'), ($1, 'CA', true, '2999-01-01'), ($1, 'TX', true, '2020-01-01'), ($1, 'TX', false, '2021-01-01')`,
          [ORG],
        );
      });
      assert.equal(
        await db.withScope(patient, (tx) => org.licensingCheck(tx, ['NY', 'CA'], 'NY')),
        'allowed',
      );
      assert.equal(
        await db.withScope(patient, (tx) => org.licensingCheck(tx, ['CA'], 'NY')),
        'refused_not_licensed',
      );
      assert.equal(
        await db.withScope(patient, (tx) => org.licensingCheck(tx, ['CA'], 'CA')),
        'refused_not_operating',
      ); // not yet in effect
      assert.equal(
        await db.withScope(patient, (tx) => org.licensingCheck(tx, ['TX'], 'TX')),
        'refused_not_operating',
      ); // latest row says no
      await assert.rejects(
        db.withScope(patient, (tx) => org.licensingCheck(tx, ['NY'], 'New York')),
        OrganisationValidationError,
      );
    });
  });

  describe('directory views and the directory_ro role (22.5.1, 21.2, 38.2 item 17)', () => {
    test('seven organisation views exist, owned by directory_ro, owner-rights (no security_invoker), nothing else owned by it', async () => {
      const v = await q<{ relname: string; owner: string; reloptions: string[] | null }>(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.reloptions FROM pg_class c
          WHERE c.relnamespace = 'organisation'::regnamespace AND c.relkind = 'v' ORDER BY 1`,
      );
      assert.deepEqual(v.map((x) => x.relname).sort(), [...VIEWS].sort());
      for (const x of v) {
        assert.equal(x.owner, 'directory_ro', x.relname);
        assert.ok(
          !(x.reloptions ?? []).some((o) => o.startsWith('security_invoker=true')),
          `${x.relname} is owner-rights`,
        );
      }
      const owned = await q(
        `SELECT c.oid::regclass::text AS object, c.relkind FROM pg_class c WHERE pg_get_userbyid(c.relowner) = 'directory_ro' ORDER BY 1`,
      );
      assert.deepEqual(
        owned.map((x) => x.object).sort(),
        VIEWS.map((x) => `organisation.${x}`).sort(),
      );
      assert.deepEqual(
        await q(
          `SELECT n.nspname FROM pg_namespace n WHERE pg_get_userbyid(n.nspowner) = 'directory_ro'`,
        ),
        [],
      );
      assert.deepEqual(
        await q(
          `SELECT p.oid::regprocedure::text FROM pg_proc p WHERE pg_get_userbyid(p.proowner) = 'directory_ro'`,
        ),
        [],
      );
    });

    test('the migration ran as a non-superuser: app_owner is not a superuser and holds only SET (no INHERIT, no ADMIN) on directory_ro', async () => {
      const r = await q<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_owner'`,
      );
      assert.deepEqual(r[0], { rolsuper: false, rolbypassrls: false });
      const m = await q<{ set_option: boolean; inherit_option: boolean; admin_option: boolean }>(
        `SELECT am.set_option, am.inherit_option, am.admin_option FROM pg_auth_members am
           JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid WHERE m.rolname = 'app_owner' AND r.rolname = 'directory_ro'`,
      );
      assert.deepEqual(m[0], { set_option: true, inherit_option: false, admin_option: false });
      const members = await q(
        `SELECT m.rolname FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid WHERE r.rolname = 'directory_ro'`,
      );
      assert.deepEqual(
        members.map((x) => x.rolname),
        ['app_owner'],
      );
    });

    test('app_api and app_worker cannot SET ROLE directory_ro', async () => {
      for (const [pool, scope, kdb] of [
        [apiPool, admin, db],
        [workerPool, worker, wdb],
      ] as const) {
        void pool;
        await rejectsCode(
          kdb.withScope(scope, (tx) => tx.query(`SET LOCAL ROLE directory_ro`)),
          '42501',
          'SET ROLE directory_ro',
        );
      }
      const can = await q(
        `SELECT pg_has_role('app_api', 'directory_ro', 'SET') AS a, pg_has_role('app_worker', 'directory_ro', 'SET') AS w, pg_has_role('app_api', 'directory_ro', 'USAGE') AS au, pg_has_role('app_worker', 'directory_ro', 'USAGE') AS wu`,
      );
      assert.deepEqual(can[0], { a: false, w: false, au: false, wu: false });
    });

    test('column grants of directory_ro equal the 22.5.1 list exactly; no table-level SELECT, no write anywhere', async () => {
      for (const t of TABLES) {
        const cols = await q<{ attname: string; s: boolean; w: boolean }>(
          `SELECT a.attname, has_column_privilege('directory_ro', c.oid, a.attnum, 'SELECT') AS s,
                  has_column_privilege('directory_ro', c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES') AS w
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            WHERE c.oid = ('organisation.' || $1)::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
          [t],
        );
        const granted = cols
          .filter((c) => c.s)
          .map((c) => c.attname)
          .sort();
        assert.deepEqual(granted, [...(GRANTS[t] ?? [])].sort(), `${t} column grants`);
        assert.ok(
          cols.every((c) => !c.w),
          `${t}: no write column privilege`,
        );
        assert.equal(
          (
            await q(
              `SELECT has_table_privilege('directory_ro', ('organisation.' || $1)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS p`,
              [t],
            )
          )[0]?.p,
          false,
          `${t} no table privilege`,
        );
      }
      // the "visibly not granted" columns of service
      for (const col of [
        'internal_name',
        'buffer_min',
        'price_cents',
        'currency',
        'fee_cents',
        'condition_revealing',
      ])
        assert.equal(
          (
            await q(
              `SELECT has_column_privilege('directory_ro', 'organisation.service'::regclass, $1, 'SELECT') AS p`,
              [col],
            )
          )[0]?.p,
          false,
          col,
        );
      // schema rights: USAGE and CREATE on organisation, USAGE on kernel only
      const s =
        await q(`SELECT has_schema_privilege('directory_ro', 'organisation', 'USAGE') AS ou, has_schema_privilege('directory_ro', 'organisation', 'CREATE') AS oc,
                                has_schema_privilege('directory_ro', 'kernel', 'USAGE') AS ku, has_schema_privilege('directory_ro', 'kernel', 'CREATE') AS kc,
                                has_schema_privilege('directory_ro', 'audit', 'USAGE') AS au`);
      assert.deepEqual(s[0], { ou: true, oc: true, ku: true, kc: false, au: false });
    });

    test('app_api has SELECT on exactly the views (not on the role); PUBLIC and app_worker have none; the views have no write grant', async () => {
      for (const v of VIEWS) {
        const g = await q(
          `SELECT has_table_privilege('app_api', ('organisation.' || $1)::regclass, 'SELECT') AS a, has_table_privilege('app_api', ('organisation.' || $1)::regclass, 'INSERT,UPDATE,DELETE') AS w,
                                  has_table_privilege('app_worker', ('organisation.' || $1)::regclass, 'SELECT') AS k FROM (SELECT 1) x`,
          [v],
        );
        assert.deepEqual(g[0], { a: true, w: false, k: false }, v);
        const acl = await q(
          `SELECT relacl::text AS acl FROM pg_class WHERE oid = ('organisation.' || $1)::regclass`,
          [v],
        );
        assert.ok(
          !String(acl[0]?.acl).includes('{=') && !String(acl[0]?.acl).includes(',='),
          `${v} not granted to PUBLIC`,
        );
      }
    });

    test('TC-AD-01 (read side): public and patient see only publishable rows, only C0 columns, through the views', async () => {
      for (const scope of [publicScope, patient]) {
        const run = <T>(f: (tx: import('@ehr/kernel').Tx) => Promise<T>): Promise<T> =>
          db.withScope(scope, f);
        const locs = await run((tx) => org.directoryLocations(tx));
        assert.deepEqual(locs.map((l) => l.name).sort(), ['Main Clinic', 'North', 'Video Clinic']);
        assert.ok(!locs.some((l) => l.id === L_INACTIVE), 'inactive location absent');
        const svc = await run((tx) => org.directoryServices(tx));
        assert.ok(svc.some((s) => s.id === S_PLAIN) && svc.some((s) => s.id === S_SENS));
        assert.ok(
          !svc.some((s) => [S_INACTIVE, S_OTHER_ORG].includes(s.id)),
          'inactive and other-organisation services absent',
        );
        const atMain = await run((tx) => org.directoryServices(tx, { locationId: L_ACTIVE }));
        assert.ok(atMain.some((s) => s.id === S_PLAIN) && atMain.some((s) => s.id === S_SENS));
        assert.ok(!atMain.some((s) => s.id === S_INACTIVE));
        const none = await run((tx) => org.directoryServices(tx, { locationId: L_INACTIVE }));
        assert.deepEqual(
          none,
          [],
          'a service linked only to an inactive location is not offered there',
        );
        assert.deepEqual(await run((tx) => org.directoryServiceClinicians(tx, S_PLAIN)), [CLIN_A]);
        assert.deepEqual(await run((tx) => org.directoryServiceClinicians(tx, S_INACTIVE)), []);
        const hours = (
          await run((tx) =>
            tx.query(
              `SELECT location_id, weekday, opens::text, closes::text FROM organisation.public_opening_hours ORDER BY location_id, opens`,
            ),
          )
        ).rows;
        assert.ok(
          hours.every((h) => h.location_id !== L_INACTIVE),
          'hours of inactive locations hidden',
        );
        assert.ok(hours.filter((h) => h.location_id === L_ACTIVE).length === 2);
        const hol = (
          await run((tx) => tx.query(`SELECT name FROM organisation.public_holiday ORDER BY name`))
        ).rows.map((x) => x.name);
        assert.ok(hol.includes('Christmas Day') && hol.includes('Independence Day'));
        const ban = (
          await run((tx) => tx.query(`SELECT message FROM organisation.public_banner`))
        ).rows.map((x) => x.message);
        assert.deepEqual(ban, ['Open now']);
        // the view has no internal_name / price / fee / condition_revealing column at all
        for (const col of [
          'internal_name',
          'price_cents',
          'fee_cents',
          'condition_revealing',
          'buffer_min',
        ])
          await rejectsCode(
            run((tx) => tx.query(`SELECT ${col} FROM organisation.public_service`)),
            '42703',
            `public_service.${col}`,
          );
      }
    });

    test('base tables return nothing (or are refused) under public; staff and system do not read the directory views', async () => {
      for (const t of TABLES) {
        const r = await db.withScope(publicScope, (tx) =>
          tx.query(`SELECT 1 FROM organisation.${t}`),
        );
        assert.equal(r.rows.length, 0, `public reads no row of ${t}`);
      }
      assert.equal(
        (await db.withScope(publicScope, (tx) => tx.query(`SELECT 1 FROM kernel.setting`))).rows
          .length,
        0,
      );
      // patient reads no service base row (internal_name and prices stay out of patient transactions)
      assert.equal(
        (
          await db.withScope(patient, (tx) =>
            tx.query(`SELECT internal_name FROM organisation.service`),
          )
        ).rows.length,
        0,
      );
      assert.equal(
        (await db.withScope(patient, (tx) => tx.query(`SELECT 1 FROM organisation.room`))).rows
          .length,
        0,
      );
      for (const scope of [doctor, admin, anonymous]) {
        const r = await db.withScope(scope, (tx) =>
          tx.query(`SELECT 1 FROM organisation.public_location`),
        );
        assert.equal(
          r.rows.length,
          0,
          `${scope.audience}/${scope.realm ?? '-'} reads no directory view row`,
        );
      }
      await rejectsCode(
        wdb.withScope(worker, (tx) => tx.query(`SELECT 1 FROM organisation.public_location`)),
        '42501',
        'app_worker has no grant on the views',
      );
      // another organisation's public transaction sees only its own rows
      const o2 = await db.withScope({ audience: 'public', orgId: ORG2 }, (tx) =>
        tx.query(`SELECT id FROM organisation.public_service`),
      );
      assert.deepEqual(
        o2.rows.map((x) => x.id),
        [S_OTHER_ORG],
      );
      // a missing organisation setting fails closed
      assert.equal(
        (
          await db.withScope({ audience: 'public' }, (tx) =>
            tx.query(`SELECT 1 FROM organisation.public_service`),
          )
        ).rows.length,
        0,
      );
    });

    test('a public/patient transaction cannot write through the views or the base tables', async () => {
      for (const scope of [publicScope, patient]) {
        await rejectsCode(
          db.withScope(scope, (tx) =>
            tx.query(`UPDATE organisation.public_service SET duration_min = 1`),
          ),
          '42501',
          'update view',
        );
        await rejectsCode(
          db.withScope(scope, (tx) => tx.query(`DELETE FROM organisation.public_location`)),
          '42501',
          'delete view',
        );
      }
    });

    test('M-5: the policies that can match audience public are exactly the seven T-DIRECTORY policies (plus the recorded kernel exception)', async () => {
      const matching = await publicMatchingPolicies();
      const org7 = matching.filter((x) => x.startsWith('organisation.')).sort();
      assert.deepEqual(
        org7,
        Object.keys(GRANTS)
          .map((t) => `organisation.${t}.${t}_directory`)
          .sort(),
      );
      assert.deepEqual(
        matching.filter((x) => !x.startsWith('organisation.')),
        ['kernel.rate_counter.rate_counter_org'],
      );
      for (const p of await q<{ roles: string[] }>(
        `SELECT roles::text[] AS roles FROM pg_policies WHERE policyname LIKE '%\\_directory'`,
      ))
        assert.deepEqual(p.roles, ['directory_ro']);
    });

    test('M-5 negative: a public-matching policy outside T-DIRECTORY is caught by the catalog check and by this test', async () => {
      await q(`CREATE POLICY rogue_public ON organisation.room FOR SELECT TO app_api USING (true)`);
      try {
        const matching = await publicMatchingPolicies();
        assert.ok(matching.includes('organisation.room.rogue_public'));
        const report = runCatalogCheck();
        const pub = report.checks.find((c) => c.id === 'M-5-public');
        assert.equal(pub?.status, 'fail');
        assert.ok(pub?.violations.some((v) => v.id === 'organisation.room.rogue_public'));
      } finally {
        await q(`DROP POLICY rogue_public ON organisation.room`);
      }
    });

    test('the repository catalog check passes, or fails only on the allow-lists/M-3 clause db/tools owns (catalog-lists.requested.patch)', () => {
      const report = runCatalogCheck();
      const failing = report.checks.filter((c) => c.status === 'fail');
      const listBound = ['M-3', 'M-4-views', 'M-5-directory', 'M-5-public'];
      assert.deepEqual(
        failing.filter((c) => !listBound.includes(c.id)).map((c) => c.id),
        [],
      );
      // every violation, if any, names only the objects this ticket added
      for (const c of failing)
        for (const v of c.violations) {
          const name = String(v.id ?? v.table ?? v.view ?? v.object);
          assert.match(name, /^organisation\./, `${c.id}: ${name}`);
        }
    });
  });

  async function publicMatchingPolicies(): Promise<string[]> {
    const r = await q<{ id: string }>(
      `WITH p AS (SELECT schemaname || '.' || tablename || '.' || policyname AS id, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS body
                    FROM pg_policies WHERE schemaname NOT LIKE 'pg\\_%' AND schemaname NOT IN ('public', 'migration'))
       SELECT id FROM p WHERE body NOT LIKE '%app.audience%' OR body LIKE '%''public''%' ORDER BY id`,
    );
    return r.map((x) => x.id);
  }
  interface Report {
    checks: { id: string; status: string; violations: Record<string, string>[] }[];
  }
  function runCatalogCheck(): Report {
    // The tool exits 1 when any check fails; the JSON report is on stdout either way.
    let out: string;
    try {
      out = execFileSync(process.execPath, [`${root}db/tools/catalog-check.mjs`], {
        env: {
          PATH: process.env.PATH,
          EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl as string).username),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      out = String((e as { stdout?: unknown }).stdout ?? '');
    }
    return JSON.parse(out) as Report;
  }
});
