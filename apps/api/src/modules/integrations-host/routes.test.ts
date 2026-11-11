// BE-22 unit and HTTP tests: a real Nest application on a loopback port with the real platform layer, this module's controllers and
// recording ports. They prove routing, headers, cookies, verbs, raw-body handling and the status mapping of the webhook route. They do
// NOT prove persistence, RLS or the real views: those are in integrations-host.dbtest.ts, on PostgreSQL.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import type { KernelDb, Tx } from '@ehr/kernel';
import { cfg, start } from '../../../test/platform/harness.js';
import type { Running } from '../../../test/platform/harness.js';
import { inventory } from '../../platform/inventory.js';
import { PUBLIC } from '../../platform/permissions.js';
import { createIntegrationsHostControllers } from './controller.js';
import type { WebhookReceiverPort } from './ports.js';
import { PublicDirectoryService } from './public-directory.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const L1 = '00000000-0000-4000-8000-000000000011';
const L2 = '00000000-0000-4000-8000-000000000012';
const S1 = '00000000-0000-4000-8000-000000000021';
const S2 = '00000000-0000-4000-8000-000000000022';
const D1 = '00000000-0000-4000-8000-000000000031';
const D2 = '00000000-0000-4000-8000-000000000032';
const D3 = '00000000-0000-4000-8000-000000000033';

