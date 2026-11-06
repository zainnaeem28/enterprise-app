// Real-database tests for BE-12, part 1: templates, leave and blocked time, the roster, authorization (own-only 403, location-bound
// roster, the policies themselves), constraints and the directory view, on PostgreSQL 17 with the migrations of the real pipeline
// (1100-1103) and the real Nest application with the identity guard. TC-DR-01 (management half), TC-DR-02, TC-DR-03.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/availability/availability.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  A1,
  A2,
  B1,
  ORG,
  ROOM1,
  SVC,
  assignRole,
  call,
  seedPrincipal,
  seedSession,
  setupAvailability,
  writeHeaders,
} from './testkit.js';
import type { AvailKit, Doctor, SeededSession } from './testkit.js';
import { AvailabilityNotFoundError } from './index.js';
import { SchedulingScopeError, SchedulingValidationError } from './errors.js';

let t: AvailKit;
before(async () => {
  t = await setupAvailability('av');
});
after(async () => {
  await t?.close();
});

const meta = {
  get requestId(): string {
    return randomUUID();
  },
};
const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const one = async <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R> =>
  (await q<R>(sql, p))[0] as R;
const rejects = (
  p: Promise<unknown>,
  cls: new (...a: never[]) => Error,
  what: string,
): Promise<void> =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(
      e instanceof cls,
      `${what}: expected ${cls.name}, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    );
    return true;
  });
const rejectsSql = (p: Promise<unknown>, code: string, what: string): Promise<void> =>
  assert.rejects(p, (e: { code?: string; message?: string }) => {
    assert.equal(e.code, code, `${what}: expected SQLSTATE ${code}, got ${e.code} (${e.message})`);
    return true;
  });

const weekRules = (over: Record<string, unknown> = {}): Record<string, unknown>[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startLocal: '09:00',
    endLocal: '12:00',
    mode: 'either',
    ...over,
  }));
const tplBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  locationId: A1,
  validFrom: '2026-01-01',
  validTo: null,
  rules: weekRules(),
  ...over,
});

const send = (
  s: SeededSession,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
  key = randomUUID(),
) =>
  call(t.k.base, method, path, {
    cookie: s.cookie,
    headers: {
      ...(method === 'GET' ? {} : writeHeaders(s, undefined, method === 'POST' ? key : undefined)),
      ...extra,
    },
    ...(body === undefined ? {} : { body }),
  });

const deniedCount = async (principal: string): Promise<number> =>
  Number(
    (
      await one<{ n: string }>(
        `SELECT count(*) AS n FROM audit.event WHERE actor_principal_id = $1 AND action = 'denied'`,
        [principal],
      )
    ).n,
  );

describe('templates (29.3): own, validated, versioned, retired not deleted', () => {
  test('a doctor creates, lists, replaces (If-Match) and retires their own template', async () => {
    const d = await t.doctor();
    const base = `/api/v1/clinicians/${d.principalId}/availability-templates`;
    const created = await send(d.session, 'POST', base, tplBody());
    assert.equal(created.status, 201, created.body);
    const tpl = created.json();
    assert.equal(tpl['clinicianId'], d.principalId);
    assert.equal((tpl['rules'] as unknown[]).length, 7);
    assert.match(String(created.headers['etag']), /^W\/"\d+"$/);
    assert.match(String(created.headers['location']), new RegExp(`${tpl['id']}$`));

    const list = await send(d.session, 'GET', base);
    assert.equal(list.status, 200);
    assert.equal((list.json()['items'] as unknown[]).length, 1);

    // PUT without If-Match: 428; stale: 412; current: 200 and the version moves.
    const url = `${base}/${tpl['id']}`;
    const body2 = tplBody({ rules: weekRules({ startLocal: '08:00', endLocal: '10:00' }) });
    assert.equal((await send(d.session, 'PUT', url, body2)).status, 428);
    assert.equal((await send(d.session, 'PUT', url, body2, { 'if-match': 'W/"999"' })).status, 412);
    const put = await send(d.session, 'PUT', url, body2, { 'if-match': `W/"${tpl['version']}"` });
    assert.equal(put.status, 200, put.body);
    assert.equal((put.json()['rules'] as { startLocal: string }[])[0]?.startLocal, '08:00');
    assert.ok(Number(put.json()['version']) > Number(tpl['version']));
    // the old version is now stale
    assert.equal(
      (await send(d.session, 'PUT', url, body2, { 'if-match': `W/"${tpl['version']}"` })).status,
      412,
    );

    const del = await send(d.session, 'DELETE', url, undefined, {
      'if-match': `W/"${put.json()['version']}"`,
    });
    assert.equal(del.status, 200, del.body);
    assert.equal(del.json()['status'], 'retired');
    // a retired template stays in the table (history) and cannot be changed or retired again
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.availability_template WHERE id = $1`,
            [tpl['id']],
          )
        ).n,
      ),
      1,
    );
    assert.equal(
      (
        await send(d.session, 'DELETE', url, undefined, {
          'if-match': `W/"${del.json()['version']}"`,
        })
      ).status,
      409,
    );
    const active = await send(d.session, 'GET', `${base}?status=active`);
    assert.equal((active.json()['items'] as unknown[]).length, 0);
    // audited as a configuration change, ids and counts only
    const a = await q<{ change: Record<string, unknown> }>(
      `SELECT change FROM audit.event WHERE resource_type = 'scheduling.availability_template' AND resource_id = $1 AND action = 'config_change' ORDER BY occurred_at`,
      [tpl['id']],
    );
    assert.deepEqual(
      a.map((r) => r.change['op']),
      ['create', 'replace', 'retire'],
    );
  });

  test('the same Idempotency-Key creates one template', async () => {
    const d = await t.doctor();
    const base = `/api/v1/clinicians/${d.principalId}/availability-templates`;
    const key = randomUUID();
    const a = await send(d.session, 'POST', base, tplBody(), {}, key);
    const b = await send(d.session, 'POST', base, tplBody(), {}, key);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers['idempotent-replay'], 'true');
    assert.equal(a.json()['id'], b.json()['id']);
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.availability_template WHERE clinician_principal_id = $1`,
            [d.principalId],
          )
        ).n,
      ),
      1,
    );
  });

  test('validation: weekday, times, overlap inside a template, overlap with another template, place, rooms, services', async () => {
    const d = await t.doctor();
    const base = `/api/v1/clinicians/${d.principalId}/availability-templates`;
    const bad = async (body: unknown, what: string): Promise<void> => {
      const r = await send(d.session, 'POST', base, body);
      assert.equal(r.status, 422, `${what}: ${r.status} ${r.body}`);
      assert.equal(r.json()['code'], 'kernel.validation_failed', what);
    };
    await bad(
      tplBody({ rules: [{ weekday: 7, startLocal: '09:00', endLocal: '10:00', mode: 'either' }] }),
      'weekday',
    );
    await bad(
      tplBody({ rules: [{ weekday: 1, startLocal: '10:00', endLocal: '09:00', mode: 'either' }] }),
      'start after end',
    );
    await bad(
      tplBody({ rules: [{ weekday: 1, startLocal: '9am', endLocal: '10:00', mode: 'either' }] }),
      'time format',
    );
    await bad(
      tplBody({ rules: [{ weekday: 1, startLocal: '09:00', endLocal: '10:00', mode: 'phone' }] }),
      'mode',
    );
    await bad(tplBody({ rules: [] }), 'no rules');
    await bad(tplBody({ validFrom: '2026-02-30' }), 'impossible date');
    await bad(
      tplBody({ validFrom: '2026-05-01', validTo: '2026-04-01' }),
      'valid_to before valid_from',
    );
    await bad(
      tplBody({
        rules: [
          { weekday: 1, startLocal: '09:00', endLocal: '11:00', mode: 'either' },
          { weekday: 1, startLocal: '10:00', endLocal: '12:00', mode: 'either' },
        ],
      }),
      'overlap inside one template',
    );
    await bad(
      tplBody({
        rules: [
          {
            weekday: 1,
            startLocal: '09:00',
            endLocal: '10:00',
            mode: 'either',
            serviceIds: [randomUUID()],
          },
        ],
      }),
      'unknown service',
    );
    await bad(
      tplBody({
        rules: [
          {
            weekday: 1,
            startLocal: '09:00',
            endLocal: '10:00',
            mode: 'either',
            roomId: randomUUID(),
          },
        ],
      }),
      'unknown room',
    );
    await bad(tplBody({ locationId: randomUUID() }), 'unknown location');
    // a good one, then an overlapping template at the same place and dates
    const ok = await send(
      d.session,
      'POST',
      base,
      tplBody({
        rules: [
          {
            weekday: 1,
            startLocal: '09:00',
            endLocal: '12:00',
            mode: 'either',
            roomId: ROOM1,
            serviceIds: [SVC],
          },
        ],
      }),
    );
    assert.equal(ok.status, 201, ok.body);
    await bad(
      tplBody({ rules: [{ weekday: 1, startLocal: '11:00', endLocal: '13:00', mode: 'either' }] }),
      'overlap with another template',
    );
    // another day, or after the first one ends, is fine
    const other = await send(
      d.session,
      'POST',
      base,
      tplBody({ rules: [{ weekday: 2, startLocal: '11:00', endLocal: '13:00', mode: 'either' }] }),
    );
    assert.equal(other.status, 201, other.body);
    // a request that is not an object
    assert.equal((await send(d.session, 'POST', base, [1, 2])).status, 422);
  });

  test('a doctor works only at a location they hold; the admin realm is not bound to a location', async () => {
    const d = await t.doctor(); // doctor role at A1 only
    const r = await send(
      d.session,
      'POST',
      `/api/v1/clinicians/${d.principalId}/availability-templates`,
      tplBody({ locationId: B1 }),
    );
    assert.equal(r.status, 403, r.body);
    assert.equal(r.json()['code'], 'auth.forbidden');
    const admin = await t.adminScope();
    const made = await t.as(admin, (tx) =>
      t.avail.createTemplate(tx, meta, d.principalId, tplBody({ locationId: B1 }) as never),
    );
    assert.equal(made.locationId, B1);
  });
});

describe('own-only (TC-DR-03, 38.2 item 12): another doctor is refused with 403, audited, and nothing changes', () => {
  test("GET, POST, PUT, DELETE of another doctor's templates and blocked time", async () => {
    const a1 = await t.doctor();
    const a2 = await t.doctor();
    const mine = await send(
      a1.session,
      'POST',
      `/api/v1/clinicians/${a1.principalId}/availability-templates`,
      tplBody(),
    );
    assert.equal(mine.status, 201);
    const tplId = mine.json()['id'] as string;
    const blocked = await send(
      a1.session,
      'POST',
      `/api/v1/clinicians/${a1.principalId}/blocked-times`,
      {
        startsAt: '2036-05-01T13:00:00Z',
        endsAt: '2036-05-01T14:00:00Z',
        kind: 'blocked',
      },
    );
    assert.equal(blocked.status, 201, blocked.body);
    const before = {
      t: await one<{ v: string }>(
        `SELECT row_version AS v FROM scheduling.availability_template WHERE id = $1`,
        [tplId],
      ),
      n: await one<{ n: string }>(
        `SELECT count(*) AS n FROM scheduling.blocked_time WHERE clinician_principal_id = $1`,
        [a1.principalId],
      ),
    };
    const denied0 = await deniedCount(a2.principalId);

    const T = `/api/v1/clinicians/${a1.principalId}/availability-templates`;
    const B = `/api/v1/clinicians/${a1.principalId}/blocked-times`;
    const attempts: [string, string, unknown?, Record<string, string>?][] = [
      ['GET', T],
      ['POST', T, tplBody()],
      ['PUT', `${T}/${tplId}`, tplBody(), { 'if-match': `W/"${before.t.v}"` }],
      ['DELETE', `${T}/${tplId}`, undefined, { 'if-match': `W/"${before.t.v}"` }],
      ['GET', B],
      [
        'POST',
        B,
        { startsAt: '2036-05-02T13:00:00Z', endsAt: '2036-05-02T14:00:00Z', kind: 'leave' },
      ],
      ['DELETE', `${B}/${blocked.json()['id']}`],
    ];
    for (const [m, p, b, h] of attempts) {
      const r = await send(a2.session, m, p, b, h);
      assert.equal(r.status, 403, `${m} ${p}: ${r.status} ${r.body}`);
      assert.equal(r.json()['code'], 'auth.forbidden', `${m} ${p}`);
    }
    // step 3 of TC-DR-03: the refusals are in the audit view
    assert.equal((await deniedCount(a2.principalId)) - denied0, attempts.length);
    // nothing of a1's changed
    assert.equal(
      (
        await one<{ v: string }>(
          `SELECT row_version AS v FROM scheduling.availability_template WHERE id = $1`,
          [tplId],
        )
      ).v,
      before.t.v,
    );
    assert.equal(
      (
        await one<{ status: string }>(
          `SELECT status FROM scheduling.availability_template WHERE id = $1`,
          [tplId],
        )
      ).status,
      'active',
    );
    assert.equal(
      (
        await one<{ n: string }>(
          `SELECT count(*) AS n FROM scheduling.blocked_time WHERE clinician_principal_id = $1`,
          [a1.principalId],
        )
      ).n,
      before.n.n,
    );
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.availability_template WHERE clinician_principal_id = $1`,
            [a2.principalId],
          )
        ).n,
      ),
      0,
    );
  });

  test('the service refuses it too, and the row-level-security policy is the third line', async () => {
    const a1 = await t.doctor();
    const a2 = await t.doctor();
    const s2 = t.staffScope(a2.session, [A1]);
    await rejects(
      t.as(s2, (tx) => t.avail.createTemplate(tx, meta, a1.principalId, tplBody() as never)),
      SchedulingScopeError,
      'service',
    );
    await rejects(
      t.as(s2, (tx) => t.avail.listTemplates(tx, a1.principalId)),
      SchedulingScopeError,
      'service list',
    );
    // straight SQL as the other doctor: INSERT refused by WITH CHECK, UPDATE and DELETE reach no row
    await rejectsSql(
      t.as(s2, (tx) =>
        tx.query(
          `INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1, kernel.uuid1('app.org_id'), $2, $3, '2026-01-01')`,
          [randomUUID(), a1.principalId, A1],
        ),
      ),
      '42501',
      'foreign template insert',
    );
    const mine = await t.as(t.staffScope(a1.session, [A1]), (tx) =>
      t.avail.createTemplate(tx, meta, a1.principalId, tplBody() as never),
    );
    const upd = await t.as(s2, (tx) =>
      tx.query(
        `UPDATE scheduling.availability_template SET valid_to = '2026-02-01' WHERE id = $1`,
        [mine.id],
      ),
    );
    assert.equal(upd.rowCount, 0);
    const bt = await t.as(t.staffScope(a1.session, [A1]), (tx) =>
      t.avail.createBlockedTime(tx, meta, a1.principalId, {
        startsAt: '2036-06-01T10:00:00Z',
        endsAt: '2036-06-01T11:00:00Z',
        kind: 'blocked',
      }),
    );
    const del = await t.as(s2, (tx) =>
      tx.query(`DELETE FROM scheduling.blocked_time WHERE id = $1`, [bt.blockedTime?.id]),
    );
    assert.equal(del.rowCount, 0);
    await rejectsSql(
      t.as(s2, (tx) =>
        tx.query(
          `INSERT INTO scheduling.blocked_time (id, organisation_id, clinician_principal_id, period, kind) VALUES ($1, kernel.uuid1('app.org_id'), $2, tstzrange(now() + interval '1 day', now() + interval '2 days', '[)'), 'leave')`,
          [randomUUID(), a1.principalId],
        ),
      ),
      '42501',
      'foreign blocked time insert',
    );
    // a patient transaction reads but cannot write either
    const p = await t.patient(1);
    await rejectsSql(
      t.as(p.scope, (tx) =>
        tx.query(
          `INSERT INTO scheduling.blocked_time (id, organisation_id, clinician_principal_id, period, kind) VALUES ($1, kernel.uuid1('app.org_id'), $2, tstzrange(now() + interval '1 day', now() + interval '2 days', '[)'), 'leave')`,
          [randomUUID(), a1.principalId],
        ),
      ),
      '42501',
      'patient write',
    );
  });

  test('a role without the permission is refused by the guard (front desk cannot manage templates)', async () => {
    const d = await t.doctor();
    const r = await send(
      t.deskA1,
      'GET',
      `/api/v1/clinicians/${d.principalId}/availability-templates`,
    );
    assert.equal(r.status, 403);
    const roster = await send(t.deskA1, 'GET', `/api/v1/locations/${A1}/roster`);
    assert.equal(
      roster.status,
      403,
      'a front-desk member who is not a lead has no roster permission',
    );
  });
});

