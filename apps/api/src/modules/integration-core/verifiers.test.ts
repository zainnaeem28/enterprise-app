// Webhook verification (ARCHITECTURE 29.5, 38.2 item 13) and the canonical request vector. No database.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { canonicalRequest, challengeOf, valueFingerprint } from './canonical.js';
import { hasSecretLikeKey } from './kinds.js';
import {
  GOOGLE_MAX_TOKEN_SECONDS,
  googleCalendarVerifier,
  googleChannelToken,
  hmacTimestampVerifier,
  type KeyVersion,
} from './verifiers.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const nowSec = NOW.getTime() / 1000;
const KEY: KeyVersion = { version: 'k2', key: Buffer.from('current-signing-key-for-tests-0001') };
const OLD: KeyVersion = { version: 'k1', key: Buffer.from('previous-signing-key-for-tests-001') };

const sign = (key: Buffer, ts: string | number, body: Buffer): string =>
  createHmac('sha256', key).update(`${ts}.`).update(body).digest('hex');

const video = hmacTimestampVerifier({
  signatureHeader: 'x-vendor-signature',
  timestampHeader: 'x-vendor-timestamp',
  allowedFields: ['id', 'type', 'meeting'],
  extract: (b) =>
    typeof b.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(b.id) && typeof b.type === 'string'
      ? { eventId: b.id, messageType: `video.${b.type.replace(/[^a-z_]/g, '')}` }
      : null,
});
const body = Buffer.from(
  JSON.stringify({ id: 'evt_1', type: 'participant_joined', meeting: 'm1' }),
);
const req = (headers: Record<string, string | undefined>, raw = body) => ({
  source: 'zoomish',
  headers,
  rawBody: raw,
});

describe('generic signed webhook (vendor signature + 5 minute replay window)', () => {
  const ts = String(Math.floor(nowSec));
  test('a valid signature is accepted and yields the vendor event ID', () => {
    const v = video.verify(
      req({ 'x-vendor-signature': `v1=${sign(KEY.key, ts, body)}`, 'x-vendor-timestamp': ts }),
      [KEY],
      NOW,
    );
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.eventId, 'evt_1');
      assert.equal(v.messageType, 'video.participant_joined');
      assert.deepEqual(v.payload, body);
    }
  });
  test('the previous key still verifies during a rotation window', () => {
    const v = video.verify(
      req({ 'x-vendor-signature': sign(OLD.key, ts, body), 'x-vendor-timestamp': ts }),
      [KEY, OLD],
      NOW,
    );
    assert.ok(v.ok);
  });
  test('wrong key, tampered body, missing headers, replay outside 5 minutes and future timestamps are all 401', () => {
    const good = sign(KEY.key, ts, body);
    const cases: [string, ReturnType<typeof req>][] = [
      [
        'wrong key',
        req({
          'x-vendor-signature': sign(Buffer.from('attacker-key-attacker-key'), ts, body),
          'x-vendor-timestamp': ts,
        }),
      ],
      [
        'tampered body',
        req(
          { 'x-vendor-signature': good, 'x-vendor-timestamp': ts },
          Buffer.from(body.toString().replace('evt_1', 'evt_2')),
        ),
      ],
      ['no signature', req({ 'x-vendor-timestamp': ts })],
      ['no timestamp', req({ 'x-vendor-signature': good })],
      [
        '6 minutes old',
        req({
          'x-vendor-signature': sign(KEY.key, nowSec - 360, body),
          'x-vendor-timestamp': String(nowSec - 360),
        }),
      ],
      [
        '6 minutes ahead',
        req({
          'x-vendor-signature': sign(KEY.key, nowSec + 360, body),
          'x-vendor-timestamp': String(nowSec + 360),
        }),
      ],
      ['not hex', req({ 'x-vendor-signature': 'zz'.repeat(32), 'x-vendor-timestamp': ts })],
      [
        'timestamp signed for another body',
        req({ 'x-vendor-signature': sign(KEY.key, nowSec - 10, body), 'x-vendor-timestamp': ts }),
      ],
    ];
    for (const [name, r] of cases) {
      const v = video.verify(r, [KEY], NOW);
      assert.deepEqual(v, { ok: false, reason: 'unauthenticated' }, name);
    }
    assert.deepEqual(
      video.verify(req({ 'x-vendor-signature': good, 'x-vendor-timestamp': ts }), [], NOW),
      { ok: false, reason: 'unauthenticated' },
      'no key configured',
    );
  });
  test('4 minutes old is inside the window', () => {
    const t = String(Math.floor(nowSec - 240));
    assert.ok(
      video.verify(
        req({ 'x-vendor-signature': sign(KEY.key, t, body), 'x-vendor-timestamp': t }),
        [KEY],
        NOW,
      ).ok,
    );
  });
  test('after verification: a body that is not an object, has an unknown field or lacks an event ID is 400, not 401', () => {
    for (const raw of [
      '[]',
      'not json',
      JSON.stringify({ id: 'e', type: 't', extra: 1 }),
      JSON.stringify({ type: 't' }),
    ]) {
      const b = Buffer.from(raw);
      const v = video.verify(
        req({ 'x-vendor-signature': sign(KEY.key, ts, b), 'x-vendor-timestamp': ts }, b),
        [KEY],
        NOW,
      );
      assert.deepEqual(v, { ok: false, reason: 'invalid' }, raw);
    }
  });
  test('an unverified body is never parsed (invalid JSON with a bad signature is 401, not 400)', () => {
    const b = Buffer.from('not json');
    assert.deepEqual(
      video.verify(
        req({ 'x-vendor-signature': 'a'.repeat(64), 'x-vendor-timestamp': ts }, b),
        [KEY],
        NOW,
      ),
      { ok: false, reason: 'unauthenticated' },
    );
  });
});

