// Real-database tests for BE-11, part 1: the booking core's state and rules on PostgreSQL 17 with the migrations of the real pipeline
// (0900-0903) and the real Nest application: exclusion constraints, stale-hold expiry, the deferred twin, terminal reservations,
// hold / confirm / cancel / reschedule, the cut-off and fee behaviour, BR-04, licensing, RLS, the HTTP routes (TC-BK-01, 04..09, 11, 18).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/core/booking.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  A1,
  adminUrl,
  B1,
  ORG,
  ROOM1,
  ROOM2,
  SVC,
  SVC2,
  call,
  patientAccount,
  pg,
  saWrite,
  setupScheduling,
  slotStart,
  writeHeaders,
} from './testkit.js';
import type { SchedKit } from './testkit.js';
import {
  CutoffPassedError,
  FeeAcceptanceRequiredError,
  HoldExpiredError,
  InvalidTransitionError,
  LeadTimeError,
  LicensingRefusedError,
  MaxFutureReachedError,
  OverlappingAppointmentError,
  PatientMergedError,
  ReservationNotFoundError,
  SchedulingValidationError,
  SlotTakenError,
} from './index.js';
import type { HoldInput } from './index.js';

let t: SchedKit;
before(async () => {
  t = await setupScheduling('bk');
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

let day = 10;
/** A fresh day for each test, so tests do not share a doctor's diary or a patient's BR-04 count. */
const nextDay = (): number => ++day;

const holdInput = (
  patientId: string,
  clinicianId: string,
  start: Date,
  over: Partial<HoldInput> = {},
): HoldInput => ({
  patientId,
  serviceId: SVC,
  locationId: A1,
  clinicianId,
  startsAt: start.toISOString(),
  mode: 'in_person',
  ...over,
});

/** A patient, their scope, and a doctor: the usual cast. */
async function cast(
  n: number,
): Promise<{ pid: string; scope: Awaited<ReturnType<SchedKit['patientScope']>>; doc: string }> {
  const pid = await t.bare(n);
  return { pid, scope: await t.patientScope(pid), doc: (await t.doctor()).principalId };
}
const status = async (id: string): Promise<string> =>
  (
    await one<{ status: string }>(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [
      id,
    ])
  ).status;

/** The next half hour that is at least `hours` away, as a Date. */
const inHours = (hours: number): Date => {
  const d = new Date(Date.now() + hours * 3_600_000);
  d.setUTCMinutes(d.getUTCMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
};

describe('constraints in the database (22.8, SBR-01)', () => {
  const ownerTx = async <T>(
    fn: (
      c: Awaited<ReturnType<SchedKit['k']['sa']['query']>> extends never ? never : typeof t.k.sa,
    ) => Promise<T>,
  ): Promise<T> => {
    // NOLOGIN: the superuser session assumes the role, which is what a definer function runs as.
    const c = new pg.Client({ connectionString: t.k.urlFor(new URL(adminUrl as string).username) });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL ROLE scheduling_booking_owner`);
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
        [ORG],
      );
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  };
  const ins = (
    c: typeof t.k.sa,
    doc: string,
    room: string | null,
    start: Date,
    minutes: number,
    extra = { overbook: false, key: null as string | null },
  ) =>
    c.query(
      `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, room_id, period, status, expires_at, overbook, session_key)
       VALUES ($1, $2, $3, $4, $5, tstzrange($6::timestamptz, $6::timestamptz + make_interval(mins => $7), '[)'), 'held', now() + interval '10 minutes', $8, $9)`,
      [randomUUID(), ORG, A1, doc, room, start.toISOString(), minutes, extra.overbook, extra.key],
    );

  test('two active rows for one doctor with overlapping times are refused (23P01); back-to-back and other doctors are fine', async () => {
    const a = (await t.doctor()).principalId;
    const b = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    await ownerTx(async (c) => {
      await ins(c, a, null, s, 30);
      await rejectsSql(
        ins(c, a, null, new Date(s.getTime() + 15 * 60_000), 30),
        '23P01',
        'overlap',
      );
    });
    await ownerTx(async (c) => {
      await ins(c, a, null, s, 30);
      await ins(c, a, null, new Date(s.getTime() + 30 * 60_000), 30); // [) bounds: back to back
      await ins(c, b, null, s, 30);
    });
  });

  test('the same for a room: another doctor in the same room and time is refused; a video visit (no room) is not', async () => {
    const a = (await t.doctor()).principalId;
    const b = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    await ownerTx(async (c) => {
      await ins(c, a, ROOM1, s, 30);
      await rejectsSql(ins(c, b, ROOM1, s, 30), '23P01', 'room overlap');
    });
    await ownerTx(async (c) => {
      await ins(c, a, ROOM1, s, 30);
      await ins(c, b, ROOM2, s, 30);
      await ins(c, b, null, new Date(s.getTime() + 60 * 60_000), 5); // no room: only the doctor constraint applies
    });
  });

  test('overbook rows are excluded from the constraints', async () => {
    const a = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    // SEC-03 F03: an overbook row needs a stored policy that allows overbooking (cap 2 here).
    await t.k.sa.query(
      `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, cutoff_hours, max_future_per_patient, overbook_cap_per_session)
       VALUES ($1, $2, $3, $4, 24, 3, 2) ON CONFLICT DO NOTHING`,
      [randomUUID(), ORG, SVC, A1],
    );
    await ownerTx(async (c) => {
      await ins(c, a, null, s, 30, { overbook: true, key: 'S' });
      await ins(c, a, null, s, 30, { overbook: true, key: 'S' });
    });
  });

  test('period shape and hold expiry shape are checks', async () => {
    const a = (await t.doctor()).principalId;
    await ownerTx(async (c) => {
      await rejectsSql(
        c.query(
          `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, period, status, expires_at)
           VALUES ($1, $2, $3, $4, tstzrange(now(), now() + interval '1 hour', '(]'), 'held', now())`,
          [randomUUID(), ORG, A1, a],
        ),
        '23514',
        'bounds',
      );
    });
    await ownerTx(async (c) => {
      await rejectsSql(
        c.query(
          `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, period, status)
           VALUES ($1, $2, $3, $4, tstzrange(now(), now() + interval '1 hour', '[)'), 'held')`,
          [randomUUID(), ORG, A1, a],
        ),
        '23514',
        'held without expiry',
      );
    });
  });

  test('the deferred twin: an occupancy row without its reservation fails at commit; so does a reservation without occupancy', async () => {
    const a = (await t.doctor()).principalId;
    const c = new pg.Client({ connectionString: t.k.urlFor(new URL(adminUrl as string).username) });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE scheduling_booking_owner`);
    await c.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
      [ORG],
    );
    await ins(c, a, null, slotStart(nextDay()), 30);
    await rejectsSql(c.query('COMMIT'), '23503', 'orphan occupancy');
    await c.end();

    const { pid, scope } = await cast(900);
    await rejectsSql(
      t.as(scope, async (tx) => {
        await tx.query(
          `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, booked_by_principal_id, booked_via, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'in_person', $7, 'patient', $7)`,
          [randomUUID(), ORG, pid, SVC, A1, a, scope.principalId],
        );
      }),
      '23503',
      'orphan reservation',
    );
  });

  test('a reservation cannot point at an occupancy row of another doctor (the twin must agree)', async () => {
    const { pid, scope, doc } = await cast(901);
    const other = (await t.doctor()).principalId;
    const id = randomUUID();
    await rejectsSql(
      t.as(scope, async (tx) => {
        await tx.query(
          `SELECT scheduling.occupy($1::uuid, $2::uuid, $3::uuid, NULL, $4::tstzrange, 600, false, NULL, 0)`,
          [
            id,
            A1,
            doc,
            `[${slotStart(nextDay()).toISOString()},${slotStart(day, 1).toISOString()})`,
          ],
        );
        await tx.query(
          `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, booked_by_principal_id, booked_via, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'in_person', $7, 'patient', $7)`,
          [id, ORG, pid, SVC, A1, other, scope.principalId],
        );
      }),
      'PS001',
      'twin disagreement',
    );
  });

  test('an application role cannot write the occupancy table; only the two definer functions can', async () => {
    const { scope } = await cast(902);
    await rejectsSql(
      t.as(scope, (tx) => tx.query(`UPDATE scheduling.slot_occupancy SET status = 'confirmed'`)),
      '42501',
      'app_api update',
    );
    await rejectsSql(
      t.as(scope, (tx) => tx.query(`DELETE FROM scheduling.slot_occupancy`)),
      '42501',
      'app_api delete',
    );
  });
});

