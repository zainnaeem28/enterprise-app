// Real-database tests for BE-02 (integration-core, worker side) on PostgreSQL 17 with the real roles, migrations, queue
// and the graphile-worker runner: the vendor call wrapper and its call log, circuit state, inbound dispatch (including an
// end-to-end run from the webhook transaction to the handler), the health check job and its events, the apply job's
// approval-evidence check (TC-AD-14), and the secret-in-log canary.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/jobs/integration-core/integration-core.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runOnce } from 'graphile-worker';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { createLogger, JobRegistry, KernelDb, Queue, syncTaskTypes } from '@ehr/kernel';
import {
  AdapterFailure,
  AdapterRegistry,
  canonicalRequest,
  challengeOf,
  CircuitBreakers,
  createIntegrationCoreTasks,
  defineIntegrationCoreJobs,
  InboundHandlerRegistry,
  runApplySecret,
  runDispatch,
  runHealthCheck,
  SecretCache,
  credentialReaderFor,
  valueFingerprint,
  VendorGateway,
  VendorUnavailableError,
  type ApprovalEvidenceVerifier,
  type InboundMessage,
  type InboundSecretWriter,
  type PayloadOpener,
  type VendorAdapter,
} from './index.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be02_w_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

const ORG = '00000000-0000-7000-8000-0000000000a1';
const P1 = '00000000-0000-7000-8000-0000000000d1';
const P2 = '00000000-0000-7000-8000-0000000000d2';
const CANARY = 'CANARY-secret-value-9f3a1c77d2-DO-NOT-LOG';
const refused = (code: string) => (e: { code?: string }) => {
  assert.equal(e.code, code);
  return true;
};

const KEY = randomBytes(32);
const gcmSeal = (plain: Buffer, ctx: string): Buffer => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  c.setAAD(Buffer.from(ctx));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
};
const opener: PayloadOpener = {
  open: (sealed, ctx) => {
    try {
      const d = createDecipheriv('aes-256-gcm', KEY, sealed.subarray(0, 12));
      d.setAAD(Buffer.from(ctx));
      d.setAuthTag(sealed.subarray(12, 28));
      return Promise.resolve(Buffer.concat([d.update(sealed.subarray(28)), d.final()]));
    } catch {
      return Promise.reject(new Error('cannot open'));
    }
  },
};

