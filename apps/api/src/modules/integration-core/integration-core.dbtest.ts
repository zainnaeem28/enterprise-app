// Real-database tests for BE-02 (integration-core, API side) on PostgreSQL 17 with the real roles, migrations and queue:
// webhook transaction (ARCHITECTURE 25.7, 38.2 item 13, TC-API webhook parts), write-only secrets (BD-11, TC-AD-12/14),
// connection settings (TC-AD-13), RLS and grants of the five tables, and the secret-in-log canary on the API side.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/integration-core/integration-core.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { JobRegistry, KernelDb, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import { AuditService } from '../audit/index.js';
import { canonicalRequest, challengeOf, valueFingerprint } from './canonical.js';
import { ConnectionService } from './connections.js';
import {
  IntegrationScopeError,
  IntegrationValidationError,
  RequestExpiredError,
  RequestStateError,
  SelfApprovalError,
} from './errors.js';
import { InboundReceiver } from './inbound.js';
import { INTEGRATION_CORE_JOBS } from './jobs.js';
import { SecretService, type Assertion } from './secret-service.js';
import type { InboundKeyProvider, OutboundSecretStore, PayloadSealer } from './secret-store.js';
import {
  googleCalendarVerifier,
  googleChannelToken,
  hmacTimestampVerifier,
  type KeyVersion,
} from './verifiers.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be02_api_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

const ORG = '00000000-0000-7000-8000-0000000000a1';
const ORG2 = '00000000-0000-7000-8000-0000000000a2';
const ADM1_P = '00000000-0000-7000-8000-0000000000c1';
const ADM1 = '00000000-0000-7000-8000-0000000000d1';
const ADM2_P = '00000000-0000-7000-8000-0000000000c2';
const ADM2 = '00000000-0000-7000-8000-0000000000d2';
const DOC_P = '00000000-0000-7000-8000-0000000000c3';
const DOC = '00000000-0000-7000-8000-0000000000d3';
const REQ = (n: number): string => `00000000-0000-7000-8000-00000000f${String(n).padStart(3, '0')}`;
const SECRET_CANARY = 'CANARY-secret-value-9f3a1c77d2-DO-NOT-LOG';

const admin1: ScopeSettings = {
  audience: 'staff',
  realm: 'admin_pool',
  orgId: ORG,
  principalId: ADM1_P,
  personId: ADM1,
  phiAccess: 'limited',
};
const admin2: ScopeSettings = {
  audience: 'staff',
  realm: 'admin_pool',
  orgId: ORG,
  principalId: ADM2_P,
  personId: ADM2,
  phiAccess: 'limited',
};
const doctor: ScopeSettings = {
  audience: 'staff',
  realm: 'google',
  orgId: ORG,
  principalId: DOC_P,
  personId: DOC,
};

const assertion = (tag: string): Assertion => ({
  credentialId: `cred_${tag}`,
  clientDataJSON: `cd_${tag}`,
  authenticatorData: `ad_${tag}`,
  signature: `sig_${tag}`,
});

