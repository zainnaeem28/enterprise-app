// Real-database test of the worker's composed task table (HEAAA-231, R8-N2), PostgreSQL 17, queue installed, API built:
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55433/postgres node --test dist/compose.dbtest.js
// Missing configuration FAILS; nothing skips. Not matched by the default `*.test.js` glob.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { createLogger, JobRegistry, loadConfig, Queue, syncTaskTypes } from '@ehr/kernel';
import type { JobType } from '@ehr/kernel';
import { pathToFileURL } from 'node:url';
import { composeWorker } from './compose.js';
import { buildWorkerRegistry, WORKER_JOBS } from './job-registry.js';
import { createPool, startWorker } from './runner.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dbName = `ehr_r8n2_${process.pid}_${Date.now()}`;
const ORG = '00000000-0000-7000-8000-0000000000a1';
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};
const sleep = (ms: number): Promise<void> => new Promise((r) => globalThis.setTimeout(r, ms));

describe('every registered worker job type has a handler in the composed task table (R8-N2)', () => {
  before(async () => {
    const admin = new pg.Client({
      connectionString: urlFor(new URL(adminUrl).username, 'postgres'),
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
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
  });
  after(async () => {
    const admin = new pg.Client({
      connectionString: urlFor(new URL(adminUrl).username, 'postgres'),
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  test('a queued job of each registered type is picked up by its handler, none is "unsupported"', async () => {
    const cfg = loadConfig({
      EHR_ENV: 'ci',
      EHR_DEPLOYABLE: 'worker',
      EHR_DATABASE_URL: urlFor('app_worker'),
      EHR_ORGANISATION_ID: ORG,
    });
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    const pool = await createPool(cfg);
    // The API's real services behind the scheduling and telehealth ports (apps/api/dist/src/worker-ports.js).
    const { tasks, registry } = await composeWorker({
      cfg,
      pool,
      log,
      patientHost: 'my.example.test',
      qrKey: 'qr-key-for-tests-0123456789abcdef0123',
    });
    const expected = WORKER_JOBS.map((j) => j.name).sort();
    assert.deepEqual(Object.keys(tasks).sort(), expected);

    // Control: a type registered WITHOUT a handler is never fetched by the library (it stays queued, attempts 0), so the check can tell.
    const control = new JobRegistry();
    control.defineJob({
      name: 'r8n2.control',
      maxAttempts: 1,
      onMerged: 'none',
      carriesPatientIds: false,
      jobScope: 'org',
    });
    for (const j of WORKER_JOBS) control.defineJob(j);
    const worker = await startWorker({ cfg, pool, log, tasks, registry: control, concurrency: 5 });
    const w = new pg.Client({ connectionString: urlFor('app_worker') });
    await w.connect();
    try {
      const queue = new Queue(registry, 'worker');
      const names = [...expected, 'r8n2.control'];
      await w.query('BEGIN');
      const tx = {
        query: (sql: string, p?: unknown[]) => w.query(sql, p),
        scope: { audience: 'system', realm: 'worker', orgId: ORG },
      };
      let n = 0;
      for (const name of names) {
        const payload = { id: `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}` };
        if (name === 'r8n2.control')
          await tx.query(
            `SELECT queue.add_job($1::text, $2::json, max_attempts => 1, job_key => $3::text)`,
            [name, JSON.stringify(payload), name],
          );
        else await queue.enqueue(tx as never, name, payload, { jobKey: 'r8n2' });
      }
      await w.query('COMMIT');

      // Picked up = the row is gone (finished) or has been locked at least once (attempts >= 1).
      const state = async (): Promise<Map<string, { attempts: number; err: string | null }>> => {
        const r = await w.query(
          `SELECT t.identifier, j.attempts, j.last_error
             FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id`,
        );
        return new Map(
          r.rows.map((x: { identifier: string; attempts: number; last_error: string | null }) => [
            x.identifier,
            { attempts: x.attempts, err: x.last_error },
          ]),
        );
      };
      const deadline = Date.now() + 60_000;
      let seen = await state();
      const pending = (): string[] =>
        expected.filter((nm) => {
          const s = seen.get(nm);
          return s !== undefined && s.attempts < 1;
        });
      while (pending().length > 0 && Date.now() < deadline) {
        await sleep(500);
        seen = await state();
      }
      assert.deepEqual(pending(), [], 'jobs never picked up');
      await sleep(500);
      seen = await state();
      assert.equal(
        seen.get('r8n2.control')?.attempts,
        0,
        'control job (no handler) must stay unpicked',
      );
      assert.deepEqual(
        expected.filter((nm) => seen.get(nm) === undefined || (seen.get(nm)?.attempts ?? 0) >= 1),
        expected,
      );
      const unsupported = [...seen].filter(
        ([k, s]) => k !== 'r8n2.control' && /unsupported/i.test(s.err ?? ''),
      );
      assert.deepEqual(
        unsupported.map(([k]) => k),
        [],
        'registered types reported unsupported',
      );
      // The start-up warning of R8-N2 names only the control type: every real type has a handler.
      const warned = lines.filter((l) => l.includes('registered job types without a task handler'));
      assert.equal(warned.length, 1, warned.join('\n'));
      assert.ok((warned[0] ?? '').includes('r8n2.control'), warned[0]);
      assert.ok((warned[0] ?? '').includes('"count":1'));
    } finally {
      await w.end();
      await worker.stop();
    }
  });

  // F01-R2: the API tier publishes through queue_api.enqueue, which accepts only types in queue_api.task_type, filled from the worker.
  test('every job type the API path may publish is accepted by queue_api.enqueue against a table synced from the worker registry', async () => {
    const url = pathToFileURL(
      fileURLToPath(new URL('../../api/dist/src/composition.js', import.meta.url)),
    ).href;
    const api = ((await import(url)) as { API_PATH_JOBS: readonly JobType[] }).API_PATH_JOBS;
    const owner = new pg.Client({ connectionString: urlFor('app_owner') });
    await owner.connect();
    const w = new pg.Client({ connectionString: urlFor('app_worker') });
    await w.connect();
    const a = new pg.Client({ connectionString: urlFor('app_api') });
    await a.connect();
    try {
      await syncTaskTypes(w, buildWorkerRegistry());
      const apiRegistry = new JobRegistry();
      for (const j of api) apiRegistry.defineJob(j);
      const queue = new Queue(apiRegistry, 'api');
      // patient.execute_merge is an INT-02 gap (no worker registration), reported separately; every other API-publishable type must be accepted.
      const publishable = apiRegistry
        .list()
        .filter((j) => j.apiEnqueue && j.name !== 'patient.execute_merge');
      assert.ok(publishable.some((j) => j.name === 'notifications.escalate_alert'));
      // Control: a type absent from the table is refused by the database.
      const ghost = new JobRegistry();
      ghost.defineJob({
        name: 'f01.ghost',
        maxAttempts: 1,
        onMerged: 'none',
        carriesPatientIds: false,
        jobScope: 'org',
        jobClass: 'job',
      });
      await a.query('BEGIN');
      await assert.rejects(
        new Queue(ghost, 'api').enqueue(
          {
            query: (q: string, p?: unknown[]) => a.query(q, p),
            scope: { audience: 'system', realm: 'api', orgId: ORG },
          } as never,
          'f01.ghost',
          { id: '00000000-0000-7000-8000-000000000001' },
        ),
        /not allowed/,
      );
      await a.query('ROLLBACK');
      const refused: string[] = [];
      for (const j of publishable) {
        await a.query('BEGIN');
        try {
          const payload: Record<string, unknown> = {
            id: '00000000-0000-7000-8000-000000000001',
            alertId: '00000000-0000-7000-8000-000000000002',
            level: 1,
          };
          if (api.find((x) => x.name === j.name)?.carriesPatientIds)
            payload['patientId'] = '00000000-0000-7000-8000-000000000003';
          await queue.enqueue(
            {
              query: (q: string, p?: unknown[]) => a.query(q, p),
              scope: { audience: 'system', realm: 'api', orgId: ORG },
            } as never,
            j.name,
            payload,
            { jobKey: `f01:${j.name}` },
          );
        } catch (e) {
          refused.push(`${j.name}: ${(e as Error).message}`);
        }
        await a.query('ROLLBACK');
      }
      assert.deepEqual(refused, []);
    } finally {
      await a.end();
      await w.end();
      await owner.end();
    }
  });
});
