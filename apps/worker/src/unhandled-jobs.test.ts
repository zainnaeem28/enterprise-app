import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobRegistry } from '@ehr/kernel';
import { buildWorkerRegistry } from './job-registry.js';
import { unhandledJobTypes } from './runner.js';

test('R8-N2: the worker entry registers job types but no handlers, so every registered type is reported unhandled', () => {
  const registry = buildWorkerRegistry();
  const all = registry.list().map((t) => t.name);
  assert.ok(all.length > 0);
  assert.deepEqual(unhandledJobTypes(registry, {}), all);
});

test('a type with a handler is not reported', () => {
  const registry = buildWorkerRegistry();
  const [first] = registry.list();
  assert.ok(first !== undefined);
  const missing = unhandledJobTypes(registry, { [first.name]: async () => undefined });
  assert.ok(!missing.includes(first.name));
  assert.equal(missing.length, registry.list().length - 1);
  assert.deepEqual(unhandledJobTypes(new JobRegistry(), {}), []);
});
