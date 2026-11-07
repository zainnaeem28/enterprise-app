// Real-database tests for BE-06 (notifications, API side) on PostgreSQL 17 with the real roles, migrations, RLS and queue:
// templates cannot bind a non-allowlisted variable (service, diagnosis, medicine, clinician), render check then publish
// (RA-R1-05), send binds only allowlisted values, dedupe prevents double sends (also under concurrency and rollback), cancel
// by prefix, row-level security of the four tables, state/immutability triggers, and the merge/export participants.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/notifications/notifications.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { JobRegistry, KernelDb, ParticipantRegistries, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import { AuditService } from '../audit/index.js';
import { NOTIFICATIONS_JOBS } from './jobs.js';
import {
  NotificationsScopeError,
  NotificationsValidationError,
  RenderCheckFailedError,
} from './errors.js';
import {
  NOTIFICATIONS_MERGE_TABLES,
  notificationsExportContributor,
  notificationsMergeParticipant,
  registerNotificationsParticipants,
} from './merge.js';
import { R1_TEMPLATE_KEYS, r1TemplatesForLanguages } from './r1-templates.js';
import { NotificationService } from './send.js';
import { TemplateService } from './templates.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be06_api_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

const ORG = '00000000-0000-7000-8000-0000000000a1';
const ORG2 = '00000000-0000-7000-8000-0000000000a2';
const P1 = '00000000-0000-7000-8000-0000000000e1'; // patient 1 (the merged one in the merge test)
const P2 = '00000000-0000-7000-8000-0000000000e2'; // patient 2 (the survivor)
const P3 = '00000000-0000-7000-8000-0000000000e3';
const PP1 = '00000000-0000-7000-8000-0000000000f1'; // portal principals
const PP3 = '00000000-0000-7000-8000-0000000000f3';
const ADM = '00000000-0000-7000-8000-0000000000c1';
const DOC = '00000000-0000-7000-8000-0000000000c3';
const REQ = '00000000-0000-7000-8000-00000000f001';
const LANGS = ['en', 'es'];
const LINK = 'https://portal.example.test/appointments';

const patient = (id: string, principal: string, proxy: string[] = []): ScopeSettings => ({
  audience: 'patient',
  realm: 'patient_pool',
  orgId: ORG,
  principalId: principal,
  patientIds: [id, ...proxy],
  proxyPatientIds: proxy,
});
const admin: ScopeSettings = {
  audience: 'staff',
  realm: 'admin_pool',
  orgId: ORG,
  principalId: ADM,
  phiAccess: 'limited',
};
const doctor: ScopeSettings = { audience: 'staff', realm: 'google', orgId: ORG, principalId: DOC };
const system = (ids?: string[]): ScopeSettings =>
  ids === undefined
    ? { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }
    : { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'patients', jobPatientIds: ids };
const ANON: ScopeSettings = { audience: 'anonymous', orgId: ORG };

const reminderVars = {
  start_at: '2030-01-15T14:30:00Z',
  time_zone: 'America/New_York',
  portal_link: LINK,
  confirm_link: LINK,
  reschedule_link: LINK,
  cancel_link: LINK,
};
const vars = {
  start_at: '2030-01-15T14:30:00Z',
  end_at: '2030-01-15T15:00:00Z',
  time_zone: 'America/New_York',
  location_name: 'Riverside Clinic',
  portal_link: LINK,
  event_uid: '00000000-0000-4000-8000-000000000001',
};

