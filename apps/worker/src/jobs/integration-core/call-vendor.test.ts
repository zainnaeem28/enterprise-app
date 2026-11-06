// Unit tests of the vendor call wrapper with a recording fake database (no PostgreSQL). The real-database behaviour
// (RLS, grants, partitions, the pending->final guard) is in integration-core.dbtest.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { KernelDb } from '@ehr/kernel';
import { AdapterRegistry, type VendorAdapter, type VendorCall } from './adapters.js';
import { VendorGateway } from './call-vendor.js';
import { CircuitBreakers } from './circuit.js';
import {
  AdapterFailure,
  IntegrationUsageError,
  VendorRejectedError,
  VendorUnavailableError,
} from './errors.js';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const CONN = '00000000-0000-7000-8000-0000000000b1';

interface Logged {
  op: string;
  outcome: string;
  attempt: number;
  errorClass: unknown;
  corrType: unknown;
  httpStatus: unknown;
  vendorRef: unknown;
  id: string;
}

function fakeDb(connection: { enabled: boolean } | null = { enabled: true }, failInsert = false) {
  const rows: Logged[] = [];
  const db = {
    withScope: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: (sql: string, p: unknown[] = []) => {
          if (sql.includes('FROM integration_core.connection'))
            return Promise.resolve({
              rows:
                connection === null
                  ? []
                  : [
                      {
                        id: CONN,
                        kind: 'sms',
                        vendor: 'testsms',
                        settings: { region: 'x' },
                        enabled: connection.enabled,
                      },
                    ],
            });
          if (sql.startsWith('INSERT INTO integration_core.outbound_call')) {
            if (failInsert)
              return Promise.reject(Object.assign(new Error('db down'), { code: '08006' }));
            rows.push({
              id: String(p[0]),
              op: String(p[3]),
              corrType: p[4],
              attempt: Number(p[6]),
              outcome: String(p[7]),
              errorClass: p[8],
              httpStatus: p[9],
              vendorRef: p[11],
            });
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes('UPDATE integration_core.outbound_call')) {
            const r = rows.find((x) => x.id === p[0]);
            assert.ok(r, 'update of a pending row that exists');
            assert.equal(r.outcome, 'pending');
            r.outcome = String(p[1]);
            r.errorClass = p[2];
            r.httpStatus = p[3];
            return Promise.resolve({ rows: [] });
          }
          throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
        },
      }),
  } as unknown as KernelDb;
  return { db, rows };
}

function adapter(
  script: (
    n: number,
    req: VendorCall,
  ) => Promise<{ data: unknown; httpStatus?: number; vendorRef?: string }>,
  opts: Partial<VendorAdapter<'sms'>> = {},
): VendorAdapter<'sms'> & { calls: VendorCall[] } {
  const calls: VendorCall[] = [];
  return {
    kind: 'sms',
    supportsIdempotencyToken: true,
    calls,
    call: (req) => {
      calls.push(req);
      return script(calls.length, req);
    },
    healthCheck: () => Promise.resolve({ ok: true }),
    ...opts,
  };
}

function gateway(
  a: VendorAdapter<'sms'> | undefined,
  db: KernelDb,
  o: {
    now?: () => number;
    circuits?: CircuitBreakers;
    maxAttempts?: number;
    timeoutMs?: number;
  } = {},
) {
  const adapters = new AdapterRegistry();
  if (a) adapters.register(a);
  const sleeps: number[] = [];
  const gw = new VendorGateway({
    db,
    orgId: ORG,
    adapters,
    credentials: () => ({ get: () => Promise.resolve('x') }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }),
    ...(o.timeoutMs === undefined ? {} : { defaultTimeoutMs: o.timeoutMs }),
    ...(o.circuits === undefined ? {} : { circuits: o.circuits }),
  });
  return { gw, sleeps };
}

