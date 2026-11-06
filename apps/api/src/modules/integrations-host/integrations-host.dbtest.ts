/* eslint-disable boundaries/module-boundaries -- test support: composes the real organisation, availability and integration-core modules the way the composition root does, on the availability kit */
// Real-database tests for BE-22 on PostgreSQL 17 with the real roles, migrations, views, queue and Nest application:
//   TC-AZ-12 (public audience), TC-BK-18 (public responses), TC-API webhook parts (idempotent receipt, signature, replay window,
//   CN-12 unknown fields), PB-2 (a public transaction cannot write), the ticket's acceptance for `/public/v1/*` and the cookie-less host.
//   EHR_TEST_ADMIN_URL=postgres://postgres:...@host:port/postgres node --test dist/src/modules/integrations-host/integrations-host.dbtest.js
// Synthetic data only. Missing configuration FAILS (the testkit throws); nothing skips.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Queue, createLogger, syncTaskTypes } from '@ehr/kernel';
import type { Tx } from '@ehr/kernel';
import { createApp } from '../../platform/app.js';
import {
  InboundReceiver,
  INTEGRATION_CORE_JOBS,
  hmacTimestampVerifier,
} from '../integration-core/index.js';
import type { InboundKeyProvider, PayloadSealer } from '../integration-core/index.js';
import { OrganisationService } from '../organisation/index.js';
import {
  A1,
  B1,
  ORG,
  SVC,
  SVC_IN,
  pg,
  setupAvailability,
} from '../scheduling/availability/testkit.js';
import type { AvailKit, Doctor } from '../scheduling/availability/testkit.js';
import { createIntegrationsHostControllers } from './controller.js';
import { PublicDirectoryService } from './public-directory.js';

const HOST = 'integrations.example.test';
const KEY = { version: 'k1', key: Buffer.from('webhook-key-for-tests-0123456789ab') };
const L_INACTIVE = '00000000-0000-7000-8000-0000000000e1';
const S_INACTIVE = '00000000-0000-7000-8000-0000000000e2';
const SENSITIVE = 'INTERNAL-NAME-CANARY-xq7';

let t: AvailKit;
let admin: Awaited<ReturnType<AvailKit['adminScope']>>;
let app: Awaited<ReturnType<typeof createApp>>;
let base = '';
const refusedCounts: string[] = [];

const meta = {
  get requestId(): string {
    return randomUUID();
  },
};
const tpl = (over: Record<string, unknown> = {}): never =>
  ({
    locationId: A1,
    validFrom: '2026-01-01',
    validTo: null,
    rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      startLocal: '09:00',
      endLocal: '12:00',
      mode: 'either',
    })),
    ...over,
  }) as never;