describe('hold, confirm, release (25.1, 23.1; TC-BK-01, 04, 08)', () => {
  test('hold -> confirm: held with an expiry, then confirmed with none; audit rows exist; a care relationship is created (TC-BK-01)', async () => {
    const { pid, scope, doc } = await cast(1);
    const h = await t.as(scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()))),
    );
    assert.ok(Date.parse(h.expiresAt) > Date.now());
    assert.equal(await status(h.reservationId), 'held');
    const a = await t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId));
    assert.equal(a.status, 'confirmed');
    assert.equal(a.expiresAt, null);
    assert.equal(a.bookedVia, 'patient');
    assert.equal(
      (
        await one<{ n: string }>(
          `SELECT count(*) AS n FROM audit.event WHERE resource_id = $1 AND action IN ('create', 'update')`,
          [h.reservationId],
        )
      ).n,
      '2',
    );
    assert.equal(
      (
        await one<{ n: string }>(
          `SELECT count(*) AS n FROM patient.care_relationship WHERE patient_id = $1 AND location_id = $2 AND ended_at IS NULL`,
          [pid, A1],
        )
      ).n,
      '1',
    );
  });

  test('confirm is idempotent by state for the booker; another principal gets 409', async () => {
    const { pid, scope, doc } = await cast(2);
    const h = await t.as(scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()))),
    );
    const a1 = await t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId));
    const a2 = await t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId));
    assert.equal(a2.status, 'confirmed');
    assert.equal(a2.version, a1.version, 'no second write');
    const other = await t.patientScope(pid); // another portal principal that reaches the same patient
    await rejects(
      t.as(other, (tx) => t.svc.confirm(tx, meta, h.reservationId)),
      InvalidTransitionError,
      'other principal',
    );
  });

  test('a confirm after the hold expired is 409 hold_expired with alternatives, and nothing is confirmed (TC-BK-08)', async () => {
    const { pid, scope, doc } = await cast(3);
    const s = slotStart(nextDay());
    const h = await t.as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, doc, s)));
    await t.age(h.reservationId);
    await assert.rejects(
      t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId)),
      (e: unknown) => {
        assert.ok(e instanceof HoldExpiredError);
        assert.ok(e.alternatives.length > 0 && e.alternatives.length <= 5);
        assert.ok(e.alternatives.every((x) => Date.parse(x) > s.getTime()));
        return true;
      },
    );
    assert.notEqual(await status(h.reservationId), 'confirmed');
  });

  test('a taken slot is 409 slot_taken with up to five alternatives from a fresh search (TC-BK-04)', async () => {
    const a = await cast(4);
    const b = await cast(5);
    const s = slotStart(nextDay());
    await t.as(a.scope, (tx) => t.svc.hold(tx, meta, holdInput(a.pid, a.doc, s)));
    await assert.rejects(
      t.as(b.scope, (tx) => t.svc.hold(tx, meta, holdInput(b.pid, a.doc, s))),
      (e: unknown) => {
        assert.ok(e instanceof SlotTakenError);
        assert.ok(e.alternatives.length >= 1 && e.alternatives.length <= 5);
        return true;
      },
    );
    // the refused hold left no row behind
    assert.equal(
      (
        await one<{ n: string }>(
          `SELECT count(*) AS n FROM scheduling.slot_reservation WHERE patient_id = $1`,
          [b.pid],
        )
      ).n,
      '0',
    );
  });

  test('a lapsed hold never causes a false "taken": the inserting transaction expires it first (doctor)', async () => {
    const a = await cast(6);
    const b = await cast(7);
    const s = slotStart(nextDay());
    const ha = await t.as(a.scope, (tx) => t.svc.hold(tx, meta, holdInput(a.pid, a.doc, s)));
    await t.age(ha.reservationId);
    const hb = await t.as(b.scope, (tx) => t.svc.hold(tx, meta, holdInput(b.pid, a.doc, s)));
    assert.equal(await status(ha.reservationId), 'expired');
    assert.equal(await status(hb.reservationId), 'held');
  });

  test('...and for a room (SAR-09): a live hold refuses a different doctor; a stale hold on the room is expired by the inserting transaction', async () => {
    const pa = await t.mkPatient(8);
    const pb = await t.mkPatient(9);
    const staff = await t.staffScope([A1]);
    const docA = (await t.doctor()).principalId;
    const docB = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    const ha = await t.as(staff, (tx) =>
      t.svc.hold(tx, meta, holdInput(pa, docA, s, { roomId: ROOM1 })),
    );
    await rejects(
      t.as(staff, (tx) => t.svc.hold(tx, meta, holdInput(pb, docB, s, { roomId: ROOM1 }))),
      SlotTakenError,
      'live room hold',
    );
    await t.age(ha.reservationId);
    const hb = await t.as(staff, (tx) =>
      t.svc.hold(tx, meta, holdInput(pb, docB, s, { roomId: ROOM1 })),
    );
    assert.equal(await status(ha.reservationId), 'expired');
    assert.equal(await status(hb.reservationId), 'held');
  });

  test('the holder can release a hold (held -> cancelled_patient), free of any cut-off', async () => {
    const { pid, scope, doc } = await cast(10);
    const h = await t.as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, doc, inHours(2))));
    const a = await t.as(scope, (tx) => t.svc.cancel(tx, meta, h.reservationId));
    assert.equal(a.status, 'cancelled_patient');
    assert.equal(a.lateChange, false);
  });

  test('the sweep frees lapsed holds (and only them); it is cleanup, not correctness', async () => {
    const { pid, scope, doc } = await cast(11);
    const h1 = await t.as(scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()))),
    );
    const h2 = await t.as(scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay(), 4))),
    );
    await t.age(h1.reservationId);
    const freed = await t.worker.withScope(t.workerScope, (tx) => t.svc.sweepExpired(tx));
    assert.ok(freed.includes(h1.reservationId));
    assert.ok(!freed.includes(h2.reservationId));
    assert.equal(await status(h1.reservationId), 'expired');
    assert.equal(await status(h2.reservationId), 'held');
    // a patient-scope or staff transaction cannot run the sweep
    await rejectsSql(
      t.as(scope, (tx) => t.svc.sweepExpired(tx)),
      '42501',
      'sweep as patient',
    );
  });

  test('validation: a bad body is 422 with field names; a past start is refused; a video visit needs the patient state', async () => {
    const { pid, scope, doc } = await cast(12);
    await rejects(
      t.as(scope, (tx) =>
        t.svc.hold(tx, meta, { ...holdInput(pid, doc, slotStart(nextDay())), serviceId: 'x' }),
      ),
      SchedulingValidationError,
      'bad service',
    );
    await rejects(
      t.as(scope, (tx) =>
        t.svc.hold(tx, meta, {
          ...holdInput(pid, doc, slotStart(nextDay())),
          startsAt: '2030-01-01T10:00:00',
        }),
      ),
      SchedulingValidationError,
      'no zone',
    );
    await rejects(
      t.as(scope, (tx) =>
        t.svc.hold(tx, meta, holdInput(pid, doc, new Date(Date.now() - 3_600_000))),
      ),
      LeadTimeError,
      'past',
    );
    await rejects(
      t.as(scope, (tx) =>
        t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()), { mode: 'video' })),
      ),
      SchedulingValidationError,
      'video without state',
    );
  });

  test('a patient cannot book for a patient outside their scope; a merged patient is 409 patient.merged', async () => {
    const mine = await cast(13);
    const theirs = await t.bare(14);
    // the scope names only `mine`: the database (lock_patients / WITH CHECK) refuses the other patient; the answer is not found, not forbidden
    await rejects(
      t.as(mine.scope, (tx) =>
        t.svc.hold(tx, meta, holdInput(theirs, mine.doc, slotStart(nextDay()))),
      ),
      ReservationNotFoundError,
      'other patient',
    );
    // a merged patient: the guard refuses the write (PM001)
    const s = await t.bare(15);
    const d = await t.bare(16);
    await t.k.sa.query(`SET session_replication_role = replica`);
    await t.k.sa.query(
      `UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`,
      [d, s],
    );
    await t.k.sa.query(`SET session_replication_role = DEFAULT`);
    const scope = await t.patientScope(d);
    await rejects(
      t.as(scope, (tx) => t.svc.hold(tx, meta, holdInput(d, mine.doc, slotStart(nextDay())))),
      PatientMergedError,
      'merged',
    );
  });
});

