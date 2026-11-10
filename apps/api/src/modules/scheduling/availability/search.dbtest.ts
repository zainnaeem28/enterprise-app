// Real-database tests for BE-12, part 2: slot search and the availability port of the booking core, on PostgreSQL 17 with the real
// migrations, the real Nest application and the real booking core. TC-DR-01, TC-DR-02 (with the race), TC-BK-03 (the data half:
// the Google meeting is a seeded busy block here; the real-calendar half is BE-14's), TC-BK-04 (alternatives), TC-BK-10 (daylight
// saving), the stale-busy rule (RA-R1-04, X-03), overbookable sessions (BR-02) and an informational latency measurement (NFR-8).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/availability/search.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  A1,
  B1,
  ORG,
  PATIENT_HOST,
  SVC,
  SVC_IN,
  call,
  saWrite,
  seedPrincipal,
  seedSession,
  setupAvailability,
  writeHeaders,
} from './testkit.js';
import type { AvailKit, Doctor } from './testkit.js';
import { ConflictsWithAppointmentsError } from './index.js';
import type { SearchResult, Slot } from './index.js';
import { OutsideHoursError, SlotTakenError } from '../core/errors.js';
import type { HoldInput } from '../core/index.js';

let t: AvailKit;
let admin: Awaited<ReturnType<AvailKit['adminScope']>>;
let patientSession: Awaited<ReturnType<AvailKit['patient']>>['session'];
before(async () => {
  t = await setupAvailability('sr');
  admin = await t.adminScope();
  patientSession = (await t.patient(1)).session;
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

const weekRules = (over: Record<string, unknown> = {}): Record<string, unknown>[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startLocal: '09:00',
    endLocal: '12:00',
    mode: 'either',
    ...over,
  }));
const tplInput = (over: Record<string, unknown> = {}): never =>
  ({
    locationId: A1,
    validFrom: '2026-01-01',
    validTo: null,
    rules: weekRules(),
    ...over,
  }) as never;

type P = Awaited<ReturnType<AvailKit['patient']>>;
let seq = 1000;
/** A doctor with an all-week 09:00-12:00 template at A1 (local time), eligible for both services and listed in the directory. */
async function doctorWithTemplate(
  over: Record<string, unknown> = {},
  opts: Parameters<AvailKit['doctor']>[0] = {},
): Promise<Doctor> {
  const d = await t.doctor(opts);
  await t.as(admin, (tx) => t.avail.createTemplate(tx, meta, d.principalId, tplInput(over)));
  return d;
}
const range = async (date: string): Promise<{ from: string; to: string }> => ({
  from: (await t.localInstant(date, '00:00')).toISOString(),
  to: (await t.localInstant(date, '23:59')).toISOString(),
});
const search = async (
  d: Doctor | null,
  date: string,
  over: Record<string, unknown> = {},
  as: 'staff' | 'patient' = 'patient',
): Promise<SearchResult> => {
  const body = {
    serviceId: SVC,
    mode: 'in_person',
    ...(d === null ? {} : { clinicianId: d.principalId }),
    ...(await range(date)),
    ...over,
  };
  const r = await call(t.k.base, 'POST', '/api/v1/availability/search', {
    host: as === 'patient' ? PATIENT_HOST : undefined,
    cookie: as === 'patient' ? patientSession.cookie : t.deskA1.cookie,
    headers: writeHeaders(
      as === 'patient' ? patientSession : t.deskA1,
      as === 'patient' ? PATIENT_HOST : undefined,
    ),
    body,
  });
  assert.equal(r.status, 200, r.body);
  return r.json() as unknown as SearchResult;
};
const starts = (r: SearchResult): string[] => r.slots.map((s) => s.startsAt);
const at = async (date: string, ...times: string[]): Promise<string[]> =>
  Promise.all(times.map(async (x) => (await t.localInstant(date, x)).toISOString()));
const hold = (
  p: Awaited<ReturnType<AvailKit['patient']>>,
  d: Doctor,
  start: string,
  over: Partial<HoldInput> = {},
) =>
  t.as(p.scope, (tx) =>
    t.core.hold(tx, meta, {
      patientId: p.patientId,
      serviceId: SVC,
      locationId: A1,
      clinicianId: d.principalId,
      startsAt: start,
      mode: 'in_person',
      ...over,
    }),
  );
const newPatient = (): ReturnType<AvailKit['patient']> => t.patient(++seq);
const blockedUrl = (d: Doctor): string => `/api/v1/clinicians/${d.principalId}/blocked-times`;
const addBlocked = (d: Doctor, s: string, e: string, extra: Record<string, unknown> = {}) =>
  call(t.k.base, 'POST', blockedUrl(d), {
    cookie: d.session.cookie,
    headers: writeHeaders(d.session, undefined, randomUUID()),
    body: { startsAt: s, endsAt: e, kind: 'blocked', ...extra },
  });

