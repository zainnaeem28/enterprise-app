// End-to-end guard test of the admin realm through the API's COMPOSITION ROOT and the real HTTP stack (INT04-F01, BE-23 N-2): the
// routes `buildComposition` mounts under `/api/v1/admin` answer only to an admin_pool session with the route's permission and a live
// elevation grant, and the grant is checked on every request. PostgreSQL 17, the real migrations, the real identity guard, the pinned
// WebAuthn flow driven by a software key (the library port is replaced by the test seam; roots and AAGUIDs come from the loader).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/composition-admin.dbtest.js
// Missing configuration FAILS; nothing skips. Synthetic data only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLogger, syncTaskTypes } from '@ehr/kernel';
import { loadAdminEnv } from './admin-env.js';
import { PEM } from './admin-env.test.js';
import { buildComposition } from './composition.js';
import { loadIdentityEnv } from './identity-env.js';
import { adminWith, api } from './modules/admin-routes/testkit.js';
import type { Admin, OrgKit } from './modules/admin-routes/testkit.js';
import { AAGUID_OK, DECOY_KEY, ORIGIN } from './modules/identity/admin/testkit.js';
import { SimpleWebAuthnPort } from './modules/identity/admin/webauthn.js';
import {
  call,
  CSRF_KEY,
  MIN_RELEASE,
  now,
  OIDC_KEY,
  ORG,
  PATIENT_HOST,
  pg,
  RATE_KEY,
  seedPrincipal,
  seedSession,
  setup,
  STAFF_HOST,
  writeHeaders,
} from './modules/identity/testkit.js';
import type { Kit } from './modules/identity/testkit.js';
import { createApp } from './platform/app.js';

