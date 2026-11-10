// Real-database tests for the overbook cap (QA-EXEC-F11; decision HEAAA-632 D-F11-T1 option A; product ruling D-F11-1): the cap is the
// total number of active bookings in one slot, the first included. Everything here goes through the REAL availability resolver, the
// real booking core and the real database functions; nothing is stubbed. TC-BK-15 (T1), the cap variants and the two-slot case (T2),
// cap changes (T3), rooms (T8) and the other readers of an overbook row (T9 a, b).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/availability/overbook.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { A1, ORG, ROOM1, SVC, call, saWrite, setupAvailability, writeHeaders } from './testkit.js';
import type { AvailKit, Doctor } from './testkit.js';
import { nearbyFreeStarts } from '../core/index.js';
import type { HoldInput } from '../core/index.js';
import { OverlappingAppointmentError, SlotTakenError } from '../core/errors.js';

let t: AvailKit;
let admin: Awaited<ReturnType<AvailKit['adminScope']>>;
let desk: ReturnType<AvailKit['staffScope']>;
before(async () => {
  t = await setupAvailability('ob');
  admin = await t.adminScope();
  desk = t.staffScope(t.deskA1, [A1]);
});
after(async () => {
  await t?.close();
});

const meta = {
  get requestId(): string {
    return randomUUID();
  },
};
type P = Awaited<ReturnType<AvailKit['patient']>>;
let seq = 30000;
/** A patient account with a care relationship at A1, so the front desk (staff scope) can see their reservation. */
async function newPatient(): Promise<P> {
  const p = await t.patient(++seq);
  await saWrite(
    t.k,
    `INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason) VALUES ($1, $2, $3, $4, 'registration')`,
    [randomUUID(), ORG, p.patientId, A1],
  );
  await saWrite(
    t.k,
    `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [p.patientId, A1, ORG],
  );
  return p;
}
const rules = (over: Record<string, unknown> = {}): Record<string, unknown>[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startLocal: '09:00',
    endLocal: '12:00',
    mode: 'either',
    ...over,
  }));
async function doctor(over: Record<string, unknown> = {}): Promise<Doctor> {
  const d = await t.doctor();
  await t.as(admin, (tx) =>
    t.avail.createTemplate(tx, meta, d.principalId, {
      locationId: A1,
      validFrom: '2026-01-01',
      validTo: null,
      rules: rules(over),
    } as never),
  );
  return d;
}
/** The stored cap for SVC at A1 (the policy every booking of these tests resolves). `null` removes the row (cap 0). */
async function setCap(cap: number | null): Promise<void> {
  await saWrite(
    t.k,
    `DELETE FROM organisation.booking_policy WHERE service_id = $1 AND location_id = $2`,
    [SVC, A1],
  );
  if (cap !== null)
    await saWrite(
      t.k,
      `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, cutoff_hours, max_future_per_patient, overbook_cap_per_session) VALUES ($1, $2, $3, $4, 24, 50, $5)`,
      [randomUUID(), ORG, SVC, A1, cap],
    );
}
const at = async (date: string, ...times: string[]): Promise<string[]> =>
  Promise.all(times.map(async (x) => (await t.localInstant(date, x)).toISOString()));
const input = (p: P, d: Doctor, start: string, over: Partial<HoldInput> = {}): HoldInput => ({
  patientId: p.patientId,
  serviceId: SVC,
  locationId: A1,
  clinicianId: d.principalId,
  startsAt: start,
  mode: 'in_person',
  ...over,
});
type Outcome = { ok: true; id: string } | { ok: false; err: unknown };
/** Hold then confirm; a refusal is returned, not thrown, so a race can be counted. */
async function book(
  p: P,
  d: Doctor,
  start: string,
  over: Partial<HoldInput> = {},
  scope = p.scope,
  confirm = true,
): Promise<Outcome> {
  try {
    const h = await t.as(scope, (tx) => t.core.hold(tx, meta, input(p, d, start, over)));
    // A desk hold is enough for the room tests: a held row occupies its doctor and room like a confirmed one.
    if (confirm) await t.as(scope, (tx) => t.core.confirm(tx, meta, h.reservationId));
    return { ok: true, id: h.reservationId };
  } catch (err) {
    return { ok: false, err };
  }
}
const wins = (o: Outcome[]): number => o.filter((x) => x.ok).length;
const allTaken = (o: Outcome[]): void => {
  for (const l of o.filter((x): x is { ok: false; err: unknown } => !x.ok))
    assert.ok(l.err instanceof SlotTakenError, String(l.err));
};
const active = async (d: Doctor, start: string): Promise<number> =>
  Number(
    (
      await t.k.q<{ n: string }>(
        `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1
          AND period && tstzrange($2::timestamptz, $2::timestamptz + interval '30 minutes', '[)')
          AND status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed')`,
        [d.principalId, start],
      )
    )[0]?.n,
  );