describe('leave and blocked time show the affected appointments before saving (TC-DR-02)', () => {
  const slot = async (): Promise<{
    doc: Doctor;
    start: Date;
    end: Date;
    patient: Awaited<ReturnType<AvailKit['patient']>>;
  }> => {
    const doc = await t.doctor();
    const day = await t.futureDate(9 + Math.floor(Math.random() * 400));
    const r = await send(
      doc.session,
      'POST',
      `/api/v1/clinicians/${doc.principalId}/availability-templates`,
      tplBody(),
    );
    assert.equal(r.status, 201, r.body);
    const start = await t.localInstant(day, '09:00');
    return {
      doc,
      start,
      end: new Date(start.getTime() + 30 * 60_000),
      patient: await t.patient(100 + Math.floor(Math.random() * 1e6)),
    };
  };
  const book = async (
    c: Awaited<ReturnType<typeof slot>>,
    start: Date,
    confirm = true,
  ): Promise<string> =>
    t
      .as(c.patient.scope, async (tx) => {
        const h = await t.core.hold(tx, meta, {
          patientId: c.patient.patientId,
          serviceId: SVC,
          locationId: A1,
          clinicianId: c.doc.principalId,
          startsAt: start.toISOString(),
          mode: 'in_person',
        });
        return h.reservationId;
      })
      .then(async (id) => {
        if (confirm) await t.as(c.patient.scope, (tx) => t.core.confirm(tx, meta, id));
        return id;
      });

  test('without acknowledgement: 409 with counts only; dryRun reports and saves nothing; acknowledged saves and cancels nothing', async () => {
    const c = await slot();
    const s2 = new Date(c.start.getTime() + 30 * 60_000);
    const confirmedId = await book(c, c.start);
    const patient2 = await t.patient(200 + Math.floor(Math.random() * 1e6));
    const heldId = await t.as(
      patient2.scope,
      async (tx) =>
        (
          await t.core.hold(tx, meta, {
            patientId: patient2.patientId,
            serviceId: SVC,
            locationId: A1,
            clinicianId: c.doc.principalId,
            startsAt: s2.toISOString(),
            mode: 'in_person',
          })
        ).reservationId,
    );
    const url = `/api/v1/clinicians/${c.doc.principalId}/blocked-times`;
    const body = {
      startsAt: c.start.toISOString(),
      endsAt: new Date(c.start.getTime() + 60 * 60_000).toISOString(),
      kind: 'leave',
      note: 'Conference',
    };

    const refused = await send(c.doc.session, 'POST', url, body);
    assert.equal(refused.status, 409, refused.body);
    assert.equal(refused.json()['code'], 'scheduling.conflicts_with_appointments');
    const errs = refused.json()['errors'] as { path: string; code: string }[];
    assert.deepEqual(Object.fromEntries(errs.map((e) => [e.path, e.code])), {
      '/conflicts/total': '2',
      '/conflicts/held': '1',
      '/conflicts/confirmed': '1',
      '/conflicts/checked_in': '0',
    });
    assert.doesNotMatch(
      refused.body,
      new RegExp(c.patient.patientId),
      'no patient identifier in the answer',
    );
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.blocked_time WHERE clinician_principal_id = $1`,
            [c.doc.principalId],
          )
        ).n,
      ),
      0,
    );

    const dry = await send(c.doc.session, 'POST', url, { ...body, dryRun: true });
    assert.equal(dry.status, 200, dry.body);
    assert.equal(dry.json()['saved'], false);
    assert.equal((dry.json()['conflicts'] as { total: number }).total, 2);
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.blocked_time WHERE clinician_principal_id = $1`,
            [c.doc.principalId],
          )
        ).n,
      ),
      0,
    );

    const saved = await send(c.doc.session, 'POST', url, { ...body, acknowledgeConflicts: true });
    assert.equal(saved.status, 201, saved.body);
    assert.equal(saved.json()['saved'], true);
    assert.equal((saved.json()['conflicts'] as { total: number }).total, 2);
    // no silent cancellation: both appointments are exactly as they were
    const st = await q<{ id: string; status: string }>(
      `SELECT id, status FROM scheduling.slot_occupancy WHERE id = ANY($1)`,
      [[confirmedId, heldId]],
    );
    assert.deepEqual(Object.fromEntries(st.map((r) => [r.id, r.status])), {
      [confirmedId]: 'confirmed',
      [heldId]: 'held',
    });
    // the note is the doctor's own and reaches no audit row
    const audit = await q<{ change: Record<string, unknown> }>(
      `SELECT change FROM audit.event WHERE resource_type = 'scheduling.blocked_time' AND resource_id = $1`,
      [saved.json()['id']],
    );
    assert.equal(audit.length, 1);
    assert.doesNotMatch(JSON.stringify(audit[0]?.change), /Conference/);
  });

  test('a free period saves at once with zero conflicts; lapsed holds and cancelled visits do not count', async () => {
    const c = await slot();
    const id = await book(c, c.start, false);
    await t.k.sa.query('BEGIN');
    await t.k.sa.query(`SET LOCAL session_replication_role = replica`);
    await t.k.sa.query(
      `UPDATE scheduling.slot_occupancy SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await t.k.sa.query('COMMIT');
    const r = await send(
      c.doc.session,
      'POST',
      `/api/v1/clinicians/${c.doc.principalId}/blocked-times`,
      {
        startsAt: c.start.toISOString(),
        endsAt: c.end.toISOString(),
        kind: 'blocked',
      },
    );
    assert.equal(r.status, 201, r.body);
    assert.equal((r.json()['conflicts'] as { total: number }).total, 0);
  });

  test('validation: periods, kind, note length, flags', async () => {
    const d = await t.doctor();
    const url = `/api/v1/clinicians/${d.principalId}/blocked-times`;
    const base = {
      startsAt: '2036-07-01T10:00:00Z',
      endsAt: '2036-07-01T11:00:00Z',
      kind: 'blocked',
    };
    for (const [what, body] of [
      ['end before start', { ...base, endsAt: '2036-07-01T09:00:00Z' }],
      ['no zone', { ...base, startsAt: '2036-07-01T10:00:00' }],
      ['kind', { ...base, kind: 'holiday' }],
      ['note too long', { ...base, note: 'x'.repeat(201) }],
      ['two years', { ...base, endsAt: '2038-07-01T11:00:00Z' }],
      ['flag type', { ...base, dryRun: 'yes' }],
    ] as const) {
      const r = await send(d.session, 'POST', url, body);
      assert.equal(r.status, 422, `${what}: ${r.status} ${r.body}`);
    }
    const ok = await send(d.session, 'POST', url, base);
    assert.equal(ok.status, 201);
    const list = await send(d.session, 'GET', `${url}?from=2036-01-01T00:00:00Z`);
    assert.equal((list.json()['items'] as unknown[]).length, 1);
    const del = await send(d.session, 'DELETE', `${url}/${ok.json()['id']}`);
    assert.equal(del.status, 204);
    assert.equal((await send(d.session, 'DELETE', `${url}/${ok.json()['id']}`)).status, 404);
  });
});

describe("roster (29.3, 29.4): a front-desk lead edits their own locations' doctor duties only", () => {
  const day = (n: number): { startsAt: string; endsAt: string } => ({
    startsAt: new Date(Date.UTC(2037, 0, 1 + n * 2, 8)).toISOString(),
    endsAt: new Date(Date.UTC(2037, 0, 1 + n * 2, 16)).toISOString(),
  });

  test("add, list and delete at the lead's location; one holder per duty and time", async () => {
    const doc = await t.doctor();
    const url = `/api/v1/locations/${A1}/roster`;
    const r = await send(t.lead, 'POST', url, {
      duty: 'on_duty_doctor',
      principalId: doc.principalId,
      ...day(0),
    });
    assert.equal(r.status, 201, r.body);
    const entry = r.json();
    const list = await send(
      t.lead,
      'GET',
      `${url}?from=2037-01-01T00:00:00Z&to=2037-02-01T00:00:00Z`,
    );
    assert.deepEqual(
      (list.json()['items'] as { id: string }[]).map((x) => x.id),
      [entry['id']],
    );
    // the same duty at the same place overlapping in time: refused as a validation problem of the period
    const doc2 = await t.doctor();
    const clash = await send(t.lead, 'POST', url, {
      duty: 'on_duty_doctor',
      principalId: doc2.principalId,
      ...day(0),
    });
    assert.equal(clash.status, 422, clash.body);
    // another duty in the same period is fine
    const call2 = await send(t.lead, 'POST', url, {
      duty: 'on_call_doctor',
      principalId: doc2.principalId,
      ...day(0),
    });
    assert.equal(call2.status, 201, call2.body);
    const del = await send(t.lead, 'DELETE', `${url}/${entry['id']}`);
    assert.equal(del.status, 204);
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.roster_entry WHERE id = $1`,
            [entry['id']],
          )
        ).n,
      ),
      0,
    );
    assert.equal((await send(t.lead, 'DELETE', `${url}/${entry['id']}`)).status, 404);
  });

  test('another location is refused (403, audited); the lead cannot set compliance on call; an ineligible principal is 422', async () => {
    const doc = await t.doctor();
    const denied0 = await deniedCount(t.lead.seeded.principalId);
    const other = await send(t.lead, 'GET', `/api/v1/locations/${A2}/roster`);
    assert.equal(other.status, 403, other.body);
    const otherPost = await send(t.lead, 'POST', `/api/v1/locations/${A2}/roster`, {
      duty: 'on_duty_doctor',
      principalId: doc.principalId,
      ...day(1),
    });
    assert.equal(otherPost.status, 403);
    assert.equal((await deniedCount(t.lead.seeded.principalId)) - denied0, 2);

    const comp = await send(t.lead, 'POST', `/api/v1/locations/${A1}/roster`, {
      duty: 'compliance_on_call',
      principalId: doc.principalId,
      ...day(2),
    });
    assert.equal(comp.status, 403, comp.body);
    assert.equal(comp.json()['code'], 'auth.forbidden');

    // front desk has no red-flag permission, so cannot be on duty as a doctor
    const inel = await send(t.lead, 'POST', `/api/v1/locations/${A1}/roster`, {
      duty: 'on_duty_doctor',
      principalId: t.deskA1.seeded.principalId,
      ...day(3),
    });
    assert.equal(inel.status, 422, inel.body);
    assert.equal(inel.json()['code'], 'scheduling.roster_principal_ineligible');
    // a doctor whose role is at another location is ineligible at this one
    const elsewhere = await t.doctor({ location: B1 });
    const wrongPlace = await send(t.lead, 'POST', `/api/v1/locations/${A1}/roster`, {
      duty: 'on_duty_doctor',
      principalId: elsewhere.principalId,
      ...day(4),
    });
    assert.equal(wrongPlace.status, 422, wrongPlace.body);
    for (const [what, body] of [
      ['duty', { duty: 'night_porter', principalId: doc.principalId, ...day(5) }],
      ['principal', { duty: 'on_duty_doctor', principalId: 'x', ...day(5) }],
      [
        'period',
        {
          duty: 'on_duty_doctor',
          principalId: doc.principalId,
          startsAt: day(5).endsAt,
          endsAt: day(5).startsAt,
        },
      ],
    ] as const)
      assert.equal(
        (await send(t.lead, 'POST', `/api/v1/locations/${A1}/roster`, body)).status,
        422,
        what,
      );
  });

  test('the admin realm sets compliance on call; the policy refuses the lead at the database even if the API did not', async () => {
    const admin = await t.adminScope();
    const comp = await seedPrincipal(t.k, 'admin_pool', { name: 'Compliance officer' });
    await assignRole(t.k, comp.principalId, 'compliance_on_call', undefined);
    const entry = await t.as(admin, (tx) =>
      t.avail.addRoster(tx, meta, A1, {
        duty: 'compliance_on_call',
        principalId: comp.principalId,
        ...day(6),
      }),
    );
    assert.equal(entry.duty, 'compliance_on_call');
    // direct SQL as the lead: insert refused (WITH CHECK), the admin's row cannot be updated or deleted
    const leadScope = t.staffScope(t.lead, [A1]);
    await rejectsSql(
      t.as(leadScope, (tx) =>
        tx.query(
          `INSERT INTO scheduling.roster_entry (id, organisation_id, location_id, duty, principal_id, period) VALUES ($1, kernel.uuid1('app.org_id'), $2, 'compliance_on_call', $3, tstzrange('2037-03-01', '2037-03-02', '[)'))`,
          [randomUUID(), A1, comp.principalId],
        ),
      ),
      '42501',
      'compliance insert by lead',
    );
    assert.equal(
      (
        await t.as(leadScope, (tx) =>
          tx.query(`UPDATE scheduling.roster_entry SET principal_id = $2 WHERE id = $1`, [
            entry.id,
            t.lead.seeded.principalId,
          ]),
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await t.as(leadScope, (tx) =>
          tx.query(`DELETE FROM scheduling.roster_entry WHERE id = $1`, [entry.id]),
        )
      ).rowCount,
      0,
    );
    await rejects(
      t.as(leadScope, (tx) => t.avail.deleteRoster(tx, meta, A1, entry.id)),
      AvailabilityNotFoundError,
      'API delete of a hidden row',
    );
    // a lead cannot reach a location they do not hold, in SQL either
    const doc = await t.doctor();
    await rejectsSql(
      t.as(leadScope, (tx) =>
        tx.query(
          `INSERT INTO scheduling.roster_entry (id, organisation_id, location_id, duty, principal_id, period) VALUES ($1, kernel.uuid1('app.org_id'), $2, 'on_duty_doctor', $3, tstzrange('2037-04-01', '2037-04-02', '[)'))`,
          [randomUUID(), A2, doc.principalId],
        ),
      ),
      '42501',
      'roster insert at another location',
    );
    // a patient cannot even read the roster
    const p = await t.patient(2);
    const seen = await t.as(p.scope, (tx) =>
      tx.query(`SELECT count(*)::int AS n FROM scheduling.roster_entry`),
    );
    assert.equal((seen.rows[0] as { n: number }).n, 0);
  });
});