describe('BR-04, overlap, licensing (25.1 steps 3-4)', () => {
  test('at most max_future_per_patient (3) future appointments per service; the fourth is 422 (TC-BK-07)', async () => {
    const { pid, scope, doc } = await cast(20);
    for (let i = 0; i < 3; i++) {
      const h = await t.as(scope, (tx) =>
        t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()))),
      );
      await t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId));
    }
    await rejects(
      t.as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay())))),
      MaxFutureReachedError,
      'fourth',
    );
    // another service has its own count
    await t.as(scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()), { serviceId: SVC2 })),
    );
  });

  test('a patient cannot hold two overlapping times, whatever the service or doctor (BQ-9)', async () => {
    const { pid, scope, doc } = await cast(21);
    const doc2 = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    await t.as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, doc, s)));
    await rejects(
      t.as(scope, (tx) =>
        t.svc.hold(
          tx,
          meta,
          holdInput(pid, doc2, new Date(s.getTime() + 15 * 60_000), { serviceId: SVC2 }),
        ),
      ),
      OverlappingAppointmentError,
      'overlap',
    );
    // an adjacent time is fine
    await t.as(scope, (tx) =>
      t.svc.hold(
        tx,
        meta,
        holdInput(pid, doc2, new Date(s.getTime() + 30 * 60_000), { serviceId: SVC2 }),
      ),
    );
  });

  test('a lapsed hold of the same patient does not block a new hold (it is stale, not active)', async () => {
    const { pid, scope, doc } = await cast(22);
    const doc2 = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    const h = await t.as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, doc, s)));
    await t.age(h.reservationId);
    await t.as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, doc2, s, { serviceId: SVC2 })));
  });

  test('video: the patient state must be an operating state and the clinician licensed there (TL-1); flag mode lets it through flagged', async () => {
    const { pid, scope, doc } = await cast(23);
    await rejects(
      t.as(scope, (tx) =>
        t.svc.hold(
          tx,
          meta,
          holdInput(pid, doc, slotStart(nextDay()), { mode: 'video', patientState: 'NJ' }),
        ),
      ),
      LicensingRefusedError,
      'not operating',
    );
    await rejects(
      t.as(scope, (tx) =>
        t.svc.hold(
          tx,
          meta,
          holdInput(pid, doc, slotStart(nextDay()), { mode: 'video', patientState: 'NY' }),
        ),
      ),
      LicensingRefusedError,
      'not licensed',
    );
    await t.k.sa.query(
      `INSERT INTO identity.licensed_state (principal_id, jurisdiction_code, organisation_id) VALUES ($1, 'NY', $2)`,
      [doc, ORG],
    );
    const h = await t.as(scope, (tx) =>
      t.svc.hold(
        tx,
        meta,
        holdInput(pid, doc, slotStart(nextDay()), { mode: 'video', patientState: 'NY' }),
      ),
    );
    assert.equal(
      (
        await one<{ licensing_result: string; patient_stated_state: string }>(
          `SELECT licensing_result, patient_stated_state FROM scheduling.slot_reservation WHERE id = $1`,
          [h.reservationId],
        )
      ).licensing_result,
      'allowed',
    );
    await t.k.sa.query(
      `UPDATE kernel.setting SET value = '"flag"' WHERE key = 'telehealth_licensing_mode'`,
    );
    const doc2 = (await t.doctor()).principalId;
    const h2 = await t.as(scope, (tx) =>
      t.svc.hold(
        tx,
        meta,
        holdInput(pid, doc2, slotStart(nextDay()), { mode: 'video', patientState: 'NY' }),
      ),
    );
    assert.equal(
      (
        await one<{ licensing_result: string }>(
          `SELECT licensing_result FROM scheduling.slot_reservation WHERE id = $1`,
          [h2.reservationId],
        )
      ).licensing_result,
      'flagged',
    );
    await t.k.sa.query(
      `UPDATE kernel.setting SET value = '"refuse"' WHERE key = 'telehealth_licensing_mode'`,
    );
  });
});