const patients = (n: number): Promise<P[]> => Promise.all(Array.from({ length: n }, newPatient));
const race = async (d: Doctor, start: string, n: number): Promise<Outcome[]> => {
  const ps = await patients(n);
  return Promise.all(ps.map((p) => book(p, d, start)));
};
const rejectsCode = (p: Promise<unknown>, code: string, what: string): Promise<void> =>
  assert.rejects(p, (e: unknown) => {
    assert.equal((e as { code?: string }).code, code, what);
    return true;
  });

describe('the overbook cap is the total in the slot (HEAAA-632 T1, T2)', () => {
  test('TC-BK-15 (SA-F-10), real resolver: cap 2 under 100 parallel bookings: exactly 2 succeed, 98 are SlotTakenError, exactly 2 active rows overlap the slot', async () => {
    const d = await doctor({ overbookable: true });
    await setCap(2);
    const [nine] = await at(await t.futureDate(60), '09:00');
    const out = await race(d, nine as string, 100);
    assert.equal(wins(out), 2, 'the cap, not 1 + cap');
    assert.equal(out.length - wins(out), 98);
    allTaken(out);
    assert.equal(await active(d, nine as string), 2);
  });

  test('cap 1 gives exactly 1; cap 3 gives exactly 3; cap 0 on an overbookable rule gives exactly 1', async () => {
    for (const [cap, expected] of [
      [1, 1],
      [3, 3],
      [0, 1],
    ] as const) {
      const d = await doctor({ overbookable: true });
      await setCap(cap);
      const [nine] = await at(await t.futureDate(61), '09:00');
      const out = await race(d, nine as string, 8);
      assert.equal(wins(out), expected, `cap ${cap}`);
      allTaken(out);
      assert.equal(await active(d, nine as string), expected, `cap ${cap}: rows`);
    }
  });

  test('two slots of one session with cap 2 give exactly 2 + 2, not a shared pool', async () => {
    const d = await doctor({ overbookable: true });
    await setCap(2);
    const [nine, half] = await at(await t.futureDate(62), '09:00', '09:30');
    const [a, b] = await Promise.all([race(d, nine as string, 6), race(d, half as string, 6)]);
    assert.equal(wins(a), 2, 'first slot');
    assert.equal(wins(b), 2, 'second slot');
    allTaken(a);
    allTaken(b);
  });
});