describe('slot search = template - bookings - busy - blocked time (TC-DR-01, TC-BK-03, RA-R1-23)', () => {
  test('each of the four subtractions removes exactly its slot; removing the leave brings the slot back', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(20);
    const all = await at(day, '09:00', '09:30', '10:00', '10:30', '11:00', '11:30');
    assert.deepEqual(starts(await search(d, day)), all, 'the template alone: six half-hour slots');

    // Google busy 10:00-10:30 (a seeded busy block; the sync that writes it is BE-14's)
    const [b0, b1] = await at(day, '10:00', '10:30');
    await saWrite(
      t.k,
      `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'google', decode(repeat('0a', 16), 'hex'), now())`,
      [ORG, d.principalId, b0, b1],
    );
    // leave 10:30-11:00, through the doctor's own API (TC-DR-01 step 2)
    const [l0, l1] = await at(day, '10:30', '11:00');
    const leave = await addBlocked(d, l0 as string, l1 as string, { kind: 'leave' });
    assert.equal(leave.status, 201, leave.body);
    // a booking at 09:00
    const p = await newPatient();
    await hold(p, d, all[0] as string);

    const expected = [all[1], all[4], all[5]];
    for (const who of ['patient', 'staff'] as const)
      assert.deepEqual(
        starts(await search(d, day, {}, who)),
        expected,
        `${who} sees template minus booking, busy and leave`,
      );

    // TC-DR-01 step 4: remove the leave and search again
    const del = await call(t.k.base, 'DELETE', `${blockedUrl(d)}/${leave.json()['id']}`, {
      cookie: d.session.cookie,
      headers: writeHeaders(d.session),
    });
    assert.equal(del.status, 204);
    assert.deepEqual(starts(await search(d, day)), [all[1], all[3], all[4], all[5]]);
  });

  test('the answer carries only what a patient may see: start, end, clinician, location, mode (never a room, patient, count, note or kind)', async () => {
    const d = await doctorWithTemplate({ rules: weekRules({ roomId: undefined }) });
    const day = await t.futureDate(21);
    await addBlocked(
      d,
      (await t.localInstant(day, '09:00')).toISOString(),
      (await t.localInstant(day, '09:30')).toISOString(),
      { kind: 'leave', note: 'Private reason' },
    );
    const r = await search(d, day);
    assert.deepEqual(Object.keys(r).sort(), ['availabilityStale', 'slots']);
    for (const s of r.slots)
      assert.deepEqual(Object.keys(s).sort(), [
        'clinicianId',
        'endsAt',
        'locationId',
        'mode',
        'startsAt',
      ]);
    assert.equal(JSON.stringify(r).includes('Private reason'), false);
    assert.equal(r.slots.length, 5);
  });

  test('the service decides the grid (60 minutes -> 09:00, 10:00, 11:00); mode and service restrictions of a rule apply', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(22);
    assert.deepEqual(
      starts(await search(d, day, { serviceId: SVC_IN })),
      await at(day, '09:00', '10:00', '11:00'),
    );
    // a video request for an in-person-only service is refused as a validation error
    const r = await call(t.k.base, 'POST', '/api/v1/availability/search', {
      host: PATIENT_HOST,
      cookie: patientSession.cookie,
      headers: writeHeaders(patientSession, PATIENT_HOST),
      body: { serviceId: SVC_IN, mode: 'video', ...(await range(day)) },
    });
    assert.equal(r.status, 422);
    const inPersonOnly = await doctorWithTemplate({ rules: weekRules({ mode: 'in_person' }) });
    assert.equal((await search(inPersonOnly, day, { mode: 'in_person' })).slots.length, 6);
    assert.equal(
      (await search(inPersonOnly, day, { mode: 'video' })).slots.length,
      0,
      'an in-person rule offers no video slot',
    );
    const forInLong = await doctorWithTemplate({ rules: weekRules({ serviceIds: [SVC_IN] }) });
    assert.equal(
      (await search(forInLong, day)).slots.length,
      0,
      'a rule for the long visit offers nothing for the short one',
    );
    assert.equal((await search(forInLong, day, { serviceId: SVC_IN })).slots.length, 3);
  });

  test('a template change takes effect in the next search (RA-R1-23): replace, then retire', async () => {
    const d = await t.doctor();
    const day = await t.futureDate(23);
    const made = await t.as(admin, (tx) =>
      t.avail.createTemplate(tx, meta, d.principalId, tplInput()),
    );
    assert.equal((await search(d, day)).slots.length, 6);
    const r2 = await t.as(admin, (tx) =>
      t.avail.replaceTemplate(
        tx,
        meta,
        d.principalId,
        made.id,
        tplInput({ rules: weekRules({ endLocal: '10:00' }) }),
        made.version,
      ),
    );
    assert.equal((await search(d, day)).slots.length, 2);
    await t.as(admin, (tx) => t.avail.retireTemplate(tx, meta, d.principalId, made.id, r2.version));
    assert.equal((await search(d, day)).slots.length, 0);
  });

  test('validity window: not before valid_from, not after valid_to', async () => {
    const day = await t.futureDate(24);
    const next = await t.futureDate(25);
    const prev = await t.futureDate(23);
    const d = await doctorWithTemplate({ validFrom: next });
    assert.equal((await search(d, day)).slots.length, 0);
    assert.equal((await search(d, next)).slots.length, 6);
    const e = await doctorWithTemplate({ validTo: prev });
    assert.equal((await search(e, day)).slots.length, 0);
    const f = await doctorWithTemplate({ validFrom: day, validTo: day });
    assert.equal((await search(f, day)).slots.length, 6);
    assert.equal((await search(f, next)).slots.length, 0);
  });

  test('who is offered: eligible and listed clinicians only to a patient; staff also see unlisted but active ones; a location filter applies', async () => {
    const day = await t.futureDate(26);
    const listed = await doctorWithTemplate();
    const unlisted = await doctorWithTemplate({}, { listed: false });
    const ineligible = await doctorWithTemplate({}, { eligible: false });
    const other = await doctorWithTemplate({ locationId: B1 }, { location: B1 });
    const clinicians = (r: SearchResult): string[] => [
      ...new Set(r.slots.map((s) => s.clinicianId)),
    ];
    const p = clinicians(await search(null, day, {}, 'patient'));
    assert.ok(p.includes(listed.principalId));
    assert.ok(!p.includes(unlisted.principalId), 'an unlisted doctor is not offered to a patient');
    assert.ok(
      !p.includes(ineligible.principalId),
      'a doctor not eligible for the service is not offered',
    );
    assert.ok(p.includes(other.principalId));
    const s = clinicians(await search(null, day, {}, 'staff'));
    assert.ok(
      s.includes(unlisted.principalId),
      'staff see an active doctor who is not directory-listed',
    );
    assert.ok(!s.includes(ineligible.principalId));
    const atB1 = await search(null, day, { locationId: B1 }, 'patient');
    assert.deepEqual(
      clinicians(atB1).filter((x) => [listed, other].some((d) => d.principalId === x)),
      [other.principalId],
    );
    assert.ok(atB1.slots.every((x) => x.locationId === B1));
    // a suspended doctor is not offered to staff either
    await saWrite(t.k, `UPDATE identity.principal SET status = 'suspended' WHERE id = $1`, [
      unlisted.principalId,
    ]);
    assert.ok(!clinicians(await search(null, day, {}, 'staff')).includes(unlisted.principalId));
  });

  test('daylight saving (TC-BK-10): the template is local wall-clock time, the slot instant moves', async () => {
    // America/New_York changes on Sunday 9 March 2036 (02:00 -> 03:00) and on Sunday 2 November 2036 (02:00 -> 01:00).
    for (const days of [
      ['2036-03-08', '2036-03-09', '2036-03-10'],
      ['2036-11-01', '2036-11-02', '2036-11-03'],
    ]) {
      const d = await doctorWithTemplate({
        rules: weekRules({ startLocal: '09:00', endLocal: '10:00' }),
      });
      const seen: string[] = [];
      for (const day of days as string[]) {
        const r = await search(d, day);
        assert.equal(r.slots.length, 2, day);
        assert.equal(
          r.slots[0]?.startsAt,
          (await t.localInstant(day, '09:00')).toISOString(),
          `${day}: 09:00 local`,
        );
        seen.push(r.slots[0]?.startsAt as string);
      }
      const hours = seen.map((s) => new Date(s).getUTCHours());
      assert.notDeepEqual(
        new Set(hours).size,
        1,
        `the UTC hour of 09:00 local changes across ${days[0]}`,
      );
    }
    // a window across the change keeps its local length: 01:00-04:00 on the spring-forward day has two real hours
    const d = await doctorWithTemplate({
      rules: weekRules({ startLocal: '00:00', endLocal: '04:00' }),
    });
    const r = await search(d, '2036-03-09', { serviceId: SVC_IN });
    assert.equal(
      r.slots.length,
      3,
      'a 04:00-hour window on the 23-hour day holds three 60-minute slots',
    );
  });

  test('range limits and input validation (29.2): 31 days, from < to, ids, zones, unknown service', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(27);
    const post = (body: unknown, who: 'patient' | 'staff' = 'patient') =>
      call(t.k.base, 'POST', '/api/v1/availability/search', {
        host: who === 'patient' ? PATIENT_HOST : undefined,
        cookie: who === 'patient' ? patientSession.cookie : t.deskA1.cookie,
        headers: writeHeaders(
          who === 'patient' ? patientSession : t.deskA1,
          who === 'patient' ? PATIENT_HOST : undefined,
        ),
        body,
      });
    const r0 = await range(day);
    const bad: [string, unknown][] = [
      [
        '32 days',
        {
          serviceId: SVC,
          mode: 'in_person',
          from: r0.from,
          to: new Date(Date.parse(r0.from) + 32 * 86_400_000).toISOString(),
        },
      ],
      ['to before from', { serviceId: SVC, mode: 'in_person', from: r0.to, to: r0.from }],
      [
        'no zone',
        {
          serviceId: SVC,
          mode: 'in_person',
          from: '2036-01-01T00:00:00',
          to: '2036-01-02T00:00:00',
        },
      ],
      ['service id', { serviceId: 'x', mode: 'in_person', ...r0 }],
      ['unknown service', { serviceId: randomUUID(), mode: 'in_person', ...r0 }],
      ['mode', { serviceId: SVC, mode: 'phone', ...r0 }],
      ['clinician id', { serviceId: SVC, mode: 'in_person', clinicianId: 'x', ...r0 }],
      [
        'includeOverbook is staff only',
        { serviceId: SVC, mode: 'in_person', includeOverbook: true, ...r0 },
      ],
      [
        'includeOverbook type',
        { serviceId: SVC, mode: 'in_person', includeOverbook: 'yes', ...r0 },
      ],
    ];
    for (const [what, body] of bad) {
      const r = await post(body);
      assert.equal(r.status, 422, `${what}: ${r.status} ${r.body}`);
      assert.equal(r.json()['code'], 'kernel.validation_failed', what);
    }
    // exactly 31 days is allowed
    assert.equal(
      (
        await post({
          serviceId: SVC,
          mode: 'in_person',
          clinicianId: d.principalId,
          from: r0.from,
          to: new Date(Date.parse(r0.from) + 31 * 86_400_000).toISOString(),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post(
          {
            serviceId: SVC,
            mode: 'in_person',
            clinicianId: d.principalId,
            includeOverbook: true,
            ...r0,
          },
          'staff',
        )
      ).status,
      200,
    );
  });

  test('who may search: a patient session and a staff member with the permission; a doctor without it, an admin session, and no session are refused', async () => {
    const day = await t.futureDate(28);
    const body = { serviceId: SVC, mode: 'in_person', ...(await range(day)) };
    const doc = await t.doctor();
    const as = (cookie: string | undefined, session: typeof t.deskA1 | undefined, host?: string) =>
      call(t.k.base, 'POST', '/api/v1/availability/search', {
        ...(host === undefined ? {} : { host }),
        ...(cookie === undefined || session === undefined
          ? {}
          : { cookie, headers: writeHeaders(session, host) }),
        body,
      });
    assert.equal(
      (await as(doc.session.cookie, doc.session)).status,
      403,
      'doctor role has no scheduling.availability.search',
    );
    assert.equal(
      (await as(t.lead.cookie, t.lead)).status,
      200,
      'front-desk lead inherits the front desk permission',
    );
    const adminSession = await seedSession(
      t.k,
      await seedPrincipal(t.k, 'admin_pool', { name: 'Admin 2' }),
      'admin_pool',
    );
    assert.equal(
      (await as(adminSession.cookie, adminSession)).status,
      403,
      'an admin-realm session is not a search caller',
    );
    assert.equal((await as(undefined, undefined)).status, 401);
  });
});

