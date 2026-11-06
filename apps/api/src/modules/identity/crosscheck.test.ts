// Things that must stay in step across the deployables and the platform layer: the permission catalogue the route
// inventory validates against (apps/api/src/platform/permissions.ts) and the catalogue the worker loads into the database;
// the identity job types on both sides; and the route inventory of this module's controller (BD-07, 38.2 item 9).
// The worker is imported from its build output, so `pnpm -r build` must have run (a missing build fails this test).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from '../../platform/inventory.js';
import { PERMISSIONS as PLATFORM_PERMISSIONS } from '../../platform/permissions.js';
import { createAuthController } from './auth.controller.js';
import { IDENTITY_JOBS } from './jobs.js';

let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}apps/worker/package.json`)) root = join(root, '..') + '/';
const worker = (await import(
  pathToFileURL(`${root}apps/worker/dist/jobs/identity/index.js`).href
)) as {
  PERMISSIONS: { key: string }[];
  ROLES: { permissions: string[] }[];
  IDENTITY_JOBS: unknown[];
  expandedMapping(): { permissions: string[] }[];
};

describe('cross-checks', () => {
  test('the catalogue the worker loads is exactly the catalogue the platform validates routes against', () => {
    assert.deepEqual(
      [...worker.PERMISSIONS.map((p) => p.key)].sort(),
      [...PLATFORM_PERMISSIONS].sort(),
    );
  });
  test('every permission any default role holds is a platform permission', () => {
    const known = new Set(PLATFORM_PERMISSIONS);
    for (const m of worker.expandedMapping())
      for (const k of m.permissions) assert.ok(known.has(k), k);
  });
  test('the identity job types are the same on the API and worker sides', () => {
    assert.deepEqual(IDENTITY_JOBS, worker.IDENTITY_JOBS);
  });
  test('the session routes pass the route inventory: each declares a permission and a resolver', () => {
    const Controller = createAuthController({} as never);
    const report = inventory([Controller as never]);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.routes.map((r) => `${r.method} ${r.path}`).sort(), [
      'GET /api/v1/auth/callback',
      'GET /api/v1/auth/session',
      'GET /api/v1/auth/sign-in',
      'POST /api/v1/auth/reauth',
      'POST /api/v1/auth/session/extend',
      'POST /api/v1/auth/sign-out',
    ]);
    const decl = Object.fromEntries(
      report.routes.map((r) => [`${r.method} ${r.path}`, r.declaration]),
    );
    assert.equal(decl['GET /api/v1/auth/sign-in']?.releaseExempt, true);
    assert.equal(decl['GET /api/v1/auth/callback']?.releaseExempt, true);
    assert.equal(decl['GET /api/v1/auth/session']?.resolver, 'session');
    assert.equal(decl['POST /api/v1/auth/reauth']?.realm, 'google');
  });
});
