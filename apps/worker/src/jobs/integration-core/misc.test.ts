import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AdapterRegistry,
  ADAPTER_KINDS,
  ADAPTER_OPERATIONS,
  type VendorAdapter,
} from './adapters.js';
import { canonicalRequest, challengeOf, valueFingerprint } from './canonical.js';
import { InboundHandlerRegistry } from './dispatch.js';
import { nextHealth } from './health.js';
import { INTEGRATION_CORE_JOBS } from './jobs.js';
import { SecretCache } from './secrets.js';

describe('adapter interfaces (acceptance: one per kind)', () => {
  test('the six R1 kinds each have an operation list, and the registry refuses duplicates and unknown kinds', () => {
    assert.deepEqual(
      [...ADAPTER_KINDS],
      ['email', 'sms', 'push', 'video', 'google_calendar', 'ocr'],
    );
    for (const k of ADAPTER_KINDS) assert.ok(ADAPTER_OPERATIONS[k].length > 0);
    const reg = new AdapterRegistry();
    const a = {
      kind: 'email',
      supportsIdempotencyToken: true,
      call: () => Promise.reject(new Error()),
      healthCheck: () => Promise.resolve({ ok: true }),
    } as unknown as VendorAdapter;
    reg.register(a);
    assert.throws(() => reg.register(a), /already registered/);
    assert.throws(() => reg.register({ ...a, kind: 'fax' } as never), /no adapter interface/);
    assert.equal(reg.get('email'), a);
    assert.equal(reg.get('sms'), undefined);
  });
});

describe('canonical request (SEC-01 O2-1)', () => {
  const f = {
    requestId: '00000000-0000-7000-8000-0000000000f1',
    connectionId: '00000000-0000-7000-8000-0000000000b1',
    name: 'webhook-signing',
    valueFingerprintHex: valueFingerprint(
      '00000000-0000-7000-8000-0000000000f1',
      Buffer.alloc(16, 7),
      'not-a-real-secret-value',
    ),
    requesterPersonId: '00000000-0000-7000-8000-0000000000d1',
    expiresAt: new Date('2026-11-06T12:30:00.000Z'),
  };
  // The same vector is pinned in apps/api/.../canonical.test.ts: the two copies must agree.
  const FINGERPRINT = '53160529cc3ab13cbde14d18bb876da38107dbc7acacb42cb7ae66f54a885c8e';
  const CHALLENGE = 'b5d96cb83c6319db10a3f4b2f413917c8375fdc2d597b0c4e6861f47ee78b470';
  test('is length-prefixed, versioned and stable; the challenge is its SHA-256', () => {
    const c = canonicalRequest(f);
    assert.equal(c.subarray(4, 4 + 20).toString(), 'ehr.secret_change.v1');
    assert.equal(challengeOf(c).length, 32);
    assert.equal(
      challengeOf(c).toString('hex'),
      challengeOf(canonicalRequest({ ...f })).toString('hex'),
    );
    assert.notEqual(
      challengeOf(canonicalRequest({ ...f, name: 'other' })).toString('hex'),
      challengeOf(c).toString('hex'),
    );
    assert.equal(f.valueFingerprintHex, FINGERPRINT);
    assert.equal(
      challengeOf(c).toString('hex'),
      CHALLENGE,
      'golden vector, identical in the API copy',
    );
  });
  test('a different value, nonce or request ID changes the fingerprint; the value itself is not in the bytes', () => {
    const a = valueFingerprint(f.requestId, Buffer.alloc(16, 1), 'value-one-value-one');
    assert.notEqual(a, valueFingerprint(f.requestId, Buffer.alloc(16, 1), 'value-two-value-two'));
    assert.notEqual(a, valueFingerprint(f.requestId, Buffer.alloc(16, 2), 'value-one-value-one'));
    assert.notEqual(
      a,
      valueFingerprint(
        '00000000-0000-7000-8000-0000000000f2',
        Buffer.alloc(16, 1),
        'value-one-value-one',
      ),
    );
    assert.equal(canonicalRequest(f).includes(Buffer.from('not-a-real-secret-value')), false);
  });
});

describe('health derivation (34.2)', () => {
  test('first failed probe degrades, the second in a row is down; a good probe restores', () => {
    const none = { total: 0, failed: 0 };
    assert.equal(nextHealth('ok', false, none), 'degraded');
    assert.equal(nextHealth('unknown', false, none), 'degraded');
    assert.equal(nextHealth('degraded', false, none), 'down');
    assert.equal(nextHealth('down', false, none), 'down');
    assert.equal(nextHealth('down', true, none), 'ok');
  });
  test('a passing probe with >= 50 % failures over >= 5 recent calls is degraded', () => {
    assert.equal(nextHealth('ok', true, { total: 10, failed: 5 }), 'degraded');
    assert.equal(nextHealth('ok', true, { total: 10, failed: 4 }), 'ok');
    assert.equal(nextHealth('ok', true, { total: 4, failed: 4 }), 'ok');
  });
});

describe('secret cache (9.1: at most 5 minutes, memory only)', () => {
  test('reads through once inside the TTL, again after it, and clear() drops everything', async () => {
    let now = 0;
    let reads = 0;
    const cache = new SecretCache(
      {
        get: () => {
          reads++;
          return Promise.resolve(`v${reads}`);
        },
      },
      () => now,
    );
    assert.equal(await cache.get('arn', '1'), 'v1');
    now = 299_999;
    assert.equal(await cache.get('arn', '1'), 'v1');
    now = 300_001;
    assert.equal(await cache.get('arn', '1'), 'v2');
    cache.clear();
    assert.equal(await cache.get('arn', '1'), 'v3');
    assert.equal(await cache.get('arn', '2'), 'v4', 'a new version ID is a new entry (rotation)');
  });
  test('a TTL above 5 minutes is refused', () => {
    assert.throws(
      () => new SecretCache({ get: () => Promise.resolve('x') }, Date.now, 300_001),
      /capped at 5 minutes/,
    );
  });
  test('the cached value does not serialise or inspect', async () => {
    const cache = new SecretCache({ get: () => Promise.resolve('TOPSECRET') });
    await cache.get('a', '1');
    const inner = JSON.stringify([
      ...(cache as unknown as { cache: Map<string, unknown> }).cache.values(),
    ]);
    assert.equal(inner.includes('TOPSECRET'), false);
  });
});

describe('inbound handler registry', () => {
  test('one handler per (source, type); a second is refused; lookup is exact', () => {
    const r = new InboundHandlerRegistry();
    const fn = () => Promise.resolve();
    r.register('twilio', 'sms.receipt', 'notifications.on_receipt', fn);
    assert.throws(
      () => r.register('twilio', 'sms.receipt', 'other.handler', fn),
      /already registered/,
    );
    assert.equal(r.resolve('twilio', 'sms.receipt')?.name, 'notifications.on_receipt');
    assert.equal(r.resolve('twilio', 'sms.other'), undefined);
    assert.equal(r.resolve('other', 'sms.receipt'), undefined);
    assert.throws(() => r.register('Bad Source', 'x.y', 'a.b', fn), /bad source/);
  });
});

describe('job list', () => {
  test('matches ARCHITECTURE 33.1 and the API-side list', () => {
    assert.deepEqual(
      INTEGRATION_CORE_JOBS.map((j) => [j.name, j.maxAttempts, j.jobClass]),
      [
        ['integration_core.dispatch_inbound', 8, 'job'],
        ['integration_core.health_check', 3, 'system'],
        ['integration_core.apply_inbound_secret', 3, 'job'],
      ],
    );
  });
});
