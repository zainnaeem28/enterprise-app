import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, requestHash } from './hash.js';
import { IdempotencyKeyRequiredError, parseIdempotencyKey } from './store.js';

const base = {
  method: 'post',
  routeTemplate: '/holds',
  pathParams: [],
  query: { b: '2', a: ['1', '3'] },
  body: { y: 1, x: [1, { d: 4, c: 3 }] },
};

test('canonical JSON sorts keys and drops whitespace', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [1, 2], c: null } }),
    '{"a":{"c":null,"d":[1,2]},"b":1}',
  );
});

test('same request, different key order and method case, same hash', () => {
  const a = requestHash(base);
  const b = requestHash({
    ...base,
    method: 'POST',
    query: { a: ['1', '3'], b: '2' },
    body: { x: [1, { c: 3, d: 4 }], y: 1 },
  });
  assert.ok(a.equals(b));
});

test('any difference in method, route, path params, query or body changes the hash', () => {
  const h = requestHash(base);
  for (const v of [
    { ...base, method: 'PUT' },
    { ...base, routeTemplate: '/holds/{id}' },
    { ...base, pathParams: ['x'] },
    { ...base, query: { b: '2' } },
    { ...base, body: { y: 2, x: [1, { d: 4, c: 3 }] } },
  ])
    assert.ok(!h.equals(requestHash(v)));
});

test('field boundaries cannot be shifted to collide', () => {
  assert.ok(
    !requestHash({ ...base, pathParams: ['a', 'bc'] }).equals(
      requestHash({ ...base, pathParams: ['ab', 'c'] }),
    ),
  );
});

test('Idempotency-Key must be a uuid v4 or v7', () => {
  assert.equal(
    parseIdempotencyKey('0192E0A0-0000-7000-8000-000000000001'),
    '0192e0a0-0000-7000-8000-000000000001',
  );
  assert.equal(
    parseIdempotencyKey('3b241101-e2bb-4255-8caf-4136c566a962'),
    '3b241101-e2bb-4255-8caf-4136c566a962',
  );
  for (const bad of [undefined, '', 'nope', '3b241101-e2bb-1255-8caf-4136c566a962'])
    assert.throws(() => parseIdempotencyKey(bad), IdempotencyKeyRequiredError);
});