describe('admin routes (29.4): any clinician, every duty, realm admin_pool', () => {
  test("an org_admin session manages another doctor's templates and blocked time and sets compliance on call; staff-realm paths and the admin prefix do not mix", async () => {
    const adminP = await seedPrincipal(t.k, 'admin_pool', { name: 'Org admin' });
    await assignRole(t.k, adminP.principalId, 'org_admin', undefined);
    const admin = await seedSession(t.k, adminP, 'admin_pool');
    const doc = await t.doctor();
    const T = `/api/v1/admin/clinicians/${doc.principalId}/availability-templates`;
    const created = await send(admin, 'POST', T, tplBody({ locationId: B1 }));
    assert.equal(created.status, 201, created.body);
    assert.equal(created.json()['clinicianId'], doc.principalId);
    const list = await send(admin, 'GET', T);
    assert.equal((list.json()['items'] as unknown[]).length, 1);
    const blocked = await send(
      admin,
      'POST',
      `/api/v1/admin/clinicians/${doc.principalId}/blocked-times`,
      {
        startsAt: '2036-08-01T13:00:00Z',
        endsAt: '2036-08-01T14:00:00Z',
        kind: 'admin',
      },
    );
    assert.equal(blocked.status, 201, blocked.body);
    // compliance on call: only here
    const comp = await seedPrincipal(t.k, 'admin_pool', { name: 'Compliance on call' });
    await assignRole(t.k, comp.principalId, 'compliance_on_call', undefined);
    const roster = await send(admin, 'POST', `/api/v1/admin/locations/${A1}/roster`, {
      duty: 'compliance_on_call',
      principalId: comp.principalId,
      startsAt: '2037-06-01T08:00:00Z',
      endsAt: '2037-06-02T08:00:00Z',
    });
    assert.equal(roster.status, 201, roster.body);
    // an admin-realm session is not allowed on the staff-realm path (the guard derives the realm from the path), and a doctor is not on the admin path
    assert.equal(
      (await send(admin, 'GET', `/api/v1/clinicians/${doc.principalId}/availability-templates`))
        .status,
      403,
    );
    assert.equal((await send(doc.session, 'GET', T)).status, 403);
  });
});