describe('cancel and reschedule (25.1, 23.1; TC-BK-05, 06; 38.2 item 2)', () => {
  const confirmed = async (n: number, start: Date, over: Partial<HoldInput> = {}) => {
    const c = await cast(n);
    const h = await t.as(c.scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(c.pid, c.doc, start, over)),
    );
    await t.as(c.scope, (tx) => t.svc.confirm(tx, meta, h.reservationId));
    return { ...c, id: h.reservationId };
  };

  test('a cancel before the cut-off commits cancel_reason and late_change=false (patient), and the slot is free again', async () => {
    const c = await confirmed(30, inHours(40));
    const a = await t.as(c.scope, (tx) =>
      t.svc.cancel(tx, meta, c.id, { reason: 'Cannot make it' }),
    );
    assert.equal(a.status, 'cancelled_patient');
    assert.equal(a.cancelReason, 'Cannot make it');
    assert.equal(a.lateChange, false);
    const other = await cast(31);
    await t.as(other.scope, (tx) => t.svc.hold(tx, meta, holdInput(other.pid, c.doc, inHours(40))));
  });

  test('a patient cancel inside the cut-off is 422 cutoff_passed (D-3 default: block), nothing changes, nothing is charged (TC-BK-05)', async () => {
    const c = await confirmed(32, inHours(10));
    const before = await one<{ row_version: string }>(
      `SELECT row_version FROM scheduling.slot_reservation WHERE id = $1`,
      [c.id],
    );
    await rejects(
      t.as(c.scope, (tx) => t.svc.cancel(tx, meta, c.id, { reason: 'Late' })),
      CutoffPassedError,
      'late patient cancel',
    );
    assert.equal(await status(c.id), 'confirmed');
    assert.equal(
      (
        await one<{ row_version: string }>(
          `SELECT row_version FROM scheduling.slot_reservation WHERE id = $1`,
          [c.id],
        )
      ).row_version,
      before.row_version,
    );
  });

  test('a clinic cancel inside the cut-off needs a reason, is never blocked, and stores late_change=true with cancelled_clinic', async () => {
    const c = await confirmed(33, inHours(10));
    const staff = await t.staffScope([A1]);
    await rejects(
      t.as(staff, (tx) => t.svc.cancel(tx, meta, c.id)),
      SchedulingValidationError,
      'staff cancel needs a reason',
    );
    // the staff member must see the patient: the booking created the care relationship at A1
    const a = await t.as(staff, (tx) => t.svc.cancel(tx, meta, c.id, { reason: 'Doctor unwell' }));
    assert.equal(a.status, 'cancelled_clinic');
    assert.equal(a.cancelReason, 'Doctor unwell');
    assert.equal(a.lateChange, true);
  });

  test('late_change = fee: refused without acceptFee, accepted with it (stored, never charged)', async () => {
    await t.k.sa.query(
      `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, cutoff_hours, late_change, max_future_per_patient)
       VALUES ($1, $2, $3, NULL, 24, 'fee', 3)`,
      [randomUUID(), ORG, SVC2],
    );
    const c = await confirmed(34, inHours(10), { serviceId: SVC2 });
    await rejects(
      t.as(c.scope, (tx) => t.svc.cancel(tx, meta, c.id)),
      FeeAcceptanceRequiredError,
      'fee not accepted',
    );
    const a = await t.as(c.scope, (tx) => t.svc.cancel(tx, meta, c.id, { acceptFee: true }));
    assert.equal(a.status, 'cancelled_patient');
    assert.equal(a.lateChange, true);
    const audit = await one<{ change: { feeAccepted: boolean } }>(
      `SELECT change FROM audit.event WHERE resource_id = $1 AND action = 'update' ORDER BY occurred_at DESC LIMIT 1`,
      [c.id],
    );
    assert.equal(audit.change.feeAccepted, true);
  });

  test('If-Match: a stale version is 412', async () => {
    const c = await confirmed(35, inHours(48));
    await rejects(
      t.as(c.scope, (tx) => t.svc.cancel(tx, meta, c.id, { expectedVersion: 1 })),
      (await import('./index.js')).PreconditionFailedError,
      'stale',
    );
  });

  test('after cancelled_* or no_show a reservation update is refused for every role, including the owner of the data and the superuser (N-2)', async () => {
    const c = await confirmed(36, inHours(50));
    await t.as(c.scope, (tx) => t.svc.cancel(tx, meta, c.id, { reason: 'x' }));
    await rejectsSql(
      t.as(c.scope, (tx) =>
        tx.query(`UPDATE scheduling.slot_reservation SET cancel_reason = 'y' WHERE id = $1`, [
          c.id,
        ]),
      ),
      'PS001',
      'app_api after cancel',
    );
    await rejectsSql(
      saWrite(t.k, `UPDATE scheduling.slot_reservation SET reason = 'z' WHERE id = $1`, [c.id]),
      'PS001',
      'superuser after cancel',
    );
    // no_show: staff set it on the occupancy; the reservation is then K
    const d = await confirmed(37, inHours(51));
    const staff = await t.staffScope([A1]);
    await t.as(staff, (tx) =>
      tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'no_show')`, [d.id]),
    );
    await rejectsSql(
      saWrite(t.k, `UPDATE scheduling.slot_reservation SET reason = 'z' WHERE id = $1`, [d.id]),
      'PS001',
      'after no_show',
    );
    // a cancelled appointment cannot be cancelled again or confirmed
    await rejects(
      t.as(c.scope, (tx) => t.svc.cancel(tx, meta, c.id)),
      InvalidTransitionError,
      'cancel twice',
    );
  });

  test('occupancy transitions outside the table of 23.1 are refused, and each audience has its own subset', async () => {
    const c = await confirmed(38, inHours(52));
    await rejectsSql(
      t.as(c.scope, (tx) =>
        tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'completed')`, [c.id]),
      ),
      'PS001',
      'skip states',
    );
    await rejectsSql(
      t.as(c.scope, (tx) =>
        tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'no_show')`, [c.id]),
      ),
      'PS001',
      'patient cannot no-show',
    );
    await rejectsSql(
      t.as(c.scope, (tx) =>
        tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'cancelled_clinic')`, [c.id]),
      ),
      'PS001',
      'patient cannot cancel as clinic',
    );
    await rejectsSql(
      t.k.sa.query(
        `UPDATE scheduling.slot_occupancy SET status = 'held', expires_at = now() WHERE id = $1`,
        [c.id],
      ),
      'PS001',
      'backwards',
    );
    await rejectsSql(
      t.k.sa.query(
        `UPDATE scheduling.slot_occupancy SET period = tstzrange(now(), now() + interval '1 hour') WHERE id = $1`,
        [c.id],
      ),
      'PS001',
      'move the slot',
    );
  });

  test('reschedule: the new hold is confirmed, the old one is rescheduled, and the link is stored, in one transaction (TC-BK-06)', async () => {
    const c = await confirmed(40, inHours(60));
    const oldVersion = (
      await one<{ row_version: string }>(
        `SELECT row_version FROM scheduling.slot_reservation WHERE id = $1`,
        [c.id],
      )
    ).row_version;
    const doc2 = (await t.doctor()).principalId;
    // the new hold may overlap the old appointment: it replaces it
    const h = await t.as(c.scope, (tx) =>
      t.svc.hold(
        tx,
        meta,
        holdInput(c.pid, doc2, new Date(inHours(60).getTime() + 15 * 60_000), {
          rescheduleOf: c.id,
        }),
      ),
    );
    const a = await t.as(c.scope, (tx) => t.svc.reschedule(tx, meta, c.id, h.reservationId));
    assert.equal(a.id, h.reservationId);
    assert.equal(a.status, 'confirmed');
    assert.equal(a.rescheduledFromId, c.id);
    assert.equal(await status(c.id), 'rescheduled');
    const after = await t.as(c.scope, (tx) => t.svc.get(tx, c.id));
    assert.equal(
      (
        await one<{ row_version: string }>(
          `SELECT row_version FROM scheduling.slot_reservation WHERE id = $1`,
          [c.id],
        )
      ).row_version,
      oldVersion,
      'reschedule writes no field of the old reservation',
    );
    assert.equal(after?.cancelReason, null);
    // one reschedule per reservation; the old one is terminal
    const h2 = await t.as(c.scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(c.pid, doc2, inHours(70))),
    );
    await rejects(
      t.as(c.scope, (tx) => t.svc.reschedule(tx, meta, c.id, h2.reservationId)),
      InvalidTransitionError,
      'second reschedule',
    );
    assert.equal(await status(h2.reservationId), 'held', 'either both change or neither');
  });

  test('reschedule inside the cut-off is blocked on the old appointment; an expired new hold changes nothing', async () => {
    const c = await confirmed(41, inHours(10));
    const doc2 = (await t.doctor()).principalId;
    const h = await t.as(c.scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(c.pid, doc2, inHours(80), { rescheduleOf: c.id })),
    );
    await rejects(
      t.as(c.scope, (tx) => t.svc.reschedule(tx, meta, c.id, h.reservationId)),
      CutoffPassedError,
      'late reschedule',
    );
    assert.equal(await status(c.id), 'confirmed');
    const d = await confirmed(42, inHours(90));
    const h2 = await t.as(d.scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(d.pid, d.doc, inHours(100), { rescheduleOf: d.id })),
    );
    await t.age(h2.reservationId);
    await rejects(
      t.as(d.scope, (tx) => t.svc.reschedule(tx, meta, d.id, h2.reservationId)),
      HoldExpiredError,
      'expired new hold',
    );
    assert.equal(await status(d.id), 'confirmed');
  });

  test('a reschedule hold must belong to the same patient and the same service', async () => {
    const c = await confirmed(43, inHours(110));
    const other = await cast(44);
    const h = await t.as(other.scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(other.pid, other.doc, inHours(120))),
    );
    await rejects(
      t.as(c.scope, (tx) => t.svc.reschedule(tx, meta, c.id, h.reservationId)),
      ReservationNotFoundError,
      'other patient',
    );
    await rejects(
      t.as(c.scope, (tx) =>
        t.svc.hold(tx, meta, holdInput(c.pid, c.doc, inHours(130), { rescheduleOf: other.pid })),
      ),
      SchedulingValidationError,
      'rescheduleOf must be an appointment of the patient',
    );
  });

  test('HEAAA635-R1-F01: a staff member with a grant at A1 cannot reschedule onto a hold at B1; nothing changes', async () => {
    const c = await confirmed(45, inHours(150));
    const deskA = await t.staffScope([A1]);
    const h = await t.as(c.scope, (tx) =>
      t.svc.hold(
        tx,
        meta,
        holdInput(c.pid, c.doc, inHours(160), { locationId: B1, rescheduleOf: c.id }),
      ),
    );
    await rejects(
      t.as(deskA, (tx) => t.svc.reschedule(tx, meta, c.id, h.reservationId)),
      ReservationNotFoundError,
      'new hold at another location',
    );
    assert.equal(await status(c.id), 'confirmed');
    assert.equal(await status(h.reservationId), 'held');
  });
});