describe('changing the cap (HEAAA-632 T3, R7)', () => {
  test('a normal booking, then the cap raised to 2, admits exactly one more', async () => {
    const d = await doctor({ overbookable: true });
    await setCap(null);
    const [nine] = await at(await t.futureDate(63), '09:00');
    const first = await book(await newPatient(), d, nine as string);
    assert.ok(first.ok, 'cap 0: one booking, a normal row');
    await setCap(2);
    const out = await race(d, nine as string, 5);
    assert.equal(wins(out), 1, 'only one more');
    allTaken(out);
    assert.equal(await active(d, nine as string), 2);
  });

  test('two active bookings, then the cap lowered to 1: both stay, a new attempt (overbook or normal) is refused with 23P01', async () => {
    const d = await doctor({ overbookable: true });
    await setCap(2);
    const [nine] = await at(await t.futureDate(64), '09:00');
    assert.equal(wins(await race(d, nine as string, 2)), 2);
    await setCap(1);
    assert.equal(await active(d, nine as string), 2, 'lowering the cap cancels nothing');
    const out = await race(d, nine as string, 3);
    assert.equal(wins(out), 0);
    allTaken(out);
    // the database alone refuses both kinds of row (the arguments cannot lift the stored cap)
    const sql = (overbook: boolean): string =>
      `SELECT scheduling.occupy($1::uuid, $2::uuid, $3::uuid, NULL, tstzrange($4::timestamptz, $4::timestamptz + interval '30 minutes', '[)'), 600, ${overbook}, ${overbook ? "'k'" : 'NULL'}, 100)`;
    for (const overbook of [true, false]) {
      const p = await newPatient();
      await rejectsCode(
        t.as(p.scope, (tx) =>
          tx.query(sql(overbook), [randomUUID(), A1, d.principalId, nine as string]),
        ),
        '23P01',
        `overbook=${overbook}`,
      );
    }
    assert.equal(await active(d, nine as string), 2);
  });
});

describe('rooms (HEAAA-632 T8, R3, F11-T-R1-01)', () => {
  const room = (over: Partial<HoldInput> = {}): Partial<HoldInput> => ({ roomId: ROOM1, ...over });
  const staffBook = async (d: Doctor, start: string): Promise<Outcome> =>
    book(await newPatient(), d, start, room(), desk, false);

  test('(a) an overbook booking holds its room: another doctor in the same room at the same time is refused and the search does not offer it; (d) the same doctor fills the room up to the cap', async () => {
    const a = await doctor({ overbookable: true, roomId: ROOM1 });
    const b = await doctor({ roomId: ROOM1 });
    await setCap(2);
    const day = await t.futureDate(65);
    const [nine, half] = await at(day, '09:00', '09:30');
    {
      const r0 = await staffBook(a, nine as string);
      assert.ok(r0.ok, String((r0 as { err?: unknown }).err));
    }
    const r = await staffBook(b, nine as string);
    assert.ok(!r.ok && r.err instanceof SlotTakenError, 'B in the same room is refused');
    // staff search for B (rule bound to the room): the slot is not offered, the next one is
    const r2 = await call(t.k.base, 'POST', '/api/v1/availability/search', {
      cookie: t.deskA1.cookie,
      headers: writeHeaders(t.deskA1),
      body: {
        serviceId: SVC,
        mode: 'in_person',
        clinicianId: b.principalId,
        from: (await t.localInstant(day, '00:00')).toISOString(),
        to: (await t.localInstant(day, '23:59')).toISOString(),
      },
    });
    assert.equal(r2.status, 200, r2.body);
    const res = r2.json() as unknown as { slots: { startsAt: string }[] };
    const offered = res.slots.map((s) => s.startsAt);
    assert.ok(!offered.includes(nine as string), 'the room is taken: not offered to B');
    assert.ok(offered.includes(half as string), 'the next slot is');
    // (d) A's second booking in the room is admitted, the third is refused (cap 2)
    assert.ok((await staffBook(a, nine as string)).ok, 'A, second booking');
    const third = await staffBook(a, nine as string);
    assert.ok(!third.ok && third.err instanceof SlotTakenError, 'cap reached');
  });

  test('(b) the reverse: B books the room first, then A is refused', async () => {
    const a = await doctor({ overbookable: true, roomId: ROOM1 });
    const b = await doctor({ roomId: ROOM1 });
    await setCap(2);
    const [nine] = await at(await t.futureDate(66), '09:00');
    assert.ok((await staffBook(b, nine as string)).ok);
    const r = await staffBook(a, nine as string);
    assert.ok(!r.ok && r.err instanceof SlotTakenError);
  });

  test('(c) the two orders raced in parallel: exactly one doctor holds the room', async () => {
    const a = await doctor({ overbookable: true, roomId: ROOM1 });
    const b = await doctor({ roomId: ROOM1 });
    await setCap(2);
    for (let i = 0; i < 5; i++) {
      const [slot] = await at(await t.futureDate(67 + i), '09:00');
      const out = await Promise.all([
        staffBook(a, slot as string),
        staffBook(b, slot as string),
        staffBook(a, slot as string),
        staffBook(b, slot as string),
      ]);
      const rows = await t.k.q<{ c: string }>(
        `SELECT DISTINCT clinician_principal_id AS c FROM scheduling.slot_occupancy
          WHERE room_id = $1 AND period && tstzrange($2::timestamptz, $2::timestamptz + interval '30 minutes', '[)')
            AND status IN ('held', 'confirmed')`,
        [ROOM1, slot],
      );
      assert.equal(rows.length, 1, `round ${i}: one doctor in the room`);
      assert.ok(wins(out) >= 1 && wins(out) <= 2, `round ${i}`);
      allTaken(out);
    }
  });

  test('(e) the guard trigger alone refuses an overbook row of a different clinician in a taken room', async () => {
    const a = await doctor({ overbookable: true, roomId: ROOM1 });
    const b = await doctor({ roomId: ROOM1 });
    await setCap(2);
    const [nine] = await at(await t.futureDate(73), '09:00');
    assert.ok((await staffBook(a, nine as string)).ok);
    await rejectsCode(
      t.k.sa.query(
        `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, room_id, period, status, expires_at, overbook, session_key)
         VALUES ($1, $2, $3, $4, $5, tstzrange($6::timestamptz, $6::timestamptz + interval '30 minutes', '[)'), 'held', now() + interval '5 minutes', true, 'x')`,
        [randomUUID(), ORG, A1, b.principalId, ROOM1, nine],
      ),
      '23P01',
      "overbook row of B in A's room",
    );
  });
});

