import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, Get } from '@nestjs/common';
import { PLATFORM_CONTROLLERS } from '../../src/platform/app.js';
import { inventory } from '../../src/platform/inventory.js';
import { PERMISSIONS } from '../../src/platform/permissions.js';
import { Route } from '../../src/platform/route.js';
import { FixtureController } from './harness.js';

test('every platform route declares a permission and a resolver', () => {
  const r = inventory(PLATFORM_CONTROLLERS as never);
  assert.deepEqual(r.failures, []);
  const keys = r.routes.map((x) => `${x.method} ${x.path}`).sort();
  assert.deepEqual(keys, ['GET /api/v1/alerts/stream', 'GET /healthz', 'GET /readyz']);
});

test('the inventory fails a route without a declaration (CI gate)', () => {
  const r = inventory([FixtureController] as never);
  assert.ok(
    r.failures.some((f) => f.includes('/api/v1/undeclared') && f.includes('no route declaration')),
    r.failures.join('\n'),
  );
  assert.equal(r.failures.length, 1, 'only the undeclared fixture handler fails');
});

test('the inventory fails an empty permission, a missing resolver and an unknown permission', () => {
  @Controller('x')
  class Bad {
    @Get('a') @Route({ permission: '', resolver: 'none' }) a(): void {}
    @Get('b') @Route({ permission: 'patient.read', resolver: '' }) b(): void {}
    @Get('c') @Route({ permission: 'patient.teleport', resolver: 'none' }) c(): void {}
    @Get('d') @Route({ permission: 'patient.read', resolver: 'patient' }) d(): void {}
  }
  const r = inventory([Bad] as never);
  assert.equal(r.failures.length, 3, r.failures.join('\n'));
});

test('the catalogue holds the 27.2 permissions (spot check) and no duplicates', () => {
  for (const p of [
    'identity.principal.kill',
    'clinical.note.sign',
    'reporting.ops.read',
    'notifications.alert.read',
  ])
    assert.ok(PERMISSIONS.includes(p), p);
  assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length);
});
