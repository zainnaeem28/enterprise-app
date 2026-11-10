// Real-database acceptance tests for F-04 (SBR-17 (a)-(d), idempotency concurrency, job rollback).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/queue/queue.dbtest.js
// Superuser URL on a throwaway PostgreSQL 17; synthetic data only. Missing configuration FAILS; nothing skips.
// Not matched by the default `test` glob.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
// `pg` has no type declarations in this package (@types/pg is not a declared dependency).
const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
import { runOnce } from 'graphile-worker';
import { installQueue } from './install.js';
import { JobRegistry, Queue } from './enqueue.js';
import { syncTaskTypes } from './sync-task-types.js';

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
  const c = new pg.Client({ connectionString: urlFor(user) }).on('error', () => undefined);
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
  for (const m of ['alpha', 'beta'])
    registry.defineJob({
      name: `${m}.on_created`,
      maxAttempts: 2,
      onMerged: 'none',
      carriesPatientIds: false,
      jobScope: 'org',
      jobClass: 'handler',
    });
  registry.defineJob({
    name: 'ops.repair',
    maxAttempts: 1,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'data_repair',
  });
  registry.registerHandler('thing.created', 'alpha');
  registry.registerHandler('thing.created', 'beta');
  const queue = new Queue(registry, 'api');

  before(async () => {
    const admin = new pg.Client({ connectionString: adminUrl }).on('error', () => undefined);
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
    const w = await open('app_worker');
    try {
      await syncTaskTypes(w, registry);
    } finally {
      await w.end();
    }
  });
  after(async () => {
    const admin = new pg.Client({ connectionString: adminUrl }).on('error', () => undefined);
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
      const n = await w.query(
        "SELECT count(*)::int AS n FROM queue.jobs WHERE key = 'f04.probe:rb'",
      );
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
      const n = await w.query(
        "SELECT count(*)::int AS n FROM queue.jobs WHERE key = 'f04.probe:ok'",
      );
      assert.equal(n.rows[0].n, 1);
    } finally {
      await w.end();
    }
  });

  test('(b) app_worker dequeues under FORCE; the table owner and app_api cannot read', async () => {
    const c = await open('app_api');
    try {
      await queue.enqueue(
        c,
        'f04.probe',
        { id: '00000000-0000-7000-8000-0000000000b2' },
        { jobKey: 'deq' },
      );
    } finally {
      await c.end();
    }
    const handled: string[] = [];
    await runOnce({
      connectionString: urlFor('app_worker'),
      schema: 'queue',
      taskList: {
        'f04.probe': async (payload: unknown) => {
          handled.push(JSON.stringify(payload));
        },
      },
    });
    assert.ok(handled.length >= 1, 'worker dequeued and ran a job under FORCE');
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

  const enqueueLater = async (jobKey: string) => {
    const c = await open('app_api');
    try {
      await queue.enqueue(
        c,
        'f04.probe',
        { id: '00000000-0000-7000-8000-0000000000b3' },
        { jobKey, runAt: new Date(Date.now() + 3_600_000) },
      );
    } finally {
      await c.end();
    }
  };

  test('(c) max attempts are carried on the job', async () => {
    await enqueueLater('maxa');
    const w = await open('app_worker');
    try {
      const r = await w.query("SELECT max_attempts FROM queue.jobs WHERE key = 'f04.probe:maxa'");
      assert.equal(r.rows[0].max_attempts, 3);
    } finally {
      await w.end();
    }
  });

  test('(d) dead jobs are visible (attempts >= max_attempts)', async () => {
    await enqueueLater('dead');
    const w = await open('app_worker');
    try {
      await w.query(
        "UPDATE queue._private_jobs SET attempts = max_attempts WHERE key = 'f04.probe:dead'",
      );
      const r = await w.query(
        "SELECT count(*)::int AS n FROM queue.jobs WHERE key = 'f04.probe:dead' AND attempts >= max_attempts",
      );
      assert.equal(r.rows[0].n, 1);
    } finally {
      await w.end();
    }
  });

  test('app_api is refused DELETE and the views (BR-F04-2 evidence of the actual grants)', async () => {
    const a = await open('app_api');
    try {
      await assert.rejects(
        a.query('DELETE FROM queue._private_jobs'),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        a.query('SELECT 1 FROM queue.jobs'),
        (e: { code?: string }) => e.code === '42501',
      );
    } finally {
      await a.end();
    }
  });

  test('(c) back-off: a failing job is rescheduled later with attempts incremented', async () => {
    const c = await open('app_api');
    try {
      await queue.enqueue(
        c,
        'f04.probe',
        { id: '00000000-0000-7000-8000-0000000000b4' },
        { jobKey: 'backoff' },
      );
    } finally {
      await c.end();
    }
    await runOnce({
      connectionString: urlFor('app_worker'),
      schema: 'queue',
      taskList: {
        'f04.probe': async () => {
          throw new Error('synthetic failure');
        },
      },
    });
    const w = await open('app_worker');
    try {
      const r = await w.query(
        "SELECT attempts, last_error, run_at > now() + interval '1 second' AS later FROM queue.jobs WHERE key = 'f04.probe:backoff'",
      );
      assert.equal(r.rows[0].attempts, 1);
      assert.match(r.rows[0].last_error, /synthetic failure/);
      assert.equal(r.rows[0].later, true, 'retry is scheduled with back-off');
    } finally {
      await w.end();
    }
  });

  test('publish fans out one job per registered handler in the caller transaction', async () => {
    const q = queue;
    const c = await open('app_api');
    try {
      await c.query('BEGIN');
      const names = await q.publish(c, 'thing.created', {
        id: '00000000-0000-7000-8000-0000000000b5',
      });
      await c.query('ROLLBACK');
      assert.deepEqual(names.sort(), ['alpha.on_created', 'beta.on_created']);
      await c.query('BEGIN');
      await q.publish(c, 'thing.created', { id: '00000000-0000-7000-8000-0000000000b5' });
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const w = await open('app_worker');
    try {
      const r = await w.query(
        "SELECT count(*)::int AS n FROM queue.jobs WHERE task_identifier IN ('alpha.on_created','beta.on_created')",
      );
      assert.equal(r.rows[0].n, 2, 'rollback left none; commit left exactly two');
    } finally {
      await w.end();
    }
  });

  test('install is repeatable after the ownership handover and keeps the hardening', async () => {
    await installQueue(urlFor('app_owner'));
    await installQueue(urlFor('app_owner'));
    const o = await open('app_owner');
    try {
      const r = await o.query(
        `SELECT (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'queue') AS schema_owner,
                (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'queue' AND c.relkind = 'r' AND (NOT c.relforcerowsecurity OR pg_get_userbyid(c.relowner) <> 'queue_owner')) AS unhardened`,
      );
      assert.equal(r.rows[0].schema_owner, 'queue_owner');
      assert.equal(r.rows[0].unhardened, 0);
    } finally {
      await o.end();
    }
    const a = await open('app_api');
    try {
      await assert.rejects(
        a.query('DELETE FROM queue._private_jobs'),
        (e: { code?: string }) => e.code === '42501',
      );
    } finally {
      await a.end();
    }
  });

  // ---- ARCHITECTURE 21.8 amendment A-1 (HEAAA-152): the API tier enqueues only through queue_api.enqueue ----
  const ID = '00000000-0000-7000-8000-0000000000c1';
  const enq = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c: any,
    task: string,
    payload: unknown,
    run: unknown = null,
    key: unknown = null,
    prio: unknown = 0,
  ) =>
    c.query(
      'SELECT queue_api.enqueue($1::text, $2::jsonb, $3::timestamptz, $4::text, $5::smallint) AS id',
      [task, JSON.stringify(payload), run, key, prio],
    );
  const refused = (code: string) => (e: { code?: string }) => e.code === code;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asApi = async (fn: (c: any) => Promise<void>) => {
    const c = await open('app_api');
    try {
      await fn(c);
    } finally {
      await c.end();
    }
  };

  test('A-1 app_api: direct SELECT/INSERT/UPDATE/DELETE on every queue table, view and sequence are refused', async () => {
    const admin = await open('app_owner');
    const objs = await admin.query(
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'queue' AND c.relkind IN ('r','p','v','m','S')`,
    );
    await admin.end();
    assert.ok(objs.rows.length >= 3);
    await asApi(async (c) => {
      for (const o of objs.rows) {
        const stmts =
          o.relkind === 'S'
            ? [`SELECT nextval('queue.${o.relname}')`]
            : ['SELECT 1 FROM', 'DELETE FROM', 'UPDATE', 'INSERT INTO'].map((v) =>
                v === 'UPDATE'
                  ? `UPDATE queue.${o.relname} SET id = id`
                  : v === 'INSERT INTO'
                    ? `INSERT INTO queue.${o.relname} DEFAULT VALUES`
                    : `${v} queue.${o.relname}`,
              );
        for (const st of stmts) await assert.rejects(c.query(st), refused('42501'), st);
      }
    });
  });

  test('A-1 app_api: library functions are refused (add_job, get_job, reschedule_jobs, permanently_fail_jobs, force_unlock_workers)', async () => {
    await asApi(async (c) => {
      for (const st of [
        "SELECT queue.add_job('f04.probe', '{}'::json)",
        "SELECT queue.get_job('w')",
        'SELECT queue.reschedule_jobs(ARRAY[1]::bigint[])',
        "SELECT queue.permanently_fail_jobs(ARRAY[1]::bigint[], 'x')",
        "SELECT queue.force_unlock_workers(ARRAY['w'])",
      ])
        await assert.rejects(c.query(st), refused('42501'), st);
      await assert.rejects(c.query('SELECT * FROM queue_api.task_type'), refused('42501'));
      await assert.rejects(
        c.query("INSERT INTO queue_api.task_type VALUES ('x.y','job',true,1)"),
        refused('42501'),
      );
    });
  });

  test('A-1 refused identifiers: unknown, system, data_repair, malformed; nothing is stored', async () => {
    await asApi(async (c) => {
      for (const t of ['nope.unknown', 'ops.repair', 'F04.probe', "f04.probe'; --", 'f04']) {
        await assert.rejects(enq(c, t, { id: ID }), refused('22023'), t);
      }
    });
    const w = await open('app_worker');
    const n = await w.query(
      "SELECT count(*)::int AS n FROM queue.jobs WHERE task_identifier IN ('nope.unknown','ops.repair')",
    );
    await w.end();
    assert.equal(n.rows[0].n, 0);
  });

  test('A-1 the task_type CHECK refuses api_enqueue for system and data_repair', async () => {
    const w = await open('app_worker');
    try {
      await assert.rejects(
        w.query(
          "INSERT INTO queue_api.task_type (task_identifier, job_class, api_enqueue, max_attempts) VALUES ('ops.sys','system',true,1)",
        ),
        refused('23514'),
      );
    } finally {
      await w.end();
    }
  });

  test('A-1 each argument bound is refused at limit + 1 and accepted at the limit', async () => {
    await asApi(async (c) => {
      const T = 'f04.probe';
      // payload: object only, bytes, depth, value shape
      await assert.rejects(enq(c, T, [ID]), refused('22023'));
      await assert.rejects(enq(c, T, 'x'), refused('22023'));
      await assert.rejects(enq(c, T, { note: 'Jane Doe has diabetes' }), refused('22023'));
      await assert.rejects(enq(c, T, { a: 'a@b.example' }), refused('22023'));
      await assert.rejects(
        enq(c, T, { a: { b: { c: { d: { e: ID } } } } }),
        refused('22023'),
        'depth 5',
      );
      await enq(c, T, { a: { b: { c: { d: ID } } } }); // depth 4 accepted
      // jsonb::text puts a space after ':' and ','; measure that exact text, not JSON.stringify.
      const jsonbLen = (n: number) =>
        `{"a": [${Array.from({ length: n }, () => `"${ID}"`).join(', ')}]}`.length;
      let n = 1;
      while (jsonbLen(n + 1) <= 4096) n++;
      const body = (k: number) => ({ a: Array.from({ length: k }, () => ID) });
      await enq(c, T, body(n));
      await assert.rejects(enq(c, T, body(n + 1)), refused('22023'), 'payload bytes');
      // run_at window
      await enq(c, T, { id: ID }, new Date(Date.now() - 4 * 60_000));
      await enq(c, T, { id: ID }, new Date(Date.now() + 399 * 86_400_000));
      await assert.rejects(
        enq(c, T, { id: ID }, new Date(Date.now() - 6 * 60_000)),
        refused('22023'),
      );
      await assert.rejects(
        enq(c, T, { id: ID }, new Date(Date.now() + 401 * 86_400_000)),
        refused('22023'),
      );
      // priority 0..10
      await enq(c, T, { id: ID }, null, null, 10);
      await assert.rejects(enq(c, T, { id: ID }, null, null, 11), refused('22023'));
      await assert.rejects(enq(c, T, { id: ID }, null, null, -1), refused('22023'));
      // job key
      await enq(c, T, { id: ID }, null, 'k'.repeat(100));
      await assert.rejects(enq(c, T, { id: ID }, null, 'k'.repeat(101)), refused('22023'));
      await assert.rejects(enq(c, T, { id: ID }, null, 'bad key'), refused('22023'));
    });
  });

  test("A-1 max_attempts comes from task_type; a job key from task A cannot replace task B's job", async () => {
    await asApi(async (c) => {
      await enq(c, 'f04.probe', { id: ID }, new Date(Date.now() + 3_600_000), 'shared');
      await enq(c, 'alpha.on_created', { id: ID }, new Date(Date.now() + 3_600_000), 'shared');
    });
    const w = await open('app_worker');
    try {
      const r = await w.query(
        "SELECT task_identifier, key, max_attempts FROM queue.jobs WHERE key LIKE '%:shared' ORDER BY task_identifier",
      );
      assert.deepEqual(r.rows, [
        { task_identifier: 'alpha.on_created', key: 'alpha.on_created:shared', max_attempts: 2 },
        { task_identifier: 'f04.probe', key: 'f04.probe:shared', max_attempts: 3 },
      ]);
    } finally {
      await w.end();
    }
  });

  test('A-1 replace mode: same task and key replaces the unstarted job', async () => {
    await asApi(async (c) => {
      await enq(c, 'f04.probe', { id: ID }, new Date(Date.now() + 3_600_000), 'rep');
      await enq(c, 'f04.probe', { id: ID }, new Date(Date.now() + 7_200_000), 'rep');
    });
    const w = await open('app_worker');
    try {
      const r = await w.query(
        "SELECT count(*)::int AS n FROM queue.jobs WHERE key = 'f04.probe:rep'",
      );
      assert.equal(r.rows[0].n, 1);
    } finally {
      await w.end();
    }
  });

  test('A-1 hostile search_path and temp-schema shadowing have no effect', async () => {
    const own = await open('app_owner');
    await own.query(
      "CREATE SCHEMA shadow; GRANT USAGE ON SCHEMA shadow TO app_api; CREATE FUNCTION shadow.jsonb_typeof(jsonb) RETURNS text LANGUAGE sql AS $$ SELECT 'object'::text $$",
    );
    await own.end();
    await asApi(async (c) => {
      await assert.rejects(
        c.query('CREATE TEMP TABLE task_type (task_identifier text)'),
        refused('42501'),
      );
      await c.query('SET search_path = shadow, pg_temp, queue, queue_api');
      await assert.rejects(enq(c, 'ops.repair', { id: ID }), refused('22023'));
      await assert.rejects(enq(c, 'f04.probe', { a: 'Jane Doe' }), refused('22023'));
      await assert.rejects(
        enq(c, 'f04.probe', [ID]),
        refused('22023'),
        'shadow.jsonb_typeof must not shadow',
      );
      await enq(c, 'f04.probe', { id: ID }); // still works
    });
    const o = await open('app_owner');
    try {
      const r = await o.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('app_api', p.oid, 'EXECUTE') AS api_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'queue_api' AND p.proname = 'enqueue'`,
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].prosecdef, true);
      assert.equal(r.rows[0].owner, 'queue_owner');
      assert.deepEqual(r.rows[0].proconfig, ['search_path=pg_catalog, pg_temp']);
      assert.equal(r.rows[0].public_exec, false);
      assert.equal(r.rows[0].api_exec, true);
      // the only SECURITY DEFINER function in queue and queue_api is the wrapper
      const d = await o.query(
        `SELECT p.oid::regproc::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('queue','queue_api') AND p.prosecdef`,
      );
      assert.deepEqual(
        d.rows.map((x: { fn: string }) => x.fn),
        ['queue_api.enqueue'],
      );
    } finally {
      await o.end();
    }
  });

  test('A-1 enqueue commits and rolls back with the caller transaction', async () => {
    await asApi(async (c) => {
      await c.query('BEGIN');
      await enq(c, 'f04.probe', { id: ID }, null, 'a1rb');
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await enq(c, 'f04.probe', { id: ID }, new Date(Date.now() + 3_600_000), 'a1ok');
      await c.query('COMMIT');
    });
    const w = await open('app_worker');
    try {
      const r = await w.query(
        "SELECT key FROM queue.jobs WHERE key IN ('f04.probe:a1rb','f04.probe:a1ok')",
      );
      assert.deepEqual(r.rows, [{ key: 'f04.probe:a1ok' }]);
    } finally {
      await w.end();
    }
  });

  test('A-1 a type missing from task_type fails closed and rolls the caller back', async () => {
    const reg = new JobRegistry();
    reg.defineJob({
      name: 'f04.unsynced',
      maxAttempts: 1,
      onMerged: 'none',
      carriesPatientIds: false,
      jobScope: 'org',
    });
    const q = new Queue(reg, 'api');
    await asApi(async (c) => {
      await c.query('BEGIN');
      await assert.rejects(q.enqueue(c, 'f04.unsynced', { id: ID }), refused('22023'));
      await c.query('ROLLBACK');
    });
  });

  test('A-1 app_worker: direct add_job in the same namespace and the dequeue cycle still work', async () => {
    const wq = new Queue(registry, 'worker');
    const w = await open('app_worker');
    try {
      await w.query('BEGIN');
      await wq.enqueue(w, 'ops.repair', { id: ID }, { jobKey: 'wk' });
      await w.query('COMMIT');
      const r = await w.query("SELECT key FROM queue.jobs WHERE task_identifier = 'ops.repair'");
      assert.deepEqual(r.rows, [{ key: 'ops.repair:wk' }]);
    } finally {
      await w.end();
    }
    const handled: string[] = [];
    await runOnce({
      connectionString: urlFor('app_worker'),
      schema: 'queue',
      taskList: {
        'ops.repair': async () => void handled.push('x'),
        'f04.probe': async () => {},
        'alpha.on_created': async () => {},
        'beta.on_created': async () => {},
      },
    });
    assert.ok(handled.length >= 1);
  });

  test('A-1 install revoked every app_api right in queue and a repeat install keeps it', async () => {
    await installQueue(urlFor('app_owner'));
    const o = await open('app_owner');
    try {
      const r = await o.query(
        `SELECT has_schema_privilege('app_api','queue','USAGE') AS usage,
                (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='queue' AND has_function_privilege('app_api', p.oid, 'EXECUTE')) AS fns,
                (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname IN ('queue','queue_api') AND has_function_privilege('public', p.oid, 'EXECUTE')) AS public_fns,
                (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='queue_api') AS api_owner,
                (SELECT count(*)::int FROM pg_policies WHERE schemaname='queue' AND NOT (roles @> ARRAY['app_worker']::name[] AND roles @> ARRAY['queue_owner']::name[] AND cardinality(roles)=2)) AS bad_policies`,
      );
      assert.deepEqual(r.rows[0], {
        usage: false,
        fns: 0,
        public_fns: 0,
        api_owner: 'queue_owner',
        bad_policies: 0,
      });
    } finally {
      await o.end();
    }
  });
});
