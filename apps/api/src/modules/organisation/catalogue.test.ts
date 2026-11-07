// HTTP tests of the patient catalogue routes: a real Nest app with the real platform layer (guard, release check, headers) and a
// recording database. They prove mounting, authentication, the scope used and the shape of the answer. Persistence and the real C0
// views are not proved here (see organisation.dbtest.ts).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { KernelDb, ScopeSettings, Tx } from '@ehr/kernel';
import { MIN_RELEASE, R, start } from '../../../test/platform/harness.js';
import type { Running } from '../../../test/platform/harness.js';
import { ApiError } from '../../platform/errors.js';
import type { GuardPolicy } from '../../platform/guard.js';
import { buildControllers } from '../../composition.js';
import { createCatalogueControllers } from './catalogue.controller.js';

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
  test('buildControllers mounts both catalogue routes, deny-by-default under the default policy', async () => {
    const t = await start({ controllers: buildControllers({ db }) });
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
