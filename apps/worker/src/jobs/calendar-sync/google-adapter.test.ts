import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CredentialReader, VendorCall } from '../integration-core/adapters.js';
import { AdapterFailure } from '../integration-core/errors.js';
import { BUSY_TITLE, GoogleCalendarAdapter } from './google-adapter.js';

const DOC = '0192abcd-1234-7abc-8def-0123456789ab';
interface Seen {
  method: string;
  url: string;
  body: string;
  auth: string | null;
}
function harness(
  handler: (s: Seen) => { status: number; body?: unknown } | undefined = () => undefined,
) {
  const seen: Seen[] = [];
  let refreshes = 0;
  const fetchStub = ((
    url: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const s: Seen = {
      method: init.method ?? 'GET',
      url: String(url),
      body: String(init.body ?? ''),
      auth: init.headers?.authorization ?? null,
    };
    seen.push(s);
    if (s.url.endsWith('/token')) {
      refreshes++;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `AT-${refreshes}`, expires_in: 3600 }), {
          status: 200,
        }),
      );
    }
    const r = handler(s) ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status }),
    );
  }) as typeof fetch;
  const adapter = new GoogleCalendarAdapter({
    apiBase: 'http://g.test',
    tokenEndpoint: 'http://g.test/token',
    fetch: fetchStub,
  });
  const creds: CredentialReader = {
    get: (n) => Promise.resolve(n === `cal-${DOC}` ? 'REFRESH-CANARY' : 'client-secret'),
  };
  const call = (operation: string, args: Record<string, unknown>) =>
    adapter.call({
      operation: operation as never,
      args: { clinicianId: DOC, calendarId: 'primary', ...args },
      connection: {
        id: 'c',
        kind: 'google_calendar',
        vendor: 'google',
        settings: { clientId: 'cid' },
      },
      credentials: creds,
      idempotencyToken: 'tok-12345678',
      signal: new AbortController().signal,
    } as VendorCall & { operation: never });
  return { seen, call, refreshes: () => refreshes, adapter };
}
const rejectedWith = (p: Promise<unknown>, retryable: boolean, status?: number) =>
  assert.rejects(p, (e: AdapterFailure) => {
    assert.ok(e instanceof AdapterFailure);
    assert.equal(e.retryable, retryable);
    if (status !== undefined) assert.equal(e.httpStatus, status);
    return true;
  });
const B = {
  eventId: 'ehr0192abcd12347abc8def0123456789ab',
  startsAt: '2031-05-01T14:00:00Z',
  endsAt: '2031-05-01T14:30:00Z',
};

test('push_busy writes ONE event: title "Busy", private, no description, attendee, location or reference to the patient (BR-07)', async () => {
  const h = harness();
  await h.call('push_busy', B);
  const post = h.seen.find((s) => s.method === 'POST' && s.url.endsWith('/events'));
  const body = JSON.parse(post?.body as string) as Record<string, unknown>;
  assert.equal(body['summary'], BUSY_TITLE);
  assert.equal(BUSY_TITLE, 'Busy');
  assert.deepEqual(Object.keys(body).sort(), [
    'end',
    'extendedProperties',
    'id',
    'reminders',
    'start',
    'summary',
    'transparency',
    'visibility',
  ]);
  assert.equal(body['visibility'], 'private');
  assert.equal(post?.auth, 'Bearer AT-1');
  assert.ok(
    !JSON.stringify(h.seen).includes('REFRESH-CANARY') ||
      h.seen
        .filter((s) => s.body.includes('REFRESH-CANARY'))
        .every((s) => s.url.endsWith('/token')),
    'the refresh token goes only to the token endpoint',
  );
});

test('push_busy is idempotent: an existing event (409) is made equal and confirmed; delete treats 404 and 410 as done', async () => {
  const h = harness((s) =>
    s.method === 'POST' && s.url.endsWith('/events') ? { status: 409 } : undefined,
  );
  await h.call('push_busy', B);
  const put = h.seen.find((s) => s.method === 'PUT');
  assert.ok(put?.url.endsWith(`/events/${B.eventId}`));
  assert.equal((JSON.parse(put?.body as string) as { status: string }).status, 'confirmed');
  const d = harness(() => ({ status: 404 }));
  assert.equal((await d.call('delete_busy', { eventId: B.eventId })).httpStatus, 404);
  assert.equal(
    (await harness(() => ({ status: 410 })).call('delete_busy', { eventId: B.eventId })).httpStatus,
    410,
  );
});

test('incremental_sync: asks for no title, returns intervals only; a sync token excludes timeMin; 410 is a non-retryable gone', async () => {
  const h = harness(() => ({
    status: 200,
    body: {
      timeZone: 'America/New_York',
      nextSyncToken: 'NEXT',
      items: [
        {
          id: 'e1',
          summary: 'SECRET TITLE',
          description: 'SECRET',
          start: { dateTime: '2031-05-01T14:00:00Z' },
          end: { dateTime: '2031-05-01T15:00:00Z' },
        },
      ],
    },
  }));
  const r = await h.call('incremental_sync', {
    timeMin: '2031-05-01T00:00:00Z',
    timeMax: '2032-05-01T00:00:00Z',
  });
  assert.ok(!JSON.stringify(r).includes('SECRET'), 'nothing of the content is returned');
  assert.deepEqual((r.data as { changes: unknown[] }).changes, [
    {
      eventId: 'e1',
      busy: { startsAt: '2031-05-01T14:00:00.000Z', endsAt: '2031-05-01T15:00:00.000Z' },
    },
  ]);
  assert.equal((r.data as { nextSyncToken: string }).nextSyncToken, 'NEXT');
  const url = new URL(h.seen.find((s) => s.method === 'GET')?.url as string);
  for (const leak of ['summary', 'description', 'location', 'displayName', 'email'])
    assert.ok(!(url.searchParams.get('fields') as string).includes(leak));
  const inc = harness(() => ({ status: 410 }));
  await rejectedWith(inc.call('incremental_sync', { syncToken: 'S1' }), false, 410);
  const u = new URL(inc.seen.find((s) => s.method === 'GET')?.url as string);
  assert.equal(u.searchParams.get('syncToken'), 'S1');
  assert.equal(u.searchParams.get('timeMin'), null);
  await rejectedWith(harness().call('incremental_sync', {}), false, undefined); // neither a token nor a window
});

