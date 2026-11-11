import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '@ehr/kernel';
import { ProviderError } from '../jobs/notifications/index.js';
import type { ProviderRequest } from '../jobs/notifications/adapters.js';
import {
  allowedPushEndpoint,
  parseSubscription,
  selectPushAdapter,
  WebPushProvider,
  type SendNotification,
} from './web-push.js';

const log = createLogger({ sink: () => undefined });
const key =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const sub = (endpoint: string): string =>
  JSON.stringify({ endpoint, keys: { p256dh: key, auth: 'tBHItJI5svbpez7KI4CCXg' } });
const req = (to: string): ProviderRequest => ({
  to,
  subject: 'Reminder',
  text: 'You have a message',
  idempotencyToken: 'tok-1',
  connection: { id: 'c', kind: 'push', vendor: 'webpush', settings: {} },
  credentials: { get: () => Promise.reject(new Error('unused')) },
  signal: new AbortController().signal,
});
const vapid = { subject: 'mailto:ops@example.org', publicKey: 'pub', privateKey: 'priv' };

test('only https push-service hosts are contacted', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/Q',
    'https://wns2-par02p.notify.windows.com/w',
  ])
    assert.ok(allowedPushEndpoint(ok), ok);
  for (const bad of [
    'http://fcm.googleapis.com/x',
    'https://evil.example/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://169.254.169.254/x',
    'https://u:p@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'not a url',
  ])
    assert.ok(!allowedPushEndpoint(bad), bad);
  assert.equal(parseSubscription(sub('https://evil.example/x')), undefined);
  assert.equal(parseSubscription('{'), undefined);
});

test('send encrypts via the library with VAPID details and returns the token as id', async () => {
  const calls: unknown[][] = [];
  const send: SendNotification = (...a) => {
    calls.push(a);
    return Promise.resolve({ statusCode: 201 });
  };
  const r = await new WebPushProvider(vapid, send).send(
    req(sub('https://fcm.googleapis.com/fcm/send/abc')),
  );
  assert.deepEqual(r, { messageId: 'tok-1', httpStatus: 201 });
  assert.deepEqual(JSON.parse(calls[0]?.[1] as string), {
    title: 'Reminder',
    body: 'You have a message',
  });
  assert.deepEqual((calls[0]?.[2] as { vapidDetails: unknown }).vapidDetails, vapid);
});

test('gone subscription and bad subscription are not retried; 5xx and 429 are', async () => {
  const failing = (statusCode: number): WebPushProvider =>
    new WebPushProvider(vapid, () => Promise.reject(Object.assign(new Error('x'), { statusCode })));
  const to = sub('https://fcm.googleapis.com/fcm/send/abc');
  await assert.rejects(
    failing(410).send(req(to)),
    (e: ProviderError) => !e.retryable && e.errorClass === 'subscription_gone',
  );
  await assert.rejects(failing(404).send(req(to)), (e: ProviderError) => !e.retryable);
  await assert.rejects(failing(503).send(req(to)), (e: ProviderError) => e.retryable);
  await assert.rejects(failing(429).send(req(to)), (e: ProviderError) => e.retryable);
  await assert.rejects(failing(400).send(req(to)), (e: ProviderError) => !e.retryable);
  await assert.rejects(
    failing(201).send(req(sub('https://evil.example/x'))),
    (e: ProviderError) => !e.retryable && e.errorClass === 'bad_subscription',
  );
});

test('selection: absent -> none; partial -> start fails; full -> adapter', async () => {
  assert.equal(await selectPushAdapter({}, log), undefined);
  await assert.rejects(
    selectPushAdapter({ EHR_VAPID_PUBLIC_KEY: 'p' }, log),
    /EHR_VAPID_PRIVATE_KEY/,
  );
  await assert.rejects(
    selectPushAdapter(
      { EHR_VAPID_PUBLIC_KEY: 'p', EHR_VAPID_PRIVATE_KEY: 'k', EHR_VAPID_SUBJECT: 'ops' },
      log,
      () => Promise.resolve({ statusCode: 201 }),
    ),
    /mailto/,
  );
  const a = await selectPushAdapter(
    {
      EHR_VAPID_PUBLIC_KEY: 'p',
      EHR_VAPID_PRIVATE_KEY: 'k',
      EHR_VAPID_SUBJECT: 'mailto:o@example.org',
    },
    log,
    () => Promise.resolve({ statusCode: 201 }),
  );
  assert.equal(a?.kind, 'push');
  assert.equal(a?.supportsIdempotencyToken, false);
});

test('the real library accepts our payload and VAPID details (request built offline, nothing sent)', async () => {
  const wp = (await import('web-push')) as unknown as {
    generateVAPIDKeys(): { publicKey: string; privateKey: string };
    generateRequestDetails(
      sub: unknown,
      payload: string,
      o: unknown,
    ): { method: string; headers: Record<string, string>; endpoint: string; body: Buffer };
  };
  const keys = wp.generateVAPIDKeys();
  const user = (await import('node:crypto')).createECDH('prime256v1');
  user.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: {
      p256dh: user.getPublicKey().toString('base64url'),
      auth: (await import('node:crypto')).randomBytes(16).toString('base64url'),
    },
  };
  const d = wp.generateRequestDetails(subscription, '{"title":"t","body":"b"}', {
    vapidDetails: { subject: 'mailto:ops@example.org', ...keys },
    TTL: 3600,
    urgency: 'normal',
  });
  assert.equal(d.method, 'POST');
  assert.match(d.headers['Authorization'] ?? '', /^vapid /);
  assert.equal(d.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(d.body.length > 0);
});