describe('stale busy data is never used silently (RA-R1-04, X-03, G2 setting calendar_stale_minutes)', () => {
  test('older than the threshold: still excluded (last known) and flagged; fresh or absent: not flagged; the threshold is a setting', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(29);
    const [b0, b1] = await at(day, '10:00', '10:30');
    const busy = (minutesOld: number): Promise<void> =>
      saWrite(t.k, `DELETE FROM scheduling.busy_block WHERE clinician_principal_id = $1`, [
        d.principalId,
      ]).then(() =>
        saWrite(
          t.k,
          `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'google', decode(repeat('0b', 16), 'hex'), now() - make_interval(mins => $5))`,
          [ORG, d.principalId, b0, b1, minutesOld],
        ),
      );
    const noCalendar = await search(d, day);
    assert.equal(noCalendar.availabilityStale, false, 'no busy data at all: nothing is stale');
    assert.equal(noCalendar.slots.length, 6);

    await busy(5);
    const fresh = await search(d, day);
    assert.equal(fresh.availabilityStale, false);
    assert.equal(fresh.slots.length, 5);

    await busy(20); // threshold 15 (PRD 7.2)
    const stale = await search(d, day);
    assert.equal(stale.availabilityStale, true, 'busy data older than 15 minutes is flagged');
    assert.equal(stale.slots.length, 5, 'the last known busy time is still honoured');
    assert.equal(
      (await search(d, day, {}, 'staff')).availabilityStale,
      true,
      'staff get the flag too',
    );

    // The threshold is the configured value, not a constant: 30 minutes makes 20-minute-old data fresh.
    await saWrite(
      t.k,
      `UPDATE kernel.setting SET value = to_jsonb(30) WHERE key = 'calendar_stale_minutes'`,
    );
    assert.equal((await search(d, day)).availabilityStale, false);
    await saWrite(
      t.k,
      `UPDATE kernel.setting SET value = to_jsonb(10) WHERE key = 'calendar_stale_minutes'`,
    );
    assert.equal((await search(d, day)).availabilityStale, true);
    await saWrite(
      t.k,
      `UPDATE kernel.setting SET value = to_jsonb(15) WHERE key = 'calendar_stale_minutes'`,
    );

    // Only doctors in the result count: another doctor's stale data does not flag this search.
    const other = await doctorWithTemplate();
    await saWrite(
      t.k,
      `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'google', decode(repeat('0c', 16), 'hex'), now() - interval '2 hours')`,
      [ORG, other.principalId, b0, b1],
    );
    await busy(1);
    assert.equal((await search(d, day)).availabilityStale, false);
    assert.equal((await search(other, day)).availabilityStale, true);
    // a stale doctor in a multi-doctor search flags the whole answer
    assert.equal((await search(null, day, {}, 'staff')).availabilityStale, true);
  });

  test('a missing setting fails closed (503), it never falls back to a number in code', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(30);
    await saWrite(
      t.k,
      `UPDATE kernel.setting SET key = 'calendar_stale_minutes_hidden' WHERE key = 'calendar_stale_minutes'`,
    );
    try {
      const r = await call(t.k.base, 'POST', '/api/v1/availability/search', {
        host: PATIENT_HOST,
        cookie: patientSession.cookie,
        headers: writeHeaders(patientSession, PATIENT_HOST),
        body: {
          serviceId: SVC,
          mode: 'in_person',
          clinicianId: d.principalId,
          ...(await range(day)),
        },
      });
      assert.equal(r.status, 503, r.body);
      assert.equal(r.json()['code'], 'kernel.unavailable');
    } finally {
      await saWrite(
        t.k,
        `UPDATE kernel.setting SET key = 'calendar_stale_minutes' WHERE key = 'calendar_stale_minutes_hidden'`,
      );
    }
  });
});

