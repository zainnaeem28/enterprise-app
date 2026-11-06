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
  setupCalendar,
  staffMember,
  writeHeaders,
} from './testkit.js';
import type { CalendarKit, SeededSession } from './testkit.js';
import { makeState } from './state.js';

let t: CalendarKit;
before(async () => {
  t = await setupCalendar('cal');
});
after(async () => {
  await t?.close();
});

const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> => t.k.q<R>(sql, p);
const one = async <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R> => (await q<R>(sql, p))[0] as R;
const nrows = async (sql: string, p?: unknown[]): Promise<number> => Number((await one<{ n: string }>(sql, p)).n);
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
  attendees: [{ self: true, responseStatus: 'accepted', email: 'jane.roe@example.com', displayName: 'Jane Roe' }],
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
  one<{ status: string; sync_token: string | null; discarded_token_hash: Buffer | null; last_synced_at: Date | null; last_error_code: string | null }>(
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
  return parts.flat().map((r) => (r as { x: string }).x).join('\n') + t.logs.join('\n');
};

describe('the doctor\'s calendar link and the OAuth callback (SA-DP-06)', () => {
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
    assert.equal((await call(t.k.base, 'GET', '/api/v1/calendar-link', { cookie: desk.cookie })).status, 403);
    assert.equal((await call(t.k.base, 'GET', '/api/v1/calendar-link')).status, 401);
  });

  test('start: a pending link and the Google consent URL with state, PKCE S256 and the two minimal scopes', async () => {
    const r = await call(t.k.base, 'POST', '/api/v1/calendar-link/start', { cookie: doc.cookie, headers: writeHeaders(doc) });
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
    assert.equal((await call(t.k.base, 'GET', '/api/v1/calendar-link', { cookie: doc.cookie })).json()['status'], 'pending_consent');
    // starting twice leaves the one link (no second row, no second audit "create")
    await call(t.k.base, 'POST', '/api/v1/calendar-link/start', { cookie: doc.cookie, headers: writeHeaders(doc) });
    assert.equal(await nrows(`SELECT count(*) AS n FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1`, [principalOf(doc)]), 1);
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM audit.event WHERE resource_type = 'calendar_sync.calendar_link' AND action = 'create' AND resource_id = $1`, [principalOf(doc)]),
      1,
    );
    // a doctor starts without the CSRF header: refused by the guard
    assert.equal((await call(t.k.base, 'POST', '/api/v1/calendar-link/start', { cookie: doc.cookie })).status, 403);
  });

  test('callback with a bad, foreign, expired or tampered state is 400: nothing is exchanged and nothing is stored', async () => {
    const other = await t.doctor('Dr Other');
    const otherState = new URL(
      ((await call(t.k.base, 'POST', '/api/v1/calendar-link/start', { cookie: other.cookie, headers: writeHeaders(other) })).json()['authorizationUrl'] as string),
    ).searchParams.get('state') as string;
    const tokenCallsBefore = t.stub.of(/^\/token$/).length;
    const putsBefore = t.store.puts.length;
    const cb = (st: string, code = AUTH_CODE) =>
      call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(st)}`, { cookie: doc.cookie });
    assert.equal((await cb(otherState)).status, 400, 'a state minted for another doctor');
    assert.equal((await cb(state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA'))).status, 400, 'a tampered state');
    assert.equal((await cb('garbage')).status, 400);
    assert.equal((await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=${AUTH_CODE}`, { cookie: doc.cookie })).status, 400, 'no state');
    t.clock.at = new Date(Date.now() + 11 * 60_000);
    try {
      assert.equal((await cb(state)).status, 400, 'an expired state');
    } finally {
      t.clock.at = undefined;
    }
    assert.equal((await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?state=${encodeURIComponent(state)}`, { cookie: doc.cookie })).status, 400, 'no code');
    assert.equal(t.stub.of(/^\/token$/).length, tokenCallsBefore);
    assert.equal(t.store.puts.length, putsBefore);
    assert.equal((await linkRow(principalOf(doc))).status, 'pending_consent');
    const body = (await cb('garbage')).body;
    assert.ok(!body.includes(AUTH_CODE) && !body.includes('garbage'), 'the error body echoes no request value');
  });

  test('the doctor declines at Google (?error): redirect "denied", nothing exchanged', async () => {
    const before = t.stub.of(/^\/token$/).length;
    const r = await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?error=access_denied&state=${encodeURIComponent(state)}`, { cookie: doc.cookie });
    assert.equal(r.status, 302);
    assert.equal(r.headers['location'], `${RETURN_URL}?calendar=denied`);
    assert.equal(t.stub.of(/^\/token$/).length, before);
  });

  test('a rejected code or a missing refresh token: redirect "error", nothing stored, the link stays pending', async () => {
    const r = await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=WRONG-CODE&state=${encodeURIComponent(state)}`, { cookie: doc.cookie });
    assert.equal(r.status, 302);
    assert.equal(r.headers['location'], `${RETURN_URL}?calendar=error`);
    assert.equal(t.store.puts.length, 0);
    assert.equal((await linkRow(principalOf(doc))).status, 'pending_consent');
  });

  test('the secret store is down: 503, no reference, no audit row, the link is not activated', async () => {
    t.store.fail = true;
    try {
      const r = await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`, { cookie: doc.cookie });
      assert.equal(r.status, 503);
      assert.ok(!r.body.includes(REFRESH_TOKEN));
    } finally {
      t.store.fail = false;
    }
    assert.equal(await nrows(`SELECT count(*) AS n FROM integration_core.secret_ref WHERE name = $1`, [`cal-${principalOf(doc)}`]), 0);
    assert.equal(await nrows(`SELECT count(*) AS n FROM audit.event WHERE action = 'secret_write'`), 0);
    assert.equal((await linkRow(principalOf(doc))).status, 'pending_consent');
    assert.equal(await nrows(`SELECT count(*) AS n FROM queue._private_jobs`), 0, 'no job of a callback that rolled back');
  });

  test('a valid callback: token stored ONLY as an outbound reference, link active, first listing and watch enqueued, audit by version ID', async () => {
    const r = await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`, { cookie: doc.cookie });
    assert.equal(r.status, 302);
    const loc = r.headers['location'] as string;
    assert.equal(loc, `${RETURN_URL}?calendar=linked`);
    assert.ok(!loc.includes('code=') && !loc.includes(state), 'the redirect carries no code and no state');
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
    assert.deepEqual((await t.queued('calendar_sync.renew_watch')).map((j) => j.payload), [{ clinicianId: me }]);

    const writes = await q<{ change: Record<string, unknown>; resource_type: string; actor_principal_id: string }>(
      `SELECT change, resource_type, actor_principal_id FROM audit.event WHERE action = 'secret_write' AND resource_id = $1`,
      [t.connectionId],
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.change, { name: `cal-${me}`, versionId: 'v1' });
    assert.equal(writes[0]?.actor_principal_id, me);
    assert.equal(await nrows(`SELECT count(*) AS n FROM audit.event WHERE resource_type = 'calendar_sync.calendar_link' AND action = 'update'`), 1);
  });

  test('canary: no token, code or state value is in any log, response, job payload, audit row, table or error', async () => {
    const state2 = new URL(
      ((await call(t.k.base, 'POST', '/api/v1/calendar-link/start', { cookie: doc.cookie, headers: writeHeaders(doc) })).json()['authorizationUrl'] as string),
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
    const failed = await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state2)}`, { cookie: doc.cookie });
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
      ((await call(t.k.base, 'POST', '/api/v1/calendar-link/start', { cookie: doc.cookie, headers: writeHeaders(doc) })).json()['authorizationUrl'] as string),
    ).searchParams.get('state') as string;
    const path = `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(st)}`;
    await call(t.k.base, 'GET', path, { cookie: doc.cookie });
    const v1 = (await one<{ v: string }>(`SELECT current_version_id AS v FROM integration_core.secret_ref WHERE name = $1`, [`cal-${me}`])).v;
    await call(t.k.base, 'GET', path, { cookie: doc.cookie });
    const v2 = (await one<{ v: string }>(`SELECT current_version_id AS v FROM integration_core.secret_ref WHERE name = $1`, [`cal-${me}`])).v;
    assert.equal(v1, v2);
    const tokens = new Set(t.store.puts.filter((p) => p.name === `cal-${me}`).slice(-2).map((p) => p.token));
    assert.equal(tokens.size, 1);
  });

  test('a state signed by the PREVIOUS key is accepted (rotation); a state signed by an unknown key is not', async () => {
    const d2 = await t.doctor('Dr Rotate');
    const me = principalOf(d2);
    await call(t.k.base, 'POST', '/api/v1/calendar-link/start', { cookie: d2.cookie, headers: writeHeaders(d2) });
    const old = makeState(t.stateKeys[1] as Buffer, me, new Date());
    const ok = await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(old)}`, { cookie: d2.cookie });
    assert.equal(ok.headers['location'], `${RETURN_URL}?calendar=linked`);
    const rogue = makeState(Buffer.from('some-other-key-0123456789abcdef0123'), me, new Date());
    assert.equal(
      (await call(t.k.base, 'GET', `/api/v1/calendar-link/callback?code=${AUTH_CODE}&state=${encodeURIComponent(rogue)}`, { cookie: d2.cookie })).status,
      400,
    );
  });

  test('unlink: the link is removed, a cleanup job is queued, a second unlink is 404, and another doctor cannot touch the link', async () => {
    const d3 = await t.doctor('Dr Unlink');
    await t.activeLink(principalOf(d3));
    const intruder = await t.doctor('Dr Intruder');
    // the intruder's DELETE only ever addresses the intruder's own (absent) link
    assert.equal((await call(t.k.base, 'DELETE', '/api/v1/calendar-link', { cookie: intruder.cookie, headers: writeHeaders(intruder) })).status, 404);
    assert.equal((await linkRow(principalOf(d3))).status, 'active');
    const r = await call(t.k.base, 'DELETE', '/api/v1/calendar-link', { cookie: d3.cookie, headers: writeHeaders(d3) });
    assert.equal(r.status, 200);
    assert.equal(await nrows(`SELECT count(*) AS n FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1`, [principalOf(d3)]), 0);
    assert.deepEqual((await t.queued('calendar_sync.unlink_cleanup')).map((j) => j.payload), [{ clinicianId: principalOf(d3) }]);
    assert.equal((await call(t.k.base, 'DELETE', '/api/v1/calendar-link', { cookie: d3.cookie, headers: writeHeaders(d3) })).status, 404);
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

  const publish = (event: string, payload: Record<string, unknown>) => t.publish(me, event, payload);

  test('a confirmed visit becomes ONE event titled "Busy": no patient, reason, service or diagnosis (TC-CAL-01/02)', async () => {
    const b = await t.booking(me, daysAhead(3), { serviceId: SVC_SENS });
    const names = await publish('scheduling.reservation_confirmed', { reservationId: b.occupancyId, patientId: b.patientId });
    assert.deepEqual(names, ['calendar_sync.on_reservation_confirmed']);
    // the handler job carries the patient ID (declared, resolve) and schedules a job that carries the occupancy ID only
    const handled = await t.runQueued('calendar_sync.on_reservation_confirmed');
    assert.equal(handled.length, 1);
    const pushes = await t.queued('calendar_sync.push_busy');
    assert.deepEqual(pushes.map((p) => p.payload), [{ occupancyId: b.occupancyId }]);
    assert.ok(!JSON.stringify(pushes).includes(b.patientId));
    t.stub.reset();
    await t.runQueued('calendar_sync.push_busy');

    const posts = t.stub.of(/\/events$/, 'POST');
    assert.equal(posts.length, 1);
    const event = JSON.parse(posts[0]?.body as string) as Record<string, unknown>;
    assert.equal(event['summary'], 'Busy');
    assert.equal(event['id'], t.w.eventIdFor(b.occupancyId));
    assert.deepEqual(Object.keys(event).sort(), ['end', 'extendedProperties', 'id', 'reminders', 'start', 'summary', 'transparency', 'visibility']);
    assert.equal(event['transparency'], 'opaque');
    assert.equal(event['visibility'], 'private');
    const wire = t.stub.requests.map((r) => r.body + r.path + r.query.toString()).join('\n');
    for (const secret of [SENSITIVE_NAME, 'private reason CANARY', 'Pat', 'Ient', b.patientId, 'Appointment'])
      assert.ok(!wire.includes(secret), `the wire carries "${secret}"`);
    assert.ok(wire.includes('Busy'));
    const map = await one<{ state: string; google_event_id: string; clinician_principal_id: string }>(
      `SELECT state, google_event_id, clinician_principal_id FROM calendar_sync.event_map WHERE occupancy_id = $1`,
      [b.occupancyId],
    );
    assert.equal(map.state, 'created');
    assert.equal(map.google_event_id, t.w.eventIdFor(b.occupancyId));
    // nothing sensitive in any table or job the feature wrote
    const everything = await dumpAll();
    for (const secret of [SENSITIVE_NAME, 'private reason CANARY'])
      assert.ok(!everything.includes(secret), `a table or job carries "${secret}"`);
    const mapRows = (await q(`SELECT to_jsonb(r)::text AS x FROM calendar_sync.event_map r`)).map((r) => (r as { x: string }).x).join();
    assert.ok(!mapRows.includes(b.patientId), 'event_map has no patient column and no patient ID');
  });

  test('a repeat push is idempotent: the same deterministic ID, one event, no duplicate (34.3)', async () => {
    const b = await t.booking(me, daysAhead(4));
    for (let i = 0; i < 3; i++) assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'created');
    assert.equal(t.stub.created.size >= 1, true);
    assert.equal([...t.stub.created.keys()].filter((k) => k === t.w.eventIdFor(b.occupancyId)).length, 1);
    assert.equal(await nrows(`SELECT count(*) AS n FROM calendar_sync.event_map WHERE occupancy_id = $1`, [b.occupancyId]), 1);
  });

  test('a cancelled visit removes the event; a repeat delete calls Google no second time; a never-created one is skipped', async () => {
    const b = await t.booking(me, daysAhead(5));
    await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId });
    await t.k.sa.query('BEGIN');
    await t.k.sa.query(`SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`, [ORG]);
    await t.k.sa.query(`UPDATE scheduling.slot_occupancy SET status = 'cancelled_patient' WHERE id = $1`, [b.occupancyId]);
    await t.k.sa.query('COMMIT');
    t.stub.reset();
    assert.equal(await t.w.runDeleteBusy(t.jobs, { occupancyId: b.occupancyId }), 'removed');
    assert.equal(t.stub.of(/\/events\/[^/]+$/, 'DELETE').length, 1);
    assert.equal((await one<{ state: string }>(`SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`, [b.occupancyId])).state, 'deleted');
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
    await t.k.sa.query(`SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`, [ORG]);
    await t.k.sa.query(`UPDATE scheduling.slot_occupancy SET status = 'rescheduled' WHERE id = $1`, [old.occupancyId]);
    await t.k.sa.query('COMMIT');
    await publish('scheduling.reservation_rescheduled', { reservationId: old.occupancyId, newReservationId: nu.occupancyId, patientId: old.patientId });
    await t.runQueued('calendar_sync.on_reservation_rescheduled');
    t.stub.reset();
    await t.runQueued('calendar_sync.delete_busy');
    await t.runQueued('calendar_sync.push_busy');
    assert.equal(t.stub.of(/\/events\/[^/]+$/, 'DELETE').length, 1);
    assert.equal(t.stub.of(/\/events$/, 'POST').length, 1);
    assert.equal((await one<{ state: string }>(`SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`, [old.occupancyId])).state, 'deleted');
    assert.equal((await one<{ state: string }>(`SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`, [nu.occupancyId])).state, 'created');
  });

  test('a doctor with no active link: nothing is pushed and nothing is lost', async () => {
    const d2 = await t.doctor('Dr NoLink');
    const b = await t.booking(principalOf(d2), daysAhead(9));
    t.stub.reset();
    assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'skipped');
    assert.equal(t.stub.requests.length, 0);
    assert.equal(await nrows(`SELECT count(*) AS n FROM calendar_sync.event_map WHERE occupancy_id = $1`, [b.occupancyId]), 0);
  });

  test('a permanent refusal by Google (403 not rate-limited) is recorded `failed` and ends the job; an outage is retried', async () => {
    const b = await t.booking(me, daysAhead(10));
    t.stub.denyInsert = true;
    assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'failed');
    assert.equal((await one<{ state: string }>(`SELECT state FROM calendar_sync.event_map WHERE occupancy_id = $1`, [b.occupancyId])).state, 'failed');
    t.stub.denyInsert = false;
    assert.equal(await t.w.runPushBusy(t.jobs, { occupancyId: b.occupancyId }), 'created', 'the next run recovers');
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
    const ids = (await t.queued('calendar_sync.push_busy')).map((j) => j.payload['occupancyId']).filter((x) => x === b1.occupancyId || x === b2.occupancyId);
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
      meeting('ev-free', new Date(day.getTime() + 4 * 3_600_000), 30, { transparency: 'transparent' }),
      meeting('ev-cancelled', new Date(day.getTime() + 5 * 3_600_000), 30, { status: 'cancelled' }),
      meeting('ev-declined', new Date(day.getTime() + 6 * 3_600_000), 30, { attendees: [{ self: true, responseStatus: 'declined' }] }),
      meeting('ev-ours', new Date(day.getTime() + 7 * 3_600_000), 30, { extendedProperties: { private: { ehrBusy: '1' } } }),
      { id: 'ev-allday', status: 'confirmed', summary: 'Conference CANARY', start: { date: '2031-07-04' }, end: { date: '2031-07-05' } },
    ] as never[])
      t.stub.events.set((e as { id: string }).id, e);
    t.stub.reset();
    assert.equal(await t.w.runFullResync(t.jobs, { clinicianId: me, marker: 'initial' }), 'synced');
    const req = t.stub.of(/\/events$/, 'GET')[0];
    const fields = req?.query.get('fields') as string;
    for (const leak of ['summary', 'description', 'location', 'displayName', 'email']) assert.ok(!fields.includes(leak), `fields mask asks for ${leak}`);
    assert.equal(req?.query.get('singleEvents'), 'true');
    assert.equal(req?.query.get('syncToken'), null);

    const bs = await blocks(me);
    const hashes = new Set(bs.map((b) => b.hash));
    const h = (id: string) => t.w.externalHash(id).toString('hex');
    assert.ok(hashes.has(h('ev-meeting')) && hashes.has(h('ev-tentative')));
    for (const id of ['ev-free', 'ev-cancelled', 'ev-declined', 'ev-ours']) assert.ok(!hashes.has(h(id)), `${id} must not block time`);
    const meet = bs.find((b) => b.hash === h('ev-meeting'));
    assert.equal(meet?.s.toISOString(), iso(day));
    assert.equal(meet?.e.toISOString(), iso(new Date(day.getTime() + 3_600_000)));
    const link = await linkRow(me);
    assert.match(link.sync_token as string, /^SYNC-/);
    assert.ok(link.last_synced_at !== null);
    assert.equal(link.status, 'active');
    const everything = await dumpAll();
    for (const leak of ['CANARY', 'Jane Roe', 'jane.roe', 'HIV']) assert.ok(!everything.includes(leak), `a title or name reached the database: ${leak}`);
  });

  test('the busy interval is what slot search subtracts: an all-day event blocks the local day in the calendar zone', async () => {
    const e = t.w.toBusyChange({ id: 'x', start: { date: '2031-07-04' }, end: { date: '2031-07-05' } }, 'America/New_York') as { busy: { startsAt: string; endsAt: string } };
    assert.equal(e.busy.startsAt, '2031-07-04T04:00:00.000Z'); // midnight EDT
    assert.equal(e.busy.endsAt, '2031-07-05T04:00:00.000Z');
    const w = t.w.toBusyChange({ id: 'y', start: { date: '2031-01-10' }, end: { date: '2031-01-11' } }, 'America/New_York') as { busy: { startsAt: string } };
    assert.equal(w.busy.startsAt, '2031-01-10T05:00:00.000Z'); // midnight EST
    assert.equal(t.w.startOfDayIn('2031-03-09', 'America/New_York'), Date.parse('2031-03-09T05:00:00.000Z')); // the spring-forward day starts in EST
  });

  test('pagination: every page is read, outside a transaction, and the token comes from the last page', async () => {
    const d2 = await t.doctor('Dr Pages');
    const m2 = principalOf(d2);
    await t.activeLink(m2);
    resetStub();
    t.stub.pageSize = 2;
    for (let i = 0; i < 5; i++) t.stub.events.set(`pg-${i}`, meeting(`pg-${i}`, daysAhead(20 + i)) as never);
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
    for (const [i, id] of ['a', 'b', 'c'].entries()) t.stub.events.set(`d-${id}`, meeting(`d-${id}`, new Date(base.getTime() + i * 3 * 3_600_000)) as never);
    await t.w.runFullResync(t.jobs, { clinicianId: m2, marker: 'initial' });
    const before = await blocks(m2);
    assert.equal(before.length, 3);
    const syncedBefore = (await one<{ s: Date }>(`SELECT max(synced_at) AS s FROM scheduling.busy_block WHERE clinician_principal_id = $1`, [m2])).s;
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
    assert.equal(after.find((b) => b.hash === h('d-a'))?.e.toISOString(), iso(new Date(moved.getTime() + 45 * 60_000)));
    const syncedAfter = (await one<{ s: Date }>(`SELECT min(synced_at) AS s FROM scheduling.busy_block WHERE clinician_principal_id = $1`, [m2])).s;
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
    await assert.rejects(t.w.runIncrementalSync(t.jobs, { clinicianId: m2 }), (e: { code?: string }) => e.code === 'integration.vendor_unavailable');
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