describe('callVendor (34.2, 34.3)', () => {
  test('a good call is recorded once with IDs, outcome, status and latency only', async () => {
    const { db, rows } = fakeDb();
    const a = adapter(() =>
      Promise.resolve({
        data: { secretish: 'response body' },
        httpStatus: 200,
        vendorRef: 'msg-1',
      }),
    );
    const { gw } = gateway(a, db);
    const r = await gw.callVendor(
      'sms',
      'send',
      { to: 'recipient' },
      { type: 'reservation', id: '00000000-0000-7000-8000-0000000000c1' },
    );
    assert.deepEqual(r.data, { secretish: 'response body' });
    assert.equal(rows.length, 1);
    assert.deepEqual(
      {
        op: rows[0]?.op,
        outcome: rows[0]?.outcome,
        attempt: rows[0]?.attempt,
        httpStatus: rows[0]?.httpStatus,
        vendorRef: rows[0]?.vendorRef,
      },
      { op: 'send', outcome: 'ok', attempt: 1, httpStatus: 200, vendorRef: 'msg-1' },
    );
    assert.equal(JSON.stringify(rows).includes('recipient'), false, 'no argument reaches the log');
    assert.equal(
      JSON.stringify(rows).includes('response body'),
      false,
      'no response reaches the log',
    );
  });

  test('the same idempotency token is used on every attempt of one call', async () => {
    const { db } = fakeDb();
    const a = adapter((n) =>
      n < 3 ? Promise.reject(new AdapterFailure(true, 503)) : Promise.resolve({ data: 1 }),
    );
    const { gw } = gateway(a, db);
    await gw.callVendor('sms', 'send', {}, {});
    assert.equal(a.calls.length, 3);
    assert.equal(new Set(a.calls.map((c) => c.idempotencyToken)).size, 1);
  });

  test('retries with exponential back-off and logs every attempt; exhaustion is 503 integration.vendor_unavailable', async () => {
    const { db, rows } = fakeDb();
    const a = adapter(() => Promise.reject(new AdapterFailure(true, 503)));
    const { gw, sleeps } = gateway(a, db, { maxAttempts: 4 });
    await assert.rejects(gw.callVendor('sms', 'send', {}, {}), (e: VendorUnavailableError) => {
      assert.equal(e.code, 'integration.vendor_unavailable');
      assert.equal(e.status, 503);
      assert.equal(e.retryable, true);
      return true;
    });
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((r) => r.attempt),
      [1, 2, 3, 4],
    );
    assert.ok(rows.every((r) => r.outcome === 'error' && r.httpStatus === 503));
    // random() = 0.5: delay = ceiling * 0.75 with ceilings 200, 400, 800
    assert.deepEqual(sleeps, [150, 300, 600]);
  });

  test('a vendor 4xx is not retried, is 502 integration.vendor_rejected and does not count against the circuit', async () => {
    const { db, rows } = fakeDb();
    const a = adapter(() => Promise.reject(new AdapterFailure(false, 422)));
    const circuits = new CircuitBreakers();
    const { gw } = gateway(a, db, { circuits });
    for (let i = 0; i < 8; i++)
      await assert.rejects(
        gw.callVendor('sms', 'send', {}, {}),
        (e: VendorRejectedError) => e.code === 'integration.vendor_rejected' && e.status === 502,
      );
    assert.equal(a.calls.length, 8, 'no retries');
    assert.equal(rows.length, 8);
    assert.equal(circuits.state(CONN), 'closed');
  });

  test('a timeout is enforced, aborts the adapter signal, and is logged as timeout', async () => {
    const { db, rows } = fakeDb();
    let aborted = false;
    const a = adapter(
      (_n, req) =>
        new Promise((_, rej) => {
          req.signal.addEventListener('abort', () => {
            aborted = true;
            rej(new Error('aborted'));
          });
        }),
      { timeoutMs: 20 },
    );
    const { gw } = gateway(a, db, { maxAttempts: 2 });
    await assert.rejects(
      gw.callVendor('sms', 'send', {}, {}),
      (e: VendorUnavailableError) => e.reason === 'timeout',
    );
    assert.ok(aborted);
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ['timeout', 'timeout'],
    );
  });

  test('after the circuit opens, a call fails fast: adapter not called, attempt logged as rejected/circuit_open', async () => {
    const { db, rows } = fakeDb();
    const a = adapter(() => Promise.reject(new AdapterFailure(true, 500)));
    const { gw } = gateway(a, db, { maxAttempts: 1 });
    for (let i = 0; i < 5; i++) await assert.rejects(gw.callVendor('sms', 'send', {}, {}));
    const callsBefore = a.calls.length;
    await assert.rejects(
      gw.callVendor('sms', 'send', {}, {}),
      (e: VendorUnavailableError) => e.reason === 'circuit_open',
    );
    assert.equal(a.calls.length, callsBefore);
    assert.equal(rows.at(-1)?.outcome, 'rejected');
    assert.equal(rows.at(-1)?.errorClass, 'circuit_open');
  });

  test('disabled connection: refused before it leaves and logged as rejected/disabled', async () => {
    const { db, rows } = fakeDb({ enabled: false });
    const a = adapter(() => Promise.resolve({ data: 1 }));
    const { gw } = gateway(a, db);
    await assert.rejects(
      gw.callVendor('sms', 'send', {}, {}),
      (e: VendorUnavailableError) => e.reason === 'disabled',
    );
    assert.equal(a.calls.length, 0);
    assert.deepEqual([rows[0]?.outcome, rows[0]?.errorClass], ['rejected', 'disabled']);
  });

  test('no connection row: fails without calling anything; no adapter installed: rejected/no_adapter', async () => {
    const none = fakeDb(null);
    const a = adapter(() => Promise.resolve({ data: 1 }));
    await assert.rejects(
      gateway(a, none.db).gw.callVendor('sms', 'send', {}, {}),
      VendorUnavailableError,
    );
    assert.equal(a.calls.length, 0);
    const noAdapter = fakeDb();
    await assert.rejects(
      gateway(undefined, noAdapter.db).gw.callVendor('sms', 'send', {}, {}),
      VendorUnavailableError,
    );
    assert.equal(noAdapter.rows[0]?.errorClass, 'no_adapter');
  });

  test('a vendor without an idempotency token gets a pending row first; after a timeout the vendor is asked before a repeat (34.3)', async () => {
    const { db, rows } = fakeDb();
    let findCalls = 0;
    const t = adapter(
      (n, req) =>
        n === 1
          ? new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('x'))))
          : Promise.resolve({ data: 'created again' }),
      {
        supportsIdempotencyToken: false,
        timeoutMs: 10,
        find: () => {
          findCalls++;
          return Promise.resolve({ data: 'already there', vendorRef: 'v-9' });
        },
      },
    );
    const { gw } = gateway(t, db);
    const r = await gw.callVendor('sms', 'send', {}, { type: 'reservation' });
    assert.equal(findCalls, 1);
    assert.equal(r.data, 'already there');
    assert.equal(t.calls.length, 1, 'the object existed, so the call was not repeated');
    assert.deepEqual(
      rows.map((x) => x.outcome),
      ['timeout', 'ok'],
      'pending rows moved to their final outcome',
    );
  });

  test('a failed log write after a successful call does not undo it and is reported', async () => {
    const { db } = fakeDb({ enabled: true }, true);
    const a = adapter(() => Promise.resolve({ data: 'fine' }));
    const adapters = new AdapterRegistry();
    adapters.register(a);
    const reported: string[] = [];
    const gw = new VendorGateway({
      db,
      orgId: ORG,
      adapters,
      credentials: () => ({ get: () => Promise.resolve('x') }),
      onRecordFailure: (i) => reported.push(i.operation),
    });
    const r = await gw.callVendor('sms', 'send', {}, {});
    assert.equal(r.data, 'fine');
    assert.deepEqual(reported, ['send']);
  });

  test('unknown kind, unknown operation and bad correlation are refused before anything happens', async () => {
    const { db } = fakeDb();
    const a = adapter(() => Promise.resolve({ data: 1 }));
    const { gw } = gateway(a, db);
    for (const call of [
      () => gw.callVendor('fax', 'send'),
      () => gw.callVendor('sms', 'explode'),
      () => gw.callVendor('sms', 'send', {}, { id: 'not-a-uuid' }),
      () => gw.callVendor('sms', 'send', {}, { type: 'Bad Type' }),
      () => gw.callVendor('sms', 'send', {}, { idempotencyToken: 'x' }),
    ])
      await assert.rejects(call(), IntegrationUsageError);
    assert.equal(a.calls.length, 0);
  });

  test('an adapter exception with a vendor message never leaks into the error or the log', async () => {
    const { db, rows } = fakeDb();
    const a = adapter(() =>
      Promise.reject(new Error('Bearer sk_live_SUPERSECRET rejected by vendor')),
    );
    const { gw } = gateway(a, db, { maxAttempts: 1 });
    await assert.rejects(gw.callVendor('sms', 'send', {}, {}), (e: Error) => {
      assert.equal(
        JSON.stringify([e.message, e.stack?.split('\n')[0]]).includes('SUPERSECRET'),
        false,
      );
      return true;
    });
    assert.equal(JSON.stringify(rows).includes('SUPERSECRET'), false);
    assert.equal(rows[0]?.errorClass, 'adapter_exception');
  });
});