describe('the availability port of the booking core (hold validation, alternatives)', () => {
  test('a hold is accepted on the grid inside the template and refused with scheduling.outside_hours everywhere else', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(31);
    const p = await newPatient();
    const [bb0, bb1] = await at(day, '10:00', '10:30');
    await saWrite(
      t.k,
      `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'google', decode(repeat('0d', 16), 'hex'), now())`,
      [ORG, d.principalId, bb0, bb1],
    );
    const [l0, l1] = await at(day, '11:00', '11:30');
    assert.equal((await addBlocked(d, l0 as string, l1 as string, { kind: 'leave' })).status, 201);
    for (const [what, time] of [
      ['before the window', '08:30'],
      ['off the grid', '09:15'],
      ['crossing the window end', '11:45'],
      ['after the window', '12:00'],
      ['on a Google busy block', '10:00'],
      ['in leave', '11:00'],
    ] as const) {
      const [start] = await at(day, time);
      await rejects(hold(p, d, start as string), OutsideHoursError, what);
    }
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1`,
            [d.principalId],
          )
        ).n,
      ),
      0,
      'nothing was written',
    );
    const [ok] = await at(day, '09:30');
    const h = await hold(p, d, ok as string);
    assert.ok(h.reservationId);
    // the other service, the other mode and another place are checked against their own rules
    const other = await newPatient();
    await rejects(
      hold(other, d, (await at(day, '09:00'))[0] as string, { locationId: B1 }),
      OutsideHoursError,
      'no template at B1',
    );
    const withRule = await doctorWithTemplate({ rules: weekRules({ mode: 'in_person' }) });
    await saWrite(
      t.k,
      `INSERT INTO identity.licensed_state (principal_id, organisation_id, jurisdiction_code) VALUES ($1, $2, 'NY')`,
      [withRule.principalId, ORG],
    );
    await rejects(
      hold(other, withRule, (await at(day, '09:00'))[0] as string, {
        mode: 'video',
        patientState: 'NY',
      }),
      OutsideHoursError,
      'in-person rule, video request',
    );
  });

  test('a taken slot is 409 scheduling.slot_taken with alternatives from the same search (TC-BK-04)', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(32);
    const [nine] = await at(day, '09:00');
    const a = await newPatient();
    const b = await newPatient();
    await hold(a, d, nine as string);
    await assert.rejects(hold(b, d, nine as string), (e: unknown) => {
      assert.ok(e instanceof SlotTakenError);
      assert.ok(e.alternatives.length >= 1 && e.alternatives.length <= 5);
      return true;
    });
    const r = await search(d, day);
    // every alternative is a slot the search itself offers, and not the taken one
    await assert.rejects(hold(b, d, nine as string), (e: unknown) => {
      const alt = (e as SlotTakenError).alternatives;
      assert.ok(!alt.includes(nine as string));
      for (const x of alt) assert.ok(starts(r).includes(x), `${x} is offered by the search`);
      return true;
    });
  });

  test('alternatives and search stay consistent after a booking: the search never offers the held slot', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(33);
    const p = await newPatient();
    const slots = await at(day, '09:00', '09:30', '10:00');
    await hold(p, d, slots[1] as string);
    assert.deepEqual(starts(await search(d, day)).slice(0, 2), [slots[0], slots[2]]);
  });
});

describe('overbookable sessions (BR-02, RA-R1-03 for the overbookable case)', () => {
  test('staff with includeOverbook see a booked slot of an overbookable window while it holds fewer than the cap; patients never do; a full slot hides nothing else; cap 0 means no overbooking (HEAAA-632 T5)', async () => {
    const d = await doctorWithTemplate({ rules: weekRules({ overbookable: true }) });
    const day = await t.futureDate(34);
    const [nine, half] = await at(day, '09:00', '09:30');
    const p = await Promise.all([newPatient(), newPatient(), newPatient(), newPatient()]);
    // cap 0 (no policy row): the first booking takes the slot, a second one is just taken
    await hold(p[0] as P, d, nine as string);
    await rejects(hold(p[1] as P, d, nine as string), SlotTakenError, 'cap 0');
    const dd = await doctorWithTemplate({ rules: weekRules({ overbookable: true }) });
    // cap 2 for this service at this place: the cap is the total in the slot, the first booking included
    await saWrite(
      t.k,
      `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, cutoff_hours, max_future_per_patient, overbook_cap_per_session) VALUES ($1, $2, $3, $4, 24, 5, 2)`,
      [randomUUID(), ORG, SVC, A1],
    );
    try {
      const free = await search(dd, day, { includeOverbook: true }, 'staff');
      assert.equal(
        free.slots.find((s: Slot) => s.startsAt === nine)?.overbook,
        undefined,
        'an empty slot is offered as a normal slot, not flagged',
      );
      await hold(p[1] as P, dd, nine as string);
      const plain = await search(dd, day);
      assert.ok(
        !starts(plain).includes(nine as string),
        'a patient does not see the occupied slot',
      );
      const staffPlain = await search(dd, day, {}, 'staff');
      assert.ok(
        !starts(staffPlain).includes(nine as string),
        'staff without the flag do not either',
      );
      const extra = await search(dd, day, { includeOverbook: true }, 'staff');
      const row = extra.slots.find((s: Slot) => s.startsAt === nine);
      assert.ok(row, 'staff with includeOverbook see the slot that holds 1 of 2');
      assert.equal(row.overbook, true);
      assert.equal(
        extra.slots.find((s: Slot) => s.startsAt === half)?.overbook,
        undefined,
        'a free slot is not flagged',
      );

      // exactly one more booking is allowed (2 in total), the third is refused (the database counts under the doctor lock)
      await hold(p[2] as P, dd, nine as string);
      await rejects(hold(p[3] as P, dd, nine as string), SlotTakenError, 'cap reached');
      const full = await search(dd, day, { includeOverbook: true }, 'staff');
      assert.equal(
        full.slots.find((s: Slot) => s.startsAt === nine),
        undefined,
        'the cap is reached, the slot is no longer offered',
      );
      // a full slot does not hide the other slots of the window
      assert.ok(
        starts(full).includes(half as string),
        'the next slot of the same window is still offered',
      );
    } finally {
      await saWrite(
        t.k,
        `DELETE FROM organisation.booking_policy WHERE service_id = $1 AND location_id = $2`,
        [SVC, A1],
      );
    }
  });
});

describe('lead time (booking policy) applies to patients, not to staff searches', () => {
  test('a patient does not see slots inside the lead time; staff do', async () => {
    const d = await doctorWithTemplate({ locationId: B1 }, { location: B1 });
    const day = await t.futureDate(35);
    await saWrite(
      t.k,
      `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, lead_time_min, cutoff_hours, max_future_per_patient) VALUES ($1, $2, $3, $4, $5, 24, 5)`,
      [randomUUID(), ORG, SVC_IN, B1, 60 * 24 * 400],
    );
    try {
      assert.equal(
        (await search(d, day, { serviceId: SVC_IN, locationId: B1 }, 'patient')).slots.length,
        0,
      );
      assert.equal(
        (await search(d, day, { serviceId: SVC_IN, locationId: B1 }, 'staff')).slots.length,
        3,
      );
    } finally {
      await saWrite(
        t.k,
        `DELETE FROM organisation.booking_policy WHERE service_id = $1 AND location_id = $2`,
        [SVC_IN, B1],
      );
    }
  });
});

describe('leave versus booking, concurrently (TC-DR-02, 25.2): never both', () => {
  const gate = (): { wait: Promise<void>; open: () => void } => {
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    return { wait, open };
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  test('a hold that starts while a leave is being saved waits for it, then finds the leave: outside hours, no appointment', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(38);
    const [start, end] = await at(day, '09:00', '09:30');
    const p = await newPatient();
    const held = gate();
    const release = gate();
    const leave = t.as(t.staffScope(d.session, [A1]), async (tx) => {
      const r = await t.avail.createBlockedTime(tx, meta, d.principalId, {
        startsAt: start as string,
        endsAt: end as string,
        kind: 'leave',
      });
      held.open(); // the leave is written, not committed, and holds the doctor's lock
      await release.wait;
      return r;
    });
    await held.wait;
    const booking = hold(p, d, start as string);
    await sleep(400); // the hold has run up to the doctor's lock
    release.open();
    const [l, h] = await Promise.allSettled([leave, booking]);
    assert.equal(l.status, 'fulfilled');
    assert.equal(h.status, 'rejected');
    assert.ok(
      (h as PromiseRejectedResult).reason instanceof OutsideHoursError,
      String((h as PromiseRejectedResult).reason),
    );
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1`,
            [d.principalId],
          )
        ).n,
      ),
      0,
    );
  });

  test('a leave that starts while a hold is being booked waits for it, then counts it: 409 and nothing saved', async () => {
    const d = await doctorWithTemplate();
    const day = await t.futureDate(39);
    const [start, end] = await at(day, '09:00', '09:30');
    const p = await newPatient();
    const held = gate();
    const release = gate();
    const booking = t.as(p.scope, async (tx) => {
      const h = await t.core.hold(tx, meta, {
        patientId: p.patientId,
        serviceId: SVC,
        locationId: A1,
        clinicianId: d.principalId,
        startsAt: start as string,
        mode: 'in_person',
      });
      held.open(); // the hold is written, not committed
      await release.wait;
      return h;
    });
    await held.wait;
    const leave = t.as(t.staffScope(d.session, [A1]), (tx) =>
      t.avail.createBlockedTime(tx, meta, d.principalId, {
        startsAt: start as string,
        endsAt: end as string,
        kind: 'leave',
      }),
    );
    await sleep(400);
    release.open();
    const [h, l] = await Promise.allSettled([booking, leave]);
    assert.equal(h.status, 'fulfilled');
    assert.equal(l.status, 'rejected');
    assert.ok(
      (l as PromiseRejectedResult).reason instanceof ConflictsWithAppointmentsError,
      String((l as PromiseRejectedResult).reason),
    );
    assert.equal(
      Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.blocked_time WHERE clinician_principal_id = $1`,
            [d.principalId],
          )
        ).n,
      ),
      0,
    );
  });

  test('20 rounds of a hold racing a leave over the same slot: either the leave is refused with the appointment counted, or the hold is refused as outside hours', async () => {
    const d = await doctorWithTemplate();
    const dayN = 40;
    const patients = await Promise.all(Array.from({ length: 20 }, () => newPatient()));
    const outcomes = { holdWon: 0, leaveWon: 0 };
    for (let i = 0; i < 20; i++) {
      const day = await t.futureDate(dayN + i);
      const [start] = await at(day, '09:00');
      const [end] = await at(day, '09:30');
      // One side is started late, by a different delay in each round, so both orders of arrival happen: even rounds delay the leave
      // (0-119 ms), odd rounds delay the hold (0-59 ms; the hold's own preparation takes about as long).
      const delay = (i * 7) % 120;
      const [hr, lv] = await Promise.allSettled([
        new Promise((r) => setTimeout(r, i % 2 === 1 ? delay / 2 : 0)).then(() =>
          hold(patients[i] as P, d, start as string),
        ),
        new Promise((r) => setTimeout(r, i % 2 === 1 ? 0 : delay)).then(() =>
          t.as(t.staffScope(d.session, [A1]), (tx) =>
            t.avail.createBlockedTime(tx, meta, d.principalId, {
              startsAt: start as string,
              endsAt: end as string,
              kind: 'leave',
            }),
          ),
        ),
      ]);
      const active = Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND lower(period) = $2::timestamptz AND status IN ('held','confirmed')`,
            [d.principalId, start],
          )
        ).n,
      );
      const leaves = Number(
        (
          await one<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.blocked_time WHERE clinician_principal_id = $1 AND lower(period) = $2::timestamptz`,
            [d.principalId, start],
          )
        ).n,
      );
      assert.ok(
        !(active === 1 && leaves === 1),
        `round ${i}: an appointment and a leave over the same slot`,
      );
      if (hr.status === 'fulfilled') {
        outcomes.holdWon++;
        assert.equal(
          lv.status,
          'rejected',
          `round ${i}: the hold won, so the leave must have been refused`,
        );
        assert.ok(
          (lv as PromiseRejectedResult).reason instanceof ConflictsWithAppointmentsError,
          `round ${i}: refused as a conflict`,
        );
      } else {
        outcomes.leaveWon++;
        assert.ok(
          (hr as PromiseRejectedResult).reason instanceof OutsideHoursError,
          `round ${i}: the hold lost to the leave and says outside hours, got ${String((hr as PromiseRejectedResult).reason)}`,
        );
        assert.equal(lv.status, 'fulfilled', `round ${i}`);
      }
    }
    assert.equal(outcomes.holdWon + outcomes.leaveWon, 20);
    assert.ok(
      outcomes.holdWon > 0 && outcomes.leaveWon > 0,
      `both orders of arrival must be exercised: ${JSON.stringify(outcomes)}`,
    );
    console.log(`# leave/hold race: hold won ${outcomes.holdWon}, leave won ${outcomes.leaveWon}`);
  });
});

