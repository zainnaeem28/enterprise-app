// Real-database test of the patient module's routes through the API's COMPOSITION ROOT (INT03-F13, decision HEAAA-354 rev 2): the
// routes `buildComposition` mounts answer for the self patient, are refused for another patient (audited 404), for a proxy, for a wrong
// realm and without a session, and the lookup limit is the shared PgRateLimiter. PostgreSQL 17, the identity guard, a real HTTP server.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/composition-patient.dbtest.js
// The URL names a superuser on a throwaway server. Missing configuration FAILS; nothing skips. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createLogger, syncTaskTypes } from '@ehr/kernel';
import { buildComposition } from './composition.js';
import { loadIdentityEnv } from './identity-env.js';
import { createApp } from './platform/app.js';
import {
  CSRF_KEY,
  MATCH_KEY,
  MIN_RELEASE,
  ORG,
  PATIENT_HOST,
  STAFF_HOST,
  adminUrl,
  call,
  id,
  now,
  patientAccount,
  pg,
  registerViaApi,
  saWrite,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
} from './modules/patient/testkit.js';
import type { Kit, SeededSession } from './modules/patient/testkit.js';

const K = 'k'.repeat(40);
const A1 = id(101);
const ENV = {
  EHR_ORGANISATION_ID: ORG,
  EHR_STAFF_HOST: STAFF_HOST,
  EHR_PATIENT_HOST: PATIENT_HOST,
  EHR_ALLOWED_ORIGINS: `https://${STAFF_HOST},https://${PATIENT_HOST}`,
  EHR_OIDC_STATE_KEY: K,
  EHR_CSRF_KEY: CSRF_KEY,
  EHR_RATE_KEY: K,
  EHR_MATCH_CHECK_KEY: MATCH_KEY,
  EHR_CHECKIN_QR_KEY: K,
  EHR_STAFF_OIDC_CLIENT_ID: 'staff',
  EHR_STAFF_OIDC_CLIENT_SECRET: K,
  EHR_STAFF_OIDC_REDIRECT_URI: `https://${STAFF_HOST}/api/v1/auth/callback`,
  EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
  EHR_PATIENT_OIDC_ISSUER: 'https://idp.example.test',
  EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.test/authorize',
  EHR_PATIENT_OIDC_TOKEN_ENDPOINT: 'https://idp.example.test/token',
  EHR_PATIENT_OIDC_JWKS_URI: 'https://idp.example.test/jwks',
  EHR_PATIENT_OIDC_CLIENT_ID: 'patient',
  EHR_PATIENT_OIDC_REDIRECT_URI: `https://${PATIENT_HOST}/api/v1/auth/callback`,
};

let k: Kit;
let base: string;
let closeApp: () => Promise<void>;
let desk: SeededSession;
let me: SeededSession;
let mine: string;
let other: string;
let proxy: SeededSession;

const who = (n: number) => ({
  givenName: `Comp${n}`,
  familyName: `Fam${n}`,
  dateOfBirth: '1985-03-09',
  phone: `+1212888${String(1000 + n)}`,
  email: `comp${n}@example.test`,
});
const send = (
  s: SeededSession | undefined,
  method: string,
  path: string,
  o: { host?: string; body?: unknown; headers?: Record<string, string>; idem?: boolean } = {},
) => {
  const host = o.host ?? STAFF_HOST;
  return call(base, method, path, {
    host,
    ...(s === undefined ? {} : { cookie: s.cookie }),
    headers: {
      ...(s !== undefined && method !== 'GET' ? writeHeaders(s, host) : {}),
      ...(o.idem === true ? { 'idempotency-key': randomUUID() } : {}),
      ...o.headers,
    },
    ...(o.body === undefined ? {} : { body: o.body }),
  });
};
const asPatient = (s: SeededSession | undefined, method: string, path: string, o = {}) =>
  send(s, method, path, { host: PATIENT_HOST, ...o });
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
const notVisible = async (): Promise<number> =>
  Number(
    (
      await k.q<{ n: string }>(
        `SELECT count(*) AS n FROM audit.event WHERE action = 'denied' AND denial_reason = 'not_visible'`,
      )
    )[0]?.n,
  );

