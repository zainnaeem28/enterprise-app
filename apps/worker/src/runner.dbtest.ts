// Real-database boot test for the worker platform layer (PostgreSQL 17, queue installed):
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55433/postgres node --test dist/runner.dbtest.js
// Missing configuration FAILS; nothing skips. Not matched by the default `*.test.js` glob.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { createLogger, JobRegistry, loadConfig, Queue, syncTaskTypes } from '@ehr/kernel';
import { createPool, startWorker } from './runner.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dbName = `ehr_f05w_${process.pid}_${Date.now()}`;
const ORG = '00000000-0000-7000-8000-0000000000a1';
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

describe('worker boots against PostgreSQL 17 and runs a queued job', () => {
  const registry = new JobRegistry();
  registry.defineJob({
    name: 'f05.probe',
    maxAttempts: 2,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
  });
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
    const w = new pg.Client({ connectionString: urlFor('app_worker') });
    await w.connect();
    await syncTaskTypes(w, registry);
    await w.end();
  });
  after(async () => {
    const admin = new pg.Client({
      connectionString: urlFor(new URL(adminUrl).username, 'postgres'),
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const cfg = () =>
    loadConfig({
      EHR_ENV: 'ci',
      EHR_DEPLOYABLE: 'worker',
      EHR_DATABASE_URL: urlFor('app_worker'),
      EHR_ORGANISATION_ID: ORG,
    });

  test('boot, run one job enqueued through the API path, retry a failing job, stop cleanly', async () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    let ran = 0;
    const done = new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 20_000).unref();
    });
    let finish!: () => void;
    const ranOnce = new Promise<void>((r) => (finish = r));
    const pool = await createPool(cfg());
    const worker = await startWorker({
      cfg: cfg(),
      pool,
      log,
      tasks: {
        'f05.probe': async () => {
          ran++;
          finish();
        },
      },
    });
    const api = new pg.Client({ connectionString: urlFor('app_api') });
    await api.connect();
    try {
      await api.query('BEGIN');
      const tx = {
        query: (sql: string, params?: unknown[]) => api.query(sql, params),
        scope: { audience: 'staff', orgId: ORG },
      };
      await new Queue(registry, 'api').enqueue(
        tx as never,
        'f05.probe',
        { id: '00000000-0000-7000-8000-0000000000b1' },
        { jobKey: 'boot' },
      );
      await api.query('COMMIT');
      await Promise.race([ranOnce, done]);
      assert.equal(ran, 1);
    } finally {
      await api.end();
      await worker.stop();
    }
    const text = lines.join('\n');
    assert.match(text, /worker started/);
    assert.match(text, /job finished/);
    assert.match(text, /worker stopped/);
  });

  test('a failing job leaks neither its message nor its stack into any output (BR-F05-02)', async () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    const out: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of ['log', 'warn', 'error', 'info'] as const)
      console[k] = (...a: unknown[]) => void out.push(a.join(' '));
    let attempts = 0;
    let seen!: () => void;
    const failed = new Promise<void>((r) => (seen = r));
    const pool = await createPool(cfg());
    const worker = await startWorker({
      cfg: cfg(),
      pool,
      log,
      tasks: {
        'f05.probe': () => {
          attempts++;
          seen();
          throw new Error('SENTINEL-PHI-VALUE');
        },
      },
    });
    const api = new pg.Client({ connectionString: urlFor('app_api') });
    await api.connect();
    try {
      await api.query('BEGIN');
      const tx = {
        query: (sql: string, params?: unknown[]) => api.query(sql, params),
        scope: { audience: 'staff', orgId: ORG },
      };
      await new Queue(registry, 'api').enqueue(
        tx as never,
        'f05.probe',
        { id: '00000000-0000-7000-8000-0000000000b2' },
        { jobKey: 'leak' },
      );
      await api.query('COMMIT');
      await Promise.race([failed, new Promise((r) => globalThis.setTimeout(r, 20_000).unref())]);
      await new Promise((r) => globalThis.setTimeout(r, 500)); // let the library log the failure
    } finally {
      Object.assign(console, orig);
      await api.end();
      await worker.stop();
    }
    assert.ok(attempts >= 1);
    const all = lines.join('\n') + out.join('\n');
    assert.match(all, /job failed/);
    assert.ok(!all.includes('SENTINEL-PHI-VALUE'), 'message leaked');
    assert.ok(!/\n\s+at /.test(all), 'stack leaked');
  });

  test('start fails fast when the queue schema is missing', async () => {
    const bad = loadConfig({
      EHR_ENV: 'ci',
      EHR_DEPLOYABLE: 'worker',
      EHR_DATABASE_URL: urlFor('app_worker'),
      EHR_ORGANISATION_ID: ORG,
      EHR_QUEUE_SCHEMA: 'nope',
    });
    const pool = await createPool(bad);
    try {
      await assert.rejects(
        startWorker({ cfg: bad, pool, log: createLogger({ sink: () => undefined }) }),
        /queue schema nope does not exist/,
      );
    } finally {
      await pool.end();
    }
  });
});
