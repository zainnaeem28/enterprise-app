// HTTP tests of the patient catalogue routes: a real Nest app with the real platform layer (guard, release check, headers) and a
// recording database. They prove mounting, authentication, the scope used and the shape of the answer. Persistence and the real C0
// views are not proved here (see organisation.dbtest.ts).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLogger } from '@ehr/kernel';
import type { KernelDb, ScopeSettings, Tx } from '@ehr/kernel';
import { MIN_RELEASE, R, start } from '../../../test/platform/harness.js';
import type { Running } from '../../../test/platform/harness.js';
import { ApiError } from '../../platform/errors.js';
import type { GuardPolicy } from '../../platform/guard.js';
import { buildComposition } from '../../composition.js';
import { loadIdentityEnv } from '../../identity-env.js';
import { createCatalogueControllers } from './catalogue.controller.js';

const K = 'k'.repeat(40);
const FAKE_ENV = {
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
const ORG = '00000000-0000-4000-8000-0000000000a1';
const L1 = '00000000-0000-4000-8000-000000000011';
const scopes: ScopeSettings[] = [];
const sqls: string[] = [];
const db = {
  withScope: (scope: ScopeSettings, fn: (tx: Tx) => Promise<unknown>) => {
    scopes.push(scope);
    return fn({
      query: (sql: string) => {
        sqls.push(sql);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Tx);
  },
} as unknown as KernelDb;

const SCOPE = { audience: 'patient', orgId: ORG } as unknown as ScopeSettings;
const organisation = {
  directoryLocations: () =>
    Promise.resolve([
      {
        id: L1,
        name: 'Main',
        kind: 'clinic' as const,
        timeZone: 'UTC',
        address: {},
        stateCode: 'NY',
        geo: null,
        phone: null,
      },
    ]),
  directoryServices: () => {
    return Promise.resolve([
      { id: 's1', patientDisplayName: 'Check-up', durationMin: 20, mode: 'either' as const },
    ]);
  },
};

// A policy that stands in for identity: a request with `x-test-session` is a patient-realm caller, anything else is 401.
const policy: GuardPolicy = {
  authorize: (req, decl) =>
    decl.permission === 'patient' && req.header('x-test-session') === 'p'
      ? Promise.resolve()
      : Promise.reject(new ApiError(401, 'auth.unauthenticated')),
};

let s: Running;
before(async () => {
  s = await start({
    policy,
    controllers: createCatalogueControllers({ db, organisation, scopeOf: () => SCOPE }),
  });
});
after(async () => {
  await s.close();
});

const get = (path: string, session = true) =>
  fetch(`${s.base}${path}`, {
    headers: { 'x-client-release': R(MIN_RELEASE), ...(session ? { 'x-test-session': 'p' } : {}) },
  });

describe('GET /api/v1/services | /locations', () => {
  test('authenticated patient: 200, no-store, items from the directory readers, under the caller scope', async () => {
    scopes.length = 0;
    for (const p of ['/api/v1/services', '/api/v1/locations']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const b = (await r.json()) as { items: { id: string }[]; nextCursor: null };
      assert.equal(b.items.length, 1);
      assert.equal(b.nextCursor, null);
    }
    assert.deepEqual(scopes, [SCOPE, SCOPE]);
    assert.ok(sqls.every((q) => /read_only/.test(q)));
  });
  test('no session: 401 and the database is not touched', async () => {
    scopes.length = 0;
    for (const p of ['/api/v1/services', '/api/v1/locations']) {
      assert.equal((await get(p, false)).status, 401, p);
    }
    assert.equal(scopes.length, 0);
  });
  test('a repeated locationId is a 400', async () => {
    assert.equal((await get('/api/v1/services?locationId=a&locationId=b')).status, 400);
  });
});

describe('composition root', () => {
  test('buildComposition mounts both catalogue routes, refused without a session under the identity policy', async () => {
    const c = buildComposition({
      db: db as unknown as KernelDb,
      logger: createLogger({ sink: () => undefined }),
      identity: loadIdentityEnv(FAKE_ENV),
    });
    const t = await start({ controllers: c.controllers, policy: c.policy });
    try {
      for (const p of ['/api/v1/services', '/api/v1/locations']) {
        const r = await fetch(`${t.base}${p}`, { headers: { 'x-client-release': R(MIN_RELEASE) } });
        assert.equal(r.status, 401, p); // mounted (not 404) and refused without a session
      }
    } finally {
      await t.close();
    }
  });
});