/** Real AES-256-GCM with the context as AAD, so a ciphertext moved to another context fails to open. */
const KEY = randomBytes(32);
function gcmSeal(plain: Buffer, ctx: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  c.setAAD(Buffer.from(ctx));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function gcmOpen(sealed: Buffer, ctx: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', KEY, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(ctx));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}
const sealer: PayloadSealer = { seal: (p, ctx) => Promise.resolve(gcmSeal(p, ctx)) };

class FakeStore implements OutboundSecretStore {
  puts: { ref: { connectionId: string; name: string }; token: string }[] = [];
  versions = new Map<string, string>();
  fail = false;
  put(ref: { connectionId: string; name: string }, value: string, token: string) {
    if (this.fail) return Promise.reject(new Error(`store down; value was ${value}`));
    this.puts.push({ ref, token });
    // Idempotent by token: a retry returns the same version.
    let v = this.versions.get(token);
    if (v === undefined) {
      v = `v${this.versions.size + 1}`;
      this.versions.set(token, v);
    }
    return Promise.resolve({
      arn: `arn:test:secret:env/integration/outbound/${ref.connectionId}/${ref.name}`,
      versionId: v,
    });
  }
}

const refused = (code: string) => (e: { code?: string }) => {
  assert.equal(e.code, code);
  return true;
};

describe('integration-core on PostgreSQL 17 (BE-02, API side)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let db: KernelDb;
  const registry = new JobRegistry();
  for (const j of INTEGRATION_CORE_JOBS) registry.defineJob(j);
  registry.registerHandler('integration_core.inbound_received', 'probe');
  registry.defineJob({
    name: 'probe.on_inbound_received',
    maxAttempts: 1,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'handler',
  });
  const queue = new Queue(registry, 'api');
  const audit = new AuditService({ queue: queue as never });
  const connections = new ConnectionService(audit);
  const store = new FakeStore();
  const applyJobs: { requestId: string; sealed: string }[] = [];
  let failEnqueue = false;
  let clock = (): Date => new Date();
  const secrets = new SecretService({
    audit,
    store,
    sealer,
    enqueueApply: (_tx, job) => {
      if (failEnqueue) return Promise.reject(new Error('queue down'));
      applyJobs.push(job);
      return Promise.resolve();
    },
    now: () => clock(),
  });

  const WH_KEY: KeyVersion = {
    version: 'k1',
    key: Buffer.from('webhook-signing-key-for-tests-0001'),
  };
  const GOOGLE_KEY: KeyVersion = {
    version: 'g1',
    key: Buffer.from('google-channel-key-for-tests-00001'),
  };
  const keys: InboundKeyProvider = {
    keys: (source) =>
      source === 'google-calendar'
        ? Promise.resolve([GOOGLE_KEY])
        : source === 'zoomish'
          ? Promise.resolve([WH_KEY])
          : Promise.reject(new Error('no key')),
  };
  const verifiers = new Map([
    [
      'zoomish',
      hmacTimestampVerifier({
        signatureHeader: 'x-sig',
        timestampHeader: 'x-ts',
        allowedFields: ['id', 'type', 'meeting'],
        extract: (b) =>
          typeof b.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(b.id)
            ? { eventId: b.id, messageType: 'video.participant_joined' }
            : null,
      }),
    ],
    ['google-calendar', googleCalendarVerifier],
  ]);
  const failures: string[] = [];
  const receiver = new InboundReceiver({
    db: undefined as never,
    queue,
    sealer,
    keys,
    orgId: ORG,
    verifiers,
    onVerificationFailure: (i) => failures.push(`${i.source}:${i.reason}`),
  });
  let rx: InboundReceiver;

  const signed = (eventId: string, extra: Record<string, unknown> = {}) => {
    const body = Buffer.from(
      JSON.stringify({ id: eventId, type: 'participant_joined', meeting: 'm-1', ...extra }),
    );
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      source: 'zoomish',
      headers: {
        'x-sig': `v1=${createHmac('sha256', WH_KEY.key).update(`${ts}.`).update(body).digest('hex')}`,
        'x-ts': ts,
      },
      rawBody: body,
    };
  };
  const count = async (sql: string, p: unknown[] = []): Promise<number> =>
    Number((await admin.query(sql, p)).rows[0].n);
  const JOBS = `queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id`;
  const jobsFor = (id: string) =>
    count(
      `SELECT count(*) AS n FROM ${JOBS} WHERE t.identifier = 'integration_core.dispatch_inbound' AND j.payload->>'messageId' = $1`,
      [id],
    );
  const totalJobs = () =>
    count(
      `SELECT count(*) AS n FROM ${JOBS} WHERE t.identifier = 'integration_core.dispatch_inbound'`,
    );
  const totalMsgs = () => count('SELECT count(*) AS n FROM integration_core.inbound_message');

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
    const w = new pg.Client({ connectionString: urlFor('app_worker') });
    await w.connect();
    await syncTaskTypes(w, registry);
    await w.end();
    admin = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    // BR-BE02-03: an idle-client error (e.g. a backend terminated by a test) must not become an unhandled 'error' event.
    admin.on('error', () => undefined);
    await admin.connect();
    pool = new pg.Pool({ connectionString: urlFor('app_api'), max: 8 });
    pool.on('error', () => undefined);
    db = new KernelDb(pool);
    rx = new InboundReceiver({
      db,
      queue,
      sealer,
      keys,
      orgId: ORG,
      verifiers,
      onVerificationFailure: (i) => failures.push(`${i.source}:${i.reason}`),
    });
    void receiver;
  });
  after(async () => {
    await pool?.end();
    await admin?.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  const meta = (n: number) => ({ requestId: REQ(n) });
  const sqlAs = async <T>(scope: ScopeSettings, sql: string, p: unknown[] = []): Promise<T[]> =>
    (await db.withScope(scope, (tx) => tx.query(sql, p))).rows as T[];

  describe('webhook transaction (25.7, 38.2 item 13)', () => {
    test('a verified message is stored under the vendor event ID and its dispatch job is enqueued in the same transaction', async () => {
      const r = await rx.receive(signed('evt_first'));
      assert.deepEqual(r, { status: 200, outcome: 'inserted' });
      const m = (
        await admin.query(
          `SELECT id, source, event_id, message_type, status, payload, organisation_id FROM integration_core.inbound_message WHERE event_id = 'evt_first'`,
        )
      ).rows;
      assert.equal(m.length, 1);
      assert.deepEqual(
        [m[0].source, m[0].message_type, m[0].status, m[0].organisation_id],
        ['zoomish', 'video.participant_joined', 'received', ORG],
      );
      assert.equal(await jobsFor(m[0].id), 1, 'exactly one dispatch job, carrying the message ID');
      assert.ok(
        !m[0].payload.includes(Buffer.from('participant_joined')),
        'the stored payload is the sealed ciphertext',
      );
      assert.equal(
        gcmOpen(m[0].payload, 'inbound:zoomish\nevt_first')
          .toString()
          .includes('participant_joined'),
        true,
      );
      assert.throws(
        () => gcmOpen(m[0].payload, 'inbound:zoomish\nevt_other'),
        'bound to source and event ID (DF-4)',
      );
    });

    test('a duplicate gets 200 and enqueues nothing; nothing new is stored', async () => {
      const before = [await totalMsgs(), await totalJobs()];
      const r = await rx.receive(signed('evt_first'));
      assert.deepEqual(r, { status: 200, outcome: 'duplicate' });
      assert.deepEqual([await totalMsgs(), await totalJobs()], before);
    });

    test('concurrent duplicates: exactly one insert, one job', async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => rx.receive(signed('evt_race'))),
      );
      assert.equal(results.filter((r) => r.status === 200 && r.outcome === 'inserted').length, 1);
      assert.equal(results.filter((r) => r.status === 200 && r.outcome === 'duplicate').length, 11);
      assert.equal(
        await count(
          `SELECT count(*) AS n FROM integration_core.inbound_message WHERE event_id = 'evt_race'`,
        ),
        1,
      );
      const id = (
        await admin.query(
          `SELECT id FROM integration_core.inbound_message WHERE event_id = 'evt_race'`,
        )
      ).rows[0].id;
      assert.equal(await jobsFor(id), 1);
    });

    test('same event ID from another source is a different message (unique per organisation, source, event)', async () => {
      const b = Buffer.from('{}');
      const g = {
        source: 'google-calendar',
        headers: {
          'x-goog-channel-id': 'evt_first',
          'x-goog-channel-token': googleChannelToken(
            GOOGLE_KEY,
            'evt_first',
            Math.floor(Date.now() / 1000) + 86_400,
          ),
          'x-goog-resource-id': 'r1',
          'x-goog-resource-state': 'exists',
          'x-goog-message-number': '1',
        },
        rawBody: b,
      };
      assert.deepEqual(await rx.receive(g), { status: 200, outcome: 'inserted' });
    });

    test('a bad signature is 401, is not recorded, enqueues nothing and is counted', async () => {
      const before = [await totalMsgs(), await totalJobs()];
      const r = signed('evt_forged');
      r.headers['x-sig'] = 'v1=' + 'a'.repeat(64);
      assert.deepEqual(await rx.receive(r), { status: 401 });
      assert.deepEqual([await totalMsgs(), await totalJobs()], before);
      assert.ok(failures.includes('zoomish:unauthenticated'));
    });

    test('malformed after a valid signature is 400; an unknown source is 404; an oversize body is 413; none stored', async () => {
      const before = [await totalMsgs(), await totalJobs()];
      assert.equal((await rx.receive(signed('evt_x', { surprise: 1 }))).status, 400);
      assert.equal((await rx.receive({ ...signed('evt_y'), source: 'nobody' })).status, 404);
      assert.equal(
        (await rx.receive({ ...signed('evt_z'), rawBody: Buffer.alloc(262_145, 0x20) })).status,
        413,
      );
      assert.deepEqual([await totalMsgs(), await totalJobs()], before);
    });

    test('Google push: valid token accepted; a repeated message number is a duplicate; the next number is new; bad token is 401', async () => {
      const exp = Math.floor(Date.now() / 1000) + 86_400;
      const push = (n: string, token = googleChannelToken(GOOGLE_KEY, 'chan-a', exp)) => ({
        source: 'google-calendar',
        headers: {
          'x-goog-channel-id': 'chan-a',
          'x-goog-channel-token': token,
          'x-goog-resource-id': 'res1',
          'x-goog-resource-state': 'exists',
          'x-goog-message-number': n,
        },
        rawBody: Buffer.alloc(0),
      });
      assert.deepEqual(await rx.receive(push('7')), { status: 200, outcome: 'inserted' });
      assert.deepEqual(await rx.receive(push('7')), { status: 200, outcome: 'duplicate' });
      assert.deepEqual(await rx.receive(push('8')), { status: 200, outcome: 'inserted' });
      assert.equal(
        (await rx.receive(push('9', googleChannelToken(GOOGLE_KEY, 'chan-a', exp - 200_000))))
          .status,
        401,
      );
      assert.equal(
        (
          await rx.receive(
            push(
              '9',
              googleChannelToken(
                { version: 'g1', key: Buffer.from('x'.repeat(32)) },
                'chan-a',
                exp,
              ),
            ),
          )
        ).status,
        401,
      );
      assert.equal(
        await count(
          `SELECT count(*) AS n FROM integration_core.inbound_message WHERE source = 'google-calendar' AND event_id LIKE 'chan-a:%'`,
        ),
        2,
      );
    });

    test('if the transaction fails the vendor gets 503 and neither the message nor the job is stored', async () => {
      const noJobRegistry = new JobRegistry(); // dispatch job unknown to this queue: the enqueue step throws
      const broken = new InboundReceiver({
        db,
        queue: new Queue(noJobRegistry, 'api'),
        sealer,
        keys,
        orgId: ORG,
        verifiers,
      });
      const before = [await totalMsgs(), await totalJobs()];
      assert.deepEqual(await broken.receive(signed('evt_atomic')), { status: 503 });
      assert.deepEqual([await totalMsgs(), await totalJobs()], before);
      assert.equal(
        await count(
          `SELECT count(*) AS n FROM integration_core.inbound_message WHERE event_id = 'evt_atomic'`,
        ),
        0,
      );
      // and the vendor's retry then succeeds
      assert.deepEqual(await rx.receive(signed('evt_atomic')), {
        status: 200,
        outcome: 'inserted',
      });
    });

    test('a secret store failure before verification is 503 and stores nothing', async () => {
      const r = new InboundReceiver({
        db,
        queue,
        sealer,
        keys: { keys: () => Promise.reject(new Error('down')) },
        orgId: ORG,
        verifiers,
      });
      assert.deepEqual(await r.receive(signed('evt_nokey')), { status: 503 });
    });

    test('the inbound_received event is published for registered handlers (message ID and organisation only)', async () => {
      const row = (
        await admin.query(
          `SELECT j.payload FROM ${JOBS} WHERE t.identifier = 'probe.on_inbound_received' ORDER BY j.id LIMIT 1`,
        )
      ).rows[0];
      assert.ok(row);
      assert.deepEqual(Object.keys(row.payload).sort(), ['messageId', 'organisationId']);
    });
  });

  describe('receive_inbound is a narrow door (21.6, DF-1, DF-2, DF-8)', () => {
    const call = (scope: ScopeSettings, args: unknown[]) =>
      db.withScope(scope, (tx) =>
        tx.query('SELECT * FROM integration_core.receive_inbound($1,$2,$3,$4)', args),
      );
    const ok = ['zoomish', 'evt_direct', 'video.x', Buffer.from('c')];

    test('refuses a signed-in audience, a missing organisation and bad arguments', async () => {
      await assert.rejects(call(admin1, ok), refused('42501'));
      await assert.rejects(
        call({ audience: 'patient', orgId: ORG, patientIds: [] }, ok),
        refused('42501'),
      );
      await assert.rejects(call({ audience: 'anonymous' }, ok), refused('22023'));
      for (const bad of [
        ['Bad Source', 'e', 'a.b', Buffer.from('c')],
        ['s', '', 'a.b', Buffer.from('c')],
        ['s', 'has space', 'a.b', Buffer.from('c')],
        ['s', 'e', 'Bad Type', Buffer.from('c')],
        ['s', 'e', 'a.b', Buffer.alloc(0)],
        ['s', 'e', 'a.b', Buffer.alloc(262_145)],
        ['s', 'e', 'a.b', null],
      ])
        await assert.rejects(call({ audience: 'anonymous', orgId: ORG }, bad), refused('22023'));
    });

    test('app_api cannot read or write inbound_message directly; app_worker cannot call the function; PUBLIC has nothing', async () => {
      await assert.rejects(
        sqlAs(
          { audience: 'anonymous', orgId: ORG },
          'SELECT * FROM integration_core.inbound_message',
        ),
        refused('42501'),
      );
      await assert.rejects(
        sqlAs(
          { audience: 'anonymous', orgId: ORG },
          `INSERT INTO integration_core.inbound_message (id, organisation_id, source, event_id, message_type, payload) VALUES (gen_random_uuid(), $1, 's', 'e', 'a.b', 'x')`,
          [ORG],
        ),
        refused('42501'),
      );
      const w = new pg.Client({ connectionString: urlFor('app_worker') });
      await w.connect();
      await assert.rejects(
        w.query(`SELECT * FROM integration_core.receive_inbound('s','e','a.b','\\x00')`),
        refused('42501'),
      );
      await w.end();
      const o = new pg.Client({ connectionString: urlFor('app_owner') });
      await o.connect();
      await assert.rejects(
        o.query(`SELECT * FROM integration_core.receive_inbound('s','e','a.b','\\x00')`),
        refused('42501'),
      );
      await assert.rejects(
        o.query('SELECT 1 FROM integration_core.inbound_message'),
        refused('42501'),
      );
      await o.end();
    });

    test('the function is owned by integration_receiver_owner, SECURITY DEFINER, with a fixed search_path; the table too', async () => {
      const f = (
        await admin.query(
          `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig FROM pg_proc WHERE oid = 'integration_core.receive_inbound(text,text,text,bytea)'::regprocedure`,
        )
      ).rows[0];
      assert.equal(f.owner, 'integration_receiver_owner');
      assert.equal(f.prosecdef, true);
      assert.ok((f.proconfig as string[]).some((c) => c.startsWith('search_path=pg_catalog')));
      assert.equal(
        (
          await admin.query(
            `SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'integration_core.inbound_message'::regclass`,
          )
        ).rows[0].o,
        'integration_receiver_owner',
      );
    });
  });

  describe('connection settings (22.3, TC-AD-13)', () => {
    let connId: string;
    test('an admin creates a connection; settings change is audited with before and after', async () => {
      const c = await db.withScope(admin1, (tx) =>
        connections.upsert(tx, meta(1), {
          kind: 'sms',
          vendor: 'testsms',
          settings: { region: 'eu', fromNumber: '+15550100' },
        }),
      );
      connId = c.id;
      assert.equal(c.enabled, false);
      assert.equal(c.health, 'unknown');
      const c2 = await db.withScope(admin1, (tx) =>
        connections.upsert(tx, meta(2), {
          kind: 'sms',
          vendor: 'testsms',
          settings: { region: 'us', fromNumber: '+15550100' },
          enabled: true,
        }),
      );
      assert.equal(c2.id, connId);
      assert.equal(c2.rowVersion, 2);
      const ev = (
        await admin.query(
          `SELECT change, actor_person_id, realm, action, resource_id FROM audit.event WHERE request_id = $1`,
          [REQ(2)],
        )
      ).rows[0];
      assert.equal(ev.action, 'config_change');
      assert.equal(ev.actor_person_id, ADM1);
      assert.equal(ev.change.before.settings.region, 'eu');
      assert.equal(ev.change.after.settings.region, 'us');
    });

    test('a credential-looking key is refused in the service (422) and again by the table CHECK', async () => {
      await assert.rejects(
        db.withScope(admin1, (tx) =>
          connections.upsert(tx, meta(3), {
            kind: 'email',
            vendor: 'testmail',
            settings: { smtp: { password: 'x' } },
          }),
        ),
        IntegrationValidationError,
      );
      await assert.rejects(
        admin.query(
          `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, settings) VALUES (gen_random_uuid(), $1, 'email', 'v', '{"nested":[{"apiKey":"x"}]}')`,
          [ORG],
        ),
        refused('23514'),
      );
      await assert.rejects(
        admin.query(
          `UPDATE integration_core.connection SET last_test_result = '{"authorization":"Bearer x"}' WHERE id = $1`,
          [connId],
        ),
        refused('23514'),
      );
    });

    test('unknown kind, bad vendor and a second connection of the same kind are refused', async () => {
      await assert.rejects(
        db.withScope(admin1, (tx) => connections.upsert(tx, meta(4), { kind: 'fax', vendor: 'v' })),
        IntegrationValidationError,
      );
      await assert.rejects(
        db.withScope(admin1, (tx) =>
          connections.upsert(tx, meta(4), { kind: 'sms', vendor: 'Bad Vendor!' }),
        ),
        IntegrationValidationError,
      );
      await assert.rejects(
        admin.query(
          `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor) VALUES (gen_random_uuid(), $1, 'sms', 'other')`,
          [ORG],
        ),
        refused('23505'),
      );
    });

    test('only the admin realm writes: a google-realm doctor, a patient and anonymous are refused by the service and by RLS', async () => {
      await assert.rejects(
        db.withScope(doctor, (tx) =>
          connections.upsert(tx, meta(5), { kind: 'push', vendor: 'v' }),
        ),
        IntegrationScopeError,
      );
      await assert.rejects(
        sqlAs(
          doctor,
          `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor) VALUES (gen_random_uuid(), $1, 'push', 'v')`,
          [ORG],
        ),
        refused('42501'),
      );
      await assert.rejects(
        sqlAs(
          { audience: 'patient', orgId: ORG, patientIds: [] },
          `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor) VALUES (gen_random_uuid(), $1, 'push', 'v')`,
          [ORG],
        ),
        refused('42501'),
      );
      assert.deepEqual(
        await sqlAs(
          doctor,
          `UPDATE integration_core.connection SET enabled = false WHERE id = $1 RETURNING id`,
          [connId],
        ),
        [],
        'RLS hides the row from an update',
      );
    });

    test('the admin cannot change health or last test (worker columns)', async () => {
      await assert.rejects(
        sqlAs(admin1, `UPDATE integration_core.connection SET health = 'ok' WHERE id = $1`, [
          connId,
        ]),
        refused('42501'),
      );
    });

    test('connectionSettings(kind) returns the record to the admin realm and nothing to other audiences', async () => {
      const got = await db.withScope(admin1, (tx) => connections.connectionSettings(tx, 'sms'));
      assert.equal(got?.id, connId);
      for (const s of [
        doctor,
        { audience: 'patient', orgId: ORG, patientIds: [] },
        { audience: 'anonymous', orgId: ORG },
        { audience: 'public', orgId: ORG },
        { audience: 'partner', orgId: ORG },
        { ...admin1, orgId: ORG2 },
        { audience: 'staff', realm: 'admin_pool' },
      ] as ScopeSettings[])
        assert.equal(
          await db.withScope(s, (tx) => connections.connectionSettings(tx, 'sms')),
          undefined,
          JSON.stringify(s),
        );
    });
  });

  describe('write-only secret references (BD-11, TC-AD-12)', () => {
    let connId: string;
    before(async () => {
      connId = (await admin.query(`SELECT id FROM integration_core.connection WHERE kind = 'sms'`))
        .rows[0].id;
    });

    test('an admin writes an outbound secret: the reply, the reference and the audit row carry a version ID and never the value', async () => {
      const r = await db.withScope(admin1, (tx) =>
        secrets.writeOutbound(tx, meta(10), {
          connectionId: connId,
          name: 'api-key',
          value: SECRET_CANARY,
          idempotencyKey: REQ(100),
        }),
      );
      assert.equal(r.versionId, 'v1');
      assert.deepEqual(Object.keys(r), ['versionId']);
      const ref = (
        await admin.query(
          `SELECT class, current_version_id, secret_arn, rotated_by_person_id FROM integration_core.secret_ref WHERE connection_id = $1`,
          [connId],
        )
      ).rows[0];
      assert.deepEqual(
        [ref.class, ref.current_version_id, ref.rotated_by_person_id],
        ['outbound', 'v1', ADM1],
      );
      const ev = (
        await admin.query(
          `SELECT action, change, resource_type FROM audit.event WHERE request_id = $1`,
          [REQ(10)],
        )
      ).rows[0];
      assert.deepEqual(
        [ev.action, ev.change],
        ['secret_write', { name: 'api-key', versionId: 'v1' }],
      );
    });

    test('a retry with the same idempotency key writes no second version; a new key rotates', async () => {
      const r1 = await db.withScope(admin1, (tx) =>
        secrets.writeOutbound(tx, meta(11), {
          connectionId: connId,
          name: 'api-key',
          value: SECRET_CANARY,
          idempotencyKey: REQ(100),
        }),
      );
      assert.equal(r1.versionId, 'v1');
      const r2 = await db.withScope(admin1, (tx) =>
        secrets.writeOutbound(tx, meta(12), {
          connectionId: connId,
          name: 'api-key',
          value: `${SECRET_CANARY}-2`,
          idempotencyKey: REQ(101),
        }),
      );
      assert.equal(r2.versionId, 'v2');
      assert.equal(
        (
          await admin.query(
            `SELECT current_version_id FROM integration_core.secret_ref WHERE connection_id = $1 AND name = 'api-key'`,
            [connId],
          )
        ).rows[0].current_version_id,
        'v2',
      );
    });

    test('a store failure is a bare 503 with no vendor text and no value; the reference does not move', async () => {
      store.fail = true;
      try {
        await assert.rejects(
          db.withScope(admin1, (tx) =>
            secrets.writeOutbound(tx, meta(13), {
              connectionId: connId,
              name: 'api-key',
              value: SECRET_CANARY,
              idempotencyKey: REQ(102),
            }),
          ),
          (e: Error & { code?: string }) => {
            assert.equal(e.code, 'kernel.unavailable');
            assert.equal(JSON.stringify([e.message, e.stack]).includes('CANARY'), false);
            return true;
          },
        );
      } finally {
        store.fail = false;
      }
      assert.equal(
        (
          await admin.query(
            `SELECT current_version_id FROM integration_core.secret_ref WHERE connection_id = $1 AND name = 'api-key'`,
            [connId],
          )
        ).rows[0].current_version_id,
        'v2',
      );
    });

    test('non-admin scopes cannot write; validation names fields only; unknown connection is 404', async () => {
      await assert.rejects(
        db.withScope(doctor, (tx) =>
          secrets.writeOutbound(tx, meta(14), {
            connectionId: connId,
            name: 'k',
            value: SECRET_CANARY,
            idempotencyKey: REQ(103),
          }),
        ),
        IntegrationScopeError,
      );
      await assert.rejects(
        db.withScope(admin1, (tx) =>
          secrets.writeOutbound(tx, meta(14), {
            connectionId: connId,
            name: 'Bad Name',
            value: 'short',
            idempotencyKey: 'nope',
          }),
        ),
        (e: IntegrationValidationError) => {
          assert.deepEqual([...e.fields].sort(), ['idempotencyKey', 'name', 'value']);
          return true;
        },
      );
      await assert.rejects(
        db.withScope(admin1, (tx) =>
          secrets.writeOutbound(tx, meta(14), {
            connectionId: REQ(999),
            name: 'k',
            value: SECRET_CANARY,
            idempotencyKey: REQ(104),
          }),
        ),
        (e: { code?: string }) => e.code === 'kernel.not_found',
      );
    });

    test('the API role cannot create or take over an inbound-verification reference, by service or by SQL', async () => {
      await admin.query(
        `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id) VALUES ($1, 'wh-key', $2, 'inbound_verification', 'arn:x:env/integration/inbound/wh-key', 'in1')`,
        [connId, ORG],
      );
      await assert.rejects(
        db.withScope(admin1, (tx) =>
          secrets.writeOutbound(tx, meta(15), {
            connectionId: connId,
            name: 'wh-key',
            value: SECRET_CANARY,
            idempotencyKey: REQ(105),
          }),
        ),
        IntegrationScopeError,
      );
      await assert.rejects(
        sqlAs(
          admin1,
          `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id) VALUES ($1, 'other', $2, 'inbound_verification', 'arn:x:env/integration/inbound/other', 'in1')`,
          [connId, ORG],
        ),
        refused('42501'),
      );
      assert.deepEqual(
        await sqlAs(
          admin1,
          `UPDATE integration_core.secret_ref SET current_version_id = 'forged' WHERE connection_id = $1 AND name = 'wh-key' RETURNING name`,
          [connId],
        ),
        [],
      );
      assert.equal(
        (
          await admin.query(
            `SELECT current_version_id FROM integration_core.secret_ref WHERE name = 'wh-key'`,
          )
        ).rows[0].current_version_id,
        'in1',
      );
    });

    test('an ARN must sit under the prefix of its class', async () => {
      await assert.rejects(
        admin.query(
          `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id) VALUES ($1, 'bad1', $2, 'outbound', 'arn:x:env/integration/inbound/bad1', 'v')`,
          [connId, ORG],
        ),
        refused('23514'),
      );
      await assert.rejects(
        admin.query(
          `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id) VALUES ($1, 'bad2', $2, 'inbound_verification', 'arn:x:env/integration/outbound/bad2', 'v')`,
          [connId, ORG],
        ),
        refused('23514'),
      );
    });
  });

  describe('dual-controlled inbound secret request (25.9, SEC-01 O2)', () => {
    let connId: string;
    before(async () => {
      connId = (await admin.query(`SELECT id FROM integration_core.connection WHERE kind = 'sms'`))
        .rows[0].id;
      clock = () => new Date();
    });
    const request = (n: number, value = SECRET_CANARY + '-inbound') =>
      db.withScope(admin1, (tx) =>
        secrets.requestInboundSecret(tx, meta(n), {
          connectionId: connId,
          name: 'wh-signing',
          value,
          requesterAssertion: assertion('req'),
        }),
      );

    test('the request stores canonical bytes and their hash, hands a sealed payload to the job, and puts the value in no table', async () => {
      const rc = await request(20);
      const row = (
        await admin.query(`SELECT * FROM integration_core.secret_change_request WHERE id = $1`, [
          rc.requestId,
        ])
      ).rows[0];
      assert.equal(row.status, 'requested');
      assert.equal(row.requester_person_id, ADM1);
      assert.deepEqual(Buffer.from(row.request_hash), challengeOf(row.canonical_request));
      assert.match(rc.fingerprintHint, /^[0-9a-f]{6}…[0-9a-f]{6}$/);
      const job = applyJobs.at(-1);
      assert.equal(job?.requestId, rc.requestId);
      // The worker can recompute everything from the sealed payload alone.
      const plain = JSON.parse(
        gcmOpen(
          Buffer.from(job?.sealed ?? '', 'base64'),
          `secret_change:${rc.requestId}`,
        ).toString(),
      ) as { value: string; nonce: string };
      assert.equal(plain.value, SECRET_CANARY + '-inbound');
      const again = canonicalRequest({
        requestId: rc.requestId,
        connectionId: connId,
        name: 'wh-signing',
        valueFingerprintHex: valueFingerprint(
          rc.requestId,
          Buffer.from(plain.nonce, 'base64'),
          plain.value,
        ),
        requesterPersonId: ADM1,
        expiresAt: row.expires_at,
      });
      assert.deepEqual(again, row.canonical_request);
      assert.throws(
        () => gcmOpen(Buffer.from(job?.sealed ?? '', 'base64'), 'secret_change:other'),
        'the context is the request ID',
      );
      const wrong = canonicalRequest({
        requestId: rc.requestId,
        connectionId: connId,
        name: 'wh-signing',
        valueFingerprintHex: valueFingerprint(
          rc.requestId,
          Buffer.from(plain.nonce, 'base64'),
          'a different value 123',
        ),
        requesterPersonId: ADM1,
        expiresAt: row.expires_at,
      });
      assert.notDeepEqual(wrong, row.canonical_request);
    });

    test('without a job enqueuer the request fails closed; a failed enqueue rolls the request back', async () => {
      const bare = new SecretService({ audit, store, sealer });
      await assert.rejects(
        db.withScope(admin1, (tx) =>
          bare.requestInboundSecret(tx, meta(21), {
            connectionId: connId,
            name: 'x1',
            value: SECRET_CANARY + 'x',
            requesterAssertion: assertion('r'),
          }),
        ),
        (e: { code?: string }) => e.code === 'kernel.unavailable',
      );
      const before = await count(
        'SELECT count(*) AS n FROM integration_core.secret_change_request',
      );
      failEnqueue = true;
      try {
        await assert.rejects(request(22));
      } finally {
        failEnqueue = false;
      }
      assert.equal(
        await count('SELECT count(*) AS n FROM integration_core.secret_change_request'),
        before,
      );
    });

    test('the requester cannot approve their own request (service 403 and database)', async () => {
      const rc = await request(23);
      await assert.rejects(
        db.withScope(admin1, (tx) =>
          secrets.decide(tx, meta(24), {
            requestId: rc.requestId,
            decision: 'approve',
            approverAssertion: assertion('self'),
          }),
        ),
        SelfApprovalError,
      );
      // Direct SQL as the requester: RLS WITH CHECK (approver <> requester) and the CHECK/trigger.
      await assert.rejects(
        sqlAs(
          admin1,
          `UPDATE integration_core.secret_change_request SET status = 'approved', approver_person_id = $2, decided_at = now(), approver_assertion = '{}' WHERE id = $1`,
          [rc.requestId, ADM1],
        ),
        (e: { code?: string }) => ['42501', 'PS001', '23514'].includes(String(e.code)),
      );
      // Even a superuser cannot make the approver equal the requester.
      await assert.rejects(
        admin.query(
          `UPDATE integration_core.secret_change_request SET status = 'approved', approver_person_id = requester_person_id, decided_at = now() WHERE id = $1`,
          [rc.requestId],
        ),
        (e: { code?: string }) => e.code === '23514' || e.code === 'PS001',
      );
      assert.equal(
        (
          await admin.query(
            `SELECT status FROM integration_core.secret_change_request WHERE id = $1`,
            [rc.requestId],
          )
        ).rows[0].status,
        'requested',
      );
    });

    test('a different elevated admin approves once; a second decision is a state conflict; the approver is recorded; the row keeps its hash', async () => {
      const rc = await request(25);
      const before = (
        await admin.query(
          `SELECT request_hash FROM integration_core.secret_change_request WHERE id = $1`,
          [rc.requestId],
        )
      ).rows[0];
      assert.deepEqual(
        await db.withScope(admin2, (tx) =>
          secrets.decide(tx, meta(26), {
            requestId: rc.requestId,
            decision: 'approve',
            approverAssertion: assertion('appr'),
          }),
        ),
        { status: 'approved' },
      );
      const row = (
        await admin.query(
          `SELECT status, approver_person_id, decided_at, approver_assertion, request_hash FROM integration_core.secret_change_request WHERE id = $1`,
          [rc.requestId],
        )
      ).rows[0];
      assert.deepEqual([row.status, row.approver_person_id], ['approved', ADM2]);
      assert.ok(row.decided_at);
      assert.deepEqual(row.approver_assertion, assertion('appr'));
      assert.deepEqual(row.request_hash, before.request_hash);
      await assert.rejects(
        db.withScope(admin2, (tx) =>
          secrets.decide(tx, meta(27), { requestId: rc.requestId, decision: 'reject' }),
        ),
        RequestStateError,
      );
      // identity of the request cannot be rewritten by the API role
      await assert.rejects(
        sqlAs(
          admin2,
          `UPDATE integration_core.secret_change_request SET request_hash = decode(repeat('00',32),'hex') WHERE id = $1`,
          [rc.requestId],
        ),
        refused('42501'),
      );
    });

    test('approval needs an assertion; rejection does not; a non-admin cannot decide; unknown id is 404', async () => {
      const rc = await request(28);
      await assert.rejects(
        db.withScope(admin2, (tx) =>
          secrets.decide(tx, meta(29), { requestId: rc.requestId, decision: 'approve' }),
        ),
        IntegrationValidationError,
      );
      await assert.rejects(
        db.withScope(admin2, (tx) =>
          secrets.decide(tx, meta(29), {
            requestId: rc.requestId,
            decision: 'approve',
            approverAssertion: { credentialId: 'x' } as never,
          }),
        ),
        IntegrationValidationError,
      );
      await assert.rejects(
        db.withScope(doctor, (tx) =>
          secrets.decide(tx, meta(29), { requestId: rc.requestId, decision: 'reject' }),
        ),
        IntegrationScopeError,
      );
      assert.deepEqual(
        await db.withScope(admin2, (tx) =>
          secrets.decide(tx, meta(30), { requestId: rc.requestId, decision: 'reject' }),
        ),
        { status: 'rejected' },
      );
      await assert.rejects(
        db.withScope(admin2, (tx) =>
          secrets.decide(tx, meta(31), { requestId: REQ(998), decision: 'reject' }),
        ),
        (e: { code?: string }) => e.code === 'kernel.not_found',
      );
    });

    test('an expired request cannot be approved (409 identity.request_expired); the trigger agrees', async () => {
      const t0 = Date.now();
      clock = () => new Date(t0 - 30 * 60_000 + 1_500);
      let rc;
      try {
        rc = await request(32);
      } finally {
        clock = () => new Date();
      }
      await new Promise((r) => setTimeout(r, 1_800));
      await assert.rejects(
        db.withScope(admin2, (tx) =>
          secrets.decide(tx, meta(33), {
            requestId: rc.requestId,
            decision: 'approve',
            approverAssertion: assertion('late'),
          }),
        ),
        RequestExpiredError,
      );
      await assert.rejects(
        admin.query(
          `UPDATE integration_core.secret_change_request SET status = 'approved', approver_person_id = $2, decided_at = now() WHERE id = $1`,
          [rc.requestId, ADM2],
        ),
        refused('PS001'),
      );
    });

    test('status moves only forward and terminal rows never change; rows are never deleted', async () => {
      const id = (
        await admin.query(
          `SELECT id FROM integration_core.secret_change_request WHERE status = 'rejected' LIMIT 1`,
        )
      ).rows[0].id;
      await assert.rejects(
        admin.query(
          `UPDATE integration_core.secret_change_request SET status = 'requested' WHERE id = $1`,
          [id],
        ),
        refused('PS001'),
      );
      await assert.rejects(
        admin.query(`DELETE FROM integration_core.secret_change_request WHERE id = $1`, [id]),
        refused('42501'),
      );
    });
  });

  describe('RLS and grants of the five tables (behavioural)', () => {
    const tables = [
      'connection',
      'secret_ref',
      'secret_change_request',
      'outbound_call',
      'inbound_message',
    ];
    before(async () => {
      const connId = (
        await admin.query(`SELECT id FROM integration_core.connection WHERE kind = 'sms'`)
      ).rows[0].id;
      await admin.query(
        `INSERT INTO integration_core.outbound_call (id, organisation_id, connection_id, operation, attempt, outcome) VALUES (gen_random_uuid(), $1, $2, 'send', 1, 'ok')`,
        [ORG, connId],
      );
    });
    test('every table is FORCE ROW LEVEL SECURITY, owned by a non-application role, with nothing granted to PUBLIC', async () => {
      const r = (
        await admin.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl
        FROM pg_class c WHERE c.relnamespace = 'integration_core'::regnamespace AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`)
      ).rows;
      assert.deepEqual(
        r.map((x: { relname: string }) => x.relname),
        [...tables].sort(),
      );
      for (const t of r) {
        assert.equal(t.relrowsecurity && t.relforcerowsecurity, true, t.relname);
        assert.ok(['app_owner', 'integration_receiver_owner'].includes(t.owner), t.owner);
        assert.ok(!/(^|,)=/.test(t.acl ?? ''), `${t.relname}: PUBLIC ACL entry`);
      }
    });

    test('rows are visible only to the admin realm (app_api) and to system jobs (app_worker); every other audience sees zero rows', async () => {
      const wrongScopes: ScopeSettings[] = [
        doctor,
        { audience: 'patient', orgId: ORG, patientIds: [] },
        { audience: 'anonymous', orgId: ORG },
        { audience: 'public', orgId: ORG },
        { audience: 'partner', orgId: ORG },
        { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }, // app_api may not act as the worker
        { ...admin1, orgId: ORG2 },
        { audience: 'staff', realm: 'admin_pool' },
      ];
      for (const t of tables.filter((x) => x !== 'inbound_message'))
        for (const s of wrongScopes)
          assert.deepEqual(
            await sqlAs(s, `SELECT 1 FROM integration_core.${t}`),
            [],
            `${t} as ${JSON.stringify(s)}`,
          );
      for (const t of tables.filter((x) => x !== 'inbound_message'))
        assert.ok(
          (await sqlAs(admin1, `SELECT 1 FROM integration_core.${t}`)).length > 0,
          `admin sees ${t}`,
        );
      // app_owner holds nothing
      const o = new pg.Client({ connectionString: urlFor('app_owner') });
      await o.connect();
      // `connection` keeps the owner's right for foreign-key checks (0400), but FORCE RLS leaves app_owner without a policy.
      for (const t of tables) {
        if (t === 'connection')
          assert.deepEqual((await o.query(`SELECT 1 FROM integration_core.${t}`)).rows, [], t);
        else
          await assert.rejects(o.query(`SELECT 1 FROM integration_core.${t}`), refused('42501'), t);
      }
      await o.end();
    });

    test('app_api cannot write the call log or move health; the call log has no DELETE for anyone', async () => {
      await assert.rejects(
        sqlAs(
          admin1,
          `INSERT INTO integration_core.outbound_call (id, organisation_id, connection_id, operation, attempt, outcome) VALUES (gen_random_uuid(), $1, gen_random_uuid(), 'send', 1, 'ok')`,
          [ORG],
        ),
        refused('42501'),
      );
      await assert.rejects(
        admin.query(`DELETE FROM integration_core.outbound_call`),
        refused('42501'),
      );
    });

    test('call-log rows land in monthly partitions, none directly granted', async () => {
      const r = (
        await admin.query(
          `SELECT tableoid::regclass::text AS part FROM integration_core.outbound_call LIMIT 1`,
        )
      ).rows[0];
      assert.match(r.part, /^integration_core\.outbound_call_y\d{4}m\d{2}$|outbound_call_default$/);
      const acl = (
        await admin.query(
          `SELECT count(*) AS n FROM pg_class WHERE relnamespace = 'integration_core'::regnamespace AND relispartition AND has_table_privilege('app_worker', oid, 'INSERT')`,
        )
      ).rows[0].n;
      assert.equal(Number(acl), 0);
    });
  });

  describe('job types (33.1)', () => {
    test('the dispatch job is API-enqueueable; health_check is not; the list matches 33.1', async () => {
      assert.deepEqual(
        INTEGRATION_CORE_JOBS.map((j) => [j.name, j.maxAttempts, j.jobClass]),
        [
          ['integration_core.dispatch_inbound', 8, 'job'],
          ['integration_core.health_check', 3, 'system'],
          ['integration_core.apply_inbound_secret', 3, 'job'],
        ],
      );
      const rows = (
        await admin.query(
          `SELECT task_identifier, api_enqueue, max_attempts FROM queue_api.task_type WHERE task_identifier LIKE 'integration_core.%' ORDER BY 1`,
        )
      ).rows;
      assert.deepEqual(
        rows.map((r: { task_identifier: string; api_enqueue: boolean }) => [
          r.task_identifier,
          r.api_enqueue,
        ]),
        [
          ['integration_core.apply_inbound_secret', true],
          ['integration_core.dispatch_inbound', true],
          ['integration_core.health_check', false],
        ],
      );
    });
  });

  describe('secret-in-log canary (API side)', () => {
    test('the canary value appears in no table, no queue row, no audit row and no captured error', async () => {
      const dump: string[] = [];
      for (const [schema, table] of [
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
            await admin.query(
              `SELECT coalesce(string_agg(t::text, E'\\n'), '') AS s FROM ${schema}.${table} t`,
            )
          ).rows[0].s,
        );
      const all = dump.join('\n');
      assert.ok(all.length > 1_000, 'the dump is not empty');
      assert.equal(all.includes('CANARY'), false);
      assert.equal(all.includes(Buffer.from(SECRET_CANARY).toString('hex')), false);
      assert.equal(all.includes(Buffer.from(SECRET_CANARY).toString('base64')), false);
      // the sealed job payload is the single allowed carrier, and it is not in the database here (INT-N4)
      assert.ok(applyJobs.length > 0);
      for (const j of applyJobs)
        assert.equal(Buffer.from(j.sealed, 'base64').includes(Buffer.from('CANARY')), false);
      void createHash;
    });
  });
});
