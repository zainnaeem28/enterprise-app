// Real-database tests of calendar-sync (BE-14) on PostgreSQL 17 with the real roles, migrations, queue, Nest application and guard, the
// worker's real jobs and the integration-core gateway, against a LOCAL contract stub of Google (testkit.ts). Covers TC-CAL-01..06 as far
// as a stub can (real-Google evidence needs the test tenant, C-10, and is BLOCKED), the OAuth link callback and its secret write
// (SA-DP-06, canary), the push route (29.5), the `410 Gone` rule (QA-AL-01, SAR-IDF-03), and the database rules under them.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/calendar-sync/calendar-sync.dbtest.js
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  A1,
  AUTH_CODE,
  CLIENT_SECRET,
  ORG,
  REFRESH_TOKEN,
  RETURN_URL,
  SENSITIVE_NAME,
  SVC_SENS,
  call,
  pg,
  setupCalendar,
  staffMember,
  writeHeaders,
} from './testkit.js';
import type { CalendarKit, SeededSession } from './testkit.js';
import { googleChannelToken } from '../integration-core/index.js';
import { makeState } from './state.js';

let t: CalendarKit;
before(async () => {
  t = await setupCalendar('cal');
});
after(async () => {
  await t?.close();
});

const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const one = async <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R> =>
  (await q<R>(sql, p))[0] as R;
const nrows = async (sql: string, p?: unknown[]): Promise<number> =>
  Number((await one<{ n: string }>(sql, p)).n);
const daysAhead = (d: number, hour = 14): Date => {
  const x = new Date(Date.now() + d * 86_400_000);
  x.setUTCHours(hour, 0, 0, 0);
  return x;
};
const iso = (d: Date): string => d.toISOString();
const principalOf = (s: SeededSession): string => s.seeded.principalId;
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();
const meeting = (id: string, start: Date, minutes = 60, extra: Record<string, unknown> = {}) => ({
  id,
  status: 'confirmed',
  summary: 'Dr Smith: HIV follow-up with Jane Roe (CANARY title)',
  description: 'Diagnosis: CANARY description',
  start: { dateTime: iso(start) },
  end: { dateTime: iso(new Date(start.getTime() + minutes * 60_000)) },
  attendees: [
    {
      self: true,
      responseStatus: 'accepted',
      email: 'jane.roe@example.com',
      displayName: 'Jane Roe',
    },
  ],
  ...extra,
});
const blocks = async (doctor: string): Promise<{ hash: string; s: Date; e: Date }[]> =>
  (
    await q<{ hash: Buffer; s: Date; e: Date }>(
      `SELECT external_hash AS hash, lower(period) AS s, upper(period) AS e FROM scheduling.busy_block WHERE clinician_principal_id = $1 ORDER BY lower(period)`,
      [doctor],
    )
  ).map((r) => ({ hash: r.hash.toString('hex'), s: r.s, e: r.e }));
const linkRow = (doctor: string) =>
  one<{
    status: string;
    sync_token: string | null;
    discarded_token_hash: Buffer | null;
    last_synced_at: Date | null;
    last_error_code: string | null;
  }>(
    `SELECT status, sync_token, discarded_token_hash, last_synced_at, last_error_code FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1`,
    [doctor],
  );
const resetStub = (): void => {
  t.stub.reset();
  t.stub.events.clear();
  t.stub.delta = [];
  t.stub.failList = 0;
  t.stub.revoked = false;
  t.stub.denyInsert = false;
  t.stub.pageSize = 250;
};
const dumpAll = async (): Promise<string> => {
  const parts = [
    await q(`SELECT to_jsonb(e)::text AS x FROM audit.event e`),
    await q(`SELECT to_jsonb(j)::text AS x FROM queue._private_jobs j`),
    await q(`SELECT to_jsonb(r)::text AS x FROM integration_core.secret_ref r`),
    await q(`SELECT to_jsonb(r)::text AS x FROM integration_core.outbound_call r`),
    await q(`SELECT to_jsonb(r)::text AS x FROM integration_core.inbound_message r`),
    await q(`SELECT to_jsonb(r)::text AS x FROM calendar_sync.calendar_link r`),
    await q(`SELECT to_jsonb(r)::text AS x FROM calendar_sync.event_map r`),
    await q(`SELECT to_jsonb(r)::text AS x FROM calendar_sync.watch_channel r`),
    await q(`SELECT to_jsonb(r)::text AS x FROM scheduling.busy_block r`),
  ];
  return (
    parts
      .flat()
      .map((r) => (r as { x: string }).x)
      .join('\n') + t.logs.join('\n')
  );
};