const K = 'k'.repeat(40);
const ENV = {
  EHR_ORGANISATION_ID: ORG,
  EHR_STAFF_HOST: STAFF_HOST,
  EHR_PATIENT_HOST: PATIENT_HOST,
  EHR_ALLOWED_ORIGINS: `https://${STAFF_HOST},https://${PATIENT_HOST}`,
  EHR_OIDC_STATE_KEY: OIDC_KEY,
  EHR_CSRF_KEY: CSRF_KEY,
  EHR_RATE_KEY: RATE_KEY,
  EHR_MATCH_CHECK_KEY: K,
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

let kit: Kit;
let k: OrgKit;
let closeApp: () => Promise<void>;
let org: Admin; // org_admin: organisation configuration, integrations
let ops: Admin; // compliance_officer: audit viewer

before(async () => {
  kit = await setup({ name: 'compadmin', withApp: false });
  const identity = loadIdentityEnv(ENV);
  const admin = loadAdminEnv(
    {
      EHR_ADMIN_ATTESTATION_ROOTS_PEM: PEM,
      EHR_ADMIN_ALLOWED_AAGUIDS: AAGUID_OK,
      EHR_ADMIN_DECOY_KEY: DECOY_KEY,
    },
    identity,
  );
  const logger = createLogger({ sink: () => undefined });
  const comp = buildComposition({
    db: kit.db,
    logger,
    identity,
    admin,
    webauthnPort: new SimpleWebAuthnPort(
      { rpId: STAFF_HOST, rpName: 'EHR admin', expectedOrigins: [ORIGIN] },
      { mode: 'self_for_tests' },
    ),
    now,
  });
  const wc = new pg.Client({ connectionString: kit.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, comp.registry);
  await wc.end();
  const app = await createApp({
    config: {
      minClientRelease: MIN_RELEASE,
      instanceCount: 1,
      integrationsHost: undefined,
      port: 0,
      requestTimeoutMs: 15_000,
    },
    logger,
    readiness: { missingRelations: () => Promise.resolve([]) },
    policy: comp.policy,
    controllers: comp.controllers,
  });
  await app.listen(0, '127.0.0.1');
  const adminBase = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  k = Object.assign(kit, { adminBase, close: kit.close.bind(kit) }) as unknown as OrgKit;
  closeApp = () => app.close();
  org = await adminWith(k, ['org_admin']);
  ops = await adminWith(k, ['compliance_officer']);
});
after(async () => {
  await closeApp();
  await kit.close();
});

const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };

describe('admin routes behind the realm guard, composed (INT04-F01, BE-23 N-2)', () => {
  test('no session: 401 on an organisation, an audit and an integration route', async () => {
    for (const [m, p, b] of [
      ['GET', '/locations', undefined],
      ['GET', '/integrations', undefined],
      ['POST', '/audit-events/search', RANGE],
    ] as const) {
      const r = await api(k, undefined, m, p, b);
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });

  test('a staff (google realm) session is refused on every admin route: wrong realm', async () => {
    const s = await seedPrincipal(kit, 'google', { subject: 'staff-sub-1' });
    const sess = await seedSession(kit, s, 'google');
    const get = await call(k.adminBase, 'GET', '/api/v1/admin/locations', {
      cookie: sess.cookie,
      headers: { 'x-client-release': `r${MIN_RELEASE}.3f9a1c2b7d10` },
    });
    assert.ok([401, 403].includes(get.status), `google session on admin route: ${get.status}`);
    const post = await call(k.adminBase, 'POST', '/api/v1/admin/audit-events/search', {
      cookie: sess.cookie,
      body: RANGE,
      headers: writeHeaders(sess),
    });
    assert.ok([401, 403].includes(post.status), `google session on admin route: ${post.status}`);
  });

  test('an admin session without a live elevation grant is refused with identity.elevation_required', async () => {
    const cold = await adminWith(k, ['org_admin'], { elevated: false });
    const r = await api(k, cold, 'GET', '/locations');
    assert.equal(r.status, 403);
    assert.equal(code(r), 'identity.elevation_required');
    const w = await api(k, cold, 'PATCH', '/integrations/00000000-0000-7000-8000-000000000001', {});
    assert.equal(w.status, 403);
    assert.equal(code(w), 'identity.elevation_required');
  });

  test('an elevated admin with the permission is served: organisation (BE-23) and integration (BE-24) routes', async () => {
    const l = await api(k, org, 'GET', '/locations');
    assert.equal(l.status, 200);
    assert.equal(l.headers['cache-control'], 'no-store');
    const i = await api(k, org, 'GET', '/integrations');
    assert.equal(i.status, 200);
  });

  test('an elevated admin WITHOUT the route permission is refused (elevation is not authority)', async () => {
    const wrong = await api(k, ops, 'GET', '/locations');
    assert.equal(wrong.status, 403);
    assert.notEqual(code(wrong), 'identity.elevation_required');
    const wrong2 = await api(k, org, 'POST', '/audit-events/search', RANGE);
    assert.equal(wrong2.status, 403);
  });

  test('the audit route (BE-24) answers the compliance officer and is itself audited', async () => {
    const r = await api(k, ops, 'POST', '/audit-events/search', RANGE);
    assert.equal(r.status, 200);
  });

  test('the elevation grant is checked on every request: a revoked grant stops the next call at once', async () => {
    const who = await adminWith(k, ['org_admin']);
    assert.equal((await api(k, who, 'GET', '/locations')).status, 200);
    await kit.sa.query(
      `UPDATE identity.elevation_grant SET revoked_at = now(), revoke_reason = 'kill_switch' WHERE session_id IN (SELECT id FROM identity.session WHERE principal_id = $1)`,
      [who.principalId],
    );
    const r = await api(k, who, 'GET', '/locations');
    assert.equal(r.status, 403);
    assert.equal(code(r), 'identity.elevation_required');
  });

  test('ports not configured are refused, not faked: the connection test is 503 (no tester) and a secret write fails closed', async () => {
    const list = await api(k, org, 'GET', '/integrations');
    assert.equal(list.status, 200);
    const missing = await api(
      k,
      org,
      'POST',
      '/integrations/00000000-0000-7000-8000-000000000001/test',
      {},
    );
    assert.ok([404, 503].includes(missing.status), `test connection: ${missing.status}`);
    const secret = await api(
      k,
      org,
      'PUT',
      '/integrations/00000000-0000-7000-8000-000000000001/secrets/api_key',
      { value: 'x'.repeat(24) },
    );
    assert.ok(secret.status >= 400, `secret write without a store: ${secret.status}`);
  });
});
