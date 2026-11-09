// Real-database test of `identity.admin_event` and `identity.admin_event_notice` as app_worker, through the composed task table with the
// API's real alert service and target resolver (INT04F02-S1..S4), PostgreSQL 17, queue installed, API built:
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/jobs/identity/admin-event.dbtest.js
// Missing configuration FAILS; nothing skips. Synthetic data only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { createLogger, KernelDb, loadConfig } from '@ehr/kernel';
import type { PoolLike as KernelPoolLike } from '@ehr/kernel';
import { composeWorker } from '../../compose.js';
import { createPool } from '../../runner.js';
import { adminEventDeadLetters, runApplyReferenceData, type SecurityNotice } from './index.js';
import { uuidv7 } from './ids.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env['EHR_TEST_ADMIN_URL'];
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_int04f02_${process.pid}_${Date.now()}`;
const ORG = '00000000-0000-7000-8000-0000000000a1';
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

type Row = Record<string, unknown>;
type Client = {
  query(s: string, p?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  connect(): Promise<void>;
  end(): Promise<void>;
};
type Handler = (payload: unknown, helpers: unknown) => Promise<void>;

let sa: Client;
let pool: { end(): Promise<void> };
let admin: Handler;
let notice: Handler;
let wdb: KernelDb;
const notices: SecurityNotice[] = [];
const q = (s: string, p?: unknown[]): Promise<Row[]> => sa.query(s, p).then((r) => r.rows);
const n = async (s: string, p?: unknown[]): Promise<number> => Number((await q(s, p))[0]?.['n']);

/** One admin-realm principal with its person. `compliance` gives it the open compliance_officer assignment. */
async function seedAdmin(
  label: string,
  compliance: boolean,
): Promise<{ principal: string; person: string }> {
  const person = uuidv7();
  const principal = uuidv7();
  await sa.query(
    `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,$3)`,
    [person, ORG, label],
  );
  await sa.query(
    `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject) VALUES ($1,$2,$3,'admin_pool',$4)`,
    [principal, ORG, person, `s-${principal}`],
  );
  if (compliance) {
    const request = uuidv7();
    await sa.query(
      `INSERT INTO identity.role_change_request (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, approver_person_id, decided_at, expires_at)
       VALUES ($1,$2,$3,$4,'{}'::jsonb,'[]'::jsonb,$5,'applied',$6,now(),now() + interval '1 day')`,
      [request, ORG, person, principal, Buffer.alloc(32, 1), uuidv7()],
    );
    await sa.query(
      `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, granted_via_request_id)
       SELECT $1, $2, $3, id, $4 FROM identity.role WHERE key = 'compliance_officer' AND realm = 'admin_pool'`,
      [uuidv7(), ORG, principal, request],
    );
  }
  return { principal, person };
}

const run = (
  h: Handler,
  name: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> => h(payload, { job: { id: String(Math.floor(Math.random() * 1e9)), key } });

before(async () => {
  const a = new pg.Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`CREATE DATABASE ${dbName}`);
  await a.end();
  const env = {
    PATH: process.env['PATH'],
    EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl).username),
    EHR_DB_MIGRATE_URL: urlFor('app_owner'),
  };
  for (const cmd of ['bootstrap', 'migrate'])
    execFileSync(process.execPath, [`${root}db/tools/migrate.mjs`, cmd], { env, stdio: 'ignore' });
  await installQueue(urlFor('app_owner'));
  sa = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
  await sa.connect();
  // Seeding bypasses the guard triggers and the role-assignment FK (a superuser fixture); the handlers under test run as app_worker.
  await sa.query(`SET session_replication_role = replica`);
  const cfg = loadConfig({
    EHR_ENV: 'ci',
    EHR_DEPLOYABLE: 'worker',
    EHR_DATABASE_URL: urlFor('app_worker'),
    EHR_ORGANISATION_ID: ORG,
  });
  const log = createLogger({ sink: () => undefined });
  const p = await createPool(cfg);
  pool = p;
  wdb = new KernelDb(p as unknown as KernelPoolLike);
  const { tasks } = await composeWorker({
    cfg,
    pool: p,
    log,
    patientHost: 'my.example.test',
    qrKey: 'qr-key-for-tests-0123456789abcdef0123',
    infra: {
      securityNotice: {
        notify: (x: SecurityNotice) => {
          notices.push(x);
          return Promise.resolve();
        },
      },
    },
  });
  admin = tasks['identity.admin_event'] as Handler;
  notice = tasks['identity.admin_event_notice'] as Handler;
  await runApplyReferenceData({ db: wdb, orgId: ORG, jobId: uuidv7() });
});
after(async () => {
  await pool?.end();
  await sa?.end();
  const a = new pg.Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await a.end();
});

describe('identity.admin_event (real database, app_worker)', () => {
  let subject: { principal: string; person: string };
  let reviewer: { principal: string; person: string };

  test('S1/S4: with no compliance recipient the alert step fails, the audit row stays and a retry writes no second row', async () => {
    subject = await seedAdmin('Subject Admin', false);
    await assert.rejects(
      run(admin, 'a', 'handle_failures:one', {
        kind: 'handle_failures',
        principalId: subject.principal,
      }),
    );
    const rows = await q(
      `SELECT action, outcome, denial_reason, realm, audience, job_id FROM audit.event WHERE resource_id = $1::uuid AND job_id LIKE 'identity.admin_event:%'`,
      [subject.principal],
    );
    assert.equal(rows.length, 1, 'the audit row is committed although the alert step failed');
    assert.deepEqual(
      { ...rows[0] },
      {
        action: 'denied',
        outcome: 'denied',
        denial_reason: 'forbidden',
        realm: 'worker',
        audience: 'system',
        job_id: 'identity.admin_event:handle_failures:one',
      },
    );
    assert.equal(await n(`SELECT count(*) AS n FROM notifications.staff_alert`), 0);
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'identity.admin_event_notice'`,
      ),
      0,
    );

    // A recipient appears; the job retries under the same key.
    reviewer = await seedAdmin('Compliance Reviewer', true);
    await run(admin, 'a', 'handle_failures:one', {
      kind: 'handle_failures',
      principalId: subject.principal,
    });
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM audit.event WHERE resource_id = $1::uuid AND job_id = 'identity.admin_event:handle_failures:one'`,
        [subject.principal],
      ),
      1,
      'the retry did not duplicate the audit row (S4)',
    );
    const alerts = await q(
      `SELECT type, severity, target_principal_ids::text[] AS targets FROM notifications.staff_alert`,
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.['type'], 'privileged_change');
    assert.equal(alerts[0]?.['severity'], 'high');
    assert.deepEqual(alerts[0]?.['targets'], [reviewer.principal]);
  });

  test('credential_enrolled: audit row names the requester and approver, the alert excludes the subject even when they hold audit.btg.review (S3)', async () => {
    const requester = await seedAdmin('Requester', false);
    const approver = await seedAdmin('Approver', false);
    const enrolled = await seedAdmin('Enrolled Admin', true); // also a compliance officer: must not review their own enrolment
    const tokenId = uuidv7();
    await sa.query(
      `INSERT INTO identity.enrolment_token (id, organisation_id, principal_id, token_hash, requested_by_person_id, approved_by_person_id, expires_at, used_at, status)
       VALUES ($1,$2,$3,$4,$5,$6, now() + interval '1 day', now(), 'used')`,
      [tokenId, ORG, enrolled.principal, Buffer.alloc(32, 7), requester.person, approver.person],
    );
    const session = uuidv7();
    await run(admin, 'a', `credential_enrolled:${session}`, {
      kind: 'credential_enrolled',
      principalId: enrolled.principal,
      sessionId: session,
    });
    const ev = (
      await q(
        `SELECT action, outcome, change FROM audit.event WHERE resource_id = $1::uuid AND job_id = $2`,
        [enrolled.principal, `identity.admin_event:credential_enrolled:${session}`],
      )
    )[0];
    assert.equal(ev?.['action'], 'enrol');
    assert.equal(ev?.['outcome'], 'allowed');
    assert.deepEqual(ev?.['change'], {
      kind: 'credential_enrolled',
      requestedByPersonId: requester.person,
      approvedByPersonId: approver.person,
      sessionId: session,
    });
    const alert = (
      await q(
        `SELECT severity, target_principal_ids::text[] AS targets FROM notifications.staff_alert WHERE resource_id = $1::uuid`,
        [enrolled.principal],
      )
    )[0];
    assert.equal(alert?.['severity'], 'high');
    assert.deepEqual(
      alert?.['targets'],
      [reviewer.principal],
      'the enrolled admin is not a recipient of their own alert',
    );
  });

  test('counter_regression: critical alert, audit row, and the notice is a separate job that carries a kind and an ID only', async () => {
    const victim = await seedAdmin('Cloned Key Admin', false);
    await sa.query(
      `INSERT INTO identity.enrolment_token (id, organisation_id, principal_id, token_hash, requested_by_person_id, approved_by_person_id, expires_at, used_at, status)
       VALUES ($1,$2,$3,$4,$5,$6, now() + interval '1 day', now(), 'used')`,
      [uuidv7(), ORG, victim.principal, Buffer.alloc(32, 9), reviewer.person, subject.person],
    );
    const tok = (
      await q(`SELECT id FROM identity.enrolment_token WHERE principal_id = $1::uuid`, [
        victim.principal,
      ])
    )[0]?.['id'];
    await sa.query(
      `INSERT INTO identity.admin_credential (id, organisation_id, principal_id, public_key, aaguid, backup_eligible, user_verified_at_enrol, enrolment_token_id)
       VALUES ($1,$2,$3,$4,$5,false,true,$6)`,
      [Buffer.alloc(32, 3), ORG, victim.principal, Buffer.alloc(32, 4), uuidv7(), tok],
    );
    await run(admin, 'a', 'counter_regression:one', {
      kind: 'counter_regression',
      principalId: victim.principal,
    });
    const alert = (
      await q(`SELECT severity FROM notifications.staff_alert WHERE resource_id = $1::uuid`, [
        victim.principal,
      ])
    )[0];
    assert.equal(alert?.['severity'], 'critical');
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM audit.event WHERE resource_id = $1::uuid AND action = 'enrol' AND job_id = 'identity.admin_event:counter_regression:one'`,
        [victim.principal],
      ),
      1,
    );

    // The notice job was queued in the same transaction as the alert and is sent by its own task.
    const queued = await q(
      `SELECT j.payload, j.key FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'identity.admin_event_notice' AND j.payload ->> 'principalId' = $1`,
      [victim.principal],
    );
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0]?.['payload'], {
      kind: 'counter_regression',
      principalId: victim.principal,
    });
    assert.equal(notices.length, 0, 'nothing has been sent yet: the notice is its own step');
    await run(
      notice,
      'n',
      String(queued[0]?.['key']),
      queued[0]?.['payload'] as Record<string, unknown>,
    );
    assert.equal(notices.length, 1);
    assert.deepEqual(Object.keys(notices[0] as object).sort(), ['jobRef', 'kind', 'principalId']);
  });

  test('S1: a job that exhausts its attempts is counted by the dead-letter gauge source', async () => {
    assert.equal(await adminEventDeadLetters(wdb, ORG), 0);
    await sa.query(`SELECT queue.add_job('identity.admin_event', '{}'::json, max_attempts => 8)`);
    await sa.query(
      `UPDATE queue._private_jobs j SET attempts = max_attempts FROM queue._private_tasks t
        WHERE t.id = j.task_id AND t.identifier = 'identity.admin_event'`,
    );
    assert.equal(await adminEventDeadLetters(wdb, ORG), 1);
  });
});