describe("the doctor's calendar link and the OAuth callback (SA-DP-06)", () => {
  let doc: SeededSession;
  let authUrl = '';
  let state = '';
  before(async () => {
    doc = await t.doctor('Dr Link');
  });

  test('status of a doctor who has not linked; a front-desk user and an anonymous caller are refused', async () => {
    const r = await call(t.k.base, 'GET', '/api/v1/calendar-link', { cookie: doc.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { status: 'not_linked' });
    assert.equal(r.headers['cache-control'], 'no-store');
    const desk = await staffMember(t.k, 'front_desk', A1, 'Desk');
    assert.equal(
      (await call(t.k.base, 'GET', '/api/v1/calendar-link', { cookie: desk.cookie })).status,
      403,
    );
    assert.equal((await call(t.k.base, 'GET', '/api/v1/calendar-link')).status, 401);
  });

  test('start: a pending link and the Google consent URL with state, PKCE S256 and the two minimal scopes', async () => {
    const r = await call(t.k.base, 'POST', '/api/v1/calendar-link/start', {
      cookie: doc.cookie,
      headers: writeHeaders(doc),
    });
    assert.equal(r.status, 200);
    authUrl = r.json()['authorizationUrl'] as string;
    const u = new URL(authUrl);
    assert.equal(u.origin, t.stub.url);
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.deepEqual(u.searchParams.get('scope')?.split(' ').sort(), [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ]);
    state = u.searchParams.get('state') as string;
    assert.ok(state.length > 40);
    assert.equal((await linkRow(principalOf(doc))).status, 'pending_consent');
    assert.equal(
      (await call(t.k.base, 'GET', '/api/v1/calendar-link', { cookie: doc.cookie })).json()[
        'status'
      ],
      'pending_consent',
    );
    // starting twice leaves the one link (no second row, no second audit "create")
    await call(t.k.base, 'POST', '/api/v1/calendar-link/start', {
      cookie: doc.cookie,
      headers: writeHeaders(doc),
    });
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1`,
        [principalOf(doc)],
      ),
      1,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'calendar_sync.calendar_link' AND action = 'create' AND resource_id = $1`,
        [principalOf(doc)],
      ),
      1,
    );
    // a doctor starts without the CSRF header: refused by the guard
    assert.equal(
      (await call(t.k.base, 'POST', '/api/v1/calendar-link/start', { cookie: doc.cookie })).status,
      403,
    );
  });

  test('callback with a bad, foreign, expired or tampered state is 400: nothing is exchanged and nothing is stored', async () => {
    const other = await t.doctor('Dr Other');
    const otherState = new URL(
      (
        await call(t.k.base, 'POST', '/api/v1/calendar-link/start', {
          cookie: other.cookie,
          headers: writeHeaders(other),
        })
      ).json()['authorizationUrl'] as string,
    ).searchParams.get('state') as string;
    const tokenCallsBefore = t.stub.of(/^\/token$/).length;
    const putsBefore = t.store.puts.length;
    const cb = (st: string, code = AUTH_CODE) =>
      call(
        t.k.base,
        'GET',
        `/api/v1/calendar-link/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(st)}`,
        { cookie: doc.cookie },
      );
    assert.equal((await cb(otherState)).status, 400, 'a state minted for another doctor');
    assert.equal(
      (await cb(state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA'))).status,
      400,
      'a tampered state',
    );
    assert.equal((await cb('garbage')).status, 400);
    assert.equal(
      (
        await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=${AUTH_CODE}`, {
          cookie: doc.cookie,
        })
      ).status,
      400,
      'no state',
    );
    t.clock.at = new Date(Date.now() + 11 * 60_000);
    try {
      assert.equal((await cb(state)).status, 400, 'an expired state');
    } finally {
      t.clock.at = undefined;
    }
    assert.equal(
      (
        await call(
          t.k.base,
          'GET',
          `/api/v1/calendar-link/callback?state=${encodeURIComponent(state)}`,
          { cookie: doc.cookie },
        )
      ).status,
      400,
      'no code',
    );
    assert.equal(t.stub.of(/^\/token$/).length, tokenCallsBefore);
    assert.equal(t.store.puts.length, putsBefore);
    assert.equal((await linkRow(principalOf(doc))).status, 'pending_consent');
    const body = (await cb('garbage')).body;
    assert.ok(
      !body.includes(AUTH_CODE) && !body.includes('garbage'),
      'the error body echoes no request value',
    );
  });

  test('the doctor declines at Google (?error): redirect "denied", nothing exchanged', async () => {
    const before = t.stub.of(/^\/token$/).length;
    const r = await call(
      t.k.base,
      'GET',
      `/api/v1/calendar-link/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { cookie: doc.cookie },
    );
    assert.equal(r.status, 302);
    assert.equal(r.headers['location'], `${RETURN_URL}?calendar=denied`);
    assert.equal(t.stub.of(/^\/token$/).length, before);
  });

  test('a rejected code or a missing refresh token: redirect "error", nothing stored, the link stays pending', async () => {
    const r = await call(
      t.k.base,
      'GET',
      `/api/v1/calendar-link/callback?code=WRONG-CODE&state=${encodeURIComponent(state)}`,
      { cookie: doc.cookie },
    );
    assert.equal(r.status, 302);
    assert.equal(r.headers['location'], `${RETURN_URL}?calendar=error`);
    assert.equal(t.store.puts.length, 0);
    assert.equal((await linkRow(principalOf(doc))).status, 'pending_consent');
  });

  test('the secret store is down: 503, no reference, no audit row, the link is not activated', async () => {
    t.store.fail = true;
    try {
      const r = await call(
        t.k.base,
        'GET',
        `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`,
        { cookie: doc.cookie },
      );
      assert.equal(r.status, 503);
      assert.ok(!r.body.includes(REFRESH_TOKEN));
    } finally {
      t.store.fail = false;
    }
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM integration_core.secret_ref WHERE name = $1`, [
        `cal-${principalOf(doc)}`,
      ]),
      0,
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM audit.event WHERE action = 'secret_write'`),
      0,
    );
    assert.equal((await linkRow(principalOf(doc))).status, 'pending_consent');
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM queue._private_jobs`),
      0,
      'no job of a callback that rolled back',
    );
  });

  test('a valid callback: token stored ONLY as an outbound reference, link active, first listing and watch enqueued, audit by version ID', async () => {
    const r = await call(
      t.k.base,
      'GET',
      `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`,
      { cookie: doc.cookie },
    );
    assert.equal(r.status, 302);
    const loc = r.headers['location'] as string;
    assert.equal(loc, `${RETURN_URL}?calendar=linked`);
    assert.ok(
      !loc.includes('code=') && !loc.includes(state),
      'the redirect carries no code and no state',
    );
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-store');

    const me = principalOf(doc);
    assert.equal(t.store.puts.length, 1);
    assert.equal(t.store.puts[0]?.name, `cal-${me}`);
    assert.equal(t.store.puts[0]?.connectionId, t.connectionId);
    const ref = await one<{ class: string; secret_arn: string; current_version_id: string }>(
      `SELECT class, secret_arn, current_version_id FROM integration_core.secret_ref WHERE name = $1`,
      [`cal-${me}`],
    );
    assert.equal(ref.class, 'outbound');
    assert.match(ref.secret_arn, /\/integration\/outbound\//);
    assert.equal(ref.current_version_id, 'v1');
    const link = await linkRow(me);
    assert.equal(link.status, 'active');
    assert.equal(link.sync_token, null, 'a new link owes a full listing');

    const resync = await t.queued('calendar_sync.full_resync');
    assert.equal(resync.length, 1);
    assert.deepEqual(resync[0]?.payload, { clinicianId: me, marker: 'initial' });
    assert.equal(resync[0]?.key, `calendar_sync.full_resync:resync_${me}_initial`);
    assert.deepEqual(
      (await t.queued('calendar_sync.renew_watch')).map((j) => j.payload),
      [{ clinicianId: me }],
    );

    const writes = await q<{
      change: Record<string, unknown>;
      resource_type: string;
      actor_principal_id: string;
    }>(
      `SELECT change, resource_type, actor_principal_id FROM audit.event WHERE action = 'secret_write' AND resource_id = $1`,
      [t.connectionId],
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.change, { name: `cal-${me}`, versionId: 'v1' });
    assert.equal(writes[0]?.actor_principal_id, me);
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'calendar_sync.calendar_link' AND action = 'update'`,
      ),
      1,
    );
  });

  test('canary: no token, code or state value is in any log, response, job payload, audit row, table or error', async () => {
    const state2 = new URL(
      (
        await call(t.k.base, 'POST', '/api/v1/calendar-link/start', {
          cookie: doc.cookie,
          headers: writeHeaders(doc),
        })
      ).json()['authorizationUrl'] as string,
    ).searchParams.get('state') as string;
    const responses: string[] = [];
    for (const [path, opts] of [
      [`/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state2)}`, {}],
      [`/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=bad`, {}],
      ['/api/v1/calendar-link', {}],
    ] as const) {
      const r = await call(t.k.base, 'GET', path, { cookie: doc.cookie, ...opts });
      responses.push(JSON.stringify(r.headers), r.body);
    }
    t.store.fail = true;
    const failed = await call(
      t.k.base,
      'GET',
      `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state2)}`,
      { cookie: doc.cookie },
    );
    t.store.fail = false;
    responses.push(JSON.stringify(failed.headers), failed.body);
    const everything = (await dumpAll()) + responses.join('\n');
    for (const canary of [REFRESH_TOKEN, AUTH_CODE, state, state2, CLIENT_SECRET])
      assert.ok(!everything.includes(canary), `a canary leaked: ${canary.slice(0, 12)}`);
    assert.ok(everything.length > 1000, 'the dump is not empty');
  });

  test('a replay of the same callback writes no second secret version (idempotent store token)', async () => {
    const me = principalOf(doc);
    const st = new URL(
      (
        await call(t.k.base, 'POST', '/api/v1/calendar-link/start', {
          cookie: doc.cookie,
          headers: writeHeaders(doc),
        })
      ).json()['authorizationUrl'] as string,
    ).searchParams.get('state') as string;
    const path = `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(st)}`;
    await call(t.k.base, 'GET', path, { cookie: doc.cookie });
    const v1 = (
      await one<{ v: string }>(
        `SELECT current_version_id AS v FROM integration_core.secret_ref WHERE name = $1`,
        [`cal-${me}`],
      )
    ).v;
    await call(t.k.base, 'GET', path, { cookie: doc.cookie });
    const v2 = (
      await one<{ v: string }>(
        `SELECT current_version_id AS v FROM integration_core.secret_ref WHERE name = $1`,
        [`cal-${me}`],
      )
    ).v;
    assert.equal(v1, v2);
    const tokens = new Set(
      t.store.puts
        .filter((p) => p.name === `cal-${me}`)
        .slice(-2)
        .map((p) => p.token),
    );
    assert.equal(tokens.size, 1);
  });

  test('a state signed by the PREVIOUS key is accepted (rotation); a state signed by an unknown key is not', async () => {
    const d2 = await t.doctor('Dr Rotate');
    const me = principalOf(d2);
    await call(t.k.base, 'POST', '/api/v1/calendar-link/start', {
      cookie: d2.cookie,
      headers: writeHeaders(d2),
    });
    const old = makeState(t.stateKeys[1] as Buffer, me, new Date());
    const ok = await call(
      t.k.base,
      'GET',
      `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(old)}`,
      { cookie: d2.cookie },
    );
    assert.equal(ok.headers['location'], `${RETURN_URL}?calendar=linked`);
    const rogue = makeState(Buffer.from('some-other-key-0123456789abcdef0123'), me, new Date());
    assert.equal(
      (
        await call(
          t.k.base,
          'GET',
          `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(rogue)}`,
          { cookie: d2.cookie },
        )
      ).status,
      400,
    );
  });

  test('unlink: the link is removed, a cleanup job is queued, a second unlink is 404, and another doctor cannot touch the link', async () => {
    const d3 = await t.doctor('Dr Unlink');
    await t.activeLink(principalOf(d3));
    const intruder = await t.doctor('Dr Intruder');
    // the intruder's DELETE only ever addresses the intruder's own (absent) link
    assert.equal(
      (
        await call(t.k.base, 'DELETE', '/api/v1/calendar-link', {
          cookie: intruder.cookie,
          headers: writeHeaders(intruder),
        })
      ).status,
      404,
    );
    assert.equal((await linkRow(principalOf(d3))).status, 'active');
    const r = await call(t.k.base, 'DELETE', '/api/v1/calendar-link', {
      cookie: d3.cookie,
      headers: writeHeaders(d3),
    });
    assert.equal(r.status, 200);
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1`,
        [principalOf(d3)],
      ),
      0,
    );
    assert.deepEqual(
      (await t.queued('calendar_sync.unlink_cleanup')).map((j) => j.payload),
      [{ clinicianId: principalOf(d3) }],
    );
    assert.equal(
      (
        await call(t.k.base, 'DELETE', '/api/v1/calendar-link', {
          cookie: d3.cookie,
          headers: writeHeaders(d3),
        })
      ).status,
      404,
    );
  });
});

describe('Busy events from bookings (TC-CAL-01, TC-CAL-02, BR-07, BR-23)', () => {
  let doc: SeededSession;
  let me = '';
  before(async () => {
    resetStub();
    doc = await t.doctor('Dr Busy');
    me = principalOf(doc);
    await t.activeLink(me, { syncToken: t.stub.newToken(), lastSyncedAt: true });
  });

  const publish = (event: string, payload: Record<string, unknown>) =>
    t.publish(me, event, payload);

  test('a confirmed visit becomes ONE event titled "Busy": no patient, reason, service or diagnosis (TC-CAL-01/02)', async () => {
    const b = await t.booking(me, daysAhead(3), { serviceId: SVC_SENS });
    const names = await publish('scheduling.reservation_confirmed', {
      reservationId: b.occupancyId,
      patientId: b.patientId,
    });
    assert.deepEqual(names, ['calendar_sync.on_reservation_confirmed']);
    // the handler job carries the patient ID (declared, resolve) and schedules a job that carries the occupancy ID only
    const handled = await t.runQueued('calendar_sync.on_reservation_confirmed');
    assert.equal(handled.length, 1);
    const pushes = await t.queued('calendar_sync.push_busy');
    assert.deepEqual(
      pushes.map((p) => p.payload),
      [{ occupancyId: b.occupancyId }],
    );
    assert.ok(!JSON.stringify(pushes).includes(b.patientId));
    t.stub.reset();
    await t.runQueued('calendar_sync.push_busy');

    const posts = t.stub.of(/\/events$/, 'POST');
    assert.equal(posts.length, 1);
    const event = JSON.parse(posts[0]?.body as string) as Record<string, unknown>;
    assert.equal(event['summary'], 'Busy');
    assert.equal(event['id'], t.w.eventIdFor(b.occupancyId));
    assert.deepEqual(Object.keys(event).sort(), [
      'end',
      'extendedProperties',
      'id',
      'reminders',
      'start',
      'summary',
      'transparency',
      'visibility',
    ]);
    assert.equal(event['transparency'], 'opaque');
    assert.equal(event['visibility'], 'private');
    const wire = t.stub.requests.map((r) => r.body + r.path + r.query.toString()).join('\n');
    for (const secret of [
      SENSITIVE_NAME,
      'private reason CANARY',
      'Pat',
      'Ient',
      b.patientId,
      'Appointment',
    ])
      assert.ok(!wire.includes(secret), `the wire carries "${secret}"`);
    assert.ok(wire.includes('Busy'));
    const map = await one<{
      state: string;
      google_event_id: string;
      clinician_principal_id: string;
    }>(
      `SELECT state, google_event_id, clinician_principal_id FROM calendar_sync.event_map WHERE occupancy_id = $1`,
      [b.occupancyId],
    );
    assert.equal(map.state, 'created');
    assert.equal(map.google_event_id, t.w.eventIdFor(b.occupancyId));
    // nothing sensitive in any table or job the feature wrote
    const everything = await dumpAll();
    for (const secret of [SENSITIVE_NAME, 'private reason CANARY'])
      assert.ok(!everything.includes(secret), `a table or job carries "${secret}"`);
    const mapRows = (await q(`SELECT to_jsonb(r)::text AS x FROM calendar_sync.event_map r`))
      .map((r) => (r as { x: string }).x)
      .join();
    assert.ok(!mapRows.includes(b.patientId), 'event_map has no patient column and no patient ID');
  });

  test('a repeat push is idempotent: the same deterministic ID, one event, no duplicate (34.3)', async () => {
    const b = await t.booking(me, daysAhead(4));
    for (let i = 0; i < 3; i++)
      assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'created');
    assert.equal(t.stub.created.size >= 1, true);
    assert.equal(
      [...t.stub.created.keys()].filter((k) => k === t.w.eventIdFor(b.occupancyId)).length,
      1,
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM calendar_sync.event_map WHERE occupancy_id = $1`, [
        b.occupancyId,
      ]),
      1,
    );
  });

  test('a cancelled visit removes the event; a repeat delete calls Google no second time; a never-created one is skipped', async () => {
    const b = await t.booking(me, daysAhead(5));
    await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId });
    await t.k.sa.query('BEGIN');
    await t.k.sa.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
      [ORG],
    );
    await t.k.sa.query(
      `UPDATE scheduling.slot_occupancy SET status = 'cancelled_patient' WHERE id = $1`,
      [b.occupancyId],
    );
    await t.k.sa.query('COMMIT');
    t.stub.reset();
    assert.equal(await t.w.runDeleteBusy(t.jobs, { occupancyId: b.occupancyId }), 'removed');
    assert.equal(t.stub.of(/\/events\/[^/]+$/, 'DELETE').length, 1);
    assert.equal(
      (
        await one<{ state: string }>(
          `SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`,
          [b.occupancyId],
        )
      ).state,
      'deleted',
    );
    t.stub.reset();
    assert.equal(await t.w.runDeleteBusy(t.jobs, { occupancyId: b.occupancyId }), 'skipped');
    assert.equal(t.stub.requests.length, 0);
    const never = await t.booking(me, daysAhead(6));
    assert.equal(await t.w.runDeleteBusy(t.jobs, { occupancyId: never.occupancyId }), 'skipped');
    assert.equal(t.stub.requests.length, 0);
    // a push for a booking that is no longer active removes instead of creating
    assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'skipped');
  });

  test('reschedule: the old Busy event is deleted and the new booking gets one', async () => {
    const old = await t.booking(me, daysAhead(7));
    const nu = await t.booking(me, daysAhead(8));
    await t.w.runPushBusy(t.jobs, { occupancyId: old.occupancyId });
    await t.k.sa.query('BEGIN');
    await t.k.sa.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
      [ORG],
    );
    await t.k.sa.query(
      `UPDATE scheduling.slot_occupancy SET status = 'rescheduled' WHERE id = $1`,
      [old.occupancyId],
    );
    await t.k.sa.query('COMMIT');
    await publish('scheduling.reservation_rescheduled', {
      reservationId: old.occupancyId,
      newReservationId: nu.occupancyId,
      patientId: old.patientId,
    });
    await t.runQueued('calendar_sync.on_reservation_rescheduled');
    t.stub.reset();
    await t.runQueued('calendar_sync.delete_busy');
    await t.runQueued('calendar_sync.push_busy');
    assert.equal(t.stub.of(/\/events\/[^/]+$/, 'DELETE').length, 1);
    assert.equal(t.stub.of(/\/events$/, 'POST').length, 1);
    assert.equal(
      (
        await one<{ state: string }>(
          `SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`,
          [old.occupancyId],
        )
      ).state,
      'deleted',
    );
    assert.equal(
      (
        await one<{ state: string }>(
          `SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`,
          [nu.occupancyId],
        )
      ).state,
      'created',
    );
  });

  test('a doctor with no active link: nothing is pushed and nothing is lost', async () => {
    const d2 = await t.doctor('Dr NoLink');
    const b = await t.booking(principalOf(d2), daysAhead(9));
    t.stub.reset();
    assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'skipped');
    assert.equal(t.stub.requests.length, 0);
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM calendar_sync.event_map WHERE occupancy_id = $1`, [
        b.occupancyId,
      ]),
      0,
    );
  });

  test('a permanent refusal by Google (403 not rate-limited) is recorded `failed` and ends the job; an outage is retried', async () => {
    const b = await t.booking(me, daysAhead(10));
    t.stub.denyInsert = true;
    assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'failed');
    assert.equal(
      (
        await one<{ state: string }>(
          `SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`,
          [b.occupancyId],
        )
      ).state,
      'failed',
    );
    t.stub.denyInsert = false;
    assert.equal(
      await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }),
      'created',
      'the next run recovers',
    );
  });

  test('backfill: a new link pushes the bookings that already exist, once', async () => {
    const d2 = await t.doctor('Dr Backfill');
    const m2 = principalOf(d2);
    await t.activeLink(m2);
    const b1 = await t.booking(m2, daysAhead(11));
    const b2 = await t.booking(m2, daysAhead(12));
    await t.booking(m2, daysAhead(13), { status: 'cancelled_patient' });
    t.stub.events.clear();
    assert.equal(await t.w.runFullResync(t.jobs, { clinicianId: m2, marker: 'initial' }), 'synced');
    const ids = (await t.queued('calendar_sync.push_busy'))
      .map((j) => j.payload['occupancyId'])
      .filter((x) => x === b1.occupancyId || x === b2.occupancyId);
    assert.equal(ids.length, 2);
  });
});

describe('a Google meeting becomes unavailable time (TC-CAL-03) and the full listing', () => {
  let me = '';
  before(async () => {
    resetStub();
    const doc = await t.doctor('Dr Sync');
    me = principalOf(doc);
    await t.activeLink(me);
  });

  test('a new link owes a listing: the timer calls nothing at Google and enqueues one keyed resync', async () => {
    t.stub.reset();
    assert.equal(await t.w.runIncrementalSync(t.jobs, { clinicianId: me }), 'resync_enqueued');
    assert.equal(t.stub.requests.length, 0);
    const j = await t.queued('calendar_sync.full_resync');
    assert.equal(j.filter((x) => x.payload['clinicianId'] === me).length, 1);
    assert.equal(j.find((x) => x.payload['clinicianId'] === me)?.payload['marker'], 'initial');
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
  });

  test('full listing: meetings become busy blocks through replace_busy_blocks; cancelled, free, declined and our own events do not; titles never arrive', async () => {
    const day = daysAhead(2, 15);
    for (const e of [
      meeting('ev-meeting', day),
      meeting('ev-tentative', new Date(day.getTime() + 2 * 3_600_000), 30, { status: 'tentative' }),
      meeting('ev-free', new Date(day.getTime() + 4 * 3_600_000), 30, {
        transparency: 'transparent',
      }),
      meeting('ev-cancelled', new Date(day.getTime() + 5 * 3_600_000), 30, { status: 'cancelled' }),
      meeting('ev-declined', new Date(day.getTime() + 6 * 3_600_000), 30, {
        attendees: [{ self: true, responseStatus: 'declined' }],
      }),
      meeting('ev-ours', new Date(day.getTime() + 7 * 3_600_000), 30, {
        extendedProperties: { private: { ehrBusy: '1' } },
      }),
      {
        id: 'ev-allday',
        status: 'confirmed',
        summary: 'Conference CANARY',
        start: { date: '2031-07-04' },
        end: { date: '2031-07-05' },
      },
    ] as never[])
      t.stub.events.set((e as { id: string }).id, e);
    t.stub.reset();
    assert.equal(await t.w.runFullResync(t.jobs, { clinicianId: me, marker: 'initial' }), 'synced');
    const req = t.stub.of(/\/events$/, 'GET')[0];
    const fields = req?.query.get('fields') as string;
    for (const leak of ['summary', 'description', 'location', 'displayName', 'email'])
      assert.ok(!fields.includes(leak), `fields mask asks for ${leak}`);
    assert.equal(req?.query.get('singleEvents'), 'true');
    assert.equal(req?.query.get('syncToken'), null);

    const bs = await blocks(me);
    const hashes = new Set(bs.map((b) => b.hash));
    const h = (id: string) => t.w.externalHash(id).toString('hex');
    assert.ok(hashes.has(h('ev-meeting')) && hashes.has(h('ev-tentative')));
    for (const id of ['ev-free', 'ev-cancelled', 'ev-declined', 'ev-ours'])
      assert.ok(!hashes.has(h(id)), `${id} must not block time`);
    const meet = bs.find((b) => b.hash === h('ev-meeting'));
    assert.equal(meet?.s.toISOString(), iso(day));
    assert.equal(meet?.e.toISOString(), iso(new Date(day.getTime() + 3_600_000)));
    const link = await linkRow(me);
    assert.match(link.sync_token as string, /^SYNC-/);
    assert.ok(link.last_synced_at !== null);
    assert.equal(link.status, 'active');
    const everything = await dumpAll();
    for (const leak of ['CANARY', 'Jane Roe', 'jane.roe', 'HIV'])
      assert.ok(!everything.includes(leak), `a title or name reached the database: ${leak}`);
  });

  test('the busy interval is what slot search subtracts: an all-day event blocks the local day in the calendar zone', async () => {
    const e = t.w.toBusyChange(
      { id: 'x', start: { date: '2031-07-04' }, end: { date: '2031-07-05' } },
      'America/New_York',
    ) as { busy: { startsAt: string; endsAt: string } };
    assert.equal(e.busy.startsAt, '2031-07-04T04:00:00.000Z'); // midnight EDT
    assert.equal(e.busy.endsAt, '2031-07-05T04:00:00.000Z');
    const w = t.w.toBusyChange(
      { id: 'y', start: { date: '2031-01-10' }, end: { date: '2031-01-11' } },
      'America/New_York',
    ) as { busy: { startsAt: string } };
    assert.equal(w.busy.startsAt, '2031-01-10T05:00:00.000Z'); // midnight EST
    assert.equal(
      t.w.startOfDayIn('2031-03-09', 'America/New_York'),
      Date.parse('2031-03-09T05:00:00.000Z'),
    ); // the spring-forward day starts in EST
  });

  test('pagination: every page is read, outside a transaction, and the token comes from the last page', async () => {
    const d2 = await t.doctor('Dr Pages');
    const m2 = principalOf(d2);
    await t.activeLink(m2);
    resetStub();
    t.stub.pageSize = 2;
    for (let i = 0; i < 5; i++)
      t.stub.events.set(`pg-${i}`, meeting(`pg-${i}`, daysAhead(20 + i)) as never);
    assert.equal(await t.w.runFullResync(t.jobs, { clinicianId: m2, marker: 'initial' }), 'synced');
    assert.equal(t.stub.of(/\/events$/, 'GET').length, 3);
    assert.equal((await blocks(m2)).length, 5);
    t.stub.pageSize = 250;
  });

  test('incremental: a changed event moves, a deleted one goes, an untouched one stays; synced_at moves for every kept block', async () => {
    const d2 = await t.doctor('Dr Delta');
    const m2 = principalOf(d2);
    await t.activeLink(m2);
    resetStub();
    const base = daysAhead(30, 10);
    for (const [i, id] of ['a', 'b', 'c'].entries())
      t.stub.events.set(
        `d-${id}`,
        meeting(`d-${id}`, new Date(base.getTime() + i * 3 * 3_600_000)) as never,
      );
    await t.w.runFullResync(t.jobs, { clinicianId: m2, marker: 'initial' });
    const before = await blocks(m2);
    assert.equal(before.length, 3);
    const syncedBefore = (
      await one<{ s: Date }>(
        `SELECT max(synced_at) AS s FROM scheduling.busy_block WHERE clinician_principal_id = $1`,
        [m2],
      )
    ).s;
    const moved = new Date(base.getTime() + 24 * 3_600_000);
    t.stub.delta = [
      meeting('d-a', moved, 45) as never,
      { id: 'd-b', status: 'cancelled' } as never,
      meeting('d-new', new Date(base.getTime() + 48 * 3_600_000), 30) as never,
    ];
    t.stub.reset();
    assert.equal(await t.w.runIncrementalSync(t.jobs, { clinicianId: m2 }), 'synced');
    const req = t.stub.of(/\/events$/, 'GET')[0];
    assert.ok(req?.query.get('syncToken')?.startsWith('SYNC-'));
    assert.equal(req?.query.get('timeMin'), null, 'no timeMin together with a sync token');
    const after = await blocks(m2);
    const h = (id: string) => t.w.externalHash(id).toString('hex');
    assert.deepEqual(new Set(after.map((b) => b.hash)), new Set([h('d-a'), h('d-c'), h('d-new')]));
    assert.equal(after.find((b) => b.hash === h('d-a'))?.s.toISOString(), iso(moved));
    assert.equal(
      after.find((b) => b.hash === h('d-a'))?.e.toISOString(),
      iso(new Date(moved.getTime() + 45 * 60_000)),
    );
    const syncedAfter = (
      await one<{ s: Date }>(
        `SELECT min(synced_at) AS s FROM scheduling.busy_block WHERE clinician_principal_id = $1`,
        [m2],
      )
    ).s;
    assert.ok(syncedAfter > syncedBefore, 'every kept block is stamped by the sync');
  });

  test('Google is down during a listing: the old blocks stay, last_synced_at does not move, the job fails for the queue to retry (TC-CAL-04 data half)', async () => {
    const d2 = await t.doctor('Dr Down');
    const m2 = principalOf(d2);
    resetStub();
    t.stub.events.set('dn-1', meeting('dn-1', daysAhead(40)) as never);
    await t.activeLink(m2);
    await t.w.runFullResync(t.jobs, { clinicianId: m2, marker: 'initial' });
    const l1 = await linkRow(m2);
    const b1 = await blocks(m2);
    t.stub.events.clear();
    t.stub.failList = 100;
    await assert.rejects(
      t.w.runIncrementalSync(t.jobs, { clinicianId: m2 }),
      (e: { code?: string }) => e.code === 'integration.vendor_unavailable',
    );
    const l2 = await linkRow(m2);
    assert.equal(l2.sync_token, l1.sync_token);
    assert.deepEqual(l2.last_synced_at, l1.last_synced_at);
    assert.deepEqual(await blocks(m2), b1);
    // the outage is on the operations view: every attempt is in the call log, with a class and no argument
    const calls = await q<{ outcome: string; error_class: string | null; operation: string }>(
      `SELECT outcome, error_class, operation FROM integration_core.outbound_call WHERE operation = 'incremental_sync' AND outcome <> 'ok' ORDER BY at DESC LIMIT 2`,
    );
    assert.ok(calls.length >= 1);
    t.stub.failList = 0;
  });
});

describe('the `410 Gone` sync-token rule and the null-token rule (QA-AL-01, SAR-IDF-03; TC-CAL-05 step 8)', () => {
  let me = '';
  let E: ReturnType<typeof meeting>;
  before(async () => {
    resetStub();
    const doc = await t.doctor('Dr Gone');
    me = principalOf(doc);
    await t.activeLink(me);
    E = meeting('gone-E', daysAhead(15, 11));
    t.stub.events.set('gone-E', E as never);
    assert.equal(await t.w.runFullResync(t.jobs, { clinicianId: me, marker: 'initial' }), 'synced');
  });
  const only = (task: string) =>
    t.queued(task).then((js) => js.filter((j) => j.payload['clinicianId'] === me));

  test('Google rejects the stored token S1 with 410: S1 is discarded, its hash kept, ONE keyed resync enqueued, no busy block changes', async () => {
    const s1 = (await linkRow(me)).sync_token as string;
    t.stub.validTokens.delete(s1);
    const before = await blocks(me);
    t.stub.reset();
    assert.equal(await t.w.runIncrementalSync(t.jobs, { clinicianId: me }), 'resync_enqueued');
    assert.equal(t.stub.of(/\/events$/, 'GET').length, 1);
    const l = await linkRow(me);
    assert.equal(l.sync_token, null);
    assert.deepEqual(l.discarded_token_hash, sha(s1));
    assert.deepEqual(await blocks(me), before, 'a 410 changes no busy block');
    const jobs = await only('calendar_sync.full_resync');
    assert.equal(jobs.length, 1);
    const marker = jobs[0]?.payload['marker'] as string;
    assert.match(marker, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(
      marker,
      `${sha(s1).toString('hex').slice(0, 8)}-${sha(s1).toString('hex').slice(8, 12)}-${sha(s1).toString('hex').slice(12, 16)}-${sha(s1).toString('hex').slice(16, 20)}-${sha(s1).toString('hex').slice(20, 32)}`,
    );
    assert.equal(jobs[0]?.key, `calendar_sync.full_resync:resync_${me}_${marker}`);
    assert.ok(!JSON.stringify(jobs).includes(s1), 'the token is not in the job');
  });

  test('a null token means a full listing is owed, never "wait": a repeated push or timer run calls nothing at Google and starts no second resync', async () => {
    t.stub.reset();
    for (let i = 0; i < 3; i++)
      assert.equal(await t.w.runIncrementalSync(t.jobs, { clinicianId: me }), 'resync_enqueued');
    assert.equal(t.stub.requests.length, 0);
    assert.equal(
      (await only('calendar_sync.full_resync')).length,
      1,
      'the key suppresses a duplicate while the job is pending',
    );
  });

  test('the resync lists everything and replaces the set once: exactly one block for E, none lost or duplicated; a new token and last_synced_at are stored', async () => {
    const lastBefore = (await linkRow(me)).last_synced_at as Date;
    const ran = await t.runQueued('calendar_sync.full_resync');
    assert.equal(ran.filter((p) => p['clinicianId'] === me).length, 1);
    const bs = await blocks(me);
    assert.equal(bs.length, 1);
    assert.equal(bs[0]?.hash, t.w.externalHash('gone-E').toString('hex'));
    const l = await linkRow(me);
    assert.ok(l.sync_token !== null && l.sync_token.startsWith('SYNC-'));
    assert.ok((l.last_synced_at as Date) > lastBefore);
    assert.equal(
      await t.w.runIncrementalSync(t.jobs, { clinicianId: me }),
      'synced',
      'the new token works',
    );
    assert.equal((await blocks(me)).length, 1);
  });

  test('a resync that went dead is enqueued again by the next timer run, and recovers the link without manual action', async () => {
    const s = (await linkRow(me)).sync_token as string;
    t.stub.validTokens.delete(s);
    assert.equal(await t.w.runIncrementalSync(t.jobs, { clinicianId: me }), 'resync_enqueued');
    await t.k.sa.query(`DELETE FROM queue._private_jobs`); // the job is dead
    assert.equal((await only('calendar_sync.full_resync')).length, 0);
    assert.equal(await t.w.runIncrementalSync(t.jobs, {}), 'sweep'); // the 15-minute timer
    const again = await only('calendar_sync.full_resync');
    assert.equal(again.length, 1);
    assert.equal(
      again[0]?.payload['marker'],
      (await linkRow(me)).discarded_token_hash === null ? 'initial' : again[0]?.payload['marker'],
    );
    await t.runQueued('calendar_sync.full_resync');
    assert.ok((await linkRow(me)).sync_token !== null);
    assert.equal((await blocks(me)).length, 1);
  });

  test("a failing listing leaves the old blocks and last_synced_at (the stale warning shows) and fails for retry; exhausted jobs are the next timer run's", async () => {
    const s = (await linkRow(me)).sync_token as string;
    t.stub.validTokens.delete(s);
    await t.w.runIncrementalSync(t.jobs, { clinicianId: me });
    const before = { l: await linkRow(me), b: await blocks(me) };
    t.stub.failList = 100;
    await assert.rejects(
      t.w.runFullResync(t.jobs, { clinicianId: me, marker: 'x' }),
      (e: { code?: string }) => e.code === 'integration.vendor_unavailable',
    );
    const after = { l: await linkRow(me), b: await blocks(me) };
    assert.deepEqual(after.b, before.b);
    assert.deepEqual(after.l.last_synced_at, before.l.last_synced_at);
    assert.equal(after.l.sync_token, null);
    t.stub.failList = 0;
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    await t.w.runIncrementalSync(t.jobs, {});
    await t.runQueued('calendar_sync.full_resync');
    assert.ok((await linkRow(me)).sync_token !== null);
  });

  test('a new link needs no 410: the callback enqueues the first listing (marker initial) and it fills the busy blocks', async () => {
    const doc = await t.doctor('Dr Fresh');
    const m2 = principalOf(doc);
    const st = new URL(
      (
        await call(t.k.base, 'POST', '/api/v1/calendar-link/start', {
          cookie: doc.cookie,
          headers: writeHeaders(doc),
        })
      ).json()['authorizationUrl'] as string,
    ).searchParams.get('state') as string;
    const r = await call(
      t.k.base,
      'GET',
      `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(st)}`,
      { cookie: doc.cookie },
    );
    assert.equal(r.headers['location'], `${RETURN_URL}?calendar=linked`);
    t.stub.reset();
    const ran = (await t.runQueued('calendar_sync.full_resync')).filter(
      (p) => p['clinicianId'] === m2,
    );
    assert.deepEqual(ran, [{ clinicianId: m2, marker: 'initial' }]);
    assert.ok(
      t.stub.of(/\/events$/, 'GET').every((x) => x.query.get('syncToken') === null),
      'a listing, never a sync-token call',
    );
    assert.equal((await blocks(m2)).length, 1);
    assert.ok((await linkRow(m2)).sync_token !== null);
  });

  test('two resyncs racing for one link: exactly one writes, the other is superseded; the set is whole and unduplicated', async () => {
    const d = await t.doctor('Dr Race');
    const m2 = principalOf(d);
    await t.activeLink(m2);
    t.stub.events.set('race-E', meeting('race-E', daysAhead(16)) as never);
    const res = await Promise.all([
      t.w.runFullResync(t.jobs, { clinicianId: m2, marker: 'initial' }),
      t.w.runFullResync(t.jobs, { clinicianId: m2, marker: 'initial' }),
    ]);
    assert.equal(res.filter((x) => x === 'synced').length, 1, JSON.stringify(res));
    assert.ok(res.every((x) => x === 'synced' || x === 'superseded'));
    assert.equal((await blocks(m2)).length, 2); // race-E and gone-E from the shared stub calendar
    // two incrementals from the same token: one writes, the other is superseded (or runs after it from the new token)
    const inc = await Promise.all([
      t.w.runIncrementalSync(t.jobs, { clinicianId: m2 }),
      t.w.runIncrementalSync(t.jobs, { clinicianId: m2 }),
    ]);
    assert.ok(
      inc.every((x) => x === 'synced' || x === 'superseded'),
      JSON.stringify(inc),
    );
    assert.ok(inc.includes('synced'));
    assert.equal((await blocks(m2)).length, 2);
  });

  test('the timer sweep: a null token owes a resync, a token gets an incremental job, revoked and pending links are left alone', async () => {
    const mk = async (n: string, setup: (m: string) => Promise<void>) => {
      const d = await t.doctor(n);
      await setup(principalOf(d));
      return principalOf(d);
    };
    const owes = await mk('Dr Owes', (m) => t.activeLink(m));
    const has = await mk('Dr Has', (m) => t.activeLink(m, { syncToken: t.stub.newToken() }));
    const revoked = await mk('Dr Revoked', async (m) => {
      await t.activeLink(m);
      await t.k.sa.query(
        `UPDATE calendar_sync.calendar_link SET status = 'token_revoked' WHERE clinician_principal_id = $1`,
        [m],
      );
    });
    const pending = await mk('Dr Pending', async (m) => {
      await t.k.sa.query(
        `INSERT INTO calendar_sync.calendar_link (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name) VALUES ($1, $2, 'primary', 'pending_consent', $3)`,
        [m, ORG, `cal-${m}`],
      );
    });
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    await t.w.runIncrementalSync(t.jobs, {});
    const rs = (await t.queued('calendar_sync.full_resync')).map((j) => j.payload['clinicianId']);
    const ic = (await t.queued('calendar_sync.incremental_sync')).map(
      (j) => j.payload['clinicianId'],
    );
    assert.ok(rs.includes(owes) && !rs.includes(has));
    assert.ok(ic.includes(has) && !ic.includes(owes));
    for (const m of [revoked, pending]) assert.ok(!rs.includes(m) && !ic.includes(m));
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
  });
});

describe('the Google push route (ARCHITECTURE 29.5; TC-CAL-05 steps 1-7)', () => {
  let me = '';
  let ch: { id: string; resourceId: string; token: string };
  const HOST = 'integrations.example.test';
  const post = (h: Record<string, string>) =>
    call(t.k.base, 'POST', '/webhooks/google/calendar', { host: HOST, headers: h });
  const hdr = (token: string, over: Record<string, string> = {}): Record<string, string> => ({
    'x-goog-channel-id': ch.id,
    'x-goog-channel-token': token,
    'x-goog-resource-id': ch.resourceId,
    'x-goog-resource-state': 'exists',
    'x-goog-message-number': '5',
    ...over,
  });
  const messages = () =>
    nrows(
      `SELECT count(*) AS n FROM integration_core.inbound_message WHERE source = 'google_calendar'`,
    );
  const lastMessage = async () =>
    (
      await one<{ id: string }>(
        `SELECT id FROM integration_core.inbound_message ORDER BY received_at DESC, id DESC LIMIT 1`,
      )
    ).id;
  const expiry = (secs: number): number => Math.floor(Date.now() / 1000) + secs;
  before(async () => {
    resetStub();
    t.verificationFailures.length = 0;
    const doc = await t.doctor('Dr Push');
    me = principalOf(doc);
    await t.activeLink(me, { syncToken: t.stub.newToken(), lastSyncedAt: true });
    assert.equal(await t.w.runRenewWatch(t.jobs, { clinicianId: me }), 'renewed');
    ch = t.stub.channels.at(-1) as typeof ch;
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    t.stub.delta = [meeting('push-E', daysAhead(17)) as never];
  });

  test("the worker's channel token and the API verifier's token function are the same bytes", () => {
    const e = expiry(3600);
    assert.equal(
      t.w.channelToken(t.channelKey, 'abc-123', e),
      googleChannelToken(t.channelKey, 'abc-123', e),
    );
  });

  test('the API role cannot read watch_channel at all: a push is verified without a table read (TDR-05)', async () => {
    await assert.rejects(
      t.k.q(`SELECT 1`).then(() => asApi(`SELECT count(*) FROM calendar_sync.watch_channel`)),
      (e: { code?: string }) => e.code === '42501',
    );
    await assert.rejects(
      asApi(`SELECT count(*) FROM calendar_sync.event_map`),
      (e: { code?: string }) => e.code === '42501',
    );
  });

  test('1, 2, 7: a wrong HMAC, a token for another channel, an expired token, a bogus resource state: 401/400, nothing recorded, no job', async () => {
    const before = await messages();
    const flip = ch.token.slice(0, -1) + (ch.token.endsWith('A') ? 'B' : 'A');
    assert.equal((await post(hdr(flip))).status, 401);
    assert.equal(
      (await post(hdr(ch.token, { 'x-goog-channel-id': 'forged-channel' }))).status,
      401,
      'channel ID does not match the token',
    );
    assert.equal(
      (await post(hdr(googleChannelToken(t.channelKey, ch.id, expiry(-60))))).status,
      401,
      'an expired token',
    );
    assert.equal(
      (await post(hdr(googleChannelToken(t.channelKey, ch.id, expiry(8 * 24 * 3600))))).status,
      401,
      'an expiry beyond 7 days',
    );
    assert.equal(
      (
        await post(
          hdr(googleChannelToken({ version: 'k9', key: t.channelKey.key }, ch.id, expiry(600))),
        )
      ).status,
      401,
      'an unknown key version',
    );
    assert.equal((await post({})).status, 401, 'no headers');
    assert.equal(
      (await post(hdr(ch.token, { 'x-goog-resource-state': 'bogus' }))).status,
      400,
      'an unknown resource state',
    );
    assert.equal((await post(hdr(ch.token, { 'x-goog-message-number': 'five' }))).status, 400);
    assert.equal(await messages(), before);
    assert.equal(await nrows(`SELECT count(*) AS n FROM queue._private_jobs`), 0);
    assert.ok(t.verificationFailures.length >= 8, 'every failure is counted');
    assert.ok(
      t.verificationFailures.some((f) => f.reason === 'invalid') &&
        t.verificationFailures.some((f) => f.reason === 'unauthenticated'),
    );
  });

  test('3: a valid token (message 5): 200, one stored message, one dispatch job; the handler checks the channel and starts ONE incremental sync that adds exactly one block', async () => {
    const r = await post(hdr(ch.token));
    assert.equal(r.status, 200);
    assert.equal(await messages(), 1);
    const dispatch = await t.queued('integration_core.dispatch_inbound');
    assert.equal(dispatch.length, 1);
    const row = await one<{ event_id: string; message_type: string; status: string }>(
      `SELECT event_id, message_type, status FROM integration_core.inbound_message WHERE source = 'google_calendar'`,
    );
    assert.equal(row.event_id, `${ch.id}:5`);
    assert.equal(row.message_type, 'google_calendar.push');
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    assert.equal(await t.dispatch(await lastMessage()), 'handled');
    const inc = await t.queued('calendar_sync.incremental_sync');
    assert.deepEqual(
      inc.map((j) => j.payload),
      [{ clinicianId: me }],
    );
    t.stub.reset();
    await t.runQueued('calendar_sync.incremental_sync');
    assert.equal(t.stub.of(/\/events$/, 'GET').length, 1);
    assert.equal((await blocks(me)).length, 1);
  });

  test('4: the same message number again is a duplicate: 200, no second stored message, no second job, no second fetch', async () => {
    const r = await post(hdr(ch.token));
    assert.equal(r.status, 200);
    assert.equal(await messages(), 1);
    assert.equal(await nrows(`SELECT count(*) AS n FROM queue._private_jobs`), 0);
  });

  test('5: a LOWER message number has a new key, so one more idempotent sync may run; the data does not change', async () => {
    assert.equal((await post(hdr(ch.token, { 'x-goog-message-number': '4' }))).status, 200);
    assert.equal(await messages(), 2);
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    assert.equal(await t.dispatch(await lastMessage()), 'handled');
    const before = await blocks(me);
    await t.runQueued('calendar_sync.incremental_sync');
    assert.deepEqual(
      (await blocks(me)).map((b) => b.hash),
      before.map((b) => b.hash),
    );
    assert.equal((await blocks(me)).length, 1);
  });

  test('6: a validly signed token for a channel with no active watch_channel row: 200, the worker ignores it, no sync, no change', async () => {
    const ghost = 'ghost-channel-1';
    const tok = googleChannelToken(t.channelKey, ghost, expiry(3600));
    const r = await post({
      ...hdr(tok),
      'x-goog-channel-id': ghost,
      'x-goog-resource-id': 'res-ghost',
      'x-goog-message-number': '6',
    });
    assert.equal(r.status, 200);
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    assert.equal(await t.dispatch(await lastMessage()), 'handled');
    assert.equal((await t.queued('calendar_sync.incremental_sync')).length, 0);
    assert.equal(
      (
        await one<{ status: string }>(
          `SELECT status FROM integration_core.inbound_message WHERE id = $1`,
          [await lastMessage()],
        )
      ).status,
      'handled',
    );
  });

  test('a message the API stored for a real channel but the WRONG resource ID (a forged store, DF-3), and the `sync` handshake, start no sync', async () => {
    const wrong = await post(
      hdr(ch.token, { 'x-goog-resource-id': 'res-wrong', 'x-goog-message-number': '7' }),
    );
    assert.equal(wrong.status, 200);
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    await t.dispatch(await lastMessage());
    assert.equal((await t.queued('calendar_sync.incremental_sync')).length, 0);
    const sync = await post(
      hdr(ch.token, { 'x-goog-resource-state': 'sync', 'x-goog-message-number': '8' }),
    );
    assert.equal(sync.status, 200);
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    await t.dispatch(await lastMessage());
    assert.equal((await t.queued('calendar_sync.incremental_sync')).length, 0);
    // handler-level strictness: anything but the three-field shape is ignored
    for (const body of [
      '',
      '{}',
      '[]',
      'not json',
      JSON.stringify({
        channelId: ch.id,
        resourceId: ch.resourceId,
        resourceState: 'exists',
        extra: 1,
      }),
    ])
      assert.equal(t.w.parsePush(Buffer.from(body)), undefined, body);
  });

  test('key rotation: a token signed with the PREVIOUS key version is accepted until the daily renewal replaces it', async () => {
    const tok = googleChannelToken(t.oldChannelKey, ch.id, expiry(3600));
    assert.equal((await post(hdr(tok, { 'x-goog-message-number': '9' }))).status, 200);
  });

  test('a burst of pushes is one sync: the incremental job is keyed by doctor', async () => {
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    for (const n of ['20', '21', '22']) {
      assert.equal((await post(hdr(ch.token, { 'x-goog-message-number': n }))).status, 200);
      await t.dispatch(await lastMessage());
    }
    assert.equal((await t.queued('calendar_sync.incremental_sync')).length, 1);
  });
});

async function asApi(sql: string): Promise<unknown> {
  const c = new pg.Client({
    connectionString: t.k.urlFor('app_api'),
  });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'staff', true), set_config('app.realm', 'google', true)`,
      [ORG],
    );
    return await c.query(sql);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

