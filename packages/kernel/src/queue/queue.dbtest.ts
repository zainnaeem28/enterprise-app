// Real-database acceptance tests for F-04 (SBR-17 (a)-(d), idempotency concurrency, job rollback).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/queue/queue.dbtest.js
// Superuser URL on a throwaway PostgreSQL 17; synthetic data only. Missing configuration FAILS; nothing skips.
// UNEXECUTED at the time of writing (no database available). Not matched by the default `test` glob.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
// `pg` has no type declarations in this package (@types/pg is not a declared dependency).
const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
import { installQueue } from './install.js';
import { JobRegistry, Queue } from './enqueue.js';

const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const dbName = `ehr_f04_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName) => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};
const open = async (user: string) => {
  const c = new pg.Client({ connectionString: urlFor(user) });
  await c.connect();
  return c;
};

describe('queue on FORCEd tables', () => {
  const registry = new JobRegistry();
  registry.defineJob({
    name: 'f04.probe',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
  });
  const queue = new Queue(registry);

  before(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
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
    await installQueue(urlFor('queue_owner'));
  });
  after(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  test('(a) enqueue commits with the business change and rolls back with it', async () => {
    const c = await open('app_api');
    try {
      await c.query('BEGIN');
      await queue.enqueue(
        c,
        'f04.probe',
        { id: '00000000-0000-7000-8000-0000000000b1' },
        { jobKey: 'rb' },
      );
      await c.query('ROLLBACK');
      const w = await open('app_worker');
      const n = await w.query("SELECT count(*)::int AS n FROM queue.jobs WHERE key = 'rb'");
      await w.end();
      assert.equal(n.rows[0].n, 0, 'rolled-back transaction leaves no job');
      await c.query('BEGIN');
      await queue.enqueue(
        c,
        'f04.probe',
        { id: '00000000-0000-7000-8000-0000000000b1' },
        { jobKey: 'ok' },
      );
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const w = await open('app_worker');
    try {
      const n = await w.query("SELECT count(*)::int AS n FROM queue.jobs WHERE key = 'ok'");
      assert.equal(n.rows[0].n, 1);
    } finally {
      await w.end();
    }
  });

  test('(b) app_worker dequeues under FORCE; the table owner and app_api cannot read', async () => {
    const w = await open('app_worker');
    try {
      const r = await w.query("SELECT queue.get_job('{f04.probe}'::text[]) AS j");
      assert.ok(r.rows[0].j !== null, 'worker dequeued the committed job');
    } finally {
      await w.end();
    }
    const a = await open('app_api');
    try {
      await assert.rejects(
        a.query('SELECT * FROM queue.jobs'),
        (e: { code?: string }) => e.code === '42501',
      );
    } finally {
      await a.end();
    }
  });

  test('(c) max attempts are carried on the job', async () => {
    const w = await open('app_worker');
    try {
      const r = await w.query("SELECT max_attempts FROM queue.jobs WHERE key = 'ok'");
      assert.equal(r.rows[0].max_attempts, 3);
    } finally {
      await w.end();
    }
  });

  test('(d) dead jobs are visible (attempts >= max_attempts)', async () => {
    const w = await open('app_worker');
    try {
      await w.query("UPDATE queue.jobs SET attempts = max_attempts WHERE key = 'ok'");
      const r = await w.query(
        'SELECT count(*)::int AS n FROM queue.jobs WHERE attempts >= max_attempts',
      );
      assert.equal(r.rows[0].n, 1);
    } finally {
      await w.end();
    }
  });
});
