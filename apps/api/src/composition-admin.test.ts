// The admin realm is composed (INT04-F01): BE-05 ceremonies, BE-23 organisation routes and BE-24 audit and integration routes are
// mounted exactly once, behind the realm guard, and absent when no admin configuration is given. A fake database is enough here
// (wiring, route inventory, guard in front of each route); the real-database guard run is composition-admin.dbtest.ts.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLogger } from '@ehr/kernel';
import type { KernelDb } from '@ehr/kernel';
import { MIN_RELEASE, R, start } from '../test/platform/harness.js';
import type { Running } from '../test/platform/harness.js';
import { PEM } from './admin-env.test.js';
import { loadAdminEnv } from './admin-env.js';
import { buildComposition } from './composition.js';
import { loadIdentityEnv } from './identity-env.js';
import { inventory } from './platform/inventory.js';

const K = 'k'.repeat(40);
const ENV = {
  EHR_ORGANISATION_ID: '00000000-0000-7000-8000-0000000000a1',
  EHR_STAFF_HOST: 'staff.example.test',
  EHR_PATIENT_HOST: 'my.example.test',
  EHR_ALLOWED_ORIGINS: 'https://staff.example.test,https://my.example.test',
  EHR_OIDC_STATE_KEY: K,
  EHR_CSRF_KEY: K,
  EHR_RATE_KEY: K,
  EHR_MATCH_CHECK_KEY: K,
  EHR_CHECKIN_QR_KEY: K,
  EHR_STAFF_OIDC_CLIENT_ID: 'staff',
  EHR_STAFF_OIDC_CLIENT_SECRET: K,
  EHR_STAFF_OIDC_REDIRECT_URI: 'https://staff.example.test/api/v1/auth/callback',
  EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
  EHR_PATIENT_OIDC_ISSUER: 'https://idp.example.test',
  EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.test/authorize',
  EHR_PATIENT_OIDC_TOKEN_ENDPOINT: 'https://idp.example.test/token',
  EHR_PATIENT_OIDC_JWKS_URI: 'https://idp.example.test/jwks',
  EHR_PATIENT_OIDC_CLIENT_ID: 'patient',
  EHR_PATIENT_OIDC_REDIRECT_URI: 'https://my.example.test/api/v1/auth/callback',
};
const identity = loadIdentityEnv(ENV);
const admin = loadAdminEnv(
  {
    EHR_ADMIN_ATTESTATION_ROOTS_PEM: PEM,
    EHR_ADMIN_ALLOWED_AAGUIDS: '2fc0579f-8113-47ea-b116-bb5a8db9202a',
    EHR_ADMIN_DECOY_KEY: 'd'.repeat(40),
  },
  identity,
);
const build = (withAdmin: boolean) =>
  buildComposition({
    db: {} as unknown as KernelDb,
    logger: createLogger({ sink: () => undefined }),
    identity,
    ...(withAdmin ? { admin } : {}),
  });

/** One route of each admin controller. */
const ADMIN_ROUTES = [
  'POST /api/v1/admin/audit-events/search',
  'POST /api/v1/admin/audit-exports',
  'GET /api/v1/admin/btg-grants',
  'GET /api/v1/admin/integrations',
  'PUT /api/v1/admin/integrations/:id/secrets/:name',
  'GET /api/v1/admin/locations',
  'POST /api/v1/admin/locations',
  'GET /api/v1/admin/settings',
];
const CEREMONY = 'POST /api/v1/admin/auth/elevation/options';

const keys = (c: ReturnType<typeof build>): string[] =>
  inventory(c.controllers as never).routes.map((r) => `${r.method} ${r.path}`);
const hostKeys = (c: ReturnType<typeof build>): string[] =>
  inventory(c.controllers as never).routes.map((r) => `${r.method} ${r.host ?? '*'} ${r.path}`);

describe('admin realm composition (INT04-F01)', () => {
  let on: ReturnType<typeof build>;
  let off: ReturnType<typeof build>;
  let tOn: Running;
  let tOff: Running;
  before(async () => {
    on = build(true);
    off = build(false);
    tOn = await start({ controllers: on.controllers, policy: on.policy });
    tOff = await start({ controllers: off.controllers, policy: off.policy });
  });
  after(async () => {
    await tOn.close();
    await tOff.close();
  });

  test('BE-05, BE-23 and BE-24 routes are mounted, each (method, path) once, and every route declares permission and resolver', () => {
    const mounted = keys(on);
    for (const r of [...ADMIN_ROUTES, CEREMONY])
      assert.equal(mounted.filter((m) => m === r).length, 1, r); // not shared with any other controller
    const bound = hostKeys(on);
    assert.equal(new Set(bound).size, bound.length, 'no (method, host, path) is mounted twice');
    assert.deepEqual(
      inventory(on.controllers as never).failures,
      [],
      'route inventory has no failures',
    );
    assert.ok(on.registry.list().some((j) => j.name === 'identity.admin_event'));
  });

  test('without the admin configuration none of them is mounted (negative control)', () => {
    const mounted = keys(off);
    for (const r of [...ADMIN_ROUTES, CEREMONY]) assert.ok(!mounted.includes(r), r);
  });

  test('every admin route is refused without a session (401), not 404, and the realm has no elevation bypass', async () => {
    for (const p of [
      '/api/v1/admin/integrations',
      '/api/v1/admin/locations',
      '/api/v1/admin/btg-grants',
    ]) {
      const r = await fetch(`${tOn.base}${p}`, { headers: { 'x-client-release': R(MIN_RELEASE) } });
      assert.equal(r.status, 401, p);
      const gone = await fetch(`${tOff.base}${p}`, {
        headers: { 'x-client-release': R(MIN_RELEASE) },
      });
      assert.equal(gone.status, 404, `${p} unmounted`);
    }
  });
});