describe('watch channels (calendar_sync.renew_watch, ARCHITECTURE 29.5)', () => {
  const HOUR = 3_600_000;
  const mkLink = async (n: string): Promise<string> => {
    const d = await t.doctor(n);
    await t.activeLink(principalOf(d), { syncToken: t.stub.newToken() });
    return principalOf(d);
  };
  const chan = (m: string, id: string, version: string, expires: Date) =>
    t.k.sa.query(
      `INSERT INTO calendar_sync.watch_channel (id, organisation_id, clinician_principal_id, channel_id, resource_id, token_key_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), ORG, m, id, `res-${id}`, version, expires.toISOString()],
    );
  before(() => resetStub());

  test('registers a channel with the HMAC token under the CURRENT key version; nothing about the token is stored', async () => {
    const m = await mkLink('Dr Watch1');
    t.stub.channels.length = 0;
    assert.equal(await t.w.runRenewWatch(t.jobs, { clinicianId: m }), 'renewed');
    const c = t.stub.channels.at(-1) as (typeof t.stub.channels)[number];
    assert.equal(c.address, 'https://integrations.example.test/webhooks/google/calendar');
    assert.match(c.token, /^v\.k2\.\d{10}\.[A-Za-z0-9_-]{43}$/);
    const exp = Number(c.token.split('.')[2]);
    assert.equal(
      exp,
      Math.floor(Number(c.expiration) / 1000),
      'the embedded expiry is the channel expiry',
    );
    assert.ok(exp * 1000 - Date.now() <= 7 * 24 * HOUR, 'never more than 7 days ahead');
    assert.ok(c.token.length < 256, "under Google's 256-character limit");
    const row = await one<{
      token_key_version: string;
      channel_id: string;
      resource_id: string;
      expires_at: Date;
    }>(
      `SELECT token_key_version, channel_id, resource_id, expires_at FROM calendar_sync.watch_channel WHERE clinician_principal_id = $1`,
      [m],
    );
    assert.equal(row.token_key_version, 'k2');
    assert.equal(row.channel_id, c.id);
    assert.equal(row.resource_id, c.resourceId);
    const cols = (
      await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'calendar_sync' AND table_name = 'watch_channel'`,
      )
    ).map((r) => r.column_name);
    assert.ok(
      !cols.some((x) => /token(?!_key_version)|hash|secret/.test(x)),
      `watch_channel columns: ${cols.join(',')}`,
    );
    const dump = JSON.stringify(
      await q(`SELECT to_jsonb(w)::text AS x FROM calendar_sync.watch_channel w`),
    );
    assert.ok(!dump.includes(c.token));
  });

  test('a renewal registers the new channel BEFORE it stops the old one, then drops the old row', async () => {
    const m = await mkLink('Dr Watch2');
    await t.w.runRenewWatch(t.jobs, { clinicianId: m });
    const first = t.stub.channels.at(-1) as (typeof t.stub.channels)[number];
    t.stub.reset();
    assert.equal(await t.w.runRenewWatch(t.jobs, { clinicianId: m }), 'renewed');
    const order = t.stub.requests
      .map((r) => `${r.method} ${r.path}`)
      .filter((x) => /watch$|channels\/stop$/.test(x));
    assert.deepEqual(
      order.map((x) => (x.endsWith('watch') ? 'watch' : 'stop')),
      ['watch', 'stop'],
    );
    assert.deepEqual(t.stub.stopped.at(-1), { id: first.id, resourceId: first.resourceId });
    const rows = await q<{ channel_id: string }>(
      `SELECT channel_id FROM calendar_sync.watch_channel WHERE clinician_principal_id = $1`,
      [m],
    );
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]?.channel_id, first.id);
  });

  test('the daily sweep renews only what needs it: no channel, under 36 h left, or an older key version; expired rows are dropped', async () => {
    const fresh = await mkLink('Dr Fresh Ch');
    await chan(fresh, `fresh-${fresh.slice(0, 8)}`, 'k2', new Date(Date.now() + 6 * 24 * HOUR));
    const oldKey = await mkLink('Dr Old Key');
    await chan(oldKey, `oldkey-${oldKey.slice(0, 8)}`, 'k1', new Date(Date.now() + 6 * 24 * HOUR));
    const soon = await mkLink('Dr Soon');
    await chan(soon, `soon-${soon.slice(0, 8)}`, 'k2', new Date(Date.now() + 10 * HOUR));
    const none = await mkLink('Dr None');
    const gone = await mkLink('Dr Expired');
    await chan(gone, `gone-${gone.slice(0, 8)}`, 'k2', new Date(Date.now() - HOUR));
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
    assert.equal(await t.w.runRenewWatch(t.jobs, {}), 'sweep');
    const ids = (await t.queued('calendar_sync.renew_watch')).map((j) => j.payload['clinicianId']);
    assert.ok(!ids.includes(fresh));
    for (const m of [oldKey, soon, none, gone]) assert.ok(ids.includes(m), `renew ${m}`);
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM calendar_sync.watch_channel WHERE expires_at < now()`),
      0,
    );
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
  });

  test('a link that is not active gets no channel; a revoked grant at Google breaks the link visibly', async () => {
    const d = await t.doctor('Dr NoChannel');
    assert.equal(await t.w.runRenewWatch(t.jobs, { clinicianId: principalOf(d) }), 'skipped');
    const m = await mkLink('Dr RevokedCh');
    t.stub.revoked = true;
    try {
      assert.equal(await t.w.runRenewWatch(t.jobs, { clinicianId: m }), 'token_revoked');
    } finally {
      t.stub.revoked = false;
    }
    assert.equal((await linkRow(m)).status, 'token_revoked');
  });
});

describe('a revoked grant is visible, not silent (TC-CAL-06, BR-33)', () => {
  let me = '';
  let doc: SeededSession;
  before(async () => {
    resetStub();
    // an alerting module's handler of calendar_sync.link_broken (BE-07/BE-06 own the real one)
    t.k.registry.registerHandler('calendar_sync.link_broken', 'alerts');
    try {
      t.k.registry.get('alerts.on_link_broken');
    } catch {
      t.k.registry.defineJob({
        name: 'alerts.on_link_broken',
        maxAttempts: 3,
        onMerged: 'none',
        carriesPatientIds: false,
        jobScope: 'org',
        jobClass: 'handler',
      });
    }
    const { syncTaskTypes } = await import('@ehr/kernel');
    const wc = new pg.Client({ connectionString: t.k.urlFor('app_worker') });
    await wc.connect();
    await syncTaskTypes(wc, t.k.registry);
    await wc.end();
    doc = await t.doctor('Dr Revoke');
    me = principalOf(doc);
    t.stub.events.set('rv-E', meeting('rv-E', daysAhead(25)) as never);
    await t.activeLink(me);
    await t.w.runFullResync(t.jobs, { clinicianId: me, marker: 'initial' });
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
  });

  test('the doctor revokes the app at Google: the next sync marks the link token_revoked, raises ONE link_broken event, frees no slot', async () => {
    const before = await blocks(me);
    t.stub.revoked = true;
    assert.equal(await t.w.runIncrementalSync(t.jobs, { clinicianId: me }), 'token_revoked');
    const l = await linkRow(me);
    assert.equal(l.status, 'token_revoked');
    assert.equal(l.last_error_code, 'token_revoked');
    assert.deepEqual(
      await blocks(me),
      before,
      'the last known busy time stays (a stale warning, not a freed slot)',
    );
    const alerts = await t.queued('alerts.on_link_broken');
    assert.equal(alerts.length, 1);
    assert.deepEqual(Object.keys(alerts[0]?.payload as object).sort(), [
      'clinicianId',
      'eventId',
      'organisationId',
      'reason',
    ]);
    // not retried forever and not alerted twice: a broken link is skipped until the doctor links again
    t.stub.reset();
    assert.equal(await t.w.runIncrementalSync(t.jobs, { clinicianId: me }), 'skipped');
    assert.equal(t.stub.requests.length, 0);
    assert.equal((await t.queued('alerts.on_link_broken')).length, 1);
    const failed = await nrows(
      `SELECT count(*) AS n FROM integration_core.outbound_call WHERE outcome <> 'ok' AND error_class IS NOT NULL`,
    );
    assert.ok(failed >= 1, 'the failure is in the outbound call log (operations view)');
    // the doctor's own page shows it
    const s = await call(t.k.base, 'GET', '/api/v1/calendar-link', { cookie: doc.cookie });
    assert.equal(s.json()['status'], 'token_revoked');
    assert.equal(s.json()['lastErrorCode'], 'token_revoked');
  });

  test('a push for a booking on a revoked grant records the failure and breaks nothing else', async () => {
    const b = await t.booking(me, daysAhead(26));
    assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'skipped'); // the link is no longer active
    await t.k.sa.query(
      `UPDATE calendar_sync.calendar_link SET status = 'active', last_error_code = NULL WHERE clinician_principal_id = $1`,
      [me],
    );
    assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'token_revoked');
    assert.equal(
      (
        await one<{ state: string }>(
          `SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`,
          [b.occupancyId],
        )
      ).state,
      'failed',
    );
    assert.equal((await linkRow(me)).status, 'token_revoked');
  });

  test('the doctor links again: the link recovers and the first listing runs', async () => {
    t.stub.revoked = false;
    const st = new URL(
      (
        await call(t.k.base, 'POST', '/api/v1/calendar-link/start', {
          cookie: doc.cookie,
          headers: writeHeaders(doc),
        })
      ).json()['authorizationUrl'] as string,
    ).searchParams.get('state') as string;
    const r = await call(
      t.k.base,
      'GET',
      `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(st)}`,
      { cookie: doc.cookie },
    );
    assert.equal(r.headers['location'], `${RETURN_URL}?calendar=linked`);
    const l = await linkRow(me);
    assert.equal(l.status, 'active');
    assert.equal(l.sync_token, null);
    assert.equal(l.last_error_code, null);
    await t.runQueued('calendar_sync.full_resync');
    assert.ok((await linkRow(me)).sync_token !== null);
  });
});

describe('unlink cleanup (departure D3)', () => {
  test('clears busy blocks, channels and Busy events of an unlinked doctor, and does nothing when the doctor linked again', async () => {
    resetStub();
    const d = await t.doctor('Dr Gone Away');
    const m = principalOf(d);
    await t.activeLink(m);
    t.stub.events.set('ua-E', meeting('ua-E', daysAhead(27)) as never);
    await t.w.runFullResync(t.jobs, { clinicianId: m, marker: 'initial' });
    const b = await t.booking(m, daysAhead(28));
    await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId });
    await t.w.runRenewWatch(t.jobs, { clinicianId: m });
    assert.equal((await blocks(m)).length, 1);
    // the doctor links again before the cleanup runs: nothing of the new link is touched
    assert.equal(await t.w.runUnlinkCleanup(t.jobs, { clinicianId: m }), 'relinked');
    assert.equal((await blocks(m)).length, 1);
    await t.k.sa.query(
      `DELETE FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1`,
      [m],
    );
    t.stub.reset();
    assert.equal(await t.w.runUnlinkCleanup(t.jobs, { clinicianId: m }), 'cleaned');
    assert.equal((await blocks(m)).length, 0, 'the unlinked calendar no longer blocks slots');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM calendar_sync.watch_channel WHERE clinician_principal_id = $1`,
        [m],
      ),
      0,
    );
    assert.equal(t.stub.stopped.length >= 1, true);
    assert.equal(t.stub.of(/\/events\/[^/]+$/, 'DELETE').length, 1);
    assert.equal(
      (
        await one<{ state: string }>(
          `SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`,
          [b.occupancyId],
        )
      ).state,
      'deleted',
    );
  });
});