describe('constraints in the database (22.8, SBR-01)', () => {
  const sa = <T = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<T[]> =>
    q<T>(sql, p);
  let doc: Doctor;
  before(async () => {
    doc = await t.doctor();
  });

  test("a rule's copied doctor must be its template's doctor (composite foreign key)", async () => {
    const other = await t.doctor();
    const tplId = randomUUID();
    await sa(
      `INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1, $2, $3, $4, '2026-01-01')`,
      [tplId, ORG, doc.principalId, A1],
    );
    await rejectsSql(
      sa(
        `INSERT INTO scheduling.template_rule (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local, mode) VALUES ($1, $2, $3, $4, 1, '09:00', '10:00', 'either')`,
        [randomUUID(), ORG, tplId, other.principalId],
      ),
      '23503',
      'rule copies another doctor',
    );
  });

  test('check constraints: weekday, start before end, valid range, empty or open-ended periods', async () => {
    const tplId = randomUUID();
    await rejectsSql(
      sa(
        `INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from, valid_to) VALUES ($1, $2, $3, $4, '2026-02-01', '2026-01-01')`,
        [tplId, ORG, doc.principalId, A1],
      ),
      '23514',
      'valid range',
    );
    await sa(
      `INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1, $2, $3, $4, '2026-01-01')`,
      [tplId, ORG, doc.principalId, A1],
    );
    const rule = (weekday: number, s: string, e: string): Promise<unknown> =>
      sa(
        `INSERT INTO scheduling.template_rule (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local, mode) VALUES ($1, $2, $3, $4, $5, $6, $7, 'either')`,
        [randomUUID(), ORG, tplId, doc.principalId, weekday, s, e],
      );
    await rejectsSql(rule(7, '09:00', '10:00'), '23514', 'weekday 7');
    await rejectsSql(rule(1, '10:00', '10:00'), '23514', 'empty rule');
    await rejectsSql(rule(1, '11:00', '10:00'), '23514', 'reversed rule');
    const blk = (period: string, kind = 'leave'): Promise<unknown> =>
      sa(
        `INSERT INTO scheduling.blocked_time (id, organisation_id, clinician_principal_id, period, kind) VALUES ($1, $2, $3, $4::tstzrange, $5)`,
        [randomUUID(), ORG, doc.principalId, period, kind],
      );
    await rejectsSql(blk('empty'), '23514', 'empty period');
    await rejectsSql(blk('[2036-01-01,)'), '23514', 'open-ended period');
    await rejectsSql(blk('[2036-01-01,2036-01-02)', 'holiday'), '23514', 'kind');
    await rejectsSql(blk('(2036-01-01,2036-01-02)'), '23514', 'exclusive lower bound');
    await blk('[2036-01-01,2036-01-02)');
  });

  test('roster exclusion: one holder per duty, place and time; back-to-back is fine', async () => {
    const ins = (duty: string, period: string): Promise<unknown> =>
      sa(
        `INSERT INTO scheduling.roster_entry (id, organisation_id, location_id, duty, principal_id, period) VALUES ($1, $2, $3, $4, $5, $6::tstzrange)`,
        [randomUUID(), ORG, B1, duty, doc.principalId, period],
      );
    await ins('on_duty_doctor', '[2038-01-01 08:00+00,2038-01-01 16:00+00)');
    await rejectsSql(
      ins('on_duty_doctor', '[2038-01-01 15:00+00,2038-01-01 20:00+00)'),
      '23P01',
      'overlap',
    );
    await ins('on_duty_doctor', '[2038-01-01 16:00+00,2038-01-01 20:00+00)');
    await ins('on_call_doctor', '[2038-01-01 15:00+00,2038-01-01 20:00+00)');
  });

  test('a template keeps its doctor and a retired template stays retired (triggers)', async () => {
    const other = await t.doctor();
    const tplId = randomUUID();
    await sa(
      `INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1, $2, $3, $4, '2026-01-01')`,
      [tplId, ORG, doc.principalId, A1],
    );
    await rejectsSql(
      sa(`UPDATE scheduling.availability_template SET clinician_principal_id = $2 WHERE id = $1`, [
        tplId,
        other.principalId,
      ]),
      'PS001',
      'move to another doctor',
    );
    await sa(`UPDATE scheduling.availability_template SET status = 'retired' WHERE id = $1`, [
      tplId,
    ]);
    await rejectsSql(
      sa(`UPDATE scheduling.availability_template SET status = 'active' WHERE id = $1`, [tplId]),
      'PS001',
      'revive',
    );
  });

  test('busy_block: no application role writes it here (calendar-sync, BE-14, owns the writer); app roles read it', async () => {
    await sa(
      `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ($1, $2, '[2036-01-01 10:00+00,2036-01-01 11:00+00)', 'google', decode(repeat('ab', 16), 'hex'), now())`,
      [ORG, doc.principalId],
    );
    await rejectsSql(
      sa(
        `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ($1, $2, '[2036-01-01 10:00+00,2036-01-01 11:00+00)', 'outlook', decode(repeat('cd', 16), 'hex'), now())`,
        [ORG, doc.principalId],
      ),
      '23514',
      'source',
    );
    await rejectsSql(
      sa(
        `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ($1, $2, '[2036-01-01 10:00+00,2036-01-01 11:00+00)', 'google', decode('ab', 'hex'), now())`,
        [ORG, doc.principalId],
      ),
      '23514',
      'short hash',
    );
    const s = t.staffScope(doc.session, [A1]);
    await rejectsSql(
      t.as(s, (tx) =>
        tx.query(
          `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES (kernel.uuid1('app.org_id'), $1, '[2036-01-01 12:00+00,2036-01-01 13:00+00)', 'google', decode(repeat('ef', 16), 'hex'), now())`,
          [doc.principalId],
        ),
      ),
      '42501',
      'app_api insert',
    );
    await rejectsSql(
      t.as(s, (tx) => tx.query(`DELETE FROM scheduling.busy_block`)),
      '42501',
      'app_api delete',
    );
    const seen = await t.as(s, (tx) =>
      tx.query(
        `SELECT count(*)::int AS n FROM scheduling.busy_block WHERE clinician_principal_id = $1`,
        [doc.principalId],
      ),
    );
    assert.equal((seen.rows[0] as { n: number }).n, 1);
    const w = await t.worker.withScope(t.workerScope, (tx) =>
      tx.query(`SELECT count(*)::int AS n FROM scheduling.busy_block`),
    );
    assert.ok((w.rows[0] as { n: number }).n >= 1);
    await rejectsSql(
      t.worker.withScope(t.workerScope, (tx) => tx.query(`DELETE FROM scheduling.busy_block`)),
      '42501',
      'app_worker delete',
    );
  });
});