describe('the other readers of an overbook row (HEAAA-632 T9 a, b)', () => {
  test('(a) TC-BK-13 variant: a patient who already holds a place in a slot that still has room gets OverlappingAppointment; once the slot is full, SlotTaken', async () => {
    const d = await doctor({ overbookable: true });
    await setCap(2);
    const [nine] = await at(await t.futureDate(74), '09:00');
    const x = await newPatient();
    const y = await newPatient();
    assert.ok((await book(x, d, nine as string)).ok);
    const again = await book(x, d, nine as string);
    assert.ok(!again.ok && again.err instanceof OverlappingAppointmentError, 'room left: overlap');
    assert.ok((await book(y, d, nine as string)).ok, 'the slot is now full (2 of 2)');
    const full = await book(x, d, nine as string);
    assert.ok(!full.ok && full.err instanceof SlotTakenError, 'full: taken, with alternatives');
  });

  test('(b) nearbyFreeStarts does not return a slot that holds an overbook row', async () => {
    const d = await doctor({ overbookable: true });
    await setCap(2);
    const [nine, half, ten] = await at(await t.futureDate(75), '09:00', '09:30', '10:00');
    assert.ok((await book(await newPatient(), d, half as string)).ok);
    const free = await t.as(admin, (tx) =>
      nearbyFreeStarts(tx, {
        clinicianId: d.principalId,
        locationId: A1,
        serviceId: SVC,
        roomId: null,
        startsAt: new Date(nine as string),
        endsAt: new Date(new Date(nine as string).getTime() + 30 * 60_000),
        mode: 'in_person',
      }),
    );
    assert.ok(!free.includes(half as string), 'the booked slot is not offered');
    assert.ok(free.includes(ten as string), 'the next free one is');
  });
});