const code = (c: string) => (e: { code?: string }) => {
  assert.equal(e.code, c);
  return true;
};
const bh = (n: number): Buffer => createHash('sha256').update(`block-${n}`).digest();
const per = (startDays: number, minutes = 60): string => {
  const s = daysAhead(startDays, 9);
  return `[${iso(s)},${iso(new Date(s.getTime() + minutes * 60_000))})`;
};

describe('scheduling.replace_busy_blocks: the one writer of busy_block (departure D1)', () => {
  let a = '';
  let b = '';
  const replace = (doctor: string, hashes: Buffer[], periods: string[]) =>
    t.asWorker((tx) =>
      tx.query(
        `SELECT * FROM scheduling.replace_busy_blocks($1::uuid, $2::bytea[], $3::tstzrange[])`,
        [doctor, hashes, periods],
      ),
    );
  const counts = (r: { rows: Record<string, unknown>[] }) =>
    r.rows[0] as { inserted: number; updated: number; deleted: number };
  before(async () => {
    a = principalOf(await t.doctor('Dr Replace A'));
    b = principalOf(await t.doctor('Dr Replace B'));
  });

  test("replaces the doctor's google blocks with exactly the given set: insert, keep and refresh, delete; another doctor's rows are untouched", async () => {
    await replace(b, [bh(900)], [per(50)]);
    assert.deepEqual(counts(await replace(a, [bh(1), bh(2), bh(3)], [per(40), per(41), per(42)])), {
      inserted: 3,
      updated: 0,
      deleted: 0,
    });
    assert.deepEqual(counts(await replace(a, [bh(1), bh(2), bh(3)], [per(40), per(41), per(42)])), {
      inserted: 0,
      updated: 3,
      deleted: 0,
    });
    assert.deepEqual(counts(await replace(a, [bh(2), bh(4)], [per(41, 90), per(43)])), {
      inserted: 1,
      updated: 1,
      deleted: 2,
    });
    const bs = await blocks(a);
    assert.equal(bs.length, 2);
    const kept = bs.find((x) => x.hash === bh(2).toString('hex')) as { s: Date; e: Date };
    assert.equal(
      kept.e.getTime() - kept.s.getTime(),
      90 * 60_000,
      'a kept block takes the new period',
    );
    assert.equal((await blocks(b)).length, 1);
    assert.deepEqual(counts(await replace(a, [], [])), { inserted: 0, updated: 0, deleted: 2 });
    assert.equal((await blocks(a)).length, 0);
    assert.equal((await blocks(b)).length, 1);
  });

  test('bad arguments are refused (22023): mismatched or duplicate or short hashes, open, empty or inclusive-end periods, too long a block', async () => {
    const ok = per(60);
    for (const [name, hashes, periods] of [
      ['mismatched lengths', [bh(1), bh(2)], [ok]],
      ['duplicate hashes', [bh(1), bh(1)], [ok, per(61)]],
      ['short hash', [Buffer.alloc(8, 1)], [ok]],
      ['unbounded', [bh(1)], ['[2031-01-01T00:00:00Z,)']],
      ['empty range', [bh(1)], ['empty']],
      ['inclusive end', [bh(1)], ['[2031-01-01T09:00:00Z,2031-01-01T10:00:00Z]']],
      ['exclusive start', [bh(1)], ['(2031-01-01T09:00:00Z,2031-01-01T10:00:00Z)']],
      ['over 400 days', [bh(1)], ['[2031-01-01T09:00:00Z,2032-03-01T10:00:00Z)']],
    ] as [string, Buffer[], string[]][])
      await assert.rejects(replace(a, hashes, periods), code('22023'), name);
    assert.equal((await blocks(a)).length, 0, 'a refused call changes nothing');
  });

  test('only an organisation-wide system job may call it; no API role can (42501)', async () => {
    const call = (scope: import('@ehr/kernel').ScopeSettings, db: 'api' | 'worker') =>
      (db === 'api' ? t.api : t.worker).withScope(scope, (tx) =>
        tx.query(
          `SELECT * FROM scheduling.replace_busy_blocks($1::uuid, '{}'::bytea[], '{}'::tstzrange[])`,
          [a],
        ),
      );
    await assert.rejects(call(t.scope(a), 'api'), code('42501')); // EXECUTE is not granted to app_api
    await assert.rejects(
      call(
        {
          audience: 'system',
          realm: 'worker',
          orgId: ORG,
          jobScope: 'patients',
          jobPatientIds: [randomUUID()],
        },
        'worker',
      ),
      code('42501'),
    ); // a patients-scope job
    await assert.rejects(
      call(
        { audience: 'staff', realm: 'google', orgId: ORG, principalId: a, personId: randomUUID() },
        'worker',
      ),
      code('42501'),
    );
  });

  test('no application role can write busy_block directly', async () => {
    for (const sql of [
      `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ('${ORG}', '${a}', '${per(70)}', 'google', '\\x${bh(5).toString('hex')}', now())`,
      `DELETE FROM scheduling.busy_block`,
      `UPDATE scheduling.busy_block SET synced_at = now()`,
    ]) {
      await assert.rejects(
        t.as(t.scope(a), (tx) => tx.query(sql)),
        code('42501'),
        sql.slice(0, 30),
      );
      await assert.rejects(
        t.asWorker((tx) => tx.query(sql)),
        code('42501'),
        sql.slice(0, 30),
      );
    }
  });

  test('concurrent replacements for one doctor serialise: the result is one whole set, never a mix (20 rounds)', async () => {
    const m = principalOf(await t.doctor('Dr Replace C'));
    const setA = { hashes: [bh(10), bh(11), bh(12)], periods: [per(80), per(81), per(82)] };
    const setB = { hashes: [bh(11), bh(13)], periods: [per(81, 30), per(83)] };
    for (let i = 0; i < 20; i++) {
      await Promise.all([
        replace(m, setA.hashes, setA.periods),
        replace(m, setB.hashes, setB.periods),
      ]);
      const got = new Set((await blocks(m)).map((x) => x.hash));
      const wa = new Set(setA.hashes.map((h) => h.toString('hex')));
      const wb = new Set(setB.hashes.map((h) => h.toString('hex')));
      const same = (x: Set<string>, y: Set<string>) =>
        x.size === y.size && [...x].every((v) => y.has(v));
      assert.ok(
        same(got, wa) || same(got, wb),
        `round ${i}: ${got.size} blocks, not one of the two sets`,
      );
    }
  });
});

