import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { request } from 'node:http';
import { cfg, effects, MIN_RELEASE, R, resetEffects, start } from './harness.js';
import type { Running } from './harness.js';
import { Lifecycle } from '../../src/platform/health.js';
import { StreamRegistry } from '../../src/platform/stream.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response): Promise<any> => r.json();
const portal = { host: 'staff.example.test' };
let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});
beforeEach(resetEffects);

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(s.base + path, { headers });

// node:fetch cannot set Host; use http.request when the host matters.
function raw(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const u = new URL(s.base);
    const r = request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe('client-release check (28.6, 38.2 item 20; TC-API-11)', () => {
  for (const [label, hdr] of [
    ['no header', {}],
    ['malformed (no r prefix)', { 'x-client-release': '142.3f9a1c2b7d10' }],
    ['malformed (short sha)', { 'x-client-release': 'r142.abc' }],
    ['malformed (zero)', { 'x-client-release': 'r0.3f9a1c2b7d10' }],
    ['malformed (injection)', { 'x-client-release': 'r142.3f9a1c2b7d10; drop' }],
    ['below min_client_release', { 'x-client-release': R(MIN_RELEASE - 1) }],
  ] as [string, Record<string, string>][]) {
    test(`refused: ${label} -> 400 kernel.client_release_unsupported, no effect`, async () => {
      for (const [method, path] of [
        ['GET', '/api/v1/ping'],
        ['POST', '/api/v1/echo'],
        ['GET', '/api/v1/protected'],
        ['GET', '/api/v1/nonexistent'],
      ] as const) {
        const r = await raw(
          method,
          path,
          { ...portal, ...hdr, 'content-type': 'application/json' },
          method === 'POST' ? '{}' : undefined,
        );
        assert.equal(r.status, 400, `${method} ${path}`);
        const b = JSON.parse(r.body);
        assert.equal(b.code, 'kernel.client_release_unsupported');
        assert.equal(b.retryable, false);
        assert.equal(b.status, 400);
        assert.ok(typeof b.requestId === 'string' && b.requestId.length > 0);
        assert.deepEqual(Object.keys(b).sort(), [
          'code',
          'requestId',
          'retryable',
          'status',
          'title',
          'type',
        ]);
        assert.equal(r.headers['cache-control'], 'no-store');
      }
      // Nothing downstream ran: no handler, no guard/policy (session lookup), no session write, no idempotency row.
      assert.deepEqual(
        { ...effects },
        { handler: 0, policy: 0, sessionWrites: 0, idempotencyRows: 0 },
      );
    });
  }

  test('accepted: N-1, N and N+1', async () => {
    for (const n of [MIN_RELEASE, MIN_RELEASE + 1, MIN_RELEASE + 50]) {
      const r = await get('/api/v1/ping', { 'x-client-release': R(n) });
      assert.equal(r.status, 200, `release ${n}`);
    }
    assert.equal(effects.handler, 3);
  });

  test('a path in other letter case does not escape the check', async () => {
    const r = await get('/API/V1/ping');
    assert.equal(r.status, 400);
    assert.equal((await j(r)).code, 'kernel.client_release_unsupported');
  });

  test('exempt routes work without the header: four navigations, /healthz, /readyz', async () => {
    for (const p of [
      '/api/v1/auth/sign-in',
      '/api/v1/auth/callback',
      '/api/v1/calendar-link/callback',
      '/api/v1/appointments/0192abcd/calendar.ics',
      '/healthz',
      '/readyz',
    ]) {
      assert.equal((await get(p)).status, 200, p);
    }
  });

  test('exemption is by route template and method: POST to a navigation route is still checked', async () => {
    const r = await raw(
      'POST',
      '/api/v1/auth/sign-in',
      { ...portal, 'content-type': 'application/json' },
      '{}',
    );
    assert.equal(r.status, 400);
  });

  test('the integrations. host is exempt as a whole, including /api/* paths and public/v1', async () => {
    const a = await raw('GET', '/public/v1/status', { host: 'integrations.example.test' });
    assert.equal(a.status, 200);
    const b = await raw('GET', '/api/v1/ping', { host: 'integrations.example.test' });
    assert.equal(b.status, 200);
  });

  test('a client header cannot turn the check off', async () => {
    const r = await raw('GET', '/api/v1/ping', {
      ...portal,
      'x-forwarded-host': 'integrations.example.test',
      origin: 'https://integrations.example.test',
    });
    assert.equal(r.status, 400);
  });

  test('SSE: outdated or missing clientRelease -> plain 400 before any event; current is accepted by the check', async () => {
    for (const q of [
      '',
      '?clientRelease=' + R(MIN_RELEASE - 1),
      '?clientRelease=junk',
      '?clientRelease=a&clientRelease=b',
    ]) {
      const r = await get('/api/v1/alerts/stream' + q, { accept: 'text/event-stream' });
      assert.equal(r.status, 400, q);
      assert.match(r.headers.get('content-type') ?? '', /json/);
      assert.equal((await j(r)).code, 'kernel.client_release_unsupported');
    }
    // With a current value the release check passes and the guard (no identity yet) answers 401: not a release error.
    const ok = await get('/api/v1/alerts/stream?clientRelease=' + R(MIN_RELEASE), {
      accept: 'text/event-stream',
    });
    assert.equal(ok.status, 401);
    assert.equal((await j(ok)).code, 'auth.unauthenticated');
  });

  test('no Access-Control-Allow-* header on portal-host responses, and a preflight is not answered', async () => {
    const hdr = { ...portal, origin: 'https://evil.example', 'x-client-release': R(MIN_RELEASE) };
    for (const [m, p] of [
      ['GET', '/api/v1/ping'],
      ['GET', '/api/v1/protected'],
      ['GET', '/api/v1/nope'],
      ['GET', '/healthz'],
    ] as const) {
      const r = await raw(m, p, hdr);
      assert.deepEqual(
        Object.keys(r.headers).filter((h) => h.startsWith('access-control-')),
        [],
        `${m} ${p}`,
      );
    }
    const pre = await raw('OPTIONS', '/api/v1/ping', {
      ...hdr,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-client-release',
    });
    assert.ok(pre.status >= 400, `preflight status ${pre.status}`);
    assert.deepEqual(
      Object.keys(pre.headers).filter((h) => h.startsWith('access-control-')),
      [],
    );
  });
});

describe('guard, deny by default (27.1, 38.2 item 9)', () => {
  const h = { 'x-client-release': R(MIN_RELEASE + 1) };
  test('a handler with no declaration is refused 403 and never runs', async () => {
    const r = await get('/api/v1/undeclared', h);
    assert.equal(r.status, 403);
    assert.equal((await j(r)).code, 'auth.forbidden');
    assert.equal(effects.handler, 0);
  });
  test('a declared permission without a session is 401 until identity supplies the policy', async () => {
    const r = await get('/api/v1/protected', h);
    assert.equal(r.status, 401);
    assert.equal(effects.handler, 0);
    assert.equal(effects.policy, 1);
  });
  test('a public declaration passes', async () => {
    assert.equal((await get('/api/v1/ping', h)).status, 200);
  });
  test('an unknown route is the standard 404', async () => {
    const r = await get('/api/v1/nothing-here', h);
    assert.equal(r.status, 404);
    assert.equal((await j(r)).code, 'kernel.not_found');
  });
});

describe('headers (28.2)', () => {
  test('every response carries X-Request-Id and Cache-Control: no-store (success, error, 404, health)', async () => {
    for (const [p, h] of [
      ['/api/v1/ping', { 'x-client-release': R(MIN_RELEASE) }],
      ['/api/v1/ping', {}],
      ['/api/v1/nope', { 'x-client-release': R(MIN_RELEASE) }],
      ['/healthz', {}],
      ['/readyz', {}],
      ['/api/v1/protected', { 'x-client-release': R(MIN_RELEASE) }],
    ] as const) {
      const r = await get(p, h);
      assert.equal(r.headers.get('cache-control'), 'no-store', p);
      assert.ok((r.headers.get('x-request-id') ?? '').length >= 8, p);
      await r.arrayBuffer();
    }
  });
  test('a caller request id is echoed when well formed and replaced when not', async () => {
    const a = await get('/healthz', { 'x-request-id': 'abc-12345678' });
    assert.equal(a.headers.get('x-request-id'), 'abc-12345678');
    const b = await get('/healthz', { 'x-request-id': 'bad id\twith spaces' });
    assert.notEqual(b.headers.get('x-request-id'), 'bad id\twith spaces');
  });
  test('/public/v1/* is the one max-age=60 exception', async () => {
    const r = await raw('GET', '/public/v1/status', { host: 'integrations.example.test' });
    assert.equal(r.headers['cache-control'], 'public, max-age=60');
  });
  test('the error body request id equals the response header', async () => {
    const r = await get('/api/v1/ping');
    assert.equal((await j(r)).requestId, r.headers.get('x-request-id'));
  });
});

describe('request limits (31.2)', () => {
  const h = { 'x-client-release': R(MIN_RELEASE), 'content-type': 'application/json' };
  const big = (n: number): string => JSON.stringify({ t: 'x'.repeat(n) });
  test('JSON body over 1 MB -> 413 kernel.payload_too_large; under is accepted', async () => {
    const over = await fetch(s.base + '/api/v1/echo-json', {
      method: 'POST',
      headers: h,
      body: big(1024 * 1024 + 10),
    });
    assert.equal(over.status, 413);
    assert.equal((await j(over)).code, 'kernel.payload_too_large');
    const under = await fetch(s.base + '/api/v1/echo-json', {
      method: 'POST',
      headers: h,
      body: big(900 * 1024),
    });
    assert.equal(under.status, 201);
  });
  test('note PATCH is limited to 256 KB', async () => {
    const over = await fetch(s.base + '/api/v1/notes/0192', {
      method: 'PATCH',
      headers: h,
      body: big(300 * 1024),
    });
    assert.equal(over.status, 413);
    const under = await fetch(s.base + '/api/v1/notes/0192', {
      method: 'PATCH',
      headers: h,
      body: big(200 * 1024),
    });
    assert.equal(under.status, 200);
  });
  test('a chunked body with no Content-Length is limited too', async () => {
    const stream = new Blob([big(1024 * 1024 + 10)]).stream();
    const r = await fetch(s.base + '/api/v1/echo-json', {
      method: 'POST',
      headers: h,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    assert.equal(r.status, 413);
  });
  test('malformed JSON -> 400 kernel.validation_failed, body never echoed', async () => {
    const r = await fetch(s.base + '/api/v1/echo-json', {
      method: 'POST',
      headers: h,
      body: '{"secret":"Jane Doe",',
    });
    assert.equal(r.status, 400);
    const text = await r.text();
    assert.equal(JSON.parse(text).code, 'kernel.validation_failed');
    assert.ok(!text.includes('Jane'));
  });
  test('header block over 16 KB is refused by the server', async () => {
    const r = await raw('GET', '/healthz', { 'x-pad': 'a'.repeat(17 * 1024) });
    assert.equal(r.status, 431);
  });
});

describe('health (DPR-04)', () => {
  test('/healthz is shallow and /readyz reports ready, with no header and no PHI', async () => {
    const a = await get('/healthz');
    assert.deepEqual(await a.json(), { status: 'ok' });
    const b = await get('/readyz');
    assert.deepEqual(await b.json(), { status: 'ready' });
  });
  test('/readyz is 503 kernel.unavailable when draining', async () => {
    const lc = s.app.get(Lifecycle);
    lc.draining = true;
    try {
      const r = await get('/readyz');
      assert.equal(r.status, 503);
      assert.equal(r.headers.get('retry-after'), '5');
      assert.equal((await j(r)).code, 'kernel.unavailable');
      assert.equal((await get('/healthz')).status, 200); // liveness unaffected
    } finally {
      lc.draining = false;
    }
  });
  test('/readyz is 503 when the database is down or the a declared relation is missing', async () => {
    const down = await start({
      readiness: {
        missingRelations: () =>
          Promise.reject(new Error('connect ECONNREFUSED postgres://u:secretpw@h/db')),
      },
    });
    const old = await start({
      readiness: { missingRelations: () => Promise.resolve(['kernel.rate_counter']) },
    });
    try {
      const a = await fetch(down.base + '/readyz');
      const text = await a.text();
      assert.equal(a.status, 503);
      assert.ok(!text.includes('secretpw'));
      assert.equal((await fetch(down.base + '/healthz')).status, 200);
      assert.equal((await fetch(old.base + '/readyz')).status, 503);
    } finally {
      await down.close();
      await old.close();
    }
  });
});

describe('rate limits (31.3) and timeout (31.2)', () => {
  test('writes: 60/min per client, then 429 kernel.rate_limited with Retry-After; reads have their own budget', async () => {
    const lim = await start({ limiter: undefined });
    try {
      const h = { 'x-client-release': R(MIN_RELEASE), 'content-type': 'application/json' };
      let last = 0;
      for (let i = 0; i < 61; i++)
        last = (
          await fetch(lim.base + '/api/v1/echo-json', { method: 'POST', headers: h, body: '{}' })
        ).status;
      assert.equal(last, 429);
      const r = await fetch(lim.base + '/api/v1/echo-json', {
        method: 'POST',
        headers: h,
        body: '{}',
      });
      const b = await j(r);
      assert.equal(b.code, 'kernel.rate_limited');
      assert.equal(b.retryable, true);
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
      assert.equal((await fetch(lim.base + '/api/v1/ping', { headers: h })).status, 200);
    } finally {
      await lim.close();
    }
  });
  test('a request over the timeout -> 504 kernel.timeout', async () => {
    const t = await start({ config: cfg({ requestTimeoutMs: 150 }) });
    try {
      const r = await fetch(t.base + '/api/v1/slow', {
        headers: { 'x-client-release': R(MIN_RELEASE) },
      });
      assert.equal(r.status, 504);
      assert.equal((await j(r)).code, 'kernel.timeout');
    } finally {
      await t.close();
    }
  });
});

describe('stream shell (32)', () => {
  test('an authorised client gets text/event-stream, ping framing, and event: closed on drain', async () => {
    const allow = await start({ policy: { authorize: () => Promise.resolve() } });
    try {
      const ac = new AbortController();
      const r = await fetch(allow.base + '/api/v1/alerts/stream?clientRelease=' + R(MIN_RELEASE), {
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /retry: 5000/);
      assert.equal(allow.app.get(StreamRegistry).count(), 1);
      allow.app.get(StreamRegistry).drain();
      let rest = '';
      for (;;) {
        const c = await reader.read();
        if (c.done) break;
        rest += new TextDecoder().decode(c.value);
      }
      assert.match(rest, /event: closed/);
    } finally {
      await allow.close();
    }
  });
});