describe('who sees what (6.5, TC-BK-11, TC-BK-18)', () => {
  test('a patient sees only their own reservations; the occupancy table carries no patient, service or free text', async () => {
    const a = await cast(50);
    const b = await cast(51);
    const ha = await t.as(a.scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(a.pid, a.doc, slotStart(nextDay()))),
    );
    assert.equal(await t.as(b.scope, (tx) => t.svc.get(tx, ha.reservationId)), undefined);
    assert.equal(
      (await t.as(b.scope, (tx) => tx.query(`SELECT 1 FROM scheduling.slot_reservation`))).rows
        .length,
      0,
    );
    // ... but B's booking transaction sees A's occupancy (times only): that is what makes the invariant work
    const occ = await t.as(b.scope, (tx) =>
      tx.query(
        `SELECT id, organisation_id, location_id, clinician_principal_id, room_id, period, status, expires_at, overbook FROM scheduling.slot_occupancy WHERE id = $1`,
        [ha.reservationId],
      ),
    );
    assert.equal(occ.rows.length, 1);
    const cols = Object.keys(occ.rows[0] as object);
    for (const bad of [
      'patient_id',
      'service_id',
      'reason',
      'booked_by_principal_id',
      'mode',
      'created_by',
    ])
      assert.ok(!cols.includes(bad), `occupancy exposes ${bad}`);
    // SEC03-F09: the booking principal, the job and the session key are not readable by any patient or staff session, however asked
    for (const col of ['created_by', 'created_by_job', 'session_key'])
      await rejectsSql(
        t.as(b.scope, (tx) => tx.query(`SELECT ${col} FROM scheduling.slot_occupancy`)),
        '42501',
        `${col} readable`,
      );
    await rejectsSql(
      t.as(b.scope, (tx) => tx.query(`SELECT * FROM scheduling.slot_occupancy`)),
      '42501',
      'SELECT * on the twin',
    );
    // a public or anonymous transaction sees no occupancy at all
    for (const audience of ['public', 'anonymous'] as const)
      assert.equal(
        (
          await t.as({ audience, orgId: ORG }, (tx) =>
            tx
              .query(`SELECT 1 FROM scheduling.slot_occupancy`)
              .catch((e) => ({ rows: [], code: e.code })),
          )
        ).rows.length,
        0,
      );
  });

  test('staff book only at their own locations and only for patients their locations care for (TC-BK-11)', async () => {
    const pid = await t.mkPatient(52); // registered by the front desk at A1
    const doc = (await t.doctor()).principalId;
    const deskA = await t.staffScope([A1]);
    const deskB = await t.staffScope([B1]);
    const h = await t.as(deskA, (tx) =>
      t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()))),
    );
    assert.equal(
      (
        await one<{ booked_via: string }>(
          `SELECT booked_via FROM scheduling.slot_reservation WHERE id = $1`,
          [h.reservationId],
        )
      ).booked_via,
      'staff',
    );
    // at B1 the staff member of A1 is refused (location), and the staff member of B1 cannot see the patient
    await assert.rejects(
      t.as(deskA, (tx) =>
        t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()), { locationId: B1 })),
      ),
      (e: { code?: string }) => e.code === '42501',
    );
    await rejects(
      t.as(deskB, (tx) =>
        t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()), { locationId: B1 })),
      ),
      ReservationNotFoundError,
      'invisible patient',
    );
    assert.equal(await t.as(deskB, (tx) => t.svc.get(tx, h.reservationId)), undefined);
  });

  test('a proxy books as proxy (D-7); the answer records who booked', async () => {
    const pid = await t.bare(53);
    const doc = (await t.doctor()).principalId;
    const scope = await t.patientScope(pid, { proxy: true });
    const h = await t.as(scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()))),
    );
    assert.equal(
      (
        await one<{ booked_via: string }>(
          `SELECT booked_via FROM scheduling.slot_reservation WHERE id = $1`,
          [h.reservationId],
        )
      ).booked_via,
      'proxy',
    );
  });
});

