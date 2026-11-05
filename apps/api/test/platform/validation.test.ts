import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../../src/platform/errors.js';
import { bodyLimitFor, normaliseText, validateObject } from '../../src/platform/limits.js';
import { MemoryRateLimiter } from '../../src/platform/rate-limit.js';
import { loadPlatformConfig } from '../../src/platform/config.js';
import { parseClientRelease } from '../../src/platform/client-release.js';

const schema = {
  name: { type: 'string', max: 100, min: 1 },
  id: { type: 'uuid' },
  n: { type: 'integer', min: 1, max: 100, optional: true },
  kind: { type: 'enum', values: ['a', 'b'] },
} as const;
const good = { name: 'Zoe', id: '0192A3B4-0000-7000-8000-000000000001', kind: 'a' };

test('validation normalises: NFC, control characters stripped, trimmed, uuid lower-cased', () => {
  const v = validateObject({ ...good, name: '  Café\u0000\u0007 ' }, schema);
  assert.equal(v['name'], 'Café');
  assert.equal(v['id'], '0192a3b4-0000-7000-8000-000000000001');
});

test('validation failure lists paths and reason codes and never a value', () => {
  try {
    validateObject({ name: 'x'.repeat(101), id: 'Jane Doe', kind: 'zzz', n: 1000 }, schema);
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'kernel.validation_failed');
    assert.deepEqual(e.extras.errors?.map((x) => x.path).sort(), ['/id', '/kind', '/n', '/name']);
    assert.ok(!JSON.stringify(e.extras).includes('Jane'));
  }
});

test('unknown fields: ignored on portal routes, refused when strict (integrations., CN-12)', () => {
  assert.deepEqual(Object.keys(validateObject({ ...good, extra: 1 }, schema)).sort(), [
    'id',
    'kind',
    'name',
  ]);
  assert.throws(
    () => validateObject({ ...good, extra: 1 }, schema, { strict: true }),
    (e: unknown) => (e as ApiError).extras.errors?.[0]?.path === '/extra',
  );
});

test('body must be an object', () => {
  for (const bad of [null, [], 'x', 3]) assert.throws(() => validateObject(bad, schema), ApiError);
});

test('multiline text keeps line breaks but not other control characters', () => {
  assert.equal(normaliseText('a\nb\u0000', true), 'a\nb');
  assert.equal(normaliseText('a\nb', false), 'ab');
});

test('body limits by route class (31.2)', () => {
  assert.equal(bodyLimitFor('PATCH', '/api/v1/notes/abc'), 256 * 1024);
  assert.equal(bodyLimitFor('PATCH', '/API/V1/NOTES/abc'), 256 * 1024);
  assert.equal(bodyLimitFor('POST', '/webhooks/video'), 256 * 1024);
  assert.equal(bodyLimitFor('POST', '/api/v1/notes/abc/sign'), 1024 * 1024);
  assert.equal(bodyLimitFor('POST', '/api/v1/patients'), 1024 * 1024);
});

test('release header parser: format r<n>.<sha12>', () => {
  assert.equal(parseClientRelease('r142.3f9a1c2b7d10'), 142);
  for (const bad of [
    undefined,
    '',
    'r142',
    'r0.3f9a1c2b7d10',
    'R142.3f9a1c2b7d10',
    'r142.3F9A1C2B7D10',
    'r-1.3f9a1c2b7d10',
    ['r1.3f9a1c2b7d10'],
    'r99999999999.3f9a1c2b7d10',
  ])
    assert.equal(parseClientRelease(bad), undefined, String(bad));
});

test('memory limiter: window resets, limit divided by instance count', async () => {
  const l = new MemoryRateLimiter(3);
  const t0 = 1_700_000_000_000;
  const res = [];
  for (let i = 0; i < 25; i++) res.push((await l.hit('k', 60, 60_000, t0)).allowed);
  assert.equal(res.filter(Boolean).length, 20); // 60 / 3
  assert.equal((await l.hit('k', 60, 60_000, t0 + 60_000)).allowed, true);
  assert.equal((await l.hit('other', 60, 60_000, t0)).allowed, true);
});

test('platform config names bad variables, never values', () => {
  assert.throws(() => loadPlatformConfig({}), /EHR_MIN_CLIENT_RELEASE is required/);
  try {
    loadPlatformConfig({ EHR_MIN_CLIENT_RELEASE: 'hunter2' });
    assert.fail();
  } catch (e) {
    assert.match(String(e), /EHR_MIN_CLIENT_RELEASE/);
    assert.ok(!String(e).includes('hunter2'));
  }
  assert.equal(loadPlatformConfig({ EHR_MIN_CLIENT_RELEASE: '141' }).minClientRelease, 141);
});

test('memory limiter stays bounded under many distinct keys in one window (BR-F05-04)', async () => {
  const l = new MemoryRateLimiter(1);
  const now = 1_000_000;
  for (let i = 0; i < 120_000; i++) await l.hit('k' + i, 10, 60_000, now);
  const size = (l as unknown as { windows: Map<string, unknown> }).windows.size;
  assert.ok(size <= 50_000, 'size ' + size);
  const h = await l.hit('fresh', 1, 60_000, now);
  assert.equal(h.allowed, true);
});