async function doctor(
  o: Parameters<AvailKit['doctor']>[0] = {},
  template: Record<string, unknown> | null = {},
): Promise<Doctor> {
  const d = await t.doctor(o);
  if (template !== null)
    await t.as(admin, (tx) => t.avail.createTemplate(tx, meta, d.principalId, tpl(template)));
  return d;
}

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
function http(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Buffer,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = request(
      { host: u.hostname, port: u.port, method, path, headers: { host: HOST, ...headers } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }),
        );
      },
    );
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const items = async (
  path: string,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>[]> => {
  const r = await http('GET', path, headers);
  assert.equal(r.status, 200, `${path}: ${r.body}`);
  return (JSON.parse(r.body) as { items: Record<string, unknown>[] }).items;
};
const clinicianIds = async (qs = ''): Promise<string[]> =>
  (await items(`/public/v1/clinicians${qs}`)).map((i) => String(i['clinicianId']));

let docOk: Doctor;
let docUnlisted: Doctor;
let docDisabled: Doctor;
let docNoTemplate: Doctor;
let docEnded: Doctor;
let docIneligible: Doctor;
let docAtB1: Doctor;

before(async () => {
  t = await setupAvailability('ih');
  admin = await t.adminScope();
  // Not in the standard fixtures: an inactive location and service, and a condition-revealing internal name that must never appear.
  await t.k.q(
    `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active) VALUES ($1, $2, 'Closed Clinic', 'clinic', 'America/New_York', 'NY', false)`,
    [L_INACTIVE, ORG],
  );
  await t.k.q(
    `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active, condition_revealing)
     VALUES ($1, $2, $3, 'Retired visit', 30, 0, 'either', false, true)`,
    [S_INACTIVE, ORG, SENSITIVE],
  );
  await t.k.q(`UPDATE organisation.service SET internal_name = $2 WHERE id = $1`, [SVC, SENSITIVE]);
  await t.k.q(
    `INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
    [ORG, S_INACTIVE, A1, L_INACTIVE],
  );
  await t.k.q(
    `INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1, $2, $3)`,
    [ORG, SVC, L_INACTIVE],
  );

  docOk = await doctor();
  docUnlisted = await doctor({ listed: false });
  docDisabled = await doctor();
  await t.k.q(`UPDATE identity.principal SET status = 'disabled' WHERE id = $1`, [
    docDisabled.principalId,
  ]);
  docNoTemplate = await doctor({}, null);
  docEnded = await doctor();
  await t.k.q(
    `UPDATE scheduling.availability_template SET valid_to = current_date - 3 WHERE clinician_principal_id = $1`,
    [docEnded.principalId],
  );
  docIneligible = await doctor({ eligible: false });
  docAtB1 = await doctor({ location: B1 }, { locationId: B1 });

  const org = new OrganisationService();
  const directory = new PublicDirectoryService({
    db: t.api,
    orgId: ORG,
    organisation: org,
    scheduling: t.avail,
  });

  // The real receiver over the real queue: the dispatch job type must exist for the enqueue in the webhook transaction.
  for (const j of INTEGRATION_CORE_JOBS)
    try {
      t.k.registry.get(j.name);
    } catch {
      t.k.registry.defineJob(j);
    }
  const wc = new pg.Client({ connectionString: t.k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, t.k.registry);
  await wc.end();
  const sealer: PayloadSealer = { seal: (plain) => Promise.resolve(Buffer.from(plain)) };
  const keys: InboundKeyProvider = { keys: () => Promise.resolve([KEY]) };
  const receiver = new InboundReceiver({
    db: t.api,
    queue: new Queue(t.k.registry, 'api'),
    sealer,
    keys,
    orgId: ORG,
    verifiers: new Map([
      [
        'video.acme',
        hmacTimestampVerifier({
          signatureHeader: 'x-sig',
          timestampHeader: 'x-ts',
          allowedFields: ['id', 'type', 'meeting'],
          extract: (b) =>
            typeof b['id'] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(b['id'])
              ? { eventId: b['id'], messageType: 'video.participant_joined' }
              : null,
        }),
      ],
    ]),
    onVerificationFailure: (i) => refusedCounts.push(`${i.source}:${i.reason}`),
  });

  app = await createApp({
    config: {
      minClientRelease: 141,
      instanceCount: 1,
      integrationsHost: HOST,
      port: 0,
      requestTimeoutMs: 15_000,
    },
    logger: createLogger({ sink: () => undefined }),
    readiness: { missingRelations: () => Promise.resolve([]) },
    policy: t.k.identity.policy, // the real identity guard: a public route must not touch a session
    limiter: { hit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 1 }) },
    controllers: createIntegrationsHostControllers({ directory, receiver }),
  });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});
after(async () => {
  await app?.close();
  await t?.close();
});

describe('GET /public/v1/* (acceptance 1)', () => {
  test('locations: only active locations, only C0 fields', async () => {
    const locs = await items('/public/v1/locations');
    const ids = locs.map((l) => l['id']);
    assert.ok(ids.includes(A1) && ids.includes(B1));
    assert.ok(!ids.includes(L_INACTIVE), 'inactive location absent');
    for (const l of locs)
      assert.deepEqual(Object.keys(l).sort(), [
        'address',
        'geo',
        'id',
        'kind',
        'name',
        'phone',
        'stateCode',
        'timeZone',
      ]);
  });

  test('services: only active services, patient display name only, never the internal name; locationId filters through the views', async () => {
    const r = await http('GET', '/public/v1/services');
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes(SENSITIVE), 'internal name leaked');
    const svc = JSON.parse(r.body).items as Record<string, unknown>[];
    const ids = svc.map((s) => s['id']);
    assert.ok(ids.includes(SVC) && ids.includes(SVC_IN));
    assert.ok(!ids.includes(S_INACTIVE), 'inactive service absent');
    for (const s of svc)
      assert.deepEqual(Object.keys(s).sort(), ['durationMin', 'id', 'mode', 'patientDisplayName']);
    const atInactive = await items(`/public/v1/services?locationId=${L_INACTIVE}`);
    assert.deepEqual(atInactive, [], 'nothing is offered at an inactive location');
    const atA1 = (await items(`/public/v1/services?locationId=${A1}`)).map((s) => s['id']);
    assert.ok(atA1.includes(SVC) && !atA1.includes(S_INACTIVE));
  });

  test('clinicians: unlisted, disabled, no template, ended template and non-eligible doctors are absent', async () => {
    const all = await clinicianIds();
    assert.ok(
      all.includes(docOk.principalId) &&
        all.includes(docAtB1.principalId) &&
        all.includes(docIneligible.principalId),
    );
    for (const [name, d] of [
      ['unlisted', docUnlisted],
      ['disabled', docDisabled],
      ['no template', docNoTemplate],
      ['ended template', docEnded],
    ] as const)
      assert.ok(!all.includes(d.principalId), `${name} clinician must be absent`);
  });

  test('clinicians?serviceId&locationId: the intersection of eligibility and an active template at that place', async () => {
    const atA1 = await clinicianIds(`?serviceId=${SVC}&locationId=${A1}`);
    assert.ok(atA1.includes(docOk.principalId));
    assert.ok(!atA1.includes(docIneligible.principalId), 'not eligible for the service');
    assert.ok(!atA1.includes(docAtB1.principalId), 'template is at another location');
    const atB1 = await clinicianIds(`?serviceId=${SVC}&locationId=${B1}`);
    assert.deepEqual(atB1, [docAtB1.principalId]);
    assert.deepEqual(await clinicianIds(`?locationId=${L_INACTIVE}`), []);
    assert.deepEqual(await clinicianIds(`?serviceId=${S_INACTIVE}`), []);
    assert.deepEqual(await clinicianIds(`?serviceId=${randomUUID()}`), []);
    const body = await items(`/public/v1/clinicians?serviceId=${SVC}&locationId=${A1}`);
    for (const c of body) assert.deepEqual(Object.keys(c).sort(), ['clinicianId', 'displayName']);
  });

  test('a delisted clinician disappears on the next request (the CDN TTL is the only delay, 60 s)', async () => {
    const d = await doctor();
    assert.ok((await clinicianIds()).includes(d.principalId));
    await t.k.q(
      `UPDATE identity.staff_profile SET directory_listed = false WHERE principal_id = $1`,
      [d.principalId],
    );
    assert.ok(!(await clinicianIds()).includes(d.principalId));
    const r = await http('GET', '/public/v1/clinicians');
    assert.equal(r.headers['cache-control'], 'public, max-age=60');
  });

  test('responses carry no patient, reservation, room, hold or count field (TC-BK-18, TC-AZ-12 step 3)', async () => {
    const p = await t.patient(7);
    await t.k.q(
      `UPDATE identity.person SET display_name = 'PATIENT-NAME-CANARY' WHERE id = (SELECT person_id FROM identity.principal WHERE id = (SELECT principal_id FROM identity.patient_link WHERE patient_id = $1))`,
      [p.patientId],
    );
    for (const path of ['/public/v1/services', '/public/v1/locations', '/public/v1/clinicians']) {
      const r = await http('GET', path);
      for (const needle of [
        p.patientId,
        'PATIENT-NAME-CANARY',
        'Avail7',
        'reservation',
        'room',
        'hold',
        'count',
      ])
        assert.ok(
          !r.body.toLowerCase().includes(needle.toLowerCase()),
          `${path} contains ${needle}`,
        );
    }
  });

  test('mutating verbs are refused (TC-AZ-12 step 2) and change nothing', async () => {
    const before = (
      await t.k.q<{ n: string }>(
        `SELECT (SELECT count(*) FROM organisation.location) + (SELECT count(*) FROM organisation.service) AS n`,
      )
    )[0]?.n;
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'])
      for (const p of ['/public/v1/services', '/public/v1/locations', '/public/v1/clinicians']) {
        const r = await http(
          m,
          p,
          { 'content-type': 'application/json' },
          JSON.stringify({ name: 'x' }),
        );
        assert.ok(r.status === 404 || r.status === 405, `${m} ${p} -> ${r.status}`);
      }
    const after = (
      await t.k.q<{ n: string }>(
        `SELECT (SELECT count(*) FROM organisation.location) + (SELECT count(*) FROM organisation.service) AS n`,
      )
    )[0]?.n;
    assert.equal(after, before);
  });
});

describe('the cookie-less host (acceptance 2, part 1)', () => {
  test('a valid staff session cookie, and a patient one, change nothing: byte-identical answers and no session write', async () => {
    const p = await t.patient(8);
    const idleBefore = await t.k.q(
      `SELECT count(*) AS n, max(last_seen_at) AS m, max(idle_expires_at) AS i FROM identity.session`,
    );
    for (const path of ['/public/v1/services', '/public/v1/locations', '/public/v1/clinicians']) {
      const anon = await http('GET', path);
      for (const cookie of [t.deskA1.cookie, p.session.cookie, `${t.lead.cookie}; other=1`]) {
        const withCookie = await http('GET', path, { cookie });
        assert.equal(withCookie.status, 200);
        assert.equal(withCookie.body, anon.body, `${path} must not depend on a cookie`);
        assert.equal(withCookie.headers['set-cookie'], undefined);
        assert.equal(withCookie.headers['x-idle-expires'], undefined);
      }
    }
    const idleAfter = await t.k.q(
      `SELECT count(*) AS n, max(last_seen_at) AS m, max(idle_expires_at) AS i FROM identity.session`,
    );
    assert.deepEqual(idleAfter, idleBefore, 'no session was read or touched');
  });

  test('a webhook with only a session cookie and no signature is 401: cookies are not an authentication on this host', async () => {
    const r = await http(
      'POST',
      '/webhooks/video/acme',
      { cookie: t.deskA1.cookie, 'content-type': 'text/plain' },
      '{"id":"c1"}',
    );
    assert.equal(r.status, 401);
    assert.equal(
      await count(
        `SELECT count(*) AS n FROM integration_core.inbound_message WHERE event_id = 'c1'`,
      ),
      0,
    );
  });
});

describe('PB-2: a public transaction cannot write; base tables return nothing to it', () => {
  const scope = { audience: 'public', orgId: ORG } as const;
  const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => t.api.withScope(scope, fn);

  test("with the route's read-only setting, INSERT, UPDATE and DELETE are refused with 25006", async () => {
    for (const sql of [
      `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code) VALUES (gen_random_uuid(), '${ORG}', 'x', 'clinic', 'UTC', 'NY')`,
      `UPDATE organisation.location SET name = 'x'`,
      `DELETE FROM organisation.location`,
      `UPDATE organisation.public_location SET name = 'x'`,
    ])
      await assert.rejects(
        run(async (tx) => {
          await tx.query('SET LOCAL transaction_read_only = on');
          await tx.query(sql);
        }),
        (e: { code?: string }) => e.code === '25006' || e.code === '42501',
        sql,
      );
  });

  test('even without it, the public audience has no write right and no base-table row', async () => {
    for (const sql of [
      `UPDATE organisation.location SET name = 'x'`,
      `DELETE FROM organisation.location`,
      `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code) VALUES (gen_random_uuid(), '${ORG}', 'x', 'clinic', 'UTC', 'NY')`,
    ]) {
      const outcome = await run((tx) => tx.query(sql)).then(
        (r) => ({ rows: r.rowCount }),
        (e: { code?: string }) => ({ code: e.code }),
      );
      assert.ok('code' in outcome || outcome.rows === 0, `${sql} wrote ${JSON.stringify(outcome)}`);
    }
    assert.ok(
      (await count(`SELECT count(*) AS n FROM organisation.location WHERE name = 'x'`)) === 0,
    );
    for (const table of [
      'organisation.service',
      'organisation.location',
      'identity.staff_profile',
      'scheduling.availability_template',
      'patient.patient',
      'scheduling.slot_reservation',
    ])
      await run((tx) => tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).then(
        (r) => assert.equal(r.rows.length, 0, `${table} returned rows to public`),
        (e: { code?: string }) => assert.equal(e.code, '42501', table),
      );
  });
});

// ---- webhooks ---------------------------------------------------------------------------------------------------------
const count = async (sql: string, p: unknown[] = []): Promise<number> =>
  Number((await t.k.q<{ n: string }>(sql, p))[0]?.n);
const JOBS = `queue._private_jobs j JOIN queue._private_tasks tk ON tk.id = j.task_id`;
const jobsFor = (id: string): Promise<number> =>
  count(
    `SELECT count(*) AS n FROM ${JOBS} WHERE tk.identifier = 'integration_core.dispatch_inbound' AND j.payload->>'messageId' = $1`,
    [id],
  );
const messages = (eventId: string): Promise<number> =>
  count(
    `SELECT count(*) AS n FROM integration_core.inbound_message WHERE source = 'video.acme' AND event_id = $1`,
    [eventId],
  );

function signedHeaders(
  body: Buffer,
  o: { key?: Buffer; ts?: number } = {},
): Record<string, string> {
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', o.key ?? KEY.key)
    .update(`${ts}.`)
    .update(body)
    .digest('hex');
  return { 'x-sig': `v1=${sig}`, 'x-ts': ts, 'content-type': 'text/plain' };
}
const event = (id: string, extra: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({ id, type: 'participant_joined', meeting: 'm-1', ...extra }));
const post = (
  body: Buffer,
  headers: Record<string, string>,
  path = '/webhooks/video/acme',
): Promise<Resp> => http('POST', path, headers, body);

describe('POST /webhooks/video/{vendor} (acceptance 2, part 2; TC-API webhook parts)', () => {
  test('a verified event is recorded once with its dispatch job in the same transaction; the vendor gets 200', async () => {
    const body = event('evt-first');
    const r = await post(body, signedHeaders(body));
    assert.equal(r.status, 200);
    assert.equal(r.body, '{}');
    assert.equal(await messages('evt-first'), 1);
    const id = (
      await t.k.q<{ id: string }>(
        `SELECT id FROM integration_core.inbound_message WHERE event_id = 'evt-first'`,
      )
    )[0]?.id as string;
    assert.equal(await jobsFor(id), 1);
  });

  test('a replay of the same event ID answers 200 and stores nothing new and enqueues nothing new', async () => {
    const body = event('evt-replay');
    for (let i = 0; i < 3; i++) assert.equal((await post(body, signedHeaders(body))).status, 200);
    assert.equal(await messages('evt-replay'), 1);
    const id = (
      await t.k.q<{ id: string }>(
        `SELECT id FROM integration_core.inbound_message WHERE event_id = 'evt-replay'`,
      )
    )[0]?.id as string;
    assert.equal(await jobsFor(id), 1);
  });

  test('20 concurrent deliveries of one event ID leave exactly one message and one job; all answer 200', async () => {
    const body = event('evt-race');
    const rs = await Promise.all(Array.from({ length: 20 }, () => post(body, signedHeaders(body))));
    assert.deepEqual([...new Set(rs.map((r) => r.status))], [200]);
    assert.equal(await messages('evt-race'), 1);
    const id = (
      await t.k.q<{ id: string }>(
        `SELECT id FROM integration_core.inbound_message WHERE event_id = 'evt-race'`,
      )
    )[0]?.id as string;
    assert.equal(await jobsFor(id), 1);
  });

  test('wrong key, tampered body, missing signature, stale and future timestamps are 401 and nothing is stored', async () => {
    const body = event('evt-bad');
    const good = signedHeaders(body);
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, Buffer, Record<string, string>][] = [
      [
        'wrong key',
        body,
        signedHeaders(body, { key: Buffer.from('another-key-0123456789abcdefgh') }),
      ],
      ['tampered body', Buffer.from(body.toString().replace('m-1', 'm-2')), good],
      ['no signature', body, { 'content-type': 'text/plain' }],
      ['stale (10 min)', body, signedHeaders(body, { ts: now - 600 })],
      ['future (10 min)', body, signedHeaders(body, { ts: now + 600 })],
      ['malformed signature', body, { ...good, 'x-sig': 'v1=zz' }],
    ];
    const failuresBefore = refusedCounts.length;
    for (const [name, b, h] of cases) assert.equal((await post(b, h)).status, 401, name);
    assert.equal(refusedCounts.length - failuresBefore, cases.length, 'each failure is counted');
    assert.equal(await messages('evt-bad'), 0);
  });

  test('unknown vendor 404; unknown JSON field 400 (CN-12); malformed JSON 400; oversized 413; GET is not routed', async () => {
    const body = event('evt-x');
    assert.equal((await post(body, signedHeaders(body), '/webhooks/video/nobody')).status, 404);
    assert.equal((await post(body, signedHeaders(body), '/webhooks/messaging/acme')).status, 404);
    const extra = event('evt-extra', { surprise: true });
    assert.equal((await post(extra, signedHeaders(extra))).status, 400);
    const junk = Buffer.from('not json');
    assert.equal((await post(junk, signedHeaders(junk))).status, 400);
    assert.equal(
      (await post(Buffer.alloc(262_145, 0x20), { 'content-type': 'text/plain' })).status,
      413,
    );
    const g = await http('GET', '/webhooks/video/acme');
    assert.ok(g.status === 404 || g.status === 405);
    for (const id of ['evt-x', 'evt-extra']) assert.equal(await messages(id), 0);
  });

  test('responses carry no-store and no body content from the vendor; the stored payload is the exact bytes', async () => {
    const body = event('evt-bytes');
    const r = await post(body, signedHeaders(body));
    assert.equal(r.headers['cache-control'], 'no-store');
    const stored = (
      await t.k.q<{ payload: Buffer }>(
        `SELECT payload FROM integration_core.inbound_message WHERE event_id = 'evt-bytes'`,
      )
    )[0]?.payload as Buffer;
    assert.ok(Buffer.from(stored).equals(body));
  });

  test('KNOWN GAP (platform): a JSON content type is parsed by the platform without a raw copy, so it is refused 503 and stored nothing', async () => {
    const body = event('evt-json');
    const r = await post(body, { ...signedHeaders(body), 'content-type': 'application/json' });
    assert.equal(r.status, 503);
    assert.equal(await messages('evt-json'), 0);
  });
});