describe('notifications on PostgreSQL 17 (BE-06, API side)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let adminDb: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let apool: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wpool: any;
  let api: KernelDb;
  let worker: KernelDb;
  const registry = new JobRegistry();
  for (const j of NOTIFICATIONS_JOBS) registry.defineJob(j);
  const queue = new Queue(registry, 'api');
  const audit = new AuditService({ queue: queue as never });
  const templates = new TemplateService({
    configuredLanguages: () => Promise.resolve(LANGS),
    audit,
  });
  const service = new NotificationService({ queue, allowedLinkHosts: ['portal.example.test'] });

  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    (await adminDb.query(sql, p)).rows as T[];
  const JOBS = `queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id`;

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
    await installQueue(urlFor('app_owner'));
    const w = new pg.Client({ connectionString: urlFor('app_worker') });
    await w.connect();
    await syncTaskTypes(w, registry);
    await w.end();
    adminDb = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    await adminDb.connect();
    // Patient rows the notifications fixtures point at: patient.guard_open_patient (BE-08, migration 0701) refuses writes for a patient that does not exist.
    await adminDb.query(
      `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York') ON CONFLICT DO NOTHING`,
      [ORG],
    );
    let mrn = 8000000;
    for (const pid of [
      P1,
      P2,
      P3,
      '00000000-0000-7000-8000-0000000000e8',
      '00000000-0000-7000-8000-0000000000e9',
    ])
      await adminDb.query(
        `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via) VALUES ($1, $2, $3, 'Fixture', 'Patient', '1980-01-01', 'NY', 'front_desk')`,
        [pid, ORG, `MRN-${mrn++}`],
      );
    // The guard reads the patient root as its owner under row-level security, so this superuser session carries an organisation and an audience too.
    await adminDb.query(
      `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
      [ORG],
    );
    apool = new pg.Pool({ connectionString: urlFor('app_api'), max: 6 });
    apool.on('error', () => undefined); // DROP DATABASE ... FORCE at teardown ends idle clients (57P01)
    wpool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 4 });
    wpool.on('error', () => undefined); // DROP DATABASE ... FORCE at teardown ends idle clients (57P01)
    api = new KernelDb(apool);
    worker = new KernelDb(wpool);
  });
  after(async () => {
    await apool?.end();
    await wpool?.end();
    await adminDb?.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  // Loads, checks and publishes one version of every R1 template, as the admin realm.
  async function publishAll(languages: string[]): Promise<void> {
    const rows = r1TemplatesForLanguages(languages);
    for (const key of R1_TEMPLATE_KEYS) {
      const ids = await api.withScope(admin, async (tx) => {
        const out: string[] = [];
        let version: number | undefined;
        for (const r of rows.filter((x) => x.key === key)) {
          const t = await templates.createDraft(
            tx,
            { ...r, ...(version === undefined ? {} : { version }) },
            { requestId: REQ },
          );
          version = t.version;
          out.push(t.id);
        }
        return out;
      });
      await api.withScope(admin, async (tx) => {
        await templates.renderCheck(tx, ids[0] as string, { requestId: REQ });
        await templates.publish(tx, ids[0] as string, { requestId: REQ });
      });
    }
  }

  describe('templates (22.13, RA-R1-05, BD-10)', () => {
    test('a template binding a service, diagnosis, medicine or clinician name cannot be saved - service layer and database', async () => {
      for (const name of ['service_name', 'diagnosis', 'medicine_name', 'clinician_name']) {
        await assert.rejects(
          api.withScope(admin, (tx) =>
            templates.createDraft(tx, {
              key: 'bad_one',
              channel: 'sms',
              language: 'en',
              body: `Hi {{${name}}}`,
              variables: [{ name, type: 'location_name' }],
            }),
          ),
          (e: RenderCheckFailedError) =>
            e instanceof RenderCheckFailedError &&
            e.code === 'notifications.render_check_failed' &&
            e.failures[0]?.rule === 'variable_not_allowed',
          name,
        );
      }
      // The service layer is not the only line: the database refuses the same row from the application role.
      const raw = (variables: unknown, body: string) =>
        api.withScope(admin, (tx) =>
          tx.query(
            `INSERT INTO notifications.template (id, organisation_id, key, channel, language, version, body, variables, status)
             VALUES (gen_random_uuid(), $1, 'raw_bad', 'sms', 'en', 1, $2, $3::jsonb, 'draft')`,
            [ORG, body, JSON.stringify(variables)],
          ),
        );
      await assert.rejects(
        raw([{ name: 'service_name', type: 'location_name' }], 'x'),
        (e: { code?: string }) => e.code === '23514',
      );
      await assert.rejects(
        raw([{ name: 'start_at', type: 'url' }], 'x'),
        (e: { code?: string }) => e.code === '23514',
      );
      await assert.rejects(
        raw([], 'Hello {{diagnosis}}'),
        (e: { code?: string }) => e.code === '23514',
      ); // placeholder not declared
      await assert.rejects(
        raw([{ name: 'portal_link', type: 'url' }], 'Hello {{portal_link} }'),
        (e: { code?: string }) => e.code === '23514',
      );
      assert.equal(
        (await q(`SELECT 1 FROM notifications.template WHERE key IN ('bad_one', 'raw_bad')`))
          .length,
        0,
      );
    });

    test('render check then publish: needs the check, needs every configured language, publishes the whole version, retires the old one', async () => {
      const set = r1TemplatesForLanguages(['en']).filter((r) => r.key === 'appointment_cancelled');
      const ids = await api.withScope(admin, async (tx) => {
        const out: string[] = [];
        let version: number | undefined;
        for (const r of set) {
          const t = await templates.createDraft(
            tx,
            { ...r, ...(version === undefined ? {} : { version }) },
            { requestId: REQ },
          );
          version = t.version;
          out.push(t.id);
        }
        return out;
      });
      // 'es' is configured but missing: the check fails and names the language.
      await assert.rejects(
        api.withScope(admin, (tx) =>
          templates.renderCheck(tx, ids[0] as string, { requestId: REQ }),
        ),
        (e: RenderCheckFailedError) =>
          e.failures.some((f) => f.rule === 'language_missing' && f.language === 'es'),
      );
      // Publishing without a passed check is refused by the service and by the table CHECK.
      await assert.rejects(
        api.withScope(admin, (tx) => templates.publish(tx, ids[0] as string)),
        (e: RenderCheckFailedError) => e.failures[0]?.rule === 'render_check_not_run',
      );
      await assert.rejects(
        api.withScope(admin, (tx) =>
          tx.query(
            `UPDATE notifications.template SET status = 'published', published_at = now() WHERE id = $1`,
            [ids[0]],
          ),
        ),
        (e: { code?: string }) => e.code === '23514',
      );
      // Add the missing language, check, publish.
      const es = r1TemplatesForLanguages(['es']).filter((r) => r.key === 'appointment_cancelled');
      await api.withScope(admin, async (tx) => {
        for (const r of es)
          await templates.createDraft(tx, { ...r, version: 1 }, { requestId: REQ });
      });
      await api.withScope(admin, async (tx) => {
        const r = await templates.renderCheck(tx, ids[0] as string, { requestId: REQ });
        assert.equal(r.rows, 8);
        await templates.publish(tx, ids[0] as string, { requestId: REQ });
      });
      assert.deepEqual(
        (
          await q(
            `SELECT DISTINCT status FROM notifications.template WHERE key = 'appointment_cancelled'`,
          )
        ).map((r) => r['status']),
        ['published'],
      );
      // Published content is frozen; editing a draft clears its check.
      await assert.rejects(
        api.withScope(admin, (tx) =>
          tx.query(`UPDATE notifications.template SET body = 'changed' WHERE id = $1`, [ids[0]]),
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      // The delete policy sees draft rows only: a published row is not even visible to it.
      assert.equal(
        (
          await api.withScope(admin, (tx) =>
            tx.query(`DELETE FROM notifications.template WHERE id = $1`, [ids[0]]),
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        adminDb.query(`DELETE FROM notifications.template WHERE id = $1`, [ids[0]]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      // Version 2 draft: check passes, an edit clears the check, publish then needs a new check; publishing v2 retires v1.
      const v2 = await api.withScope(admin, async (tx) => {
        let version: number | undefined;
        const out: string[] = [];
        for (const r of [...set, ...es]) {
          const t = await templates.createDraft(
            tx,
            { ...r, ...(version === undefined ? {} : { version }) },
            { requestId: REQ },
          );
          version = t.version;
          out.push(t.id);
        }
        return out;
      });
      assert.equal(
        (
          await q<{ version: number }>(
            `SELECT DISTINCT version FROM notifications.template WHERE id = ANY($1::uuid[])`,
            [v2],
          )
        )[0]?.version,
        2,
      );
      await api.withScope(admin, (tx) =>
        templates.renderCheck(tx, v2[0] as string, { requestId: REQ }),
      );
      await api.withScope(admin, (tx) =>
        templates.updateDraft(
          tx,
          v2[0] as string,
          { body: 'Your appointment was cancelled. Sign in: {{portal_link}}' },
          { requestId: REQ },
        ),
      );
      assert.equal(
        (
          await q(`SELECT render_check_passed_at FROM notifications.template WHERE id = $1`, [
            v2[0],
          ])
        )[0]?.['render_check_passed_at'],
        null,
      );
      await assert.rejects(
        api.withScope(admin, (tx) => templates.publish(tx, v2[1] as string)),
        (e: RenderCheckFailedError) => e.failures[0]?.rule === 'render_check_not_run',
      );
      await api.withScope(admin, async (tx) => {
        await templates.renderCheck(tx, v2[0] as string, { requestId: REQ });
        await templates.publish(tx, v2[0] as string, { requestId: REQ });
      });
      const st = await q<{ version: number; status: string }>(
        `SELECT DISTINCT version, status FROM notifications.template WHERE key = 'appointment_cancelled' ORDER BY version`,
      );
      assert.deepEqual(
        st.map((r) => `${r.version}:${r.status}`),
        ['1:retired', '2:published'],
      );
      // Every change was audited (config_change), without template text.
      const au = await q<{ change: unknown }>(
        `SELECT change FROM audit.event WHERE resource_type = 'notifications.template' AND action = 'config_change'`,
      );
      assert.ok(au.length >= 8);
      assert.equal(JSON.stringify(au).includes('Sign in'), false);
    });

    test('only the admin realm writes templates; staff and patients read them (T-CONF); anonymous reads none', async () => {
      await assert.rejects(
        api.withScope(doctor, (tx) =>
          templates.createDraft(tx, {
            key: 'doc_made',
            channel: 'sms',
            language: 'en',
            body: 'x',
            variables: [],
          }),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      const rows = await api.withScope(doctor, (tx) =>
        templates.list(tx, { key: 'appointment_cancelled' }),
      );
      assert.ok(rows.length >= 8);
      assert.ok(
        (
          await api.withScope(patient(P1, PP1), (tx) =>
            templates.list(tx, { key: 'appointment_cancelled' }),
          )
        ).length >= 8,
      );
      assert.equal((await api.withScope(ANON, (tx) => templates.list(tx))).length, 0);
      // Updates by the staff realm see no row at all (the policy is admin-realm only).
      assert.equal(
        (
          await api.withScope(doctor, (tx) =>
            tx.query(
              `UPDATE notifications.template SET status = 'retired' WHERE key = 'appointment_cancelled'`,
            ),
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await api.withScope(patient(P1, PP1), (tx) =>
            tx.query(`DELETE FROM notifications.template WHERE status = 'draft'`),
          )
        ).rowCount,
        0,
      );
    });
  });

  describe('send, dedupe, cancel (22.13, 24, BR-08)', () => {
    before(async () => {
      await publishAll(LANGS);
    });

    test('send binds allowlisted values only: one queued row per channel, a job per row in the same transaction, no address, no text', async () => {
      const r = await api.withScope(patient(P1, PP1), (tx) =>
        service.send(tx, {
          templateKey: 'appointment_confirmation',
          recipientRef: `patient:${P1}`,
          variables: vars,
          dedupeKey: 'confirm:res-0001',
        }),
      );
      assert.deepEqual(r.created.map((c) => c.channel).sort(), ['email', 'in_app', 'push', 'sms']);
      assert.deepEqual(r.duplicates, []);
      const rows = await q<Record<string, unknown>>(
        `SELECT * FROM notifications.notification WHERE dedupe_key LIKE 'confirm:res-0001:%' ORDER BY channel`,
      );
      assert.equal(rows.length, 4);
      for (const n of rows) {
        assert.equal(n['status'], 'queued');
        assert.equal(n['patient_id'], P1);
        assert.equal(n['principal_id'], null);
        assert.equal(n['attempts'], 0);
        assert.deepEqual(Object.keys(n['variables'] as object).sort(), [
          'end_at',
          'event_uid',
          'location_name',
          'portal_link',
          'start_at',
          'time_zone',
        ]);
        // 22.13: the key never contains the recipient.
        assert.equal(String(n['dedupe_key']).includes(P1), false);
      }
      const cols = (
        await q<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'notifications' AND table_name = 'notification'`,
        )
      ).map((c) => c.column_name);
      assert.equal(
        cols.some((c) => /address|email|phone|body|text|message$/.test(c)),
        false,
      );
      const jobs = await q<{
        identifier: string;
        payload: { notificationId: string; patientId: string };
      }>(
        `SELECT t.identifier, j.payload FROM ${JOBS} WHERE t.identifier = 'notifications.send_message' ORDER BY j.id`,
      );
      assert.equal(jobs.length, 4);
      assert.deepEqual(
        new Set(jobs.map((j) => j.payload.notificationId)),
        new Set(rows.map((n) => n['id'])),
      );
      assert.ok(
        jobs.every((j) => j.payload.patientId === P1 && Object.keys(j.payload).length === 2),
      );
      assert.equal(JSON.stringify(jobs).includes('Riverside'), false);
    });

    test('free text, unknown names, a service or clinician field, bad links and condition-revealing location names never reach a notification (TC-NT-06)', async () => {
      const send = (
        variables: Record<string, unknown>,
        extra: Partial<{ templateKey: string; dedupeKey: string }> = {},
      ) =>
        api.withScope(patient(P1, PP1), (tx) =>
          service.send(tx, {
            templateKey: 'appointment_confirmation',
            recipientRef: `patient:${P1}`,
            variables,
            dedupeKey: extra.dedupeKey ?? 'confirm:bad-case',
          }),
        );
      const fields = async (variables: Record<string, unknown>): Promise<string[]> => {
        try {
          await send(variables);
        } catch (e) {
          if (e instanceof NotificationsValidationError) return [...e.fields];
          throw e;
        }
        return [];
      };
      assert.deepEqual(await fields({ ...vars, service_name: 'HIV clinic' }), [
        'variables.service_name',
      ]);
      assert.deepEqual(await fields({ ...vars, clinician_name: 'Dr. Jones' }), [
        'variables.clinician_name',
      ]);
      assert.deepEqual(await fields({ ...vars, diagnosis: 'x' }), ['variables.diagnosis']);
      assert.deepEqual(await fields({ ...vars, location_name: 'HIV and sexual health clinic' }), [
        'variables.location_name',
      ]);
      assert.deepEqual(await fields({ ...vars, portal_link: 'https://evil.test/steal' }), [
        'variables.portal_link',
      ]);
      assert.deepEqual(await fields({ ...vars, portal_link: 'javascript:alert(1)' }), [
        'variables.portal_link',
      ]);
      assert.deepEqual(await fields({ ...vars, start_at: 'tomorrow, for the biopsy' }), [
        'variables.start_at',
      ]);
      assert.deepEqual(await fields({ ...vars, location_name: { a: 1 } }), [
        'variables.location_name',
      ]);
      assert.deepEqual(
        await fields(
          { ...vars, __proto__: 'x' }.constructor === Object ? { ...vars, 'bad key!': 'x' } : vars,
        ),
        ['variables.*'],
      );
      const { portal_link: _omit, ...missing } = vars;
      void _omit;
      assert.deepEqual(await fields(missing), ['variables']);
      assert.equal(
        (
          await q(
            `SELECT 1 FROM notifications.notification WHERE dedupe_key LIKE 'confirm:bad-case%'`,
          )
        ).length,
        0,
      );
      // Recipient reference, dedupe key and template key are checked too.
      const bad = async (o: Partial<Parameters<NotificationService['send']>[1]>) => {
        try {
          await api.withScope(patient(P1, PP1), (tx) =>
            service.send(tx, {
              templateKey: 'appointment_confirmation',
              recipientRef: `patient:${P1}`,
              variables: vars,
              dedupeKey: 'confirm:x1',
              ...o,
            }),
          );
        } catch (e) {
          return e instanceof NotificationsValidationError ? [...e.fields] : ['other'];
        }
        return [];
      };
      assert.deepEqual(await bad({ recipientRef: 'a@example.test' }), ['recipientRef']);
      assert.deepEqual(await bad({ recipientRef: '+15550100' }), ['recipientRef']);
      assert.deepEqual(await bad({ dedupeKey: `reminder:${P1}:48h` }), ['dedupeKey']);
      assert.deepEqual(await bad({ dedupeKey: 'has space' }), ['dedupeKey']);
      assert.deepEqual(await bad({ templateKey: 'no_such_template' }), ['templateKey']);
    });

    test('dedupe keys prevent double sends: a repeat creates nothing and queues nothing, also under concurrency', async () => {
      const again = await api.withScope(patient(P1, PP1), (tx) =>
        service.send(tx, {
          templateKey: 'appointment_confirmation',
          recipientRef: `patient:${P1}`,
          variables: vars,
          dedupeKey: 'confirm:res-0001',
        }),
      );
      assert.deepEqual(again.created, []);
      assert.deepEqual(again.duplicates.sort(), ['email', 'in_app', 'push', 'sms']);
      assert.equal(
        Number(
          (
            await q(
              `SELECT count(*)::int AS n FROM notifications.notification WHERE dedupe_key LIKE 'confirm:res-0001:%'`,
            )
          )[0]?.['n'],
        ),
        4,
      );

      const before4 = Number(
        (
          await q(
            `SELECT count(*)::int AS n FROM ${JOBS} WHERE t.identifier = 'notifications.send_message'`,
          )
        )[0]?.['n'],
      );
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          api.withScope(patient(P3, PP3), (tx) =>
            service.send(tx, {
              templateKey: 'appointment_reminder_48h',
              recipientRef: `patient:${P3}`,
              variables: reminderVars,
              dedupeKey: 'reminder:res-race:48h',
            }),
          ),
        ),
      );
      assert.equal(
        results.reduce((n, r) => n + r.created.length, 0),
        4,
        'exactly one set of four rows was created',
      );
      assert.equal(
        results.reduce((n, r) => n + r.duplicates.length, 0),
        20,
      );
      const after = Number(
        (
          await q(
            `SELECT count(*)::int AS n FROM ${JOBS} WHERE t.identifier = 'notifications.send_message'`,
          )
        )[0]?.['n'],
      );
      assert.equal(after - before4, 4, 'and exactly four jobs');
      // The database enforces it too, whoever inserts.
      await assert.rejects(
        adminDb.query(`INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, template_key, template_version, channel, dedupe_key)
                       SELECT gen_random_uuid(), organisation_id, recipient_kind, patient_id, template_key, template_version, channel, dedupe_key FROM notifications.notification LIMIT 1`),
        (e: { code?: string }) => e.code === '23505',
      );
    });

    test('a rolled-back business transaction leaves no notification and no job; a delayed send waits for send_after', async () => {
      const jobsBefore = Number((await q(`SELECT count(*)::int AS n FROM ${JOBS}`))[0]?.['n']);
      await assert.rejects(
        api.withScope(patient(P1, PP1), async (tx) => {
          await service.send(tx, {
            templateKey: 'appointment_cancelled',
            recipientRef: `patient:${P1}`,
            variables: { portal_link: LINK },
            dedupeKey: 'cancelled:rolled-back',
          });
          throw new Error('booking failed');
        }),
        /booking failed/,
      );
      assert.equal(
        (
          await q(
            `SELECT 1 FROM notifications.notification WHERE dedupe_key LIKE 'cancelled:rolled-back%'`,
          )
        ).length,
        0,
      );
      assert.equal(
        Number((await q(`SELECT count(*)::int AS n FROM ${JOBS}`))[0]?.['n']),
        jobsBefore,
      );

      const at = new Date(Date.now() + 48 * 3600_000);
      await api.withScope(patient(P1, PP1), (tx) =>
        service.send(tx, {
          templateKey: 'appointment_cancelled',
          recipientRef: `patient:${P1}`,
          variables: { portal_link: LINK },
          dedupeKey: 'cancelled:delayed',
          sendAfter: at,
        }),
      );
      const row = (
        await q<{ send_after: Date }>(
          `SELECT send_after FROM notifications.notification WHERE dedupe_key = 'cancelled:delayed:sms'`,
        )
      )[0];
      assert.equal(row?.send_after.getTime(), at.getTime());
      const job = (
        await q<{ run_at: Date }>(
          `SELECT j.run_at FROM ${JOBS} WHERE t.identifier = 'notifications.send_message' AND j.payload->>'notificationId' = (SELECT id::text FROM notifications.notification WHERE dedupe_key = 'cancelled:delayed:sms')`,
        )
      )[0];
      assert.ok(Math.abs((job?.run_at.getTime() ?? 0) - at.getTime()) < 1000);
    });

    test('cancel by dedupe-key prefix cancels queued rows of that resource only; sent rows are final', async () => {
      for (const res of ['res-c1', 'res-c2', 'res-c10'])
        await api.withScope(patient(P2, PP1), (tx) =>
          service.send(tx, {
            templateKey: 'appointment_reminder_4h',
            recipientRef: `patient:${P2}`,
            variables: reminderVars,
            dedupeKey: `reminder:${res}:4h`,
          }),
        );
      // A patient can cancel only what they can see (their in-app rows); the system scope (an event handler) cancels all.
      assert.equal(
        await api.withScope(patient(P2, PP1), (tx) => service.cancel(tx, 'reminder:res-c1')),
        1,
      );
      assert.equal(
        await worker.withScope(system([P2]), (tx) => service.cancel(tx, 'reminder:res-c1')),
        3,
      );
      assert.equal(
        await worker.withScope(system([P2]), (tx) => service.cancel(tx, 'reminder:res-c1')),
        0,
      );
      assert.deepEqual(
        (
          await q(
            `SELECT DISTINCT status FROM notifications.notification WHERE dedupe_key LIKE 'reminder:res-c1:%'`,
          )
        ).map((r) => r['status']),
        ['cancelled'],
      );
      assert.deepEqual(
        (
          await q(
            `SELECT DISTINCT status FROM notifications.notification WHERE dedupe_key LIKE 'reminder:res-c2:%'`,
          )
        ).map((r) => r['status']),
        ['queued'],
      );
      assert.deepEqual(
        (
          await q(
            `SELECT DISTINCT status FROM notifications.notification WHERE dedupe_key LIKE 'reminder:res-c10:%'`,
          )
        ).map((r) => r['status']),
        ['queued'],
        'BE06-F3: res-c1 does not cancel res-c10',
      );
      await assert.rejects(
        worker.withScope(system(), (tx) =>
          tx.query(
            `UPDATE notifications.notification SET status = 'queued' WHERE dedupe_key LIKE 'reminder:res-c1:%'`,
          ),
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await assert.rejects(
        api.withScope(system(), (tx) => service.cancel(tx, 'reminder')),
        (e: NotificationsValidationError) => e.fields[0] === 'prefix',
      );
      await assert.rejects(
        worker.withScope(system(), (tx) => service.cancel(tx, '')),
        (e: NotificationsValidationError) => e.fields[0] === 'prefix',
      );
    });

    test('in-app notices: a patient lists only their own sent notices and marks them read once', async () => {
      const id = String(
        (
          await q(
            `SELECT id FROM notifications.notification WHERE dedupe_key = 'confirm:res-0001:in_app'`,
          )
        )[0]?.['id'],
      );
      assert.deepEqual(
        await api.withScope(patient(P1, PP1), (tx) => service.listInApp(tx)),
        [],
        'still queued: not a notice yet',
      );
      await adminDb.query(
        `UPDATE notifications.notification SET status = 'sent', sent_at = now() WHERE id = $1`,
        [id],
      );
      const list = await api.withScope(patient(P1, PP1), (tx) => service.listInApp(tx));
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, id);
      assert.equal(list[0]?.read, false);
      assert.deepEqual(await api.withScope(patient(P3, PP3), (tx) => service.listInApp(tx)), []);
      assert.equal(
        await api.withScope(patient(P3, PP3), (tx) => service.markRead(tx, id)),
        false,
        'not theirs',
      );
      assert.equal(await api.withScope(patient(P1, PP1), (tx) => service.markRead(tx, id)), true);
      assert.equal(await api.withScope(patient(P1, PP1), (tx) => service.markRead(tx, id)), true);
      assert.equal(
        Number(
          (
            await q(
              `SELECT count(*)::int AS n FROM notifications.in_app_read WHERE notification_id = $1`,
              [id],
            )
          )[0]?.['n'],
        ),
        1,
      );
      assert.equal(
        (await api.withScope(patient(P1, PP1), (tx) => service.listInApp(tx)))[0]?.read,
        true,
      );
      // A proxy of P1 does not see P1's notices (T-PAT-OWN).
      assert.deepEqual(
        await api.withScope(patient(P3, PP3, [P1]), (tx) => service.listInApp(tx)),
        [],
      );
    });
  });

  describe('row-level security and grants', () => {
    test('app_api: patients see only their own in-app rows; staff (google) and admin see no patient notification; anonymous sees nothing', async () => {
      const count = (s: ScopeSettings) =>
        api.withScope(s, async (tx) =>
          Number(
            (await tx.query(`SELECT count(*)::int AS n FROM notifications.notification`)).rows[0]?.[
              'n'
            ],
          ),
        );
      assert.ok((await count(patient(P1, PP1))) >= 1);
      const asProxy = await api.withScope(patient(P3, PP3, [P1]), async (tx) =>
        Number(
          (
            await tx.query(
              `SELECT count(*)::int AS n FROM notifications.notification WHERE patient_id = $1`,
              [P1],
            )
          ).rows[0]?.['n'],
        ),
      );
      assert.equal(asProxy, 0, 'a proxy-only view of P1 reads nothing (T-PAT-OWN)');
      assert.equal(await count(doctor), 0);
      assert.equal(await count(admin), 0);
      assert.equal(await count(ANON), 0);
      assert.equal(await count({ ...patient(P1, PP1), orgId: ORG2 }), 0);
      const channels = await api.withScope(patient(P1, PP1), async (tx) =>
        (await tx.query(`SELECT DISTINCT channel FROM notifications.notification`)).rows.map(
          (r) => r['channel'],
        ),
      );
      assert.deepEqual(channels, ['in_app']);
    });

    test('inserts: a patient only for themselves, queued only; admin realm only to principals; a worker needs its patients scope', async () => {
      const ins = (
        s: ScopeSettings,
        o: {
          patient?: string | null;
          principal?: string | null;
          status?: string;
          k: string;
          db?: KernelDb;
        },
      ) =>
        (o.db ?? api).withScope(s, (tx) =>
          tx.query(
            `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, principal_id, template_key, template_version, channel, status, dedupe_key)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'appointment_cancelled', 2, 'sms', $5, $6)`,
            [
              ORG,
              o.principal ? 'principal' : 'patient',
              o.patient ?? null,
              o.principal ?? null,
              o.status ?? 'queued',
              `rls:${o.k}`,
            ],
          ),
        );
      const denied = (e: { code?: string }) => e.code === '42501';
      await assert.rejects(ins(patient(P1, PP1), { patient: P3, k: 'a' }), denied);
      await assert.rejects(ins(patient(P1, PP1), { patient: P1, status: 'sent', k: 'b' }), denied);
      await assert.rejects(ins(admin, { patient: P1, k: 'c' }), denied);
      await assert.rejects(ins(ANON, { patient: P1, k: 'd' }), denied);
      await assert.rejects(ins(system([P3]), { patient: P1, k: 'e', db: worker }), denied);
      await ins(patient(P1, PP1), { patient: P1, k: 'ok1' });
      await ins(admin, { principal: ADM, k: 'ok2' });
      await ins(system([P1]), { patient: P1, k: 'ok3', db: worker });
      await ins(doctor, { patient: P1, k: 'ok4' }); // staff may queue a send; reading it back awaits T-STAFF (BE-08)
      assert.equal(
        Number(
          (
            await q(
              `SELECT count(*)::int AS n FROM notifications.notification WHERE dedupe_key LIKE 'rls:ok%'`,
            )
          )[0]?.['n'],
        ),
        4,
      );
      // A principal sees their own principal notices only.
      assert.equal(
        await api.withScope(admin, async (tx) =>
          Number(
            (await tx.query(`SELECT count(*)::int AS n FROM notifications.notification`)).rows[0]?.[
              'n'
            ],
          ),
        ),
        1,
      );
    });

    test('the application role cannot change content, delete, or touch receipts; receipts and reads are append-only', async () => {
      const id = String(
        (await q(`SELECT id FROM notifications.notification WHERE dedupe_key = 'rls:ok1'`))[0]?.[
          'id'
        ],
      );
      await assert.rejects(
        api.withScope(patient(P1, PP1), (tx) =>
          tx.query(`UPDATE notifications.notification SET variables = '{}'::jsonb WHERE id = $1`, [
            id,
          ]),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        api.withScope(patient(P1, PP1), (tx) =>
          tx.query(`DELETE FROM notifications.notification WHERE id = $1`, [id]),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        api.withScope(patient(P1, PP1), (tx) =>
          tx.query(`SELECT 1 FROM notifications.delivery_receipt`),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      // Even the superuser's UPDATE/DELETE on append-only rows and content columns is refused by the triggers.
      await assert.rejects(
        adminDb.query(
          `UPDATE notifications.notification SET variables = '{"code":"A1B2C3"}'::jsonb WHERE id = $1`,
          [id],
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await assert.rejects(
        adminDb.query(`DELETE FROM notifications.notification WHERE id = $1`, [id]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await adminDb.query(
        `INSERT INTO notifications.delivery_receipt (id, organisation_id, notification_id, patient_id, status, received_at, vendor_event_id) VALUES (gen_random_uuid(), $1, $2, $3, 'delivered', now(), 'ev-append')`,
        [ORG, id, P1],
      );
      await assert.rejects(
        adminDb.query(
          `UPDATE notifications.delivery_receipt SET status = 'bounced' WHERE vendor_event_id = 'ev-append'`,
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await assert.rejects(
        adminDb.query(
          `DELETE FROM notifications.delivery_receipt WHERE vendor_event_id = 'ev-append'`,
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      // A receipt is unique per (notification, vendor event).
      await assert.rejects(
        adminDb.query(
          `INSERT INTO notifications.delivery_receipt (id, organisation_id, notification_id, patient_id, status, received_at, vendor_event_id) VALUES (gen_random_uuid(), $1, $2, $3, 'delivered', now(), 'ev-append')`,
          [ORG, id, P1],
        ),
        (e: { code?: string }) => e.code === '23505',
      );
    });

    test('table rules: dedupe key without the recipient, recipient kind consistent, values on the allowlist, forward-only status', async () => {
      const raw = (
        patientId: string | null,
        principalId: string | null,
        kind: string,
        key: string,
        vals = '{}',
      ) =>
        adminDb.query(
          `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, principal_id, template_key, template_version, channel, variables, dedupe_key)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'appointment_cancelled', 2, 'sms', $5::jsonb, $6)`,
          [ORG, kind, patientId, principalId, vals, key],
        );
      const check = (e: { code?: string }) => e.code === '23514';
      await assert.rejects(raw(P1, null, 'patient', `reminder:${P1}:48h`), check);
      await assert.rejects(raw(P1, null, 'patient', `reminder:${P1.toUpperCase()}:48h`), check);
      await assert.rejects(raw(P1, ADM, 'patient', 'tbl:both'), check);
      await assert.rejects(raw(null, null, 'patient', 'tbl:none'), check);
      await assert.rejects(raw(P1, null, 'patient', 'tbl:v1', '{"service_name":"x"}'), check);
      await assert.rejects(raw(P1, null, 'patient', 'tbl:v2', '{"location_name":{"a":1}}'), check);
      await assert.rejects(
        raw(P1, null, 'patient', 'tbl:v3', `{"location_name":"${'x'.repeat(501)}"}`),
        check,
      );
      await assert.rejects(raw(P1, null, 'patient', 'Has Upper'), check);
      const id = String(
        (await q(`SELECT id FROM notifications.notification WHERE dedupe_key = 'rls:ok3'`))[0]?.[
          'id'
        ],
      );
      await assert.rejects(
        adminDb.query(`UPDATE notifications.notification SET status = 'sent' WHERE id = $1`, [id]),
        check,
      ); // sent without sent_at
      await adminDb.query(
        `UPDATE notifications.notification SET status = 'sending', attempts = 1 WHERE id = $1`,
        [id],
      );
      await adminDb.query(
        `UPDATE notifications.notification SET status = 'failed', error_class = 'vendor_unavailable' WHERE id = $1`,
        [id],
      );
      await assert.rejects(
        adminDb.query(`UPDATE notifications.notification SET status = 'queued' WHERE id = $1`, [
          id,
        ]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await adminDb.query(
        `UPDATE notifications.notification SET status = 'sent', sent_at = now() WHERE id = $1`,
        [id],
      );
      await assert.rejects(
        adminDb.query(`UPDATE notifications.notification SET attempts = 9 WHERE id = $1`, [id]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      assert.deepEqual(
        (await q(`SELECT row_version FROM notifications.notification WHERE id = $1`, [id])).map(
          (r) => Number(r['row_version']),
        ),
        [4],
      );
    });
  });

  describe('merge and export participants (22.16, 24, SBR-16)', () => {
    const MERGED = '00000000-0000-7000-8000-0000000000e8';
    const SURV = '00000000-0000-7000-8000-0000000000e9';
    const seed = async (): Promise<Record<string, string>> => {
      const ids: Record<string, string> = {};
      let n = 0;
      for (const [status, patientId] of [
        ['queued', MERGED],
        ['sending', MERGED],
        ['failed', MERGED],
        ['sent', MERGED],
        ['suppressed', MERGED],
        ['cancelled', MERGED],
        ['queued', SURV],
      ] as const) {
        n += 1;
        const id = `00000000-0000-7000-8000-00000000b${String(n).padStart(3, '0')}`;
        ids[`${status}${patientId === SURV ? '_surv' : ''}`] = id;
        await adminDb.query(
          `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, template_key, template_version, channel, status, dedupe_key, variables)
           VALUES ($1, $2, 'patient', $3, 'appointment_cancelled', 2, 'sms', 'queued', $4, '{"portal_link":"https://portal.example.test/a"}')`,
          [id, ORG, patientId, `merge:n${n}`],
        );
        if (status === 'sending')
          await adminDb.query(
            `UPDATE notifications.notification SET status = 'sending' WHERE id = $1`,
            [id],
          );
        if (status === 'failed') {
          await adminDb.query(
            `UPDATE notifications.notification SET status = 'sending' WHERE id = $1`,
            [id],
          );
          await adminDb.query(
            `UPDATE notifications.notification SET status = 'failed' WHERE id = $1`,
            [id],
          );
        }
        if (status === 'sent')
          await adminDb.query(
            `UPDATE notifications.notification SET status = 'sent', sent_at = now() WHERE id = $1`,
            [id],
          );
        if (status === 'suppressed')
          await adminDb.query(
            `UPDATE notifications.notification SET status = 'suppressed', suppress_reason = 'preference_off' WHERE id = $1`,
            [id],
          );
        if (status === 'cancelled')
          await adminDb.query(
            `UPDATE notifications.notification SET status = 'cancelled' WHERE id = $1`,
            [id],
          );
      }
      await adminDb.query(
        `INSERT INTO notifications.delivery_receipt (id, organisation_id, notification_id, patient_id, status, received_at, vendor_event_id) VALUES (gen_random_uuid(), $1, $2, $3, 'delivered', now(), 'merge-ev-1')`,
        [ORG, ids['sent'], MERGED],
      );
      await adminDb.query(
        `INSERT INTO notifications.in_app_read (notification_id, organisation_id, patient_id) VALUES ($1, $2, $3)`,
        [ids['sent'], ORG, MERGED],
      );
      return ids;
    };

    test('repointPatient: R rows move to the survivor, K rows stay, counts add up for notifications, receipts and reads; scope is enforced', async () => {
      const ids = await seed();
      const run = (s: ScopeSettings) =>
        worker.withScope(s, (tx) =>
          notificationsMergeParticipant.repointPatient(tx, MERGED, SURV, REQ),
        );
      // Not a merge job: refused, nothing changes.
      await assert.rejects(run(system()), NotificationsScopeError);
      await assert.rejects(
        run(system([MERGED])),
        NotificationsScopeError,
        'the survivor must be in the job scope too',
      );
      await assert.rejects(run(patient(MERGED, PP1)), NotificationsScopeError);
      await assert.rejects(
        worker.withScope(system([MERGED, SURV]), (tx) =>
          notificationsMergeParticipant.repointPatient(tx, 'not-a-uuid', SURV, REQ),
        ),
        NotificationsValidationError,
      );

      const counts = await run(system([MERGED, SURV]));
      assert.deepEqual(
        counts.map((c) => c.table),
        [...NOTIFICATIONS_MERGE_TABLES],
      );
      const byTable = Object.fromEntries(counts.map((c) => [c.table, c]));
      assert.deepEqual(
        [
          byTable['notifications.notification']?.found,
          byTable['notifications.notification']?.repointed,
          byTable['notifications.notification']?.resolved,
          byTable['notifications.notification']?.kept,
        ],
        [6, 3, 0, 3],
      );
      assert.deepEqual(
        [
          byTable['notifications.delivery_receipt']?.found,
          byTable['notifications.delivery_receipt']?.repointed,
          byTable['notifications.delivery_receipt']?.kept,
        ],
        [1, 0, 1],
      );
      assert.deepEqual(
        [
          byTable['notifications.in_app_read']?.found,
          byTable['notifications.in_app_read']?.repointed,
          byTable['notifications.in_app_read']?.kept,
        ],
        [1, 0, 1],
      );
      for (const c of counts) assert.equal(c.found, c.repointed + c.resolved + c.kept, c.table);
      const where = async (id?: string) =>
        (
          await q<{ id: string; patient_id: string; status: string }>(
            `SELECT id, patient_id, status FROM notifications.notification WHERE id = $1`,
            [id],
          )
        )[0];
      for (const s of ['queued', 'sending', 'failed'])
        assert.equal((await where(ids[s]))?.patient_id, SURV, s);
      for (const s of ['sent', 'suppressed', 'cancelled'])
        assert.equal((await where(ids[s]))?.patient_id, MERGED, s);
      assert.equal(
        Number(
          (
            await q(
              `SELECT count(*)::int AS n FROM notifications.notification WHERE patient_id = $1 AND status IN ('queued','sending','failed')`,
              [MERGED],
            )
          )[0]?.['n'],
        ),
        0,
      );
      // Idempotent: a second run finds no R row and the equation still holds.
      const second = await run(system([MERGED, SURV]));
      assert.deepEqual([second[0]?.found, second[0]?.repointed, second[0]?.kept], [3, 0, 3]);
      // The dedupe key never named the patient, so nothing collided; the survivor's own row is untouched.
      assert.equal((await where(ids['queued_surv']))?.patient_id, SURV);
    });

    test("exportPart returns the patient's notifications, receipts and reads - no address and no message text exist to leak", async () => {
      const part = (await worker.withScope(system([MERGED, SURV]), (tx) =>
        notificationsExportContributor.exportPart(tx, [MERGED, SURV], REQ),
      )) as {
        module: string;
        notifications: Record<string, unknown>[];
        deliveryReceipts: unknown[];
        inAppReads: unknown[];
      };
      assert.equal(part.module, 'notifications');
      assert.equal(part.notifications.length, 7);
      assert.equal(part.deliveryReceipts.length, 1);
      assert.equal(part.inAppReads.length, 1);
      assert.ok(part.notifications.every((n) => [MERGED, SURV].includes(String(n['patient_id']))));
      await assert.rejects(
        worker.withScope(system([SURV]), (tx) =>
          notificationsExportContributor.exportPart(tx, [MERGED], REQ),
        ),
        NotificationsScopeError,
      );
      await assert.rejects(
        worker.withScope(system([MERGED]), (tx) =>
          notificationsExportContributor.exportPart(tx, [], REQ),
        ),
        NotificationsValidationError,
      );
    });

    test('the participants register with the kernel registries once', () => {
      const r = new ParticipantRegistries();
      registerNotificationsParticipants(r);
      assert.deepEqual(
        r.mergeParticipants().map((p) => p.module),
        ['notifications'],
      );
      assert.deepEqual(
        r.exportContributors().map((p) => p.module),
        ['notifications'],
      );
      assert.throws(() => registerNotificationsParticipants(r), /already registered/);
    });
  });
});