describe('row-level security, grants and triggers of calendar_sync (SA-DP-06 database half)', () => {
  let A = '';
  let B = '';
  before(async () => {
    A = principalOf(await t.doctor('Dr RLS A'));
    B = principalOf(await t.doctor('Dr RLS B'));
    await t.activeLink(A);
    await t.k.sa.query(
      `INSERT INTO calendar_sync.calendar_link (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name) VALUES ($1, $2, 'primary', 'pending_consent', $3)`,
      [B, ORG, `cal-${B}`],
    );
  });
  const admin = (): import('@ehr/kernel').ScopeSettings => ({
    audience: 'staff',
    realm: 'admin_pool',
    orgId: ORG,
    principalId: randomUUID(),
    personId: randomUUID(),
    phiAccess: 'limited',
  });

  test('a doctor sees, changes and deletes only their own link; the sync token is not readable by the API role', async () => {
    const rows = await t.as(t.scope(A), (tx) =>
      tx.query(`SELECT clinician_principal_id FROM calendar_sync.calendar_link`),
    );
    assert.deepEqual(
      rows.rows.map((r) => r.clinician_principal_id),
      [A],
    );
    assert.equal(
      (
        await t.as(t.scope(A), (tx) =>
          tx.query(
            `UPDATE calendar_sync.calendar_link SET last_error_code = 'x' WHERE clinician_principal_id = $1`,
            [B],
          ),
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await t.as(t.scope(A), (tx) =>
          tx.query(`DELETE FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1`, [
            B,
          ]),
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      t.as(t.scope(B), (tx) =>
        tx.query(
          `INSERT INTO calendar_sync.calendar_link (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name, created_by) VALUES ($1, $2, 'primary', 'pending_consent', $3, $1)`,
          [A, ORG, `cal-${A}`],
        ),
      ),
      code('42501'),
    );
    await assert.rejects(
      t.as(t.scope(A), (tx) => tx.query(`SELECT sync_token FROM calendar_sync.calendar_link`)),
      code('42501'),
    );
    await assert.rejects(
      t.as(t.scope(A), (tx) =>
        tx.query(`SELECT discarded_token_hash FROM calendar_sync.calendar_link`),
      ),
      code('42501'),
    );
    await assert.rejects(
      t.as(t.scope(A), (tx) =>
        tx.query(
          `UPDATE calendar_sync.calendar_link SET last_synced_at = now() WHERE clinician_principal_id = $1`,
          [A],
        ),
      ),
      code('42501'),
      "last_synced_at is the worker's",
    );
    await assert.rejects(
      t.as(t.scope(A), (tx) =>
        tx.query(
          `UPDATE calendar_sync.calendar_link SET token_secret_name = 'cal-x' WHERE clinician_principal_id = $1`,
          [A],
        ),
      ),
      code('42501'),
    );
    // the admin realm reads (the operations view) and writes nothing
    assert.ok(
      (await t.as(admin(), (tx) => tx.query(`SELECT 1 FROM calendar_sync.calendar_link`))).rows
        .length >= 2,
    );
    assert.equal(
      (
        await t.as(admin(), (tx) =>
          tx.query(`UPDATE calendar_sync.calendar_link SET last_error_code = 'x'`),
        )
      ).rowCount,
      0,
    );
    // a patient and an anonymous audience see nothing
    assert.equal(
      (
        await t.as(
          {
            audience: 'patient',
            realm: 'patient_pool',
            orgId: ORG,
            principalId: randomUUID(),
            personId: randomUUID(),
            patientIds: [randomUUID()],
          },
          (tx) => tx.query(`SELECT 1 FROM calendar_sync.calendar_link`),
        )
      ).rows.length,
      0,
    );
  });

  test('a new link starts pending, names only its own secret, and cannot become active without a stored token reference (PS001)', async () => {
    const ins = (status: string, name: string, principal = B) =>
      t.as(t.scope(principal), (tx) =>
        tx.query(
          `INSERT INTO calendar_sync.calendar_link (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name, created_by) VALUES ($1, $2, 'primary', $3, $4, $1)`,
          [principal, ORG, status, name],
        ),
      );
    const C = principalOf(await t.doctor('Dr RLS C'));
    await assert.rejects(ins('active', `cal-${C}`, C), code('PS001')); // the trigger (and, behind it, the policy): a new link starts pending
    await assert.rejects(ins('pending_consent', 'cal-someone-else', C), code('23514')); // the CHECK: the name is the doctor's own
    await assert.rejects(
      t.as(t.scope(B), (tx) =>
        tx.query(
          `UPDATE calendar_sync.calendar_link SET status = 'active' WHERE clinician_principal_id = $1`,
          [B],
        ),
      ),
      code('PS001'),
    );
    // with the reference stored (as the callback does) the same update passes
    await t.k.sa.query(
      `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
      [ORG],
    );
    await t.k.sa.query(
      `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id) VALUES ($1, $2, $3, 'outbound', $4, 'v9')`,
      [
        t.connectionId,
        `cal-${B}`,
        ORG,
        `arn:test:secret:env/integration/outbound/${t.connectionId}/cal-${B}`,
      ],
    );
    assert.equal(
      (
        await t.as(t.scope(B), (tx) =>
          tx.query(
            `UPDATE calendar_sync.calendar_link SET status = 'active' WHERE clinician_principal_id = $1`,
            [B],
          ),
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await t.as(t.scope(B), (tx) =>
          tx.query(
            `SELECT status FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1`,
            [B],
          ),
        )
      ).rows[0]?.status,
      'active',
    );
  });

  test('no API role has any right on watch_channel or event_map; the worker cannot create or delete a link', async () => {
    for (const sql of [
      `SELECT 1 FROM calendar_sync.watch_channel`,
      `SELECT 1 FROM calendar_sync.event_map`,
      `INSERT INTO calendar_sync.event_map (occupancy_id, organisation_id, clinician_principal_id, google_event_id, state) VALUES ('${randomUUID()}', '${ORG}', '${A}', 'ehrabcde', 'created')`,
    ])
      await assert.rejects(
        t.as(t.scope(A), (tx) => tx.query(sql)),
        code('42501'),
        sql.slice(0, 40),
      );
    await assert.rejects(
      t.asWorker((tx) => tx.query(`DELETE FROM calendar_sync.calendar_link`)),
      code('42501'),
    );
    await assert.rejects(
      t.asWorker((tx) =>
        tx.query(
          `INSERT INTO calendar_sync.calendar_link (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name) VALUES ($1, $2, 'primary', 'pending_consent', $3)`,
          [randomUUID(), ORG, 'cal-x'],
        ),
      ),
      code('42501'),
    );
    // a patients-scope job reads no link
    assert.equal(
      (
        await t.worker.withScope(
          {
            audience: 'system',
            realm: 'worker',
            orgId: ORG,
            jobScope: 'patients',
            jobPatientIds: [randomUUID()],
          },
          (tx) => tx.query(`SELECT 1 FROM calendar_sync.calendar_link`),
        )
      ).rows.length,
      0,
    );
    // the worker moves a link only through the columns it owns, and an event mapping only its state
    await assert.rejects(
      t.asWorker((tx) =>
        tx.query(`UPDATE calendar_sync.calendar_link SET token_secret_name = 'cal-x'`),
      ),
      code('42501'),
    );
    await assert.rejects(
      t.asWorker((tx) =>
        tx.query(`UPDATE calendar_sync.event_map SET google_event_id = 'ehrzzzzz'`),
      ),
      code('42501'),
    );
  });

  test("the doctor's write of an outbound secret reference is limited to their own name, class outbound, and the google_calendar connection", async () => {
    const S = principalOf(await t.doctor('Dr RLS S'));
    const email = randomUUID();
    await t.k.sa.query(
      `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, enabled) VALUES ($1, $2, 'email', 'ses', true)`,
      [email, ORG],
    );
    const ins = (principal: string, conn: string, name: string, cls = 'outbound') =>
      t.as(t.scope(principal), (tx) =>
        tx.query(
          `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id, created_by)
           VALUES ($1::uuid, $2, $3::uuid, $4, $5, 'v1', $6::uuid)`,
          [
            conn,
            name,
            ORG,
            cls,
            `arn:x:secret:env/integration/${cls === 'outbound' ? 'outbound' : 'inbound'}/${conn}/${name}`,
            principal,
          ],
        ),
      );
    await assert.rejects(
      ins(S, t.connectionId, `cal-${A}`),
      code('42501'),
      "another doctor's name",
    );
    await assert.rejects(
      ins(S, t.connectionId, `cal-${S}`, 'inbound_verification'),
      code('42501'),
      'the inbound class',
    );
    await assert.rejects(
      ins(S, email, `cal-${S}`),
      code('42501'),
      'a connection that is not google_calendar',
    );
    await assert.rejects(
      ins(S, t.connectionId, 'oauth-client-secret'),
      code('42501'),
      'the OAuth client secret',
    );
    await ins(S, t.connectionId, `cal-${S}`);
    const seen = await t.as(t.scope(S), (tx) =>
      tx.query(`SELECT name FROM integration_core.secret_ref`),
    );
    assert.deepEqual(
      seen.rows.map((r) => r.name),
      [`cal-${S}`],
      'a doctor reads no other reference (not the OAuth client secret, not another doctor)',
    );
    assert.equal(
      (
        await t.as(t.scope(S), (tx) =>
          tx.query(
            `UPDATE integration_core.secret_ref SET current_version_id = 'v2' WHERE name = $1`,
            [`cal-${A}`],
          ),
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await t.as(t.scope(S), (tx) =>
          tx.query(`SELECT 1 FROM integration_core.connection WHERE kind = 'email'`),
        )
      ).rows.length,
      0,
    );
    await assert.rejects(
      t.as(t.scope(S), (tx) => tx.query(`DELETE FROM integration_core.secret_ref`)),
      code('42501'),
    );
    assert.equal(
      (
        await t.as(
          {
            audience: 'patient',
            realm: 'patient_pool',
            orgId: ORG,
            principalId: randomUUID(),
            personId: randomUUID(),
            patientIds: [randomUUID()],
          },
          (tx) => tx.query(`SELECT 1 FROM integration_core.secret_ref`),
        )
      ).rows.length,
      0,
    );
  });

  test('event_map and busy-event state: a mapping keeps its identity, and its occupancy is real', async () => {
    const b = await t.booking(A, daysAhead(90));
    await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId });
    await assert.rejects(
      t.k.sa.query(
        `UPDATE calendar_sync.event_map SET google_event_id = 'ehrnewid1' WHERE occupancy_id = $1`,
        [b.occupancyId],
      ),
      code('PS001'),
    );
    await assert.rejects(
      t.k.sa.query(
        `INSERT INTO calendar_sync.event_map (occupancy_id, organisation_id, clinician_principal_id, google_event_id, state) VALUES ($1, $2, $3, 'ehrabcde', 'created')`,
        [randomUUID(), ORG, A],
      ),
      code('23503'),
    );
    await assert.rejects(
      t.k.sa.query(
        `INSERT INTO calendar_sync.event_map (occupancy_id, organisation_id, clinician_principal_id, google_event_id, state) VALUES ($1, $2, $3, 'NOT-BASE32', 'created')`,
        [b.occupancyId, ORG, A],
      ),
      code('23514'),
    );
  });
});

describe('job types and events (ARCHITECTURE 33.1)', () => {
  test('the API list and the worker list are the same, and the crontab matches 33.1', async () => {
    const { CALENDAR_SYNC_JOBS, CALENDAR_SYNC_CRONTAB } = await import('./jobs.js');
    assert.deepEqual(t.w.CALENDAR_SYNC_JOBS, CALENDAR_SYNC_JOBS);
    assert.equal(t.w.CALENDAR_SYNC_CRONTAB, CALENDAR_SYNC_CRONTAB);
    assert.deepEqual(CALENDAR_SYNC_JOBS.map((j) => j.name).sort(), [
      'calendar_sync.delete_busy',
      'calendar_sync.full_resync',
      'calendar_sync.incremental_sync',
      'calendar_sync.on_reservation_cancelled',
      'calendar_sync.on_reservation_confirmed',
      'calendar_sync.on_reservation_rescheduled',
      'calendar_sync.push_busy',
      'calendar_sync.renew_watch',
      'calendar_sync.unlink_cleanup',
    ]);
    assert.match(
      CALENDAR_SYNC_CRONTAB,
      /^\*\/15 \* \* \* \* calendar_sync\.incremental_sync\n0 3 \* \* \* calendar_sync\.renew_watch$/,
    );
    // every job that carries a patient ID declares on_merged; the jobs the handlers schedule carry none
    for (const j of CALENDAR_SYNC_JOBS) {
      if (j.carriesPatientIds) assert.equal(j.onMerged, 'resolve');
      if (!j.name.includes('.on_')) assert.equal(j.carriesPatientIds, false);
    }
  });

  test('payloads are IDs only: a UUID-shaped or `initial` marker passes; a 64-character hex token hash would be refused', async () => {
    const { assertPayloadIsIdsOnly } = await import('@ehr/kernel/dist/queue/enqueue.js');
    assertPayloadIsIdsOnly({ clinicianId: randomUUID(), marker: 'initial' });
    assertPayloadIsIdsOnly({ clinicianId: randomUUID(), marker: randomUUID() });
    assert.throws(() =>
      assertPayloadIsIdsOnly({ clinicianId: randomUUID(), marker: sha('x').toString('hex') }),
    );
    assert.throws(() => assertPayloadIsIdsOnly({ clinicianId: randomUUID(), syncToken: 'SYNC-1' }));
  });

  test("the three booking events reach calendar-sync and no other module's job is touched", async () => {
    const me = principalOf(await t.doctor('Dr Events'));
    for (const e of ['confirmed', 'cancelled', 'rescheduled'])
      assert.deepEqual(
        await t.publish(me, `scheduling.reservation_${e}`, {
          reservationId: randomUUID(),
          newReservationId: randomUUID(),
          patientId: randomUUID(),
        }),
        [`calendar_sync.on_reservation_${e}`],
      );
    await t.k.sa.query(`DELETE FROM queue._private_jobs`);
  });
});