test('failures: outages and rate limits are retryable; a refusal is not; a rejected grant is token_revoked (401); no error carries a body', async () => {
  for (const status of [500, 502, 503, 429, 408])
    await rejectedWith(harness(() => ({ status })).call('push_busy', B), true, status);
  await rejectedWith(
    harness(() => ({
      status: 403,
      body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
    })).call('push_busy', B),
    true,
    403,
  );
  await rejectedWith(
    harness(() => ({ status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } })).call(
      'push_busy',
      B,
    ),
    false,
    403,
  );
  await rejectedWith(
    harness(() => ({ status: 400, body: { error: 'CANARY-ECHO' } })).call('push_busy', B),
    false,
    400,
  );
  await rejectedWith(
    harness(() => ({ status: 404 })).call('watch', {
      channelId: 'c1',
      token: 't',
      address: 'https://x.test/h',
      expiresAtMs: 1,
    }),
    false,
    404,
  );
  const e = (await harness(() => ({ status: 400, body: { error: 'CANARY-ECHO' } }))
    .call('push_busy', B)
    .catch((x: Error) => x)) as Error;
  assert.ok(!e.message.includes('CANARY') && !String(e.stack).includes('CANARY'));
  // the access token is refused twice (after one refresh): the grant is gone
  const h = harness(() => ({ status: 401 }));
  await rejectedWith(h.call('push_busy', B), false, 401);
  assert.equal(h.refreshes(), 2, 'one refresh, then the revoked grant is reported');
  // the token endpoint refuses the refresh token (invalid_grant): token_revoked without a body
  const bad = new GoogleCalendarAdapter({
    apiBase: 'http://g.test',
    tokenEndpoint: 'http://g.test/token',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      )) as never,
  });
  await rejectedWith(
    bad.call({
      operation: 'push_busy',
      args: { clinicianId: DOC, calendarId: 'primary', ...B },
      connection: {
        id: 'c',
        kind: 'google_calendar',
        vendor: 'google',
        settings: { clientId: 'cid' },
      },
      credentials: { get: () => Promise.resolve('x') },
      idempotencyToken: 'tok-12345678',
      signal: new AbortController().signal,
    } as never),
    false,
    401,
  );
});

test('the access token is cached per doctor and never printed; a missing client ID is a configuration failure; arguments are validated', async () => {
  const h = harness();
  await h.call('delete_busy', { eventId: B.eventId });
  await h.call('delete_busy', { eventId: B.eventId });
  assert.equal(h.refreshes(), 1);
  const internals =
    JSON.stringify(h.adapter) +
    String((h.adapter as unknown as { access: Map<string, unknown> }).access.get(DOC));
  assert.ok(!internals.includes('AT-1'), 'the cached token is redacted when printed');
  await rejectedWith(harness().call('push_busy', { ...B, eventId: 'NOT BASE32!' }), false);
  await rejectedWith(harness().call('push_busy', { ...B, startsAt: 'nope' }), false);
  await rejectedWith(
    harness().call('watch', {
      channelId: 'c',
      token: 't',
      address: 'http://insecure.test',
      expiresAtMs: 1,
    }),
    false,
  );
  const noClient = new GoogleCalendarAdapter({
    apiBase: 'http://g.test',
    tokenEndpoint: 'http://g.test/token',
    fetch: (() => Promise.resolve(new Response('{}'))) as never,
  });
  await rejectedWith(
    noClient.call({
      operation: 'delete_busy',
      args: { clinicianId: DOC, calendarId: 'primary', eventId: B.eventId },
      connection: { id: 'c', kind: 'google_calendar', vendor: 'google', settings: {} },
      credentials: { get: () => Promise.resolve('x') },
      idempotencyToken: 'tok-12345678',
      signal: new AbortController().signal,
    } as never),
    false,
  );
});

test('watch and stop_watch: the channel token travels in the body only; 404 on stop is done; the result carries the resource ID', async () => {
  const h = harness((s) =>
    s.url.endsWith('/watch')
      ? { status: 200, body: { id: 'c1', resourceId: 'res-1', expiration: '1900000000000' } }
      : { status: 404 },
  );
  const r = await h.call('watch', {
    channelId: 'c1',
    token: 'v.k2.1.abc',
    address: 'https://integrations.example.test/webhooks/google/calendar',
    expiresAtMs: 1_900_000_000_000,
  });
  assert.deepEqual(r.data, { resourceId: 'res-1', expiresAtMs: 1_900_000_000_000 });
  const w = h.seen.find((s) => s.url.endsWith('/watch'));
  assert.equal(JSON.parse(w?.body as string).type, 'web_hook');
  assert.ok(!w?.url.includes('v.k2'));
  assert.equal(
    (await h.call('stop_watch', { channelId: 'c1', resourceId: 'res-1' })).httpStatus,
    404,
  );
});

test('health check: an unauthenticated read, no credential involved', async () => {
  const h = harness();
  assert.deepEqual(await h.adapter.healthCheck(), { ok: true, httpStatus: 200 });
  assert.equal(h.refreshes(), 0);
});
