// Real-database tests for F-04: RLS under withScope, concurrent duplicate idempotency keys.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/scope/scope.dbtest.js
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
import { KernelDb } from '../scope/with-scope.js';
import {
  beginIdempotent,
  completeIdempotent,
  IdempotencyConflictError,
} from '../idempotency/store.js';
import { requestHash } from '../idempotency/hash.js';

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

const ORG_A = '00000000-0000-7000-8000-00000000000a';
const ORG_B = '00000000-0000-7000-8000-00000000000b';
const PRINCIPAL = '00000000-0000-7000-8000-0000000000c1';
const ROUTE = '/v1/settings';
const staff = (orgId: string) =>
  ({ audience: 'staff', realm: 'admin_pool', orgId, principalId: PRINCIPAL }) as const;

describe('withScope and idempotency on PostgreSQL', () => {
  let pool: { connect(): Promise<never>; end(): Promise<void> };
  let db: KernelDb;
  let admin: { query(s: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

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
    pool = new pg.Pool({ connectionString: urlFor('app_api'), max: 4 });
    db = new KernelDb(pool as never);
    admin = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    await (admin as unknown as { connect(): Promise<void> }).connect();
  });
  after(async () => {
    await pool.end();
    await (admin as unknown as { end(): Promise<void> }).end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  const insertSetting = (
    tx: { query(s: string, p?: unknown[]): Promise<unknown> },
    org: string,
    key: string,
  ) =>
    tx.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, $2, '1', 'int')`,
      [org, key],
    );

  test('RLS under withScope: an organisation sees only its rows; a handle without scope sees none', async () => {
    await db.withScope(staff(ORG_A), (tx) => insertSetting(tx, ORG_A, 'a.key'));
    await db.withScope(staff(ORG_B), (tx) => insertSetting(tx, ORG_B, 'b.key'));
    const seenA = await db.withScope(staff(ORG_A), (tx) =>
      tx.query('SELECT key FROM kernel.setting'),
    );
    assert.deepEqual(
      seenA.rows.map((r) => r['key']),
      ['a.key'],
    );
    const none = await db.withScope({ audience: 'staff' }, (tx) =>
      tx.query('SELECT key FROM kernel.setting'),
    );
    assert.equal(none.rows.length, 0, 'missing org setting fails closed');
    await assert.rejects(
      db.withScope(staff(ORG_A), (tx) => insertSetting(tx, ORG_B, 'cross')),
      (e: { code?: string }) => e.code === '42501',
    );
  });

  test('settings do not leak past the transaction (transaction-local)', async () => {
    await db.withScope(staff(ORG_A), (tx) => tx.query('SELECT 1'));
    const c = await (
      pool as unknown as {
        connect(): Promise<{
          query(s: string): Promise<{ rows: Record<string, unknown>[] }>;
          release(): void;
        }>;
      }
    ).connect();
    try {
      const r = await c.query("SELECT current_setting('app.org_id', true) AS v");
      assert.ok(r.rows[0]!['v'] === null || r.rows[0]!['v'] === '');
    } finally {
      c.release();
    }
  });

  const hash = (body: unknown) =>
    requestHash({ method: 'POST', routeTemplate: ROUTE, pathParams: [], query: {}, body });
  const KEY = '00000000-0000-4000-8000-000000000001';

  test('concurrent duplicate keys give one write and one replay; a different body gives a conflict', async () => {
    const h = hash({ n: 1 });
    const run = () =>
      db.withScope(
        staff(ORG_A),
        async (tx) => {
          const b = await beginIdempotent(tx, ROUTE, KEY, h);
          if (b.kind === 'replay') return 'replay';
          await insertSetting(tx, ORG_A, 'idem.key');
          await new Promise((r) => setTimeout(r, 150));
          await completeIdempotent(tx, ROUTE, KEY, { status: 201, body: Buffer.from('{}') });
          return 'new';
        },
        { idempotent: true },
      );
    const results = await Promise.all([run(), run()]);
    assert.deepEqual([...results].sort(), ['new', 'replay']);
    const n = await admin.query(
      "SELECT count(*)::int AS n FROM kernel.setting WHERE key = 'idem.key'",
    );
    assert.equal(n.rows[0]!['n'], 1, 'one write');
    await assert.rejects(
      db.withScope(staff(ORG_A), (tx) => beginIdempotent(tx, ROUTE, KEY, hash({ n: 2 }))),
      IdempotencyConflictError,
    );
  });
});