describe('integration-core on PostgreSQL 17 (BE-02, worker side)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wpool: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let apool: any;
  let db: KernelDb;
  let apiDb: KernelDb;
  const logs: string[] = [];
  const log = createLogger({ sink: (l) => logs.push(l), level: 'debug' });
  const registry = new JobRegistry();
  defineIntegrationCoreJobs(registry);
  for (const [m, e] of [
    ['notifications', 'connection_down'],
    ['notifications', 'connection_restored'],
    ['notifications', 'secret_change_refused'],
  ] as const) {
    registry.defineJob({
      name: `${m}.on_${e}`,
      maxAttempts: 3,
      onMerged: 'none',
      carriesPatientIds: false,
      jobScope: 'org',
      jobClass: 'handler',
    });
    registry.registerHandler(`integration_core.${e}`, m);
  }
  const wq = new Queue(registry, 'worker');
  const aq = new Queue(registry, 'api');

  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    (await admin.query(sql, p)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> =>
    (await q<T>(sql, p))[0] as T;
  const JOBS = `queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id`;
  const connect = async (user: string) => {
    const c = new pg.Client({ connectionString: urlFor(user) });
    await c.connect();
    return c;
  };

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
    await installQueue(urlFor('app_owner'));
    const w = await connect('app_worker');
    await syncTaskTypes(w, registry);
    await w.end();
    admin = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    await admin.connect();
    wpool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 6 });
    wpool.on('error', () => undefined); // DROP DATABASE ... FORCE at teardown ends idle clients (57P01)
    apool = new pg.Pool({ connectionString: urlFor('app_api'), max: 4 });
    apool.on('error', () => undefined); // DROP DATABASE ... FORCE at teardown ends idle clients (57P01)
    db = new KernelDb(wpool);
    apiDb = new KernelDb(apool);
    for (const [kind, vendor] of [
      ['sms', 'testsms'],
      ['email', 'testmail'],
      ['video', 'testvideo'],
    ])
      await admin.query(
        `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, enabled) VALUES (gen_random_uuid(), $1, $2, $3, true)`,
        [ORG, kind, vendor],
      );
  });
  after(async () => {
    await wpool?.end();
    await apool?.end();
    await admin?.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  const connId = async (kind: string): Promise<string> =>
    (
      await one<{ id: string }>(`SELECT id FROM integration_core.connection WHERE kind = $1`, [
        kind,
      ])
    ).id;

  function sms(
    script: (n: number) => Promise<{ data: unknown; httpStatus?: number; vendorRef?: string }>,
    o: Partial<VendorAdapter<'sms'>> = {},
  ) {
    const calls: number[] = [];
    const a: VendorAdapter<'sms'> & { calls: number[] } = {
      kind: 'sms',
      supportsIdempotencyToken: true,
      calls,
      call: () => {
        calls.push(Date.now());
        return script(calls.length);
      },
      healthCheck: () => Promise.resolve({ ok: true }),
      ...o,
    };
    return a;
  }
  function gateway(
    a: VendorAdapter,
    o: { now?: () => number; circuits?: CircuitBreakers; kind?: 'sms' } = {},
  ) {
    const adapters = new AdapterRegistry();
    adapters.register(a);
    return new VendorGateway({
      db,
      orgId: ORG,
      adapters,
      credentials: () => ({ get: () => Promise.resolve('x') }),
      sleep: () => Promise.resolve(),
      logger: log,
      ...(o.now === undefined ? {} : { now: o.now }),
      ...(o.circuits === undefined ? {} : { circuits: o.circuits }),
    });
  }

  describe('callVendor against the real call log (24, 34.2, 34.3)', () => {
    test('a good call writes one row in the current monthly partition with IDs, outcome, status, latency and vendor ref only', async () => {
      const cid = await connId('sms');
      const corr = '00000000-0000-7000-8000-0000000000c1';
      const gw = gateway(
        sms(() =>
          Promise.resolve({
            data: { body: 'SENSITIVE RESPONSE' },
            httpStatus: 202,
            vendorRef: 'msg-77',
          }),
        ),
      );
      await gw.callVendor(
        'sms',
        'send',
        { to: '+15550100', text: 'SENSITIVE ARG' },
        { type: 'reservation', id: corr },
      );
      const r = await one<Record<string, unknown>>(
        `SELECT tableoid::regclass::text AS part, * FROM integration_core.outbound_call WHERE correlation_id = $1`,
        [corr],
      );
      assert.match(String(r.part), /outbound_call_y2026m11|outbound_call_y\d{4}m\d{2}/);
      assert.deepEqual(
        [
          r.connection_id,
          r.organisation_id,
          r.operation,
          r.correlation_type,
          r.attempt,
          r.outcome,
          r.http_status,
          r.vendor_ref,
          r.error_class,
        ],
        [cid, ORG, 'send', 'reservation', 1, 'ok', 202, 'msg-77', null],
      );
      assert.ok(Number(r.latency_ms) >= 0);
      assert.equal(JSON.stringify(r).includes('SENSITIVE'), false);
    });

    test('retryable failures are retried with the same token; every attempt is a row; exhaustion is vendor_unavailable', async () => {
      const a = sms(() => Promise.reject(new AdapterFailure(true, 503)));
      const gw = gateway(a);
      const corr = '00000000-0000-7000-8000-0000000000c2';
      await assert.rejects(
        gw.callVendor('sms', 'send', {}, { id: corr, idempotencyToken: 'tok-retry-0001' }),
        VendorUnavailableError,
      );
      const rows = await q(
        `SELECT attempt, outcome, http_status, error_class FROM integration_core.outbound_call WHERE correlation_id = $1 ORDER BY attempt`,
        [corr],
      );
      assert.deepEqual(
        rows.map((r) => [r.attempt, r.outcome, r.http_status]),
        [
          [1, 'error', 503],
          [2, 'error', 503],
          [3, 'error', 503],
        ],
      );
    });

    test('the circuit opens after 5 failures: the next call fails fast and is logged as rejected/circuit_open; half-open probe recovers', async () => {
      let t = 5_000_000;
      const circuits = new CircuitBreakers({ now: () => t });
      let healthy = false;
      const a = sms((n) =>
        healthy ? Promise.resolve({ data: n }) : Promise.reject(new AdapterFailure(true, 500)),
      );
      const gw = new VendorGateway({
        db,
        orgId: ORG,
        adapters: Object.assign(new AdapterRegistry(), {}),
        credentials: () => ({ get: () => Promise.resolve('x') }),
        sleep: () => Promise.resolve(),
        maxAttempts: 1,
        circuits,
        now: () => t,
      });
      (gw as unknown as { d: { adapters: AdapterRegistry } }).d.adapters.register(a);
      const corr = '00000000-0000-7000-8000-0000000000c3';
      for (let i = 0; i < 5; i++)
        await assert.rejects(gw.callVendor('sms', 'send', {}, { id: corr }));
      const calls = a.calls.length;
      await assert.rejects(
        gw.callVendor('sms', 'send', {}, { id: corr }),
        (e: VendorUnavailableError) => e.reason === 'circuit_open',
      );
      assert.equal(a.calls.length, calls, 'the vendor was not called');
      const last = await one(
        `SELECT outcome, error_class FROM integration_core.outbound_call WHERE correlation_id = $1 ORDER BY at DESC, attempt DESC LIMIT 1`,
        [corr],
      );
      assert.deepEqual([last.outcome, last.error_class], ['rejected', 'circuit_open']);
      t += 30_000;
      healthy = true;
      const r = await gw.callVendor('sms', 'send', {}, { id: corr });
      assert.equal(r.data, calls + 1);
      assert.equal(circuits.state(await connId('sms')), 'closed');
    });

    test('a vendor without an idempotency token gets a pending row first, moved once to its outcome; a finished row never changes', async () => {
      const corr = '00000000-0000-7000-8000-0000000000c4';
      let seenPending = 0;
      const a = sms(
        async () => {
          seenPending = Number(
            (
              await one(
                `SELECT count(*) AS n FROM integration_core.outbound_call WHERE correlation_id = $1 AND outcome = 'pending'`,
                [corr],
              )
            ).n,
          );
          return { data: 1, httpStatus: 200 };
        },
        { supportsIdempotencyToken: false },
      );
      await gateway(a).callVendor('sms', 'send', {}, { id: corr });
      assert.equal(seenPending, 1, 'a pending row existed while the vendor call ran');
      const rows = await q(
        `SELECT outcome, http_status FROM integration_core.outbound_call WHERE correlation_id = $1`,
        [corr],
      );
      assert.deepEqual(
        rows.map((r) => [r.outcome, r.http_status]),
        [['ok', 200]],
      );
      await assert.rejects(
        admin.query(
          `UPDATE integration_core.outbound_call SET outcome = 'error' WHERE correlation_id = $1`,
          [corr],
        ),
        refused('PS001'),
      );
      await assert.rejects(
        admin.query(`DELETE FROM integration_core.outbound_call WHERE correlation_id = $1`, [corr]),
        refused('42501'),
      );
    });

    test('the worker role cannot rewrite what a row says it was (column grants and the guard)', async () => {
      const c = await connect('app_worker');
      try {
        await c.query('BEGIN');
        await c.query(
          `SELECT set_config('app.audience','system',true), set_config('app.org_id',$1,true), set_config('app.job_scope','org',true), set_config('app.realm','worker',true)`,
          [ORG],
        );
        for (const col of ['operation', 'organisation_id', 'connection_id', 'attempt', 'at']) {
          await c.query('SAVEPOINT s');
          await assert.rejects(
            c.query(`UPDATE integration_core.outbound_call SET ${col} = ${col}`),
            refused('42501'),
            col,
          );
          await c.query('ROLLBACK TO s');
        }
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    });

    test('a disabled connection is refused before it leaves, logged as rejected/disabled', async () => {
      await admin.query(
        `UPDATE integration_core.connection SET enabled = false WHERE kind = 'email'`,
      );
      const adapters = new AdapterRegistry();
      let called = 0;
      adapters.register({
        kind: 'email',
        supportsIdempotencyToken: true,
        call: () => {
          called++;
          return Promise.resolve({ data: 1 });
        },
        healthCheck: () => Promise.resolve({ ok: true }),
      });
      const gw = new VendorGateway({
        db,
        orgId: ORG,
        adapters,
        credentials: () => ({ get: () => Promise.resolve('x') }),
      });
      const corr = '00000000-0000-7000-8000-0000000000c5';
      await assert.rejects(
        gw.callVendor('email', 'send', {}, { id: corr }),
        VendorUnavailableError,
      );
      assert.equal(called, 0);
      assert.deepEqual(
        (await one(
          `SELECT outcome, error_class FROM integration_core.outbound_call WHERE correlation_id = $1`,
          [corr],
        )) as object,
        { outcome: 'rejected', error_class: 'disabled' },
      );
      await admin.query(
        `UPDATE integration_core.connection SET enabled = true WHERE kind = 'email'`,
      );
    });
  });

  describe('inbound dispatch (25.7)', () => {
    const seed = async (
      source: string,
      eventId: string,
      type: string,
      body: string,
      ctxEvent = eventId,
    ): Promise<string> => {
      const id = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id;
      await admin.query(
        `INSERT INTO integration_core.inbound_message (id, organisation_id, source, event_id, message_type, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          ORG,
          source,
          eventId,
          type,
          gcmSeal(Buffer.from(body), `inbound:${source}\n${ctxEvent}`),
        ],
      );
      return id;
    };
    const deps = (reg: InboundHandlerRegistry) => ({
      db,
      orgId: ORG,
      queue: wq,
      log,
      registry: reg,
      opener,
    });
    const status = (id: string) =>
      one<{ status: string; handler: string | null; attempts: number; error_class: string | null }>(
        `SELECT status, handler, attempts, error_class FROM integration_core.inbound_message WHERE id = $1`,
        [id],
      );

    test('a registered handler receives the decrypted message once; a re-run does nothing', async () => {
      const reg = new InboundHandlerRegistry();
      const got: InboundMessage[] = [];
      reg.register('zoomish', 'video.participant_joined', 'telehealth.on_event', (m) => {
        got.push(m);
        return Promise.resolve();
      });
      const id = await seed('zoomish', 'evt-d1', 'video.participant_joined', '{"hello":"world"}');
      assert.equal(await runDispatch(deps(reg), id), 'handled');
      assert.equal(got.length, 1);
      assert.equal(got[0]?.body.toString(), '{"hello":"world"}');
      assert.deepEqual(
        [got[0]?.source, got[0]?.eventId, got[0]?.messageType],
        ['zoomish', 'evt-d1', 'video.participant_joined'],
      );
      const s = await status(id);
      assert.deepEqual([s.status, s.handler, s.attempts], ['handled', 'telehealth.on_event', 1]);
      assert.equal(await runDispatch(deps(reg), id), 'skipped');
      assert.equal(got.length, 1);
    });

    test('no handler: status no_handler, visible for the dead-letter view; no exception (nothing to retry)', async () => {
      const id = await seed('zoomish', 'evt-d2', 'video.unknown_type', '{}');
      assert.equal(await runDispatch(deps(new InboundHandlerRegistry()), id), 'no_handler');
      assert.equal((await status(id)).status, 'no_handler');
    });

    test('a failing handler leaves the message failed and fails the job; the retry runs the handler again and handles it', async () => {
      const reg = new InboundHandlerRegistry();
      let n = 0;
      reg.register('zoomish', 'video.flaky', 'telehealth.on_flaky', () => {
        n++;
        return n === 1
          ? Promise.reject(new TypeError('boom with PHI-like text John Smith'))
          : Promise.resolve();
      });
      const id = await seed('zoomish', 'evt-d3', 'video.flaky', '{}');
      await assert.rejects(runDispatch(deps(reg), id));
      let s = await status(id);
      assert.deepEqual([s.status, s.error_class], ['failed', 'typeerror']);
      assert.equal(JSON.stringify(s).includes('John'), false, 'only an error class is stored');
      assert.equal(await runDispatch(deps(reg), id), 'handled');
      s = await status(id);
      assert.deepEqual([s.status, s.attempts, s.error_class], ['handled', 2, null]);
    });

    test('a ciphertext moved to another message does not open (DF-4): the handler is never called', async () => {
      const reg = new InboundHandlerRegistry();
      let called = 0;
      reg.register('zoomish', 'video.moved', 'telehealth.on_moved', () => {
        called++;
        return Promise.resolve();
      });
      const id = await seed('zoomish', 'evt-d4', 'video.moved', '{"secret":"x"}', 'evt-OTHER');
      await assert.rejects(runDispatch(deps(reg), id));
      assert.equal(called, 0);
      assert.equal((await status(id)).status, 'failed');
    });

    test('end to end: the webhook transaction (receive_inbound + enqueue) then the real queue runner dispatches to the handler', async () => {
      const reg = new InboundHandlerRegistry();
      const got: string[] = [];
      reg.register('zoomish', 'video.e2e', 'telehealth.on_e2e', (m) => {
        got.push(m.body.toString());
        return Promise.resolve();
      });
      const sealed = gcmSeal(Buffer.from('{"e2e":true}'), 'inbound:zoomish\nevt-e2e');
      const run = () =>
        apiDb.withScope({ audience: 'anonymous', orgId: ORG }, async (tx) => {
          const r = (
            await tx.query(
              'SELECT outcome, message_id FROM integration_core.receive_inbound($1,$2,$3,$4)',
              ['zoomish', 'evt-e2e', 'video.e2e', sealed],
            )
          ).rows[0] as { outcome: string; message_id: string | null };
          if (r.outcome === 'inserted')
            await aq.enqueue(
              tx,
              'integration_core.dispatch_inbound',
              { messageId: r.message_id },
              { jobKey: String(r.message_id) },
            );
          return r.outcome;
        });
      assert.equal(await run(), 'inserted');
      assert.equal(await run(), 'duplicate');
      assert.equal(
        Number(
          (
            await one(
              `SELECT count(*) AS n FROM ${JOBS} WHERE t.identifier = 'integration_core.dispatch_inbound' AND j.payload->>'messageId' = (SELECT id::text FROM integration_core.inbound_message WHERE event_id = 'evt-e2e')`,
            )
          ).n,
        ),
        1,
      );
      const tasks = createIntegrationCoreTasks({
        dispatch: deps(reg),
        health: {
          db,
          orgId: ORG,
          queue: wq,
          adapters: new AdapterRegistry(),
          credentials: () => ({ get: () => Promise.resolve('') }),
          log,
        },
        apply: {
          db,
          orgId: ORG,
          queue: wq,
          log,
          opener,
          writer: { put: () => Promise.reject(new Error('unused')) },
        },
      });
      await runOnce({ connectionString: urlFor('app_worker'), schema: 'queue', taskList: tasks });
      assert.deepEqual(got, ['{"e2e":true}']);
      assert.equal(
        (
          await one(
            `SELECT status FROM integration_core.inbound_message WHERE event_id = 'evt-e2e'`,
          )
        ).status,
        'handled',
      );
    });
  });

  describe('health check job and connection events (34.2, NFR-21)', () => {
    const adapterWith = (ok: () => boolean | 'throw') => {
      const reg = new AdapterRegistry();
      reg.register({
        kind: 'video',
        supportsIdempotencyToken: true,
        call: () => Promise.resolve({ data: 1 }),
        healthCheck: () => {
          const r = ok();
          return r === 'throw'
            ? Promise.reject(new Error('Bearer sk_live_LEAK'))
            : Promise.resolve({ ok: r, httpStatus: r ? 200 : 503 });
        },
      });
      return reg;
    };
    const run = (reg: AdapterRegistry) =>
      runHealthCheck({
        db,
        orgId: ORG,
        queue: wq,
        adapters: reg,
        credentials: () => ({ get: () => Promise.resolve('x') }),
        log,
      });
    const health = () =>
      one<{ health: string; last_test_result: Record<string, unknown>; last_test_at: Date | null }>(
        `SELECT health, last_test_result, last_test_at FROM integration_core.connection WHERE kind = 'video'`,
      );
    // The sweep covers every connection; this test follows the video one (the others have no adapter in this registry).
    const eventsOf = async (task: string) => {
      const video = await connId('video');
      return (
        await q<{ payload: { connectionId: string } }>(
          `SELECT j.payload FROM ${JOBS} WHERE t.identifier = $1`,
          [task],
        )
      ).filter((r) => r.payload.connectionId === video);
    };
    const downJobs = () => eventsOf('notifications.on_connection_down');
    const upJobs = () => eventsOf('notifications.on_connection_restored');

    test('ok -> degraded -> down publishes connection_down once; recovery publishes connection_restored once', async () => {
      let state: boolean | 'throw' = true;
      const reg = adapterWith(() => state);
      await run(reg);
      assert.equal((await health()).health, 'ok');
      assert.equal((await downJobs()).length, 0);
      state = false;
      let ch = await run(reg);
      assert.equal((await health()).health, 'degraded');
      assert.deepEqual(
        ch.filter((c) => c.kind === 'video').map((c) => [c.kind, c.from, c.to]),
        [['video', 'ok', 'degraded']],
      );
      assert.equal((await downJobs()).length, 0, 'degraded is not an alert');
      state = 'throw';
      await run(reg);
      assert.equal((await health()).health, 'down');
      const down = await downJobs();
      assert.equal(down.length, 1);
      assert.deepEqual(Object.keys(down[0]?.payload as object).sort(), [
        'connectionId',
        'organisationId',
      ]);
      ch = await run(reg);
      assert.deepEqual(
        ch.filter((c) => c.kind === 'video'),
        [],
        'no change, no event',
      );
      assert.equal((await downJobs()).length, 1);
      state = true;
      await run(reg);
      assert.equal((await health()).health, 'ok');
      assert.equal((await upJobs()).length, 1);
    });

    test('BR-BE02-01: a down connection that is disabled reads unknown and publishes no connection_restored', async () => {
      const reg = adapterWith(() => 'throw');
      await run(reg);
      await run(reg);
      await run(reg);
      assert.equal((await health()).health, 'down');
      const before = (await upJobs()).length;
      await admin.query(
        `UPDATE integration_core.connection SET enabled = false WHERE kind = 'video'`,
      );
      await run(reg);
      assert.equal((await health()).health, 'unknown');
      assert.equal((await upJobs()).length, before);
      await admin.query(
        `UPDATE integration_core.connection SET enabled = true WHERE kind = 'video'`,
      );
      await run(adapterWith(() => true));
      assert.equal((await health()).health, 'ok');
    });

    test('the shared state and the last test result are stored without any credential or vendor text', async () => {
      const h = await health();
      assert.ok(h.last_test_at);
      assert.deepEqual(Object.keys(h.last_test_result).sort(), [
        'checkedAt',
        'httpStatus',
        'latencyMs',
        'ok',
      ]);
      assert.equal(JSON.stringify(h).includes('LEAK'), false);
    });

    test('the admin operations read sees the state written by the worker (T-CONF(admin))', async () => {
      const r = await apiDb.withScope(
        { audience: 'staff', realm: 'admin_pool', orgId: ORG, principalId: P1, personId: P1 },
        (tx) =>
          tx.query(`SELECT kind, health FROM integration_core.connection WHERE kind = 'video'`),
      );
      assert.deepEqual(r.rows, [{ kind: 'video', health: 'ok' }]);
    });

    test('a disabled connection is not probed and reads unknown', async () => {
      await admin.query(
        `UPDATE integration_core.connection SET enabled = false WHERE kind = 'video'`,
      );
      let probed = 0;
      await run(
        adapterWith(() => {
          probed++;
          return true;
        }),
      );
      assert.equal(probed, 0);
      assert.equal((await health()).health, 'unknown');
      await admin.query(
        `UPDATE integration_core.connection SET enabled = true WHERE kind = 'video'`,
      );
    });
  });

  describe('apply_inbound_secret: the worker re-checks approval evidence (25.9, TC-AD-14, SEC-01 O2)', () => {
    const writerCalls: { name: string; token: string }[] = [];
    const writer: InboundSecretWriter = {
      put: (name, _value, token) => {
        writerCalls.push({ name, token });
        return Promise.resolve({
          arn: `arn:test:env/integration/inbound/${name}`,
          versionId: `iv-${writerCalls.length}`,
        });
      },
    };
    const okVerifier: ApprovalEvidenceVerifier = { verify: () => Promise.resolve({ ok: true }) };
    let n = 0;
    /** Creates a request the way the API does (canonical bytes, sealed value), optionally approved. */
    async function makeRequest(
      o: { approve?: boolean; value?: string; sealValue?: string; expiresInMs?: number } = {},
    ) {
      n++;
      const cid = await connId('sms');
      const requestId = `00000000-0000-7000-8000-00000000e${String(n).padStart(3, '0')}`;
      const value = o.value ?? `${CANARY}-${n}`;
      const nonce = randomBytes(16);
      const expiresAt = new Date(Date.now() + (o.expiresInMs ?? 20 * 60_000));
      const canonical = canonicalRequest({
        requestId,
        connectionId: cid,
        name: `wh-${n}`,
        valueFingerprintHex: valueFingerprint(requestId, nonce, value),
        requesterPersonId: P1,
        expiresAt,
      });
      await admin.query(
        `INSERT INTO integration_core.secret_change_request (id, organisation_id, connection_id, name, requester_person_id, request_hash, canonical_request, expires_at, requester_assertion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{"credentialId":"c"}')`,
        [requestId, ORG, cid, `wh-${n}`, P1, challengeOf(canonical), canonical, expiresAt],
      );
      if (o.approve)
        await admin.query(
          `UPDATE integration_core.secret_change_request SET status='approved', approver_person_id=$2, decided_at=now(), approver_assertion='{"credentialId":"d"}' WHERE id=$1`,
          [requestId, P2],
        );
      const sealed = gcmSeal(
        Buffer.from(
          JSON.stringify({ value: o.sealValue ?? value, nonce: nonce.toString('base64') }),
        ),
        `secret_change:${requestId}`,
      ).toString('base64');
      return { requestId, sealed, name: `wh-${n}`, value };
    }
    const deps = (verifier?: ApprovalEvidenceVerifier, now?: () => Date) => ({
      db,
      orgId: ORG,
      queue: wq,
      log,
      opener,
      writer,
      ...(verifier === undefined ? {} : { verifier }),
      ...(now === undefined ? {} : { now }),
    });
    const req = (id: string) =>
      one<{ status: string; applied_version_id: string | null; job_id: string | null }>(
        `SELECT status, applied_version_id, job_id FROM integration_core.secret_change_request WHERE id = $1`,
        [id],
      );

    test('TC-AD-14: a compromised api writes an approval row and a job; the worker (default verifier) refuses, writes nothing and raises the alert', async () => {
      const r = await makeRequest({ approve: true });
      const before = writerCalls.length;
      const out = await runApplySecret(deps(), r);
      assert.deepEqual(out, { status: 'refused', reason: 'no_verifier_configured' });
      assert.equal(writerCalls.length, before, 'the secret store was not written');
      assert.equal(
        (await q(`SELECT 1 FROM integration_core.secret_ref WHERE name = $1`, [r.name])).length,
        0,
      );
      assert.equal((await req(r.requestId)).status, 'rejected');
      const alert = await q(
        `SELECT j.payload FROM ${JOBS} WHERE t.identifier = 'notifications.on_secret_change_refused'`,
      );
      assert.ok(alert.some((a) => (a.payload as { requestId: string }).requestId === r.requestId));
      const ev = await one(
        `SELECT action, change, realm, audience FROM audit.event WHERE resource_id = $1`,
        [r.requestId],
      );
      assert.deepEqual(ev.change, { outcome: 'refused', reasonClass: 'no_verifier_configured' });
    });

    test('with valid evidence: the value is written once under the request ID, the reference moves, the request is applied, the audit row has the version ID only', async () => {
      const r = await makeRequest({ approve: true });
      const out = await runApplySecret(deps(okVerifier), r);
      assert.equal(out.status, 'applied');
      assert.deepEqual(writerCalls.at(-1), { name: r.name, token: r.requestId });
      const ref = await one(
        `SELECT class, current_version_id, secret_arn FROM integration_core.secret_ref WHERE name = $1`,
        [r.name],
      );
      assert.deepEqual(
        [ref.class, ref.current_version_id],
        ['inbound_verification', out.status === 'applied' ? out.versionId : ''],
      );
      assert.match(String(ref.secret_arn), /\/integration\/inbound\//);
      assert.equal((await req(r.requestId)).status, 'applied');
      const ev = await one(
        `SELECT change, job_id FROM audit.event WHERE resource_id = $1 AND action = 'secret_write'`,
        [r.requestId],
      );
      assert.deepEqual(Object.keys(ev.change as object).sort(), ['name', 'versionId']);
      const again = await runApplySecret(deps(okVerifier), r);
      assert.deepEqual(again, { status: 'closed', was: 'applied' });
      assert.equal(
        writerCalls.filter((w) => w.token === r.requestId).length,
        1,
        'idempotent: no second write',
      );
    });

    test('the verifier receives what the worker recomputed: the challenge is SHA-256 of the canonical bytes, persons differ', async () => {
      const r = await makeRequest({ approve: true });
      let seen: Parameters<ApprovalEvidenceVerifier['verify']>[0] | undefined;
      await runApplySecret(
        deps({
          verify: (i) => {
            seen = i;
            return Promise.resolve({ ok: false, reason: 'test_stop' });
          },
        }),
        r,
      );
      assert.ok(seen);
      const stored = await one<{ request_hash: Buffer }>(
        `SELECT request_hash FROM integration_core.secret_change_request WHERE id = $1`,
        [r.requestId],
      );
      assert.deepEqual(seen?.challenge, stored.request_hash);
      assert.deepEqual([seen?.requesterPersonId, seen?.approverPersonId], [P1, P2]);
      assert.equal(
        JSON.stringify(seen).includes('CANARY'),
        false,
        'the verifier is never given the value',
      );
    });

    test('a payload whose value differs from the signed request is refused (canonical_mismatch); nothing is written', async () => {
      const r = await makeRequest({ approve: true, sealValue: 'attacker chosen value 0123456789' });
      const before = writerCalls.length;
      assert.deepEqual(await runApplySecret(deps(okVerifier), r), {
        status: 'refused',
        reason: 'canonical_mismatch',
      });
      assert.equal(writerCalls.length, before);
    });

    test('a payload sealed for another request does not open (payload_unreadable)', async () => {
      const a = await makeRequest({ approve: true });
      const b = await makeRequest({ approve: true });
      assert.deepEqual(
        await runApplySecret(deps(okVerifier), { requestId: b.requestId, sealed: a.sealed }),
        { status: 'refused', reason: 'payload_unreadable' },
      );
    });

    test('not yet approved: waiting (the job re-enqueues itself); rejected and expired requests are closed', async () => {
      const r = await makeRequest();
      assert.deepEqual(await runApplySecret(deps(okVerifier), r), { status: 'waiting' });
      const exp = await makeRequest({ approve: true });
      assert.deepEqual(
        await runApplySecret(
          deps(okVerifier, () => new Date(Date.now() + 25 * 60_000)),
          exp,
        ),
        { status: 'closed', was: 'expired' },
      );
      assert.equal((await req(exp.requestId)).status, 'expired');
      assert.deepEqual(await runApplySecret(deps(okVerifier), exp), {
        status: 'closed',
        was: 'expired',
      });
    });

    test('missing assertions are refused even with a permissive verifier', async () => {
      const r = await makeRequest({ approve: true });
      await admin.query(
        `ALTER TABLE integration_core.secret_change_request DISABLE TRIGGER scr_guard`,
      );
      await admin.query(
        `UPDATE integration_core.secret_change_request SET approver_assertion = NULL WHERE id = $1`,
        [r.requestId],
      );
      await admin.query(
        `ALTER TABLE integration_core.secret_change_request ENABLE TRIGGER scr_guard`,
      );
      assert.deepEqual(await runApplySecret(deps(okVerifier), r), {
        status: 'refused',
        reason: 'assertion_missing',
      });
    });

    test('the task wrapper re-enqueues a waiting request for later', async () => {
      const r = await makeRequest();
      const tasks = createIntegrationCoreTasks({
        dispatch: undefined as never,
        health: undefined as never,
        apply: deps(okVerifier),
      });
      await runOnce({ connectionString: urlFor('app_worker'), schema: 'queue', taskList: {} }); // drain anything pending
      await wq_enqueue_apply(r);
      await runOnce({ connectionString: urlFor('app_worker'), schema: 'queue', taskList: tasks });
      const rows = await q(
        `SELECT j.run_at FROM ${JOBS} WHERE t.identifier = 'integration_core.apply_inbound_secret' AND j.payload->>'requestId' = $1`,
        [r.requestId],
      );
      assert.equal(rows.length, 1);
      assert.ok(
        (rows[0]?.run_at as Date).getTime() > Date.now() + 20_000,
        'looks again in about 30 s',
      );
    });

    async function wq_enqueue_apply(r: { requestId: string; sealed: string }): Promise<void> {
      await admin.query(
        `SELECT queue.add_job('integration_core.apply_inbound_secret', $1::json, job_key => $2)`,
        [
          JSON.stringify({ requestId: r.requestId, sealed: r.sealed }),
          `integration_core.apply_inbound_secret:${r.requestId}`,
        ],
      );
    }
  });

  describe('credential reads and the secret cache', () => {
    test('credentials resolve through secret_ref at the time of use; a rotation is picked up after the cache bound', async () => {
      const cid = await connId('sms');
      await admin.query(
        `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id) VALUES ($1,'api-key',$2,'outbound','arn:t:env/integration/outbound/x/api-key','v1')`,
        [cid, ORG],
      );
      const now = 0;
      const store = new Map([
        ['v1', 'value-one'],
        ['v2', 'value-two'],
      ]);
      const cache = new SecretCache(
        { get: (_arn, v) => Promise.resolve(store.get(v) as string) },
        () => now,
      );
      const reader = credentialReaderFor(db, ORG, cid, cache);
      assert.equal(await reader.get('api-key'), 'value-one');
      await admin.query(
        `UPDATE integration_core.secret_ref SET current_version_id = 'v2' WHERE connection_id = $1 AND name = 'api-key'`,
        [cid],
      );
      assert.equal(
        await reader.get('api-key'),
        'value-two',
        'a new version ID is a new cache entry',
      );
      await assert.rejects(
        reader.get('missing'),
        (e: { code?: string }) => e.code === 'integration.secret_missing',
      );
    });
  });

  describe('secret-in-log canary (worker side)', () => {
    test('the canary value appears in no log line, no table, no queue row and no audit row', async () => {
      const dump: string[] = [logs.join('\n')];
      for (const [s, t] of [
        ['integration_core', 'connection'],
        ['integration_core', 'secret_ref'],
        ['integration_core', 'secret_change_request'],
        ['integration_core', 'outbound_call'],
        ['integration_core', 'inbound_message'],
        ['audit', 'event'],
        ['queue', '_private_jobs'],
      ])
        dump.push(
          (
            await one<{ s: string }>(
              `SELECT coalesce(string_agg(t::text, E'\\n'), '') AS s FROM ${s}.${t} t`,
            )
          ).s,
        );
      const all = dump.join('\n');
      assert.ok(logs.length > 0 && all.length > 2_000);
      assert.equal(all.includes('CANARY'), false);
      assert.equal(all.includes('LEAK'), false, 'no vendor error text');
      assert.equal(all.includes('John Smith'), false, 'no handler error text');
      assert.equal(all.includes('SENSITIVE'), false, 'no call argument or response');
    });
  });
});