describe('the HTTP routes (29.2; TC-BK-01, 09)', () => {
  test('hold -> confirm -> read -> cancel through the guard, CSRF and idempotency, with the registry error codes', async () => {
    const pid = await t.bare(60);
    const acct = await patientAccount(t.k, pid, 'Booker');
    const doc = (await t.doctor()).principalId;
    const host = 'my.example.test';
    const post = (
      path: string,
      body: unknown,
      key = randomUUID(),
      extra: Record<string, string> = {},
    ) =>
      call(t.k.base, 'POST', path, {
        host,
        cookie: acct.cookie,
        headers: { ...writeHeaders(acct, host, key), ...extra },
        body,
      });
    const s = slotStart(nextDay());
    const body = {
      patientId: pid,
      serviceId: SVC,
      locationId: A1,
      clinicianId: doc,
      startsAt: s.toISOString(),
      mode: 'in_person',
    };

    const key = randomUUID();
    const r1 = await post('/api/v1/holds', body, key);
    assert.equal(r1.status, 201, r1.body);
    const id = r1.json()['reservationId'] as string;
    // the same key again replays; the same key with another body is 409 (TC-BK-09)
    const r2 = await post('/api/v1/holds', body, key);
    assert.equal(r2.status, 201);
    assert.equal(r2.json()['reservationId'], id);
    assert.equal(r2.headers['idempotent-replay'], 'true');
    assert.equal((await post('/api/v1/holds', { ...body, reason: 'other' }, key)).status, 409);
    assert.equal(
      (
        await one<{ n: string }>(
          `SELECT count(*) AS n FROM scheduling.slot_reservation WHERE patient_id = $1`,
          [pid],
        )
      ).n,
      '1',
    );

    const c = await post(`/api/v1/appointments/${id}/confirm`, {});
    assert.equal(c.status, 200, c.body);
    assert.equal(c.json()['status'], 'confirmed');
    const g = await call(t.k.base, 'GET', `/api/v1/appointments/${id}`, {
      host,
      cookie: acct.cookie,
    });
    assert.equal(g.status, 200);
    assert.ok(typeof g.json()['locationTimeZone'] === 'string');
    const etag = g.headers['etag'] as string;

    // list
    const l = await call(t.k.base, 'GET', `/api/v1/patients/${pid}/appointments?status=confirmed`, {
      host,
      cookie: acct.cookie,
    });
    assert.equal(l.status, 200);
    assert.equal((l.json()['items'] as unknown[]).length, 1);

    // cancel needs If-Match (428), refuses a stale one (412), then works
    assert.equal((await post(`/api/v1/appointments/${id}/cancel`, {})).status, 428);
    assert.equal(
      (await post(`/api/v1/appointments/${id}/cancel`, {}, randomUUID(), { 'if-match': 'W/"99"' }))
        .status,
      412,
    );
    const x = await post(
      `/api/v1/appointments/${id}/cancel`,
      { reason: 'No longer needed' },
      randomUUID(),
      { 'if-match': etag },
    );
    assert.equal(x.status, 200, x.body);
    assert.equal(x.json()['status'], 'cancelled_patient');

    // another patient's account cannot see or touch it: 404, not 403 (CN-04)
    const otherPid = await t.bare(61);
    const other = await patientAccount(t.k, otherPid, 'Other');
    const o = await call(t.k.base, 'GET', `/api/v1/appointments/${id}`, {
      host,
      cookie: other.cookie,
    });
    assert.equal(o.status, 404);
    const oc = await call(t.k.base, 'POST', `/api/v1/appointments/${id}/confirm`, {
      host,
      cookie: other.cookie,
      headers: writeHeaders(other, host, randomUUID()),
      body: {},
    });
    assert.equal(oc.status, 404);
  });

  test('a taken slot over HTTP is 409 scheduling.slot_taken with alternatives in the error list (TC-BK-04)', async () => {
    const doc = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    const a = await cast(62);
    await t.as(a.scope, (tx) => t.svc.hold(tx, meta, holdInput(a.pid, doc, s)));
    const pid = await t.bare(63);
    const acct = await patientAccount(t.k, pid, 'Second');
    const host = 'my.example.test';
    const r = await call(t.k.base, 'POST', '/api/v1/holds', {
      host,
      cookie: acct.cookie,
      headers: writeHeaders(acct, host, randomUUID()),
      body: {
        patientId: pid,
        serviceId: SVC,
        locationId: A1,
        clinicianId: doc,
        startsAt: s.toISOString(),
        mode: 'in_person',
      },
    });
    assert.equal(r.status, 409, r.body);
    const j = r.json() as { code: string; errors?: { path: string; code: string }[] };
    assert.equal(j.code, 'scheduling.slot_taken');
    assert.ok(
      (j.errors ?? []).length >= 1 &&
        (j.errors ?? []).every(
          (e) => e.path.startsWith('/alternatives/') && !Number.isNaN(Date.parse(e.code)),
        ),
    );
  });

  test('the body cannot choose the room, the booker or an overbook session; a staff session cannot use the patient route (realm)', async () => {
    const pid = await t.bare(64);
    const acct = await patientAccount(t.k, pid, 'Booker 2');
    const doc = (await t.doctor()).principalId;
    const host = 'my.example.test';
    const r = await call(t.k.base, 'POST', '/api/v1/holds', {
      host,
      cookie: acct.cookie,
      headers: writeHeaders(acct, host, randomUUID()),
      body: {
        patientId: pid,
        serviceId: SVC,
        locationId: A1,
        clinicianId: doc,
        startsAt: slotStart(nextDay()).toISOString(),
        mode: 'in_person',
        roomId: ROOM1,
        overbook: true,
        sessionKey: 'S',
        bookedVia: 'staff',
        bookedByPrincipalId: randomUUID(),
      },
    });
    assert.equal(r.status, 201, r.body);
    const row = await one<{
      room_id: string | null;
      overbook: boolean;
      session_key: string | null;
      booked_via: string;
    }>(
      `SELECT o.room_id, o.overbook, o.session_key, r.booked_via FROM scheduling.slot_occupancy o JOIN scheduling.slot_reservation r ON r.id = o.id WHERE o.id = $1`,
      [r.json()['reservationId']],
    );
    assert.equal(row.room_id, null);
    assert.equal(row.overbook, false);
    assert.equal(row.session_key, null);
    assert.equal(row.booked_via, 'patient');
    const staffRes = await call(t.k.base, 'POST', '/api/v1/holds', {
      cookie: t.deskA1.cookie,
      headers: writeHeaders(t.deskA1, undefined, randomUUID()),
      body: {
        patientId: pid,
        serviceId: SVC,
        locationId: A1,
        clinicianId: doc,
        startsAt: slotStart(nextDay()).toISOString(),
        mode: 'in_person',
      },
    });
    assert.ok(
      staffRes.status === 401 || staffRes.status === 403 || staffRes.status === 404,
      `staff session on a patient route: ${staffRes.status}`,
    );
  });
});