describe('Google Calendar push (29.5 channel token, TDR-05)', () => {
  const expiry = Math.floor(nowSec + 3 * 24 * 3600);
  const headers = (over: Record<string, string | undefined> = {}) => ({
    'x-goog-channel-id': 'chan-123',
    'x-goog-channel-token': googleChannelToken(KEY, 'chan-123', expiry),
    'x-goog-resource-id': 'res_abc',
    'x-goog-resource-state': 'exists',
    'x-goog-message-number': '42',
    ...over,
  });
  const r = (h: Record<string, string | undefined>) => ({
    source: 'google-calendar',
    headers: h,
    rawBody: Buffer.alloc(0),
  });

  test('a valid token is accepted with no body and no table read; event ID is channel:message number', () => {
    const v = googleCalendarVerifier.verify(r(headers()), [KEY, OLD], NOW);
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.eventId, 'chan-123:42');
      assert.equal(v.messageType, 'google_calendar.push');
      assert.deepEqual(JSON.parse(v.payload.toString()), {
        channelId: 'chan-123',
        resourceId: 'res_abc',
        resourceState: 'exists',
      });
    }
  });
  test('a token under the previous key version is accepted (rotation window); an unknown version is not', () => {
    const t = googleChannelToken(OLD, 'chan-123', expiry);
    assert.ok(
      googleCalendarVerifier.verify(r(headers({ 'x-goog-channel-token': t })), [KEY, OLD], NOW).ok,
    );
    assert.deepEqual(
      googleCalendarVerifier.verify(r(headers({ 'x-goog-channel-token': t })), [KEY], NOW),
      { ok: false, reason: 'unauthenticated' },
    );
  });
  test('wrong token, token for another channel, expired token and a token valid for more than 7 days are 401', () => {
    const bad = [
      headers({
        'x-goog-channel-token': googleChannelToken(
          { version: 'k2', key: Buffer.from('attacker-attacker-attacker-1') },
          'chan-123',
          expiry,
        ),
      }),
      headers({ 'x-goog-channel-id': 'chan-999' }),
      headers({
        'x-goog-channel-token': googleChannelToken(KEY, 'chan-123', Math.floor(nowSec - 1)),
      }),
      headers({
        'x-goog-channel-token': googleChannelToken(
          KEY,
          'chan-123',
          Math.floor(nowSec + GOOGLE_MAX_TOKEN_SECONDS + 60),
        ),
      }),
      headers({ 'x-goog-channel-token': 'garbage' }),
      headers({ 'x-goog-channel-token': undefined }),
    ];
    for (const h of bad)
      assert.deepEqual(googleCalendarVerifier.verify(r(h), [KEY, OLD], NOW), {
        ok: false,
        reason: 'unauthenticated',
      });
  });
  test('an unknown resource state or a malformed message number is 400 after the token verified', () => {
    for (const h of [
      headers({ 'x-goog-resource-state': 'deleted' }),
      headers({ 'x-goog-resource-state': undefined }),
      headers({ 'x-goog-message-number': 'x1' }),
      headers({ 'x-goog-resource-id': undefined }),
    ])
      assert.deepEqual(googleCalendarVerifier.verify(r(h), [KEY], NOW), {
        ok: false,
        reason: 'invalid',
      });
    for (const s of ['sync', 'exists', 'not_exists'])
      assert.ok(
        googleCalendarVerifier.verify(r(headers({ 'x-goog-resource-state': s })), [KEY], NOW).ok,
      );
  });
  test('a repeated message number gives the same event ID (the unique index de-duplicates it)', () => {
    const a = googleCalendarVerifier.verify(r(headers()), [KEY], NOW);
    const b = googleCalendarVerifier.verify(r(headers()), [KEY], NOW);
    assert.ok(a.ok && b.ok && a.eventId === b.eventId);
  });
});

describe('canonical request (SEC-01 O2-1): identical to the worker copy', () => {
  test('pinned golden vector', () => {
    const rid = '00000000-0000-7000-8000-0000000000f1';
    const fp = valueFingerprint(rid, Buffer.alloc(16, 7), 'not-a-real-secret-value');
    assert.equal(fp, '53160529cc3ab13cbde14d18bb876da38107dbc7acacb42cb7ae66f54a885c8e');
    const c = canonicalRequest({
      requestId: rid,
      connectionId: '00000000-0000-7000-8000-0000000000b1',
      name: 'webhook-signing',
      valueFingerprintHex: fp,
      requesterPersonId: '00000000-0000-7000-8000-0000000000d1',
      expiresAt: new Date('2026-11-06T12:30:00.000Z'),
    });
    assert.equal(
      challengeOf(c).toString('hex'),
      'b5d96cb83c6319db10a3f4b2f413917c8375fdc2d597b0c4e6861f47ee78b470',
    );
  });
});

describe('credential-looking keys', () => {
  test('are found at any depth', () => {
    assert.equal(hasSecretLikeKey({ region: 'x', nested: { items: [{ apiKey: 'v' }] } }), true);
    assert.equal(hasSecretLikeKey({ region: 'x', fromAddress: 'a@b.c', retries: 3 }), false);
    for (const k of [
      'password',
      'client_secret',
      'accessToken',
      'Authorization',
      'private-key',
      'webhookSignature',
    ])
      assert.equal(hasSecretLikeKey({ [k]: 1 }), true, k);
  });
});
