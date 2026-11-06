import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClientLike, PoolLike, QueryResult } from '../db.js';
import { KernelDb, LockOrderError } from './with-scope.js';
import { ScopeError, SETTING_NAMES, buildScopeStatement } from './settings.js';

const ORG = '0192e0a0-0000-7000-8000-000000000001';
const P1 = '0192e0a0-0000-7000-8000-0000000000b2';
const P2 = '0192e0a0-0000-7000-8000-0000000000a1';

type Script = (sql: string, params: unknown[] | undefined, n: number) => QueryResult | Error;

function fakePool(script: Script = () => ({ rows: [] })): {
  pool: PoolLike;
  log: string[];
  released: (Error | undefined)[];
} {
  const log: string[] = [];
  const released: (Error | undefined)[] = [];
  let n = 0;
  const pool: PoolLike = {
    async connect(): Promise<PoolClientLike> {
      return {
        async query(sql: string, params?: unknown[]): Promise<QueryResult> {
          log.push(sql.trim().split(',')[0]!);
          const r = script(sql, params, n++);
          if (r instanceof Error) throw r;
          return r;
        },
        release(e?: Error | boolean): void {
          released.push(e instanceof Error ? e : undefined);
        },
      };
    },
  };
  return { pool, log, released };
}

test('scope statement sets every 21.3 setting in one statement, transaction-local, unset ones empty', () => {
  const { sql, params } = buildScopeStatement({
    audience: 'staff',
    orgId: ORG,
    patientIds: [P1, P2],
    realm: 'google',
  });
  assert.equal((sql.match(/set_config\(/g) ?? []).length, SETTING_NAMES.length);
  assert.ok(
    sql
      .split('set_config(')
      .slice(1)
      .every((p) => /, true\)/.test(p)),
  );
  assert.equal(params[SETTING_NAMES.indexOf('app.patient_ids')], `${P1},${P2}`);
  assert.equal(params[SETTING_NAMES.indexOf('app.principal_id')], '');
  assert.equal(params.length, SETTING_NAMES.length);
});

test('scope values are validated: no SQL or list injection through a setting', () => {
  assert.throws(
    () => buildScopeStatement({ audience: 'staff', orgId: `${ORG}'; DROP` }),
    ScopeError,
  );
  assert.throws(
    () => buildScopeStatement({ audience: 'staff', patientIds: [`${P1},${P2}`] }),
    ScopeError,
  );
  assert.throws(() => buildScopeStatement({ audience: "staff'" as never }), ScopeError);
});

test('withScope: BEGIN, scope, work, COMMIT; handle is dead afterwards', async () => {
  const { pool, log, released } = fakePool();
  const db = new KernelDb(pool);
  const tx = await db.withScope({ audience: 'staff', orgId: ORG }, async (t) => {
    await t.query('SELECT 1');
    return t;
  });
  assert.deepEqual(log, ['BEGIN', "SELECT set_config('app.audience'", 'SELECT 1', 'COMMIT']);
  assert.deepEqual(released, [undefined]);
  assert.throws(() => tx.query('SELECT 1'), LockOrderError);
});

test('withScope rolls back on error and rethrows', async () => {
  const { pool, log } = fakePool();
  await assert.rejects(
    new KernelDb(pool).withScope({ audience: 'staff', orgId: ORG }, () =>
      Promise.reject(new Error('x')),
    ),
    /x/,
  );
  assert.equal(log.at(-1), 'ROLLBACK');
  assert.ok(!log.includes('COMMIT'));
});

test('a failed rollback destroys the connection', async () => {
  const { pool, released } = fakePool((sql) =>
    sql === 'ROLLBACK' ? new Error('gone') : { rows: [] },
  );
  await assert.rejects(
    new KernelDb(pool).withScope({ audience: 'staff', orgId: ORG }, () =>
      Promise.reject(new Error('x')),
    ),
  );
  assert.equal(released[0]?.message, 'gone');
});

test('40P01 is retried as a whole new transaction only when idempotent, at most twice', async () => {
  let fails = 0;
  const run = async (idempotent: boolean): Promise<number> => {
    const { pool, log } = fakePool();
    await new KernelDb(pool)
      .withScope(
        { audience: 'staff', orgId: ORG },
        async () => {
          if (fails-- > 0) throw Object.assign(new Error('deadlock'), { code: '40P01' });
        },
        { idempotent, sleep: async () => {} },
      )
      .catch(() => {});
    return log.filter((l) => l === 'BEGIN').length;
  };
  fails = 1;
  assert.equal(await run(true), 2);
  fails = 5;
  assert.equal(await run(true), 3);
  fails = 5;
  assert.equal(await run(false), 1);
});

test('lockPatients sorts IDs, once only; scope-owner functions need it first and no_key_update', async () => {
  const { pool, log } = fakePool();
  await new KernelDb(pool).withScope({ audience: 'staff', orgId: ORG }, async (tx) => {
    await assert.rejects(tx.callScopeOwner('patient.begin_merge', [P1, P2]), /before lockPatients/);
    await tx.lockPatients([P1, P2, P1], 'key_share');
    await assert.rejects(tx.callScopeOwner('patient.begin_merge', [P1, P2]), /no_key_update/);
    await assert.rejects(tx.lockPatients([P1], 'key_share'), /once/);
  });
  const { pool: pool2 } = fakePool((sql, params) => {
    if (sql.includes('lock_patients')) assert.deepEqual(params, [[P2, P1], 'no_key_update']);
    return { rows: [] };
  });
  await new KernelDb(pool2).withScope({ audience: 'staff', orgId: ORG }, async (tx) => {
    await tx.lockPatients([P1, P2], 'no_key_update');
    await tx.callScopeOwner('patient.begin_merge', [P1, P2], [P1, P2]);
    await assert.rejects(
      tx.callScopeOwner('patient.begin_merge', [], ['0192e0a0-0000-7000-8000-0000000000ff']),
      /not locked/,
    );
    await assert.rejects(tx.callScopeOwner('patient.nope', []), /not a patient_scope_owner/);
  });
  assert.ok(log.length > 0);
});

test('the sign-in setter exists only on the sign-in handle and only for audience anonymous', async () => {
  const { pool, log } = fakePool();
  const db = new KernelDb(pool);
  assert.throws(
    () => db.withSignInScope({ audience: 'staff', orgId: ORG }, async () => {}),
    LockOrderError,
  );
  await db.withSignInScope({ audience: 'anonymous', orgId: ORG }, (tx) =>
    tx.setAuthIdentity({ realm: 'google', subject: 'sub-1', email: 'A@B.example' }),
  );
  assert.ok(log.includes("SELECT set_config('app.auth_realm'"));
  await db.withScope({ audience: 'staff', orgId: ORG }, async (tx) => {
    assert.equal((tx as unknown as { setAuthIdentity?: unknown }).setAuthIdentity, undefined);
  });
});