before(async () => {
  assert.ok(adminUrl, 'EHR_TEST_ADMIN_URL must name a throwaway PostgreSQL 17 server');
  k = await setup({ name: 'f13', fixtures: standardFixtures });
  // The composed API: the same function main.ts calls, over the kit's database. The kit's own app serves the same database.
  const c = buildComposition({
    db: k.db,
    logger: createLogger({ sink: () => undefined }),
    identity: loadIdentityEnv(ENV),
    now,
  });
  // The composed queue publishes `audit.btg_opened` and the like: the database must know the API's task types.
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, c.registry);
  await wc.end();
  const app = await createApp({
    config: {
      minClientRelease: MIN_RELEASE,
      instanceCount: 1,
      integrationsHost: undefined,
      port: 0,
      requestTimeoutMs: 15_000,
    },
    logger: createLogger({ sink: () => undefined }),
    readiness: { missingRelations: () => Promise.resolve([]) },
    policy: c.policy,
    // The platform's general per-principal limit (31.3) is not under test; the lookup limit is the patient controller's own.
    limiter: { hit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 1 }) },
    controllers: c.controllers,
  });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  closeApp = () => app.close();

  desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
  // Patients are registered through the composed API (POST /patients/match and /patients are newly mounted routes).
  const composedKit = { ...k, base } as Kit;
  mine = await registerViaApi(composedKit, desk, A1, who(1));
  other = await registerViaApi(composedKit, desk, A1, who(2));
  me = await patientAccount(k, mine);
  proxy = await patientAccount(k, undefined, 'Proxy Person');
  await saWrite(
    k,
    `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status) VALUES (gen_random_uuid(), $1, $2, $3, 'parent', 'F13', 'active')`,
    [ORG, proxy.seeded.principalId, mine],
  );
});
after(async () => {
  await closeApp?.();
  await k?.close();
});