const scopes: unknown[] = [];
const queries: string[] = [];
/** A fake database whose "view" rows are what the real C0 views would have left; the test of the views is the dbtest. */
const db = {
  withScope: async (scope: unknown, fn: (tx: Tx) => Promise<unknown>) => {
    scopes.push(scope);
    return fn({
      query: (sql: string) => {
        queries.push(sql);
        if (/identity\.public_clinician/.test(sql))
          return Promise.resolve({
            rows: [
              { principal_id: D1, display_name: 'Dr Ada' },
              { principal_id: D2, display_name: 'Dr Bo' },
              { principal_id: D3, display_name: 'Dr Cy' },
            ],
          });
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Tx);
  },
} as unknown as KernelDb;

const organisation = {
  directoryLocations: () =>
    Promise.resolve([
      {
        id: L1,
        name: 'Main',
        kind: 'clinic',
        timeZone: 'America/New_York',
        address: {},
        stateCode: 'NY',
        geo: null,
        phone: null,
        internalNote: 'LEAK',
      },
    ]),
  directoryServices: (_tx: Tx, f: { locationId?: string } = {}) =>
    Promise.resolve(
      [
        {
          id: S1,
          patientDisplayName: 'Check-up',
          durationMin: 20,
          mode: 'either',
          internalName: 'LEAK',
        },
        { id: S2, patientDisplayName: 'Follow-up', durationMin: 15, mode: 'video' },
      ].filter(
        (s) => f.locationId === undefined || (f.locationId === L1 ? s.id === S1 : s.id === S2),
      ),
    ),
  directoryBanners: () => Promise.resolve([]),
  directoryServiceClinicians: (_tx: Tx, serviceId: string) =>
    Promise.resolve(serviceId === S1 ? [D1, D2] : serviceId === S2 ? [D3] : []),
};
const scheduling = {
  directoryClinicianLocations: (_tx: Tx, loc?: string | null) =>
    Promise.resolve(
      [
        { clinicianId: D1, locationId: L1 },
        { clinicianId: D2, locationId: L2 },
        { clinicianId: D3, locationId: L2 },
      ].filter((p) => loc === undefined || loc === null || p.locationId === loc),
    ),
};

const received: { source: string; headers: Record<string, string | undefined>; rawBody: Buffer }[] =
  [];
let nextStatus: number = 200;
const receiver: WebhookReceiverPort = {
  receive: (r) => {
    received.push(r);
    return Promise.resolve(
      nextStatus === 200 ? { status: 200, outcome: 'inserted' } : { status: nextStatus },
    );
  },
};
const refused: { source: string; status: number }[] = [];
const directory = new PublicDirectoryService({ db, orgId: ORG, organisation, scheduling });
const controllers = createIntegrationsHostControllers({
  directory,
  receiver,
  onWebhookRefused: (i) => refused.push(i),
});

let s: Running;
before(async () => {
  s = await start({ controllers });
});
after(async () => {
  await s.close();
});

const HOST = { host: 'integrations.example.test' };
function http(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Buffer,
) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const u = new URL(s.base);
    const r = request(
      { host: u.hostname, port: u.port, method, path, headers: { ...HOST, ...headers } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }),
        );
      },
    );
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('route inventory: four public GET routes and three webhook POST routes, all declared public and release-exempt', () => {
  const r = inventory(controllers as never);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`).sort(), [
    'GET /public/v1/banners',
    'GET /public/v1/clinicians',
    'GET /public/v1/locations',
    'GET /public/v1/services',
    'POST /webhooks/messaging/:vendor',
    'POST /webhooks/sns/receipts',
    'POST /webhooks/video/:vendor',
  ]);
  for (const x of r.routes) {
    assert.equal(x.declaration?.permission, PUBLIC);
    assert.equal(x.declaration?.releaseExempt, true);
  }
});

describe('public directory over HTTP', () => {
  test('answers with max-age=60, request id, no Set-Cookie, no CORS; only allow-listed fields', async () => {
    for (const p of ['/public/v1/services', '/public/v1/locations', '/public/v1/clinicians']) {
      const r = await http('GET', p, { cookie: '__Host-sid=SESSION-CANARY' });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['cache-control'], 'public, max-age=60');
      assert.ok(r.headers['x-request-id']);
      assert.equal(r.headers['set-cookie'], undefined);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
      assert.ok(!r.body.includes('LEAK'), 'a non-allow-listed field reached the response');
    }
  });

  test('every read runs as audience public with the configured org and nothing else, read-only', async () => {
    scopes.length = 0;
    queries.length = 0;
    await http('GET', '/public/v1/locations');
    assert.deepEqual(scopes, [{ audience: 'public', orgId: ORG }]);
    assert.equal(queries[0], 'SET LOCAL transaction_read_only = on');
  });

  test('POST, PUT, PATCH, DELETE are refused with 404/405 and reach no database', async () => {
    scopes.length = 0;
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'])
      for (const p of ['/public/v1/services', '/public/v1/locations', '/public/v1/clinicians']) {
        const r = await http(m, p, { 'content-type': 'application/json' }, '{}');
        assert.ok(r.status === 404 || r.status === 405, `${m} ${p} -> ${r.status}`);
        assert.notEqual(r.headers['cache-control'], 'public, max-age=60');
      }
    assert.deepEqual(scopes, []);
  });

  test('unknown or malformed query parameters are 400 (CN-12), and never cached', async () => {
    for (const p of [
      '/public/v1/services?x=1',
      '/public/v1/locations?locationId=' + L1,
      '/public/v1/services?locationId=not-a-uuid',
      '/public/v1/clinicians?serviceId=1;drop',
      `/public/v1/clinicians?serviceId=${S1}&serviceId=${S2}`,
    ]) {
      const r = await http('GET', p);
      assert.equal(r.status, 400, p);
      assert.notEqual(r.headers['cache-control'], 'public, max-age=60');
    }
  });

  test('clinicians: only the intersection of listed, bookable at the place and eligible for the service', async () => {
    const ids = async (q: string) =>
      (
        JSON.parse((await http('GET', '/public/v1/clinicians' + q)).body) as {
          items: { clinicianId: string }[];
        }
      ).items.map((i) => i.clinicianId);
    assert.deepEqual(await ids(''), [D1, D2, D3]);
    assert.deepEqual(await ids(`?serviceId=${S1}`), [D1, D2]);
    assert.deepEqual(await ids(`?locationId=${L2}`), [D2, D3]);
    // D1 has no template at L2, D3 is not eligible for S1
    assert.deepEqual(await ids(`?serviceId=${S1}&locationId=${L2}`), []); // S1 is not offered at L2
    assert.deepEqual(await ids(`?serviceId=${S1}&locationId=${L1}`), [D1]);
    assert.deepEqual(await ids(`?serviceId=${S2}&locationId=${L2}`), [D3]);
    assert.deepEqual(await ids(`?serviceId=00000000-0000-4000-8000-0000000000ff`), []); // unknown/inactive: same as empty
    assert.deepEqual(await ids(`?locationId=00000000-0000-4000-8000-0000000000ee`), []);
    const r = await http('GET', `/public/v1/clinicians?serviceId=${S1}`);
    for (const i of (JSON.parse(r.body) as { items: Record<string, unknown>[] }).items)
      assert.deepEqual(Object.keys(i).sort(), ['clinicianId', 'displayName']);
  });
});

describe('webhooks over HTTP', () => {
  const sig = { 'x-signature': 'v1=abc', 'x-timestamp': '1700000000' };

  test('the raw bytes reach the receiver unchanged (non-JSON type), the cookie header does not, the source is kind.vendor', async () => {
    received.length = 0;
    nextStatus = 200;
    const body = Buffer.from('  {"id" : "e1"}\n'); // signature covers these exact bytes, whitespace included
    const r = await http(
      'POST',
      '/webhooks/video/acme',
      {
        ...sig,
        'content-type': 'text/plain',
        cookie: '__Host-sid=SESSION-CANARY',
        'content-length': String(body.length),
      },
      body,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body, '{}');
    assert.equal(received.length, 1);
    assert.equal(received[0]?.source, 'video.acme');
    assert.ok(received[0]?.rawBody.equals(body));
    assert.equal(received[0]?.headers['cookie'], undefined);
    assert.equal(received[0]?.headers['x-signature'], 'v1=abc');
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('status mapping: 400, 401, 404, 413, 503 from the receiver become problem responses; nothing is cached', async () => {
    refused.length = 0;
    for (const [from, to] of [
      [400, 400],
      [401, 401],
      [404, 404],
      [413, 413],
      [503, 503],
      [500, 503],
    ] as const) {
      nextStatus = from;
      const r = await http(
        'POST',
        '/webhooks/messaging/acme',
        { ...sig, 'content-type': 'text/plain' },
        'x',
      );
      assert.equal(r.status, to);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.ok(!r.body.includes('v1=abc'));
    }
    assert.equal(refused.length, 6);
    nextStatus = 200;
  });

  test('a JSON body reaches the receiver as the exact raw bytes (platform keeps them for /webhooks/*)', async () => {
    received.length = 0;
    const r = await http(
      'POST',
      '/webhooks/video/acme',
      { ...sig, 'content-type': 'application/json' },
      '{"id":"e1"}',
    );
    assert.equal(r.status, 200);
    assert.equal(received.length, 1);
    assert.ok(received[0]?.rawBody.equals(Buffer.from('{"id":"e1"}')));
  });

  test('a body over 256 KB is 413 before the receiver', async () => {
    received.length = 0;
    const r = await http(
      'POST',
      '/webhooks/video/acme',
      { ...sig, 'content-type': 'text/plain' },
      Buffer.alloc(262_145, 0x20),
    );
    assert.equal(r.status, 413);
    assert.equal(received.length, 0);
  });

  test('GET on a webhook path is not routed', async () => {
    const r = await http('GET', '/webhooks/video/acme');
    assert.ok(r.status === 404 || r.status === 405);
  });

  test('the host config used here is the integrations host: the release header is not required', async () => {
    assert.equal(cfg().integrationsHost, 'integrations.example.test');
    const r = await http('GET', '/public/v1/locations'); // no x-client-release
    assert.equal(r.status, 200);
  });
});
