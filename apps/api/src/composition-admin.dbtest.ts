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

describe('TC-AD-09 (server half): maintenance banner read routes, composed (HEAAA-645, amendment A-8)', () => {
  const PUBLIC_HOST = 'site.example.test';
  const OTHER_ORG = '00000000-0000-7000-8000-0000000000e9';
  const hour = 3_600_000;
  const iso = (offset: number): string => new Date(Date.now() + offset).toISOString();
  const ids: Record<string, string> = {};
  let patient: Awaited<ReturnType<typeof seedSession>>;
  let google: Awaited<ReturnType<typeof seedSession>>;

  const read = (host: string, path: string, s?: { cookie: string }): ReturnType<typeof call> =>
    call(k.adminBase, 'GET', path, {
      host,
      ...(s === undefined ? {} : { cookie: s.cookie }),
    });
  const readIds = (r: { json(): Record<string, unknown> }): string[] =>
    (r.json()['items'] as { id: string }[]).map((x) => x.id).sort();
  const post = async (surface: string, message: string, startsAt: string, endsAt: string) => {
    const r = await api(k, org, 'PUT', '/banners', { surface, message, startsAt, endsAt });
    assert.equal(r.status, 200, r.body);
    return String(r.json()['id']);
  };

  before(async () => {
    for (const surface of ['site', 'patient', 'staff', 'partner'])
      ids[surface] = await post(surface, `Current ${surface} notice`, iso(-hour), iso(hour));
    ids['expired'] = await post('patient', 'Expired patient notice', iso(-3 * hour), iso(-hour));
    ids['future'] = await post('staff', 'Future staff notice', iso(hour), iso(3 * hour));
    // A banner of another organisation, inserted as the superuser (the admin API cannot write across organisations).
    for (const surface of ['site', 'patient', 'staff'])
      await kit.sa.query(
        `INSERT INTO organisation.banner (id, organisation_id, surface, message, starts_at, ends_at)
         VALUES (gen_random_uuid(), $1, $2, 'Other organisation notice', now() - interval '1 hour', now() + interval '1 hour')`,
        [OTHER_ORG, surface],
      );
    patient = await seedSession(
      kit,
      await seedPrincipal(kit, 'patient_pool', { name: 'Banner Patient' }),
      'patient_pool',
    );
    google = await seedSession(
      kit,
      await seedPrincipal(kit, 'google', { subject: 'banner-staff-sub' }),
      'google',
    );
  });

  test('1: a patient session on my. gets the current patient banner only, in the four-field shape', async () => {
    const r = await read(PATIENT_HOST, '/api/v1/banners', patient);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(readIds(r), [ids['patient']]);
    assert.equal(r.json()['nextCursor'], null);
    assert.deepEqual(Object.keys((r.json()['items'] as object[])[0]!).sort(), [
      'endsAt',
      'id',
      'message',
      'startsAt',
    ]);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('2: google and admin_pool sessions on staff. get the current staff banner only', async () => {
    const g = await read(STAFF_HOST, '/api/v1/banners', google);
    assert.equal(g.status, 200, g.body);
    assert.deepEqual(readIds(g), [ids['staff']]);
    const a = await read(STAFF_HOST, '/api/v1/banners', org.session);
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(readIds(a), [ids['staff']]);
  });

  test('3: no session is 401 auth.unauthenticated; any query parameter is 400 kernel.validation_failed', async () => {
    const none = await read(PATIENT_HOST, '/api/v1/banners');
    assert.equal(none.status, 401);
    assert.equal(code(none), 'auth.unauthenticated');
    for (const [host, s] of [
      [PATIENT_HOST, patient],
      [STAFF_HOST, google],
    ] as const) {
      const r = await read(host, '/api/v1/banners?surface=site', s);
      assert.equal(r.status, 400, r.body);
      assert.equal(code(r), 'kernel.validation_failed');
    }
  });

  test('4: GET /public/v1/banners needs no cookie, returns current site banners only, max-age=60, four fields', async () => {
    const r = await call(k.adminBase, 'GET', '/public/v1/banners', {
      host: PUBLIC_HOST,
      release: false,
    });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(readIds(r), [ids['site']]);
    assert.equal(r.headers['cache-control'], 'public, max-age=60');
    assert.deepEqual(Object.keys((r.json()['items'] as object[])[0]!).sort(), [
      'endsAt',
      'id',
      'message',
      'startsAt',
    ]);
    const q = await call(k.adminBase, 'GET', '/public/v1/banners?x=1', {
      host: PUBLIC_HOST,
      release: false,
    });
    assert.equal(q.status, 400, q.body);
    assert.equal(code(q), 'kernel.validation_failed');
    const w = await call(k.adminBase, 'POST', '/public/v1/banners', {
      host: PUBLIC_HOST,
      release: false,
      body: {},
    });
    assert.ok([404, 405].includes(w.status), `POST /public/v1/banners: ${w.status}`);
  });

  test('5: a banner of another organisation is never returned by either route', async () => {
    const all = [
      ...readIds(await read(PATIENT_HOST, '/api/v1/banners', patient)),
      ...readIds(await read(STAFF_HOST, '/api/v1/banners', google)),
      ...readIds(
        await call(k.adminBase, 'GET', '/public/v1/banners', { host: PUBLIC_HOST, release: false }),
      ),
    ];
    const foreign = await kit.q<{ id: string }>(
      `SELECT id FROM organisation.banner WHERE organisation_id = $1`,
      [OTHER_ORG],
    );
    assert.equal(foreign.length, 3);
    for (const f of foreign) assert.ok(!all.includes(f.id), `foreign banner ${f.id} leaked`);
  });

  test('6: after PUT /admin/banners {id, remove: true} the banner is absent from the next read', async () => {
    const extra = await post('patient', 'Second patient notice', iso(-hour), iso(2 * hour));
    assert.deepEqual(
      readIds(await read(PATIENT_HOST, '/api/v1/banners', patient)),
      [ids['patient']!, extra].sort(),
    );
    const del = await api(k, org, 'PUT', '/banners', { id: extra, remove: true });
    assert.equal(del.status, 200, del.body);
    assert.deepEqual(readIds(await read(PATIENT_HOST, '/api/v1/banners', patient)), [
      ids['patient'],
    ]);
  });

  test('7: audience public cannot read the base table organisation.banner (DR-5)', async () => {
    const rows = await kit.db.withScope({ audience: 'public', orgId: ORG }, async (tx) => {
      try {
        return (await tx.query(`SELECT id FROM organisation.banner`)).rows;
      } catch (e) {
        return (e as { code?: string }).code === '42501' ? [] : Promise.reject(e);
      }
    });
    assert.equal(rows.length, 0);
  });
});