describe('INT03-F13: the patient routes through the composition root', () => {
  test('2: the self patient reaches profile, communication preferences (read and write) and proxies; proxy requests are refused until D-7', async () => {
    const profile = await asPatient(me, 'GET', `/api/v1/patients/${mine}/profile`);
    assert.equal(profile.status, 200, profile.body);
    assert.ok(profile.headers['etag'], 'ETag on the profile');
    const prefs = await asPatient(me, 'GET', `/api/v1/patients/${mine}/communication-preferences`);
    assert.equal(prefs.status, 200, prefs.body);
    assert.equal(
      prefs.json()['stored'],
      false,
      'nothing stored yet: the first write needs no If-Match',
    );
    const path = `/api/v1/patients/${mine}/communication-preferences`;
    const first = await asPatient(me, 'PUT', path, {
      body: { channels: ['email'], language: 'en' },
    });
    assert.equal(first.status, 200, first.body);
    const second = await asPatient(me, 'PUT', path, {
      body: { channels: ['email', 'sms'], language: 'en' },
      headers: { 'if-match': String(first.headers['etag']) },
    });
    assert.equal(second.status, 200, second.body);
    const proxies = await asPatient(me, 'GET', `/api/v1/patients/${mine}/proxies`);
    assert.equal(proxies.status, 200, proxies.body);
    const req = await asPatient(me, 'POST', `/api/v1/patients/${mine}/proxy-requests`, {
      body: { relationship: 'parent' },
      idem: true,
    });
    assert.equal(req.status, 422, req.body);
    assert.equal(code(req), 'identity.proxy_rules_not_configured');
  });

  test('3: another patient is a 404 on profile, communication preferences and contacts, and the guard audits not_visible', async () => {
    for (const p of ['profile', 'communication-preferences', 'contacts']) {
      const before = await notVisible();
      const r = await asPatient(me, 'GET', `/api/v1/patients/${other}/${p}`);
      assert.equal(r.status, 404, `${p} ${r.body}`);
      assert.equal(code(r), 'kernel.not_found', p);
      assert.equal(await notVisible(), before + 1, `${p}: an audited denial, not an unmounted 404`);
    }
  });

  test('4: without a session every newly mounted route is 401 (not 404); a wrong-realm session is refused', async () => {
    const zero = '00000000-0000-7000-8000-000000000001';
    const routes: [string, string][] = [
      ['POST', '/api/v1/patients/self-registration'],
      ['GET', `/api/v1/patients/${zero}/profile`],
      ['PATCH', `/api/v1/patients/${zero}/profile`],
      ['GET', `/api/v1/patients/${zero}/communication-preferences`],
      ['GET', `/api/v1/patients/${zero}/proxies`],
      ['POST', `/api/v1/consents/${zero}/sign`],
      ['POST', '/api/v1/patients/search'],
      ['POST', '/api/v1/patients/lookup'],
      ['GET', `/api/v1/patients/${zero}`],
      ['GET', '/api/v1/duplicate-flags'],
      ['GET', '/api/v1/admin/consents'],
      ['POST', '/api/v1/admin/patient-labels'],
      ['POST', '/api/v1/patient-merges'],
      ['GET', `/api/v1/patient-merges/${zero}`],
      ['POST', `/api/v1/patient-merges/${zero}/approve`],
      ['POST', `/api/v1/patient-merges/${zero}/reject`],
    ];
    for (const [m, p] of routes) {
      const r = await send(undefined, m, p);
      assert.equal(r.status, 401, `${m} ${p} ${r.body}`);
    }
    // A patient session on staff-only routes, a google session on the admin route.
    for (const [m, p] of [
      ['POST', '/api/v1/patients/lookup'],
      ['POST', '/api/v1/patient-merges'],
    ] as const) {
      const r = await asPatient(me, m, p, { body: {}, idem: true });
      assert.ok([401, 403, 404].includes(r.status), `${m} ${p} ${r.status} ${r.body}`);
    }
    const lab = await send(desk, 'POST', '/api/v1/admin/patient-labels', { body: {} });
    assert.ok([401, 403, 404].includes(lab.status), `${lab.status} ${lab.body}`);
  });

  test('5: a proxy (scope appointments) cannot read or change the principal patient profile', async () => {
    const patch = await asPatient(proxy, 'PATCH', `/api/v1/patients/${mine}/profile`, {
      body: { preferredName: 'Nope' },
      headers: { 'if-match': '"1"' },
    });
    assert.ok([403, 404].includes(patch.status), `${patch.status} ${patch.body}`);
    const read = await asPatient(proxy, 'GET', `/api/v1/patients/${mine}/profile`);
    assert.equal(read.status, 404, read.body);
  });

  test('6: the 31st POST /patients/lookup within a minute from one staff principal is 429 kernel.rate_limited with Retry-After (PgRateLimiter)', async () => {
    const dr = await staffMember(k, 'doctor', A1, 'Doctor rate');
    const body = { mrn: 'MRN-9999999' };
    for (let i = 0; i < 30; i += 1)
      assert.equal(
        (await send(dr, 'POST', '/api/v1/patients/lookup', { body })).status,
        200,
        `call ${i + 1}`,
      );
    const over = await send(dr, 'POST', '/api/v1/patients/lookup', { body });
    assert.equal(over.status, 429, over.body);
    assert.equal(code(over), 'kernel.rate_limited');
    assert.ok(over.headers['retry-after'], 'Retry-After header');
    // The counter is in the database (shared across instances), not in this process.
    const rows = await k.q<{ n: string }>(`SELECT count(*) AS n FROM kernel.rate_counter`);
    assert.ok(Number(rows[0]?.n) > 0);
  });

  test('7: break-the-glass and the telehealth routes are mounted (QA-EXEC-F01, F03); an unassigned doctor is told btgAvailable and opens a grant', async () => {
    const zero = '00000000-0000-7000-8000-000000000001';
    for (const [m, p] of [
      ['POST', `/api/v1/patients/${mine}/break-glass`],
      ['GET', `/api/v1/appointments/${zero}/video-session`],
      ['GET', `/api/v1/appointments/${zero}/video-session/host`],
    ] as const) {
      const r = await send(undefined, m, p);
      assert.equal(r.status, 401, `${m} ${p} ${r.body}`);
    }
    const dr = await staffMember(k, 'doctor', A1, 'Doctor btg');
    const blocked = await send(dr, 'GET', `/api/v1/patients/${mine}/chart-summary`);
    assert.equal(blocked.status, 403, blocked.body);
    assert.equal(code(blocked), 'clinical.not_assigned');
    assert.equal(blocked.json()['btgAvailable'], true);
    const short = await send(dr, 'POST', `/api/v1/patients/${mine}/break-glass`, {
      body: { reason: 'too short' },
      idem: true,
    });
    assert.equal(short.status, 422, short.body);
    const key = randomUUID();
    const open = await send(dr, 'POST', `/api/v1/patients/${mine}/break-glass`, {
      body: { reason: 'Emergency access, synthetic test' },
      headers: { 'idempotency-key': key },
    });
    assert.equal(open.status, 201, open.body);
    assert.ok(open.json()['grantId'] && open.json()['expiresAt']);
    const replay = await send(dr, 'POST', `/api/v1/patients/${mine}/break-glass`, {
      body: { reason: 'Emergency access, synthetic test' },
      headers: { 'idempotency-key': key },
    });
    assert.equal(replay.status, 201, replay.body);
    assert.equal(replay.json()['grantId'], open.json()['grantId']);
    const grants = await k.q<{ n: string }>(
      `SELECT count(*) AS n FROM audit.btg_grant WHERE patient_id = $1`,
      [mine],
    );
    assert.equal(Number(grants[0]?.n), 1, 'the replay opened no second grant');
    assert.equal((await send(dr, 'GET', `/api/v1/patients/${mine}/chart-summary`)).status, 200);
  });

  test('8: R3-F01 / BR-34: GET /patients/{id} carries the same ARCH 28.2 banner as GET /patients/{id}/banner (displayName, allergies with coded and uncoded marks)', async () => {
    await saWrite(
      k,
      `INSERT INTO clinical.allergy (id, organisation_id, patient_id, code_system, code, display, coded, category, severity, recorded_by)
       VALUES (gen_random_uuid(), $1, $2, 'rxnorm', '70001', 'Synthetic coded allergy', true, 'drug', 'severe', $3),
              (gen_random_uuid(), $1, $2, NULL, NULL, 'Synthetic free-text allergy', false, 'food', 'mild', $3)`,
      [ORG, mine, desk.seeded.principalId],
    );
    const full = await send(desk, 'GET', `/api/v1/patients/${mine}`);
    const only = await send(desk, 'GET', `/api/v1/patients/${mine}/banner`);
    assert.equal(full.status, 200, full.body);
    assert.equal(only.status, 200, only.body);
    const a = full.json()['patientBanner'] as Record<string, unknown>;
    const b = only.json()['patientBanner'] as Record<string, unknown>;
    assert.deepEqual(a, b, 'the two routes return the same banner');
    assert.equal(a['displayName'], 'Comp1 Fam1');
    assert.equal(a['patientId'], mine);
    const al = a['allergies'] as {
      state: string;
      items: { coded: boolean }[];
      uncodedCount: number;
    };
    assert.equal(al.state, 'recorded');
    assert.equal(al.items.length, 2);
    assert.equal(al.uncodedCount, 1);
    assert.deepEqual(al.items.map((i) => i.coded).sort(), [false, true]);
    assert.equal(a['givenName'], undefined, 'no legacy PatientBanner fields');
    assert.ok(full.json()['patient'], 'the demographics remain');
    assert.ok(full.headers['etag']);
  });
});
