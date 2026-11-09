// The REAL production composition against a real database and a real OIDC IdP process-side: `loadIdentityEnv` -> `buildComposition` ->
// `createApp` (the same three calls `main.ts` makes), not a test harness composition. A patient signs in through the callback and
// then reaches the booking routes. Fails (never skips) without EHR_TEST_ADMIN_URL. Synthetic data only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/test/composition.dbtest.js
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLogger } from '@ehr/kernel';
import { buildComposition } from '../src/composition.js';
import { loadIdentityEnv } from '../src/identity-env.js';
import { call, ORG, PATIENT_HOST, setup, STAFF_HOST } from '../src/modules/identity/testkit.js';
import type { Kit, Resp } from '../src/modules/identity/testkit.js';
import { createApp } from '../src/platform/app.js';

const K = 'c'.repeat(48);
let k: Kit;
let app: Awaited<ReturnType<typeof createApp>>;
let base = '';
let cookie = '';
let csrf = '';

const patientCall = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Resp> =>
  call(base, method, path, {
    host: PATIENT_HOST,
    cookie,
    headers: { origin: `https://${PATIENT_HOST}`, 'x-csrf-token': csrf, ...headers },
    ...(body === undefined ? {} : { body }),
  });

before(async () => {
  k = await setup({ name: 'composition', withApp: false });
  // The configuration a CI deployment gives the process: endpoints of an OIDC provider (here the local conformance IdP) and generated keys.
  const e = k.idp.endpoints;
  const env = loadIdentityEnv({
    EHR_ORGANISATION_ID: ORG,
    EHR_STAFF_HOST: STAFF_HOST,
    EHR_PATIENT_HOST: PATIENT_HOST,
    EHR_ALLOWED_ORIGINS: `https://${STAFF_HOST},https://${PATIENT_HOST}`,
    EHR_OIDC_STATE_KEY: K,
    EHR_CSRF_KEY: K + '1',
    EHR_RATE_KEY: K + '2',
    EHR_MATCH_CHECK_KEY: K + '3',
    EHR_CHECKIN_QR_KEY: K + '4',
    EHR_STAFF_OIDC_ISSUER: e.issuer,
    EHR_STAFF_OIDC_AUTHORIZATION_ENDPOINT: e.authorizationEndpoint,
    EHR_STAFF_OIDC_TOKEN_ENDPOINT: e.tokenEndpoint,
    EHR_STAFF_OIDC_JWKS_URI: e.jwksUri,
    EHR_STAFF_OIDC_CLIENT_ID: k.idp.clientId,
    EHR_STAFF_OIDC_CLIENT_SECRET: 'x'.repeat(24),
    EHR_STAFF_OIDC_REDIRECT_URI: `https://${STAFF_HOST}/api/v1/auth/callback`,
    EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
    EHR_PATIENT_OIDC_ISSUER: e.issuer,
    EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: e.authorizationEndpoint,
    EHR_PATIENT_OIDC_TOKEN_ENDPOINT: e.tokenEndpoint,
    EHR_PATIENT_OIDC_JWKS_URI: e.jwksUri,
    EHR_PATIENT_OIDC_CLIENT_ID: k.idp.clientId,
    EHR_PATIENT_OIDC_REDIRECT_URI: `https://${PATIENT_HOST}/api/v1/auth/callback`,
  });
  const c = buildComposition({
    db: k.db,
    logger: createLogger({ sink: () => undefined }),
    identity: env,
  });
  app = await createApp({
    config: {
      minClientRelease: 141,
      instanceCount: 1,
      integrationsHost: undefined,
      port: 0,
      requestTimeoutMs: 15_000,
    },
    logger: createLogger({ sink: () => undefined }),
    readiness: { missingRelations: () => Promise.resolve([]) },
    policy: c.policy,
    controllers: c.controllers,
  });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});
after(async () => {
  await app?.close();
  await k?.close();
});

