// Statement-level tests with a scripted client. They show the control flow only: that two requests produce one
// write and one replay under real concurrency is proved by db/tools tests on PostgreSQL 17, not here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResult } from '../db.js';
import { Tx } from '../scope/with-scope.js';
import { IdempotencyConflictError, beginIdempotent, completeIdempotent } from './store.js';

const hash = Buffer.alloc(32, 1);
function tx(script: (sql: string) => QueryResult): Tx {
  return new Tx({ query: async (sql: string) => script(sql), release() {} }, { audience: 'staff' });
}

test('first request inserts and proceeds as new', async () => {
  const r = await beginIdempotent(
    tx(() => ({ rows: [{ key: 'k' }] })),
    '/holds',
    'k',
    hash,
  );
  assert.equal(r.kind, 'new');
});

test('duplicate with the same hash replays the stored response', async () => {
  const t = tx((sql) =>
    sql.includes('INSERT')
      ? { rows: [] }
      : {
          rows: [
            {
              request_hash: hash,
              state: 'completed',
              response_status: 201,
              response_body: Buffer.from('{"id":1}'),
              response_location: '/holds/1',
            },
          ],
        },
  );
  const r = await beginIdempotent(t, '/holds', 'k', hash);
  assert.ok(r.kind === 'replay');
  assert.equal(r.response.status, 201);
  assert.equal(r.reread, false);
});

test('a body over 64 KB is replayed by re-reading the resource', async () => {
  const t = tx((sql) =>
    sql.includes('INSERT')
      ? { rows: [] }
      : {
          rows: [
            {
              request_hash: hash,
              state: 'completed',
              response_status: 201,
              response_body: null,
              response_location: null,
            },
          ],
        },
  );
  const r = await beginIdempotent(t, '/holds', 'k', hash);
  assert.ok(r.kind === 'replay' && r.reread);
});

test('same key with a different hash is 409 kernel.idempotency_conflict', async () => {
  const t = tx((sql) =>
    sql.includes('INSERT')
      ? { rows: [] }
      : { rows: [{ request_hash: Buffer.alloc(32, 2), state: 'completed' }] },
  );
  await assert.rejects(
    beginIdempotent(t, '/holds', 'k', hash),
    (e: unknown) =>
      e instanceof IdempotencyConflictError &&
      e.code === 'kernel.idempotency_conflict' &&
      e.status === 409,
  );
});

test('completion drops a body over 64 KB', async () => {
  let params: unknown[] = [];
  const t = new Tx(
    {
      query: async (_s: string, p?: unknown[]) => ((params = p ?? []), { rows: [] }),
      release() {},
    },
    { audience: 'staff' },
  );
  await completeIdempotent(t, '/holds', 'k', { status: 200, body: Buffer.alloc(64 * 1024 + 1) });
  assert.equal(params[3], null);
  await completeIdempotent(t, '/holds', 'k', { status: 200, body: Buffer.from('x') });
  assert.ok(Buffer.isBuffer(params[3]));
});