describe('search latency on a synthetic volume set (NFR-8: informational only, not a measurement of the ci volume set)', () => {
  test('40 doctors, 7 rules each, 14-day range, with bookings and busy blocks: timings are printed, not asserted', async () => {
    const doctors: Doctor[] = [];
    for (let i = 0; i < 40; i++)
      doctors.push(
        await doctorWithTemplate({
          rules: [
            ...weekRules({ startLocal: '08:00', endLocal: '12:00' }),
            ...weekRules({ startLocal: '13:00', endLocal: '17:00' }),
          ],
        }),
      );
    const from = await t.futureDate(60);
    const to = await t.futureDate(74);
    await saWrite(
      t.k,
      `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at)
       SELECT $1, d, tstzrange(s, s + interval '1 hour', '[)'), 'google', decode(md5(d::text || s::text), 'hex'), now()
         FROM unnest($2::uuid[]) d, generate_series(($3::date + time '10:00') AT TIME ZONE 'America/New_York', ($4::date + time '10:00') AT TIME ZONE 'America/New_York', interval '1 day') s`,
      [ORG, doctors.map((d) => d.principalId), from, to],
    );
    const scope = (await t.patient(++seq)).scope;
    const samples: number[] = [];
    let last: SearchResult | undefined;
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      const r = await t.as(scope, (tx) =>
        t.search.search(tx, {
          serviceId: SVC,
          mode: 'in_person',
          from: new Date(Date.parse(`${from}T05:00:00Z`)).toISOString(),
          to: new Date(Date.parse(`${to}T05:00:00Z`)).toISOString(),
        }),
      );
      samples.push(performance.now() - t0);
      last = r;
    }
    samples.sort((a, b) => a - b);
    const p = (x: number): number =>
      samples[Math.min(samples.length - 1, Math.floor(x * samples.length))] as number;
    console.log(
      `# search latency (informational): ${doctors.length} doctors, ${last?.slots.length ?? 0} slots returned (cap 2000), n=${samples.length}, p50=${p(0.5).toFixed(0)} ms, p95=${p(0.95).toFixed(0)} ms, max=${samples[samples.length - 1]?.toFixed(0)} ms`,
    );
    assert.ok((last?.slots.length ?? 0) > 0);
  });
});