describe('production composition root', () => {
  test('without a session the identity and booking routes are mounted and refuse (not 404)', async () => {
    const s = await call(base, 'GET', '/api/v1/auth/session', { host: PATIENT_HOST });
    assert.equal(s.status, 401);
    for (const [m, p] of [
      ['GET', '/api/v1/services'],
      ['GET', '/api/v1/locations'],
      ['GET', '/api/v1/clinicians'],
      ['POST', '/api/v1/availability/search'],
      ['POST', '/api/v1/holds'],
    ] as const) {
      const r = await call(base, m, p, {
        host: PATIENT_HOST,
        ...(m === 'POST' ? { body: {} } : {}),
      });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    const start = await call(base, 'GET', '/api/v1/auth/sign-in?returnTo=%2Fbook', {
      host: PATIENT_HOST,
    });
    assert.equal(start.status, 302);
  });

  test('M4 (INT03-F01): the clinical, messaging, privacy and reporting routes are mounted and refuse without a session (not 404)', async () => {
    const id = '00000000-0000-7000-8000-000000000001';
    for (const [host, m, p] of [
      [PATIENT_HOST, 'GET', `/api/v1/appointments/${id}/questionnaire`],
      [PATIENT_HOST, 'GET', '/api/v1/privacy-requests'],
      [PATIENT_HOST, 'POST', '/api/v1/privacy-requests'],
      [PATIENT_HOST, 'GET', `/api/v1/patients/${id}/threads`],
      [STAFF_HOST, 'GET', `/api/v1/patients/${id}/banner`],
      [STAFF_HOST, 'GET', `/api/v1/patients/${id}/chart-summary`],
      [STAFF_HOST, 'POST', `/api/v1/check-ins/${id}/triage`],
      [STAFF_HOST, 'POST', '/api/v1/encounters'],
      [STAFF_HOST, 'POST', `/api/v1/notes/${id}/sign`],
      [STAFF_HOST, 'GET', '/api/v1/threads'],
      [STAFF_HOST, 'GET', '/api/v1/tasks'],
      [STAFF_HOST, 'GET', '/api/v1/admin/privacy-requests'],
      [STAFF_HOST, 'GET', '/api/v1/admin/reports/ops'],
    ] as const) {
      const r = await call(base, m, p, { host, ...(m === 'POST' ? { body: {} } : {}) });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });

  test('a patient signs in through the callback and reaches session, catalogue, clinicians, search and holds', async () => {
    k.idp.nextLogin = {
      sub: 'sub-composition-patient',
      email: 'p@example.org',
      email_verified: true,
    };
    const start = await call(base, 'GET', '/api/v1/auth/sign-in?returnTo=%2Fbook', {
      host: PATIENT_HOST,
    });
    const oidc = start.setCookies.find((c) => c.startsWith('__Host-oidc='))?.split(';')[0] ?? '';
    const r = await fetch(String(start.headers['location']), { redirect: 'manual' });
    const back = new URL(r.headers.get('location') ?? '');
    const cb = await call(base, 'GET', `${back.pathname}${back.search}`, {
      host: PATIENT_HOST,
      cookie: oidc,
      headers: { 'x-forwarded-for': '198.18.9.9' },
      release: false,
    });
    assert.equal(cb.status, 302, cb.body);
    const sid = cb.setCookies.find(
      (c) => c.startsWith('__Host-sid=') || c.startsWith('__Host-session'),
    );
    assert.ok(sid, `session cookie set: ${cb.setCookies.join('|')}`);
    cookie = sid.split(';')[0] as string;

    const session = await patientCall('GET', '/api/v1/auth/session');
    assert.equal(session.status, 200, session.body);
    csrf = String(session.json()['csrfToken']);
    assert.ok(csrf.length > 0);

    for (const p of ['/api/v1/services', '/api/v1/locations', '/api/v1/clinicians']) {
      const x = await patientCall('GET', p);
      assert.equal(x.status, 200, `${p}: ${x.body}`);
      assert.ok(Array.isArray(x.json()['items']), p);
    }
    const bad = await patientCall('GET', '/api/v1/clinicians?serviceId=nope');
    assert.equal(bad.status, 400);

    // Search is validated by the real handler (empty body: 400/422). A hold with no resolvable patient is refused by the guard's resolver
    // (404 masks, 4xx); the unauthenticated 401 above is what proves the route is mounted. A full booking needs seeded clinicians (follow-up).
    const search = await patientCall('POST', '/api/v1/availability/search', {});
    assert.ok(
      search.status === 400 || search.status === 422,
      `search ${search.status} ${search.body}`,
    );
    const hold = await patientCall(
      'POST',
      '/api/v1/holds',
      {},
      { 'idempotency-key': 'composition-hold-1' },
    );
    assert.ok(hold.status >= 400 && hold.status < 500, `hold ${hold.status} ${hold.body}`);

    // M4 through the real stack (guard, scope, real database): the signed-in patient lists their own privacy requests (none yet).
    const requests = await patientCall('GET', '/api/v1/privacy-requests');
    assert.equal(requests.status, 200, `privacy-requests ${requests.status} ${requests.body}`);
    // A staff-only M4 route is refused for a patient-realm session (authorization is the guard's, not the UI's).
    const ops = await patientCall('GET', '/api/v1/admin/reports/ops');
    assert.ok(ops.status === 401 || ops.status === 403 || ops.status === 404, `ops ${ops.status}`);
  });
});