describe('the clinician directory view (22.5.1)', () => {
  test('a patient sees (clinician, location) pairs with an active template that has not ended; nothing else', async () => {
    const d = await t.doctor();
    const p = await t.patient(3);
    const pairs = async (): Promise<string[]> =>
      (await t.as(p.scope, (tx) => t.avail.directoryClinicianLocations(tx, A1)))
        .filter((x) => x.clinicianId === d.principalId)
        .map((x) => `${x.clinicianId}@${x.locationId}`);
    assert.deepEqual(await pairs(), []);
    const made = await t.as(t.staffScope(d.session, [A1]), (tx) =>
      t.avail.createTemplate(tx, meta, d.principalId, tplBody() as never),
    );
    assert.deepEqual(await pairs(), [`${d.principalId}@${A1}`]);
    assert.deepEqual(
      (await t.as(p.scope, (tx) => t.avail.directoryClinicianLocations(tx, B1))).filter(
        (x) => x.clinicianId === d.principalId,
      ),
      [],
    );
    // the base table is closed to the directory path: a patient reads it only through the API's own search
    await t.as(t.staffScope(d.session, [A1]), (tx) =>
      t.avail.retireTemplate(tx, meta, d.principalId, made.id, made.version),
    );
    assert.deepEqual(await pairs(), []);
    // an ended template is not listed either
    const ended = await t.as(t.staffScope(d.session, [A1]), (tx) =>
      t.avail.createTemplate(
        tx,
        meta,
        d.principalId,
        tplBody({ validFrom: '2020-01-01', validTo: '2020-12-31' }) as never,
      ),
    );
    assert.equal(ended.validTo, '2020-12-31');
    assert.deepEqual(await pairs(), []);
    await rejects(
      t.as(p.scope, (tx) => t.avail.directoryClinicianLocations(tx, 'nope')),
      SchedulingValidationError,
      'bad location id',
    );
  });
});
