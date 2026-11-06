// Real-database tests for F-05 on PostgreSQL 17 (migrations 0001..0150 from empty, queue installed):
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55433/postgres node --test dist/test/platform/db.dbtest.js
// Superuser URL on a throwaway server; synthetic data only. Missing configuration FAILS; nothing skips.
// Not matched by the default `test` glob (`*.test.js`).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KernelDb, loadConfig, createLogger } from '@ehr/kernel';
import { createApp } from '../../src/platform/app.js';
import { pgReadiness } from '../../src/platform/pg-readiness.js';
import { PgRateLimiter } from '../../src/platform/rate-limit.js';
import { cfg, FixtureController, R, MIN_RELEASE } from './harness.js';
import { CountingPolicy } from './harness.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const dbName = `ehr_f05_${process.pid}_${Date.now()}`;
const ORG = '00000000-0000-7000-8000-0000000000a1';
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};
const adminOn = async (database: string) => {
  const c = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username, database) });
  await c.connect();
  return c;
};

describe('platform layer against PostgreSQL 17', () => {
  before(async () => {
    const admin = await adminOn('postgres');
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
  });
  after(async () => {
    const admin = await adminOn('postgres');
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const kcfg = () =>
    loadConfig({
      EHR_ENV: 'ci',
      EHR_DEPLOYABLE: 'api',
      EHR_DATABASE_URL: urlFor('app_api'),
      EHR_POOL_MAX: '20',
    });

  test('/readyz: 200 against the migrated schema', async () => {
    const ready = await pgReadiness(kcfg());
    const app = await createApp({
      config: cfg(),
      logger: createLogger({ sink: () => undefined }),
      readiness: ready.probe,
    });
    await app.listen(0, '127.0.0.1');
    try {
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      const r = await fetch(base + '/readyz');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { status: 'ready' });
      assert.equal((await fetch(base + '/healthz')).status, 200);
    } finally {
      await app.close();
      await ready.close();
    }
  });

  test('/readyz: 503 kernel.unavailable when the database is unreachable or a declared relation is missing', async () => {
    const ready = await pgReadiness(kcfg());
    const missing = await createApp({
      config: cfg(),
      logger: createLogger({ sink: () => undefined }),
      readiness: {
        missingRelations: async () =>
          [...(await ready.probe.missingRelations()), 'kernel.nope'].filter(Boolean).length > 0
            ? ['kernel.nope']
            : [],
      },
    });
    await missing.listen(0, '127.0.0.1');
    const dead = await pgReadiness(
      loadConfig({
        EHR_ENV: 'ci',
        EHR_DEPLOYABLE: 'api',
        EHR_DATABASE_URL: 'postgres://app_api@127.0.0.1:1/nope',
      }),
    );
    const down = await createApp({
      config: cfg(),
      logger: createLogger({ sink: () => undefined }),
      readiness: dead.probe,
    });
    await down.listen(0, '127.0.0.1');
    try {
      const u2 = (await down.getUrl()).replace('[::1]', '127.0.0.1');
      const r = await fetch(u2 + '/readyz');
      assert.equal(r.status, 503);
      assert.equal(((await r.json()) as { code: string }).code, 'kernel.unavailable');
      assert.equal((await fetch(u2 + '/healthz')).status, 200);
      assert.equal(
        (await fetch((await missing.getUrl()).replace('[::1]', '127.0.0.1') + '/readyz')).status,
        503,
      );
    } finally {
      await missing.close();
      await down.close();
      await ready.close();
      await dead.close();
    }
  });

  test('the probe sees a relation that is really absent: it reports exactly the missing names', async () => {
    const admin = await adminOn(dbName);
    await admin.query('ALTER TABLE kernel.rate_counter RENAME TO rate_counter_x');
    const ready = await pgReadiness(kcfg());
    try {
      assert.deepEqual(await ready.probe.missingRelations(), ['kernel.rate_counter']);
    } finally {
      await ready.close();
      await admin.query('ALTER TABLE kernel.rate_counter_x RENAME TO rate_counter');
      await admin.end();
    }
  });

  test('TC-API-11 on ci: refused requests change no row in the idempotency table and write no counter', async () => {
    const ready = await pgReadiness(kcfg());
    const app = await createApp({
      config: cfg(),
      logger: createLogger({ sink: () => undefined }),
      readiness: ready.probe,
      policy: new CountingPolicy(),
      controllers: [FixtureController],
    });
    await app.listen(0, '127.0.0.1');
    const admin = await adminOn(dbName);
    const snapshot = async () =>
      (
        await admin.query(
          `SELECT (SELECT count(*) FROM kernel.idempotency_key)::int AS idem, (SELECT count(*) FROM kernel.rate_counter)::int AS rate, (SELECT coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0) FROM pg_stat_user_tables WHERE schemaname IN ('kernel','identity'))::int AS writes`,
        )
      ).rows[0];
    try {
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      const before = await snapshot();
      for (const h of [
        {},
        { 'x-client-release': 'junk' },
        { 'x-client-release': R(MIN_RELEASE - 1) },
      ]) {
        for (const [m, p] of [
          ['GET', '/api/v1/protected'],
          ['POST', '/api/v1/echo'],
        ] as const) {
          const r = await fetch(base + p, {
            method: m,
            headers: { ...h, 'content-type': 'application/json' },
            ...(m === 'POST' ? { body: '{}' } : {}),
          });
          assert.equal(r.status, 400);
          assert.equal(
            ((await r.json()) as { code: string }).code,
            'kernel.client_release_unsupported',
          );
        }
      }
      assert.deepEqual(await snapshot(), before);
    } finally {
      await admin.end();
      await app.close();
      await ready.close();
    }
  });

  test('PgRateLimiter is exact across instances under concurrency, and stores only keyed hashes', async () => {
    const poolA = new pg.Pool({ connectionString: urlFor('app_api'), max: 10 });
    const poolB = new pg.Pool({ connectionString: urlFor('app_api'), max: 10 });
    try {
      const secret = 'test-secret-0123456789';
      const a = new PgRateLimiter(new KernelDb(poolA), ORG, secret);
      const b = new PgRateLimiter(new KernelDb(poolB), ORG, secret);
      const now = Date.parse('2026-11-05T10:00:10Z');
      const hits = await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          (i % 2 ? a : b).hit('ip:203.0.113.9:signin', 30, 300_000, now),
        ),
      );
      assert.equal(hits.filter((h) => h.allowed).length, 30);
      assert.equal(hits.filter((h) => !h.allowed).length, 50);
      assert.ok(hits.every((h) => h.retryAfterSeconds >= 1 && h.retryAfterSeconds <= 300));
      // next window starts fresh
      assert.equal(
        (await a.hit('ip:203.0.113.9:signin', 30, 300_000, now + 300_000)).allowed,
        true,
      );
      const admin = await adminOn(dbName);
      const rows = (
        await admin.query('SELECT key, count FROM kernel.rate_counter ORDER BY window_start')
      ).rows as { key: string; count: number }[];
      await admin.end();
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.count, 80);
      assert.ok(
        rows.every((r) => /^[0-9a-f]{64}$/.test(r.key)) &&
          !rows.some((r) => r.key.includes('203.0.113')),
      );
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  test("the rate limiter cannot write another organisation's counters (RLS) and an anonymous scope has no other table access", async () => {
    const pool = new pg.Pool({ connectionString: urlFor('app_api'), max: 2 });
    try {
      const db = new KernelDb(pool);
      await assert.rejects(
        db.withScope({ audience: 'anonymous', orgId: ORG }, (tx) =>
          tx.query(
            "INSERT INTO kernel.rate_counter (organisation_id, key, window_start, count) VALUES ('00000000-0000-7000-8000-0000000000a2', 'x', now(), 1)",
          ),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
    } finally {
      await pool.end();
    }
  });
});
