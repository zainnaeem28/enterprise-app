// SNS delivery-receipt route (INT-N2): signature verification, subscription handling, replay, mapping. The certificates are generated
// here (openssl, a throw-away CA and a leaf), and every fixture is signed here; nothing is fetched from AWS and no AWS account exists.
// This proves the verifier against OUR reading of the SNS signing rules (AWS docs); it is not evidence of a real SNS delivery.
import assert from 'node:assert/strict';
import { createSign, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { start } from '../../../test/platform/harness.js';
import type { Running } from '../../../test/platform/harness.js';
import { createIntegrationsHostControllers } from './controller.js';
import { mapReceiptEvent } from './receipt-events.js';
import { SnsReceiptReceiver } from './sns-receipts.js';
import type { SnsReceiptConfig } from './sns-receipts.js';
import { stringToSign } from './sns-verify.js';
import type { SnsType } from './sns-verify.js';

const REGION = 'eu-west-2';
const HOST = `sns.${REGION}.amazonaws.com`;
const CERT_URL = `https://${HOST}/SimpleNotificationService-0123456789abcdef.pem`;
const EMAIL_TOPIC = 'arn:aws:sns:eu-west-2:123456789012:ehr-ses-events';
const SMS_TOPIC = 'arn:aws:sns:eu-west-2:123456789012:ehr-sms-events';
// The throw-away certificates are valid from the real clock, so the test clock starts there.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);

const dir = mkdtempSync(join(tmpdir(), 'sns-test-'));
const sh = (...a: string[]): void => void execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
sh(
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  'ca.key',
  '-out',
  'ca.pem',
  '-days',
  '30',
  '-subj',
  '/CN=test-ca',
);
sh(
  'req',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  'leaf.key',
  '-out',
  'leaf.csr',
  '-subj',
  '/CN=sns.amazonaws.com',
);
sh(
  'x509',
  '-req',
  '-in',
  'leaf.csr',
  '-CA',
  'ca.pem',
  '-CAkey',
  'ca.key',
  '-CAcreateserial',
  '-out',
  'leaf.pem',
  '-days',
  '2',
);
sh(
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  'other.key',
  '-out',
  'other.pem',
  '-days',
  '30',
  '-subj',
  '/CN=other',
);
const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
const LEAF = read('leaf.pem');
const LEAF_KEY = read('leaf.key');
const CA = read('ca.pem');
const OTHER = read('other.pem');
const OTHER_KEY = read('other.key');
after(() => rmSync(dir, { recursive: true, force: true }));

interface Opts {
  type?: SnsType;
  topic?: string;
  message?: string;
  messageId?: string;
  timestamp?: Date;
  key?: string;
  algo?: 'RSA-SHA256' | 'RSA-SHA1';
  version?: string;
  certUrl?: string;
  subscribeUrl?: string;
  token?: string;
}
/** A signed SNS envelope, as raw bytes. */
function sns(o: Opts = {}): Buffer {
  const type = o.type ?? 'Notification';
  const f: Record<string, string> = {
    Type: type,
    MessageId: o.messageId ?? randomUUID(),
    TopicArn: o.topic ?? EMAIL_TOPIC,
    Message: o.message ?? sesEvent('Delivery'),
    Timestamp: (o.timestamp ?? NOW).toISOString(),
  };
  if (type !== 'Notification') {
    f['Token'] = o.token ?? 'tok-1';
    f['SubscribeURL'] =
      o.subscribeUrl ??
      `https://${HOST}/?Action=ConfirmSubscription&TopicArn=${f['TopicArn']}&Token=${f['Token']}`;
  }
  const sig = createSign(o.algo ?? 'RSA-SHA256')
    .update(stringToSign(type, f), 'utf8')
    .sign(o.key ?? LEAF_KEY, 'base64');
  return Buffer.from(
    JSON.stringify({
      ...f,
      SignatureVersion: o.version ?? '2',
      Signature: sig,
      SigningCertURL: o.certUrl ?? CERT_URL,
    }),
  );
}
function sesEvent(type: 'Delivery' | 'Bounce' | 'Complaint', mid = 'ses-mid-1'): string {
  const k = type.toLowerCase();
  return JSON.stringify({
    eventType: type,
    mail: { messageId: mid, destination: ['patient@example.test'] },
    [k]: { timestamp: '2026-11-11T11:59:30.000Z', recipients: ['patient@example.test'] },
  });
}

interface Stored {
  source: string;
  eventId: string;
  messageType: string;
  payload: Buffer;
}
function build(over: Partial<SnsReceiptConfig> = {}) {
  const stored: Stored[] = [];
  const seenEventIds = new Set<string>();
  const refused: string[] = [];
  const fetched: string[] = [];
  const confirmed: string[] = [];
  const logs: string[] = [];
  let storeStatus = 200;
  const r = new SnsReceiptReceiver({
    region: REGION,
    topics: new Map([
      [EMAIL_TOPIC, 'email'],
      [SMS_TOPIC, 'sms'],
    ]),
    fetchCertificate: (u) => {
      fetched.push(u);
      return Promise.resolve(LEAF);
    },
    confirmSubscription: (u) => {
      confirmed.push(u);
      return Promise.resolve(200);
    },
    store: {
      storeVerified: (m) => {
        if (storeStatus !== 200) return Promise.resolve({ status: storeStatus });
        stored.push(m);
        const dup = seenEventIds.has(`${m.source}/${m.eventId}`);
        seenEventIds.add(`${m.source}/${m.eventId}`);
        return Promise.resolve({ status: 200, outcome: dup ? 'duplicate' : 'inserted' });
      },
    },
    logger: {
      info: (m: string, f?: unknown) => logs.push(m + JSON.stringify(f ?? {})),
      warn: (m: string, f?: unknown) => logs.push(m + JSON.stringify(f ?? {})),
      error: (m: string, f?: unknown) => logs.push(m + JSON.stringify(f ?? {})),
      debug: () => undefined,
    } as never,
    onRefused: (i) => refused.push(i.reason),
    now: () => NOW,
    ...over,
  });
  return {
    r,
    stored,
    refused,
    fetched,
    confirmed,
    logs,
    setStore: (n: number) => (storeStatus = n),
  };
}

describe('signature verification', () => {
  test('a valid SigV2 notification is stored once, as a normalised receipt with no address', async () => {
    const t = build();
    assert.deepEqual(await t.r.receive(sns()), { status: 200 });
    assert.equal(t.stored.length, 1);
    const s = t.stored[0] as Stored;
    assert.equal(s.source, 'email');
    assert.equal(s.messageType, 'delivery_receipt');
    const body = JSON.parse(s.payload.toString('utf8'));
    assert.deepEqual(Object.keys(body).sort(), [
      'eventId',
      'occurredAt',
      'providerMessageId',
      'status',
    ]);
    assert.equal(body.status, 'delivered');
    assert.equal(body.providerMessageId, 'ses-mid-1');
    assert.ok(!s.payload.toString().includes('patient@example.test'));
    assert.deepEqual(t.fetched, [CERT_URL]);
  });

  test('a tampered message is 401 and nothing is stored', async () => {
    const t = build();
    const env = JSON.parse(sns().toString());
    env.Message = sesEvent('Bounce');
    assert.deepEqual(await t.r.receive(Buffer.from(JSON.stringify(env))), { status: 401 });
    assert.deepEqual(t.refused, ['bad_signature']);
    assert.equal(t.stored.length, 0);
  });

  test('a signature by another key under the pinned URL is 401', async () => {
    const t = build();
    assert.equal((await t.r.receive(sns({ key: OTHER_KEY }))).status, 401);
    assert.equal(t.stored.length, 0);
  });

  test('SignatureVersion 1 (SHA1) is refused, even when correctly signed', async () => {
    const t = build();
    assert.equal((await t.r.receive(sns({ version: '1', algo: 'RSA-SHA1' }))).status, 401);
    assert.deepEqual(t.refused, ['signature_version']);
    assert.deepEqual(t.fetched, [], 'refused before any certificate fetch');
  });

  test('a SigV2 label over a SHA1 signature does not verify', async () => {
    const t = build();
    assert.equal((await t.r.receive(sns({ algo: 'RSA-SHA1' }))).status, 401);
  });

  for (const [name, url] of [
    [
      'wrong host',
      'https://sns.eu-west-2.amazonaws.com.evil.test/SimpleNotificationService-0123.pem',
    ],
    ['other region', 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123.pem'],
    ['http', `http://${HOST}/SimpleNotificationService-0123.pem`],
    ['credentials', `https://x:y@${HOST}/SimpleNotificationService-0123.pem`],
    ['port', `https://${HOST}:8443/SimpleNotificationService-0123.pem`],
    ['wrong path', `https://${HOST}/other.pem`],
    ['query', `https://${HOST}/SimpleNotificationService-0123.pem?x=1`],
    [
      'look-alike',
      'https://sns.eu-west-2.amazonaws.com@evil.test/SimpleNotificationService-0123.pem',
    ],
  ] as const)
    test(`SigningCertURL ${name} is refused without a fetch`, async () => {
      const t = build();
      assert.equal((await t.r.receive(sns({ certUrl: url }))).status, 401);
      assert.deepEqual(t.refused, ['cert_url']);
      assert.deepEqual(t.fetched, []);
    });

  test('an expired certificate is refused', async () => {
    const t = build({ now: () => new Date(NOW.getTime() + 3 * 86_400_000) });
    const late = new Date(NOW.getTime() + 3 * 86_400_000);
    assert.equal((await t.r.receive(sns({ timestamp: late }))).status, 401);
    assert.deepEqual(t.refused, ['cert_invalid']);
  });

  test('with a trust anchor configured, a certificate from another issuer is refused and the right one accepted', async () => {
    const ok = build({ trustAnchorsPem: [CA] });
    assert.equal((await ok.r.receive(sns())).status, 200);
    const bad = build({ trustAnchorsPem: [OTHER] });
    assert.equal((await bad.r.receive(sns())).status, 401);
    assert.deepEqual(bad.refused, ['cert_invalid']);
  });

  test('a certificate that cannot be fetched is 401 (nothing verified), not stored', async () => {
    const t = build({ fetchCertificate: () => Promise.reject(new Error('down')) });
    assert.equal((await t.r.receive(sns())).status, 401);
    assert.deepEqual(t.refused, ['cert_unavailable']);
  });

  test('a stale or future timestamp is refused', async () => {
    const t = build();
    assert.equal(
      (await t.r.receive(sns({ timestamp: new Date(NOW.getTime() - 2 * 3600_000) }))).status,
      401,
    );
    assert.equal(
      (await t.r.receive(sns({ timestamp: new Date(NOW.getTime() + 20 * 60_000) }))).status,
      401,
    );
    assert.deepEqual(t.refused, ['stale_timestamp', 'stale_timestamp']);
    assert.equal(t.stored.length, 0);
  });

  test('a topic outside the allowlist is refused before any certificate fetch', async () => {
    const t = build();
    assert.equal(
      (await t.r.receive(sns({ topic: 'arn:aws:sns:eu-west-2:999999999999:attacker' }))).status,
      401,
    );
    assert.deepEqual(t.refused, ['topic_not_allowed']);
    assert.deepEqual(t.fetched, []);
  });

  test('malformed bodies are 400', async () => {
    const t = build();
    for (const b of ['', 'not json', '[]', '{"Type":"Notification"}', '{"Type":"Other"}'])
      assert.equal((await t.r.receive(Buffer.from(b))).status, 400, b);
  });

  test('the certificate is fetched once and cached', async () => {
    const t = build();
    await t.r.receive(sns());
    await t.r.receive(sns());
    assert.equal(t.fetched.length, 1);
  });
});

describe('replay', () => {
  test('the same signed message twice stores once and answers 200 both times', async () => {
    const t = build();
    const m = sns();
    assert.equal((await t.r.receive(m)).status, 200);
    assert.equal((await t.r.receive(m)).status, 200);
    assert.equal(t.stored.length, 1);
  });

  test('a replay that reaches another process is a duplicate at the durable store (same event ID = MessageId)', async () => {
    const t = build();
    const m = sns({ messageId: 'fixed-id-1' });
    await t.r.receive(m);
    const other = build({ store: t.r['c'].store });
    await other.r.receive(m);
    assert.equal(t.stored.length, 2);
    assert.equal(t.stored[0]?.eventId, 'fixed-id-1');
    assert.equal(t.stored[1]?.eventId, 'fixed-id-1');
  });

  test('a failed store is 503 and the retry is processed, not treated as a replay', async () => {
    const t = build();
    const m = sns();
    t.setStore(503);
    assert.equal((await t.r.receive(m)).status, 503);
    t.setStore(200);
    assert.equal((await t.r.receive(m)).status, 200);
    assert.equal(t.stored.length, 1);
  });
});

describe('subscription handling', () => {
  test('SubscriptionConfirmation: the pinned SubscribeURL is requested once', async () => {
    const t = build();
    assert.equal((await t.r.receive(sns({ type: 'SubscriptionConfirmation' }))).status, 200);
    assert.equal(t.confirmed.length, 1);
    assert.match(
      t.confirmed[0] as string,
      /^https:\/\/sns\.eu-west-2\.amazonaws\.com\/\?Action=ConfirmSubscription/,
    );
    assert.equal(t.stored.length, 0);
  });

  test('a correctly signed confirmation whose SubscribeURL points elsewhere is refused and not requested', async () => {
    const t = build();
    for (const u of [
      'https://evil.test/?Action=ConfirmSubscription&TopicArn=' + EMAIL_TOPIC + '&Token=tok-1',
      `http://${HOST}/?Action=ConfirmSubscription&TopicArn=${EMAIL_TOPIC}&Token=tok-1`,
      `https://${HOST}/?Action=ConfirmSubscription&TopicArn=${SMS_TOPIC}&Token=tok-1`,
      `https://${HOST}/?Action=ConfirmSubscription&TopicArn=${EMAIL_TOPIC}&Token=other`,
      `https://${HOST}/?Action=Unsubscribe&TopicArn=${EMAIL_TOPIC}&Token=tok-1`,
    ])
      assert.equal(
        (await t.r.receive(sns({ type: 'SubscriptionConfirmation', subscribeUrl: u }))).status,
        401,
        u,
      );
    assert.deepEqual(t.confirmed, []);
  });

  test('an unsigned or tampered confirmation is never requested', async () => {
    const t = build();
    const env = JSON.parse(sns({ type: 'SubscriptionConfirmation' }).toString());
    env.SubscribeURL = `https://${HOST}/?Action=ConfirmSubscription&TopicArn=${EMAIL_TOPIC}&Token=forged`;
    env.Token = 'forged';
    assert.equal((await t.r.receive(Buffer.from(JSON.stringify(env)))).status, 401);
    assert.deepEqual(t.confirmed, []);
  });

  test('a failed confirmation GET is 503 (SNS retries)', async () => {
    const t = build({ confirmSubscription: () => Promise.resolve(500) });
    assert.equal((await t.r.receive(sns({ type: 'SubscriptionConfirmation' }))).status, 503);
  });

  test('UnsubscribeConfirmation is acknowledged, stores nothing and requests nothing', async () => {
    const t = build();
    assert.equal((await t.r.receive(sns({ type: 'UnsubscribeConfirmation' }))).status, 200);
    assert.deepEqual(t.confirmed, []);
    assert.equal(t.stored.length, 0);
  });
});

describe('event mapping', () => {
  test('SES Delivery, Bounce and Complaint map to the receipt statuses', () => {
    for (const [t, st] of [
      ['Delivery', 'delivered'],
      ['Bounce', 'bounced'],
      ['Complaint', 'complaint'],
    ] as const) {
      const m = mapReceiptEvent('email', sesEvent(t));
      assert.equal(m.kind, 'receipt');
      if (m.kind === 'receipt') {
        assert.equal(m.receipt.status, st);
        assert.equal(m.receipt.eventId, `${t.toLowerCase()}:ses-mid-1:2026-11-11T11:59:30.000Z`);
      }
    }
  });

  test('other SES events are ignored (200, not stored); a broken one is 400', async () => {
    assert.deepEqual(mapReceiptEvent('email', JSON.stringify({ eventType: 'Open', mail: {} })), {
      kind: 'ignored',
    });
    assert.deepEqual(mapReceiptEvent('email', '{"eventType":"Delivery"}'), { kind: 'invalid' });
    const t = build();
    assert.equal(
      (
        await t.r.receive(
          sns({ message: JSON.stringify({ eventType: 'Send', mail: { messageId: 'x' } }) }),
        )
      ).status,
      200,
    );
    assert.equal(t.stored.length, 0);
    assert.equal((await t.r.receive(sns({ message: 'garbage' }))).status, 400);
  });

  test('SMS events on the SMS topic: delivered, failed, and non-final states ignored', async () => {
    const ev = (eventType: string) =>
      JSON.stringify({
        eventType,
        messageId: 'sms-mid-1',
        eventTimestamp: 1_794_398_400_000,
        destinationPhoneNumber: '+15550100',
      });
    const t = build();
    assert.equal(
      (await t.r.receive(sns({ topic: SMS_TOPIC, message: ev('TEXT_DELIVERED') }))).status,
      200,
    );
    assert.equal(
      (await t.r.receive(sns({ topic: SMS_TOPIC, message: ev('TEXT_BLOCKED') }))).status,
      200,
    );
    assert.equal(
      (await t.r.receive(sns({ topic: SMS_TOPIC, message: ev('TEXT_SUCCESSFUL') }))).status,
      200,
    );
    assert.deepEqual(
      t.stored.map((s) => [s.source, JSON.parse(s.payload.toString()).status]),
      [
        ['sms', 'delivered'],
        ['sms', 'failed'],
      ],
    );
    assert.ok(t.stored.every((s) => !s.payload.toString().includes('+1555')));
  });

  test('no log line carries message content', async () => {
    const t = build();
    await t.r.receive(sns({ message: 'garbage patient@example.test' }));
    await t.r.receive(sns({ type: 'SubscriptionConfirmation' }));
    await t.r.receive(sns({ type: 'UnsubscribeConfirmation' }));
    assert.ok(t.logs.length > 0);
    assert.ok(
      t.logs.every((l) => !/patient@|garbage|tok-1|\.pem/.test(l)),
      t.logs.join('\n'),
    );
  });
});

describe('route over HTTP', () => {
  let s: Running;
  const t = build();
  before(async () => {
    s = await start({
      controllers: createIntegrationsHostControllers({
        directory: {} as never,
        receiver: { receive: () => Promise.resolve({ status: 404 }) },
        snsReceipts: t.r,
      }),
    });
  });
  after(async () => {
    await s.close();
  });
  const post = (body: Buffer, contentType: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(s.base);
      const r = request(
        {
          host: u.hostname,
          port: u.port,
          method: 'POST',
          path: '/webhooks/sns/receipts',
          headers: { host: 'integrations.example.test', 'content-type': contentType },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      r.on('error', reject);
      r.end(body);
    });

  test('SNS posts text/plain: the exact bytes are verified and stored; tampered bytes are 401', async () => {
    const m = sns();
    assert.equal(await post(m, 'text/plain; charset=UTF-8'), 200);
    assert.equal(t.stored.length, 1);
    assert.equal(
      await post(
        Buffer.from(m.toString().replace('Delivery', 'Bounce')),
        'text/plain; charset=UTF-8',
      ),
      401,
    );
    assert.equal(t.stored.length, 1);
  });

  test('also with application/json (the platform keeps the raw bytes for /webhooks/*)', async () => {
    assert.equal(await post(sns(), 'application/json'), 200);
  });

  test('unconfigured: 404', async () => {
    const x = await start({
      controllers: createIntegrationsHostControllers({
        directory: {} as never,
        receiver: { receive: () => Promise.resolve({ status: 404 }) },
      }),
    });
    try {
      const u = new URL(x.base);
      const code = await new Promise<number>((res, rej) => {
        const r = request(
          {
            host: u.hostname,
            port: u.port,
            method: 'POST',
            path: '/webhooks/sns/receipts',
            headers: { host: 'integrations.example.test', 'content-type': 'text/plain' },
          },
          (rs) => {
            rs.resume();
            rs.on('end', () => res(rs.statusCode ?? 0));
          },
        );
        r.on('error', rej);
        r.end('{}');
      });
      assert.equal(code, 404);
    } finally {
      await x.close();
    }
  });
});
