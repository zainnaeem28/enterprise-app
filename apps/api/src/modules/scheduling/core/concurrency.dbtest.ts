// Real-database tests for BE-11, part 2: real concurrency on a pool of 40 connections (ARCHITECTURE 5.1, 25.1, 25.2, 38.2 items 1, 11,
// 15; SHARED-BOUNDARIES 6.5, 9.2; TC-BK-13..17 and the merge participant). Every race runs against the real exclusion constraints,
// advisory locks and row locks; nothing is mocked. Synthetic data only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/core/concurrency.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ParticipantRegistries } from '@ehr/kernel';
import type { MergeParticipant, ScopeSettings } from '@ehr/kernel';
import { registerIdentityParticipants } from '../../identity/index.js';
import { registerNotificationsParticipants } from '../../notifications/index.js';
import { A1, ORG, SVC, SVC2, ROOM1, setupScheduling, slotStart } from './testkit.js';
import type { SchedKit } from './testkit.js';
import {
  HoldExpiredError,
  OverlappingAppointmentError,
  PatientMergedError,
  ReservationNotFoundError,
  SlotTakenError,
  schedulingExportContributor,
  schedulingMergeParticipant,
} from './index.js';
import type { HoldInput } from './index.js';

let t: SchedKit;
before(async () => {
  t = await setupScheduling('cc');
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
const n = async (sql: string, p?: unknown[]): Promise<number> =>
  Number(((await q<{ n: string }>(sql, p))[0] as { n: string }).n);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let day = 40;
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

type Outcome = { ok: true; id: string } | { ok: false; err: unknown };
/** One caller's whole booking: hold, then confirm. Any refusal is returned, not thrown, so a race can be counted. */
async function book(scope: ScopeSettings, input: HoldInput): Promise<Outcome> {
  try {
    const h = await t.as(scope, (tx) => t.svc.hold(tx, meta, input));
    await t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId));
    return { ok: true, id: h.reservationId };
  } catch (err) {
    return { ok: false, err };
  }
}
const wins = (o: Outcome[]): number => o.filter((x) => x.ok).length;
const activeCount = (doctor: string, start: Date): Promise<number> =>
  n(
    `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND lower(period) = $2
        AND status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed')`,
    [doctor, start.toISOString()],
  );

describe('RA-R1-03: parallel booking of one slot (TC-BK-13, 14, 15)', () => {
  test('TC-BK-13: 100 parallel bookings of one non-overbookable slot by ONE patient account: exactly one appointment exists, the 99 others get "taken" with alternatives', async () => {
    const pid = await t.bare(1);
    const scope = await t.patientScope(pid);
    const doc = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    const out = await Promise.all(
      Array.from({ length: 100 }, () => book(scope, holdInput(pid, doc, s))),
    );
    assert.equal(wins(out), 1, 'exactly one succeeds');
    const losers = out.filter((x): x is { ok: false; err: unknown } => !x.ok);
    assert.equal(losers.length, 99);
    for (const l of losers) {
      assert.ok(
        l.err instanceof SlotTakenError,
        `a loser must get "taken", got ${l.err instanceof Error ? `${l.err.name}: ${l.err.message}` : String(l.err)}`,
      );
      assert.ok((l.err as SlotTakenError).alternatives.length >= 1);
    }
    assert.equal(await activeCount(doc, s), 1);
    assert.equal(
      await n(`SELECT count(*) AS n FROM scheduling.slot_reservation WHERE patient_id = $1`, [pid]),
      1,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM scheduling.slot_occupancy o JOIN scheduling.slot_reservation r ON r.id = o.id WHERE r.patient_id = $1 AND o.status = 'confirmed'`,
        [pid],
      ),
      1,
    );
  });

  test('100 parallel CONFIRMATIONS of one held slot: one transition, every other call is the same answer by state', async () => {
    const pid = await t.bare(2);
    const scope = await t.patientScope(pid);
    const doc = (await t.doctor()).principalId;
    const h = await t.as(scope, (tx) =>
      t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()))),
    );
    const out = await Promise.allSettled(
      Array.from({ length: 100 }, () =>
        t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId)),
      ),
    );
    assert.equal(
      out.filter((x) => x.status === 'fulfilled').length,
      100,
      JSON.stringify(
        out
          .filter((x) => x.status === 'rejected')
          .slice(0, 1)
          .map((x) => String((x as PromiseRejectedResult).reason)),
      ),
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM audit.event WHERE resource_id = $1 AND action = 'update'`,
        [h.reservationId],
      ),
      1,
      'one change, one audit row',
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.care_relationship WHERE patient_id = $1 AND ended_at IS NULL`,
        [pid],
      ),
      1,
    );
  });

  test('TC-BK-14: 100 DIFFERENT patients: exactly one wins; no patient sees another reservation', async () => {
    const doc = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    const casts = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const pid = await t.bare(100 + i);
        return { pid, scope: await t.patientScope(pid) };
      }),
    );
    const out = await Promise.all(casts.map((c) => book(c.scope, holdInput(c.pid, doc, s))));
    assert.equal(wins(out), 1);
    for (const l of out.filter((x): x is { ok: false; err: unknown } => !x.ok)) {
      assert.ok(
        l.err instanceof SlotTakenError,
        `got ${l.err instanceof Error ? `${l.err.name}: ${l.err.message}` : String(l.err)}`,
      );
      assert.ok((l.err as SlotTakenError).alternatives.length >= 1);
    }
    assert.equal(await activeCount(doc, s), 1);
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id WHERE o.clinician_principal_id = $1 AND lower(o.period) = $2`,
        [doc, s.toISOString()],
      ),
      1,
      'a refused hold leaves no reservation behind',
    );
    const winnerIdx = out.findIndex((x) => x.ok);
    const winner = out[winnerIdx] as { ok: true; id: string };
    for (const [i, c] of casts.entries()) {
      const rows = (
        await t.as(c.scope, (tx) => tx.query(`SELECT id FROM scheduling.slot_reservation`))
      ).rows as { id: string }[];
      assert.deepEqual(
        rows.map((r) => r.id),
        i === winnerIdx ? [winner.id] : [],
        "a patient sees only their own reservation, never another's",
      );
    }
  });

  test('TC-BK-15 (SA-F-10): an overbookable session with a cap of 2 under 100 parallel bookings: exactly 2 succeed, never more', async () => {
    const doc = (await t.doctor()).principalId;
    t.overbook.set(doc, 'SESSION-1');
    await t.k.sa.query(
      `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, cutoff_hours, max_future_per_patient, overbook_cap_per_session)
       VALUES ($1, $2, $3, NULL, 24, 3, 2) ON CONFLICT DO NOTHING`,
      [randomUUID(), ORG, SVC2],
    );
    const s = slotStart(nextDay());
    const casts = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const pid = await t.bare(300 + i);
        return { pid, scope: await t.patientScope(pid) };
      }),
    );
    const out = await Promise.all(
      casts.map((c) => book(c.scope, holdInput(c.pid, doc, s, { serviceId: SVC2 }))),
    );
    assert.equal(wins(out), 2, 'the cap, not one');
    for (const l of out.filter((x): x is { ok: false; err: unknown } => !x.ok))
      assert.ok(l.err instanceof SlotTakenError, String(l.err));
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND overbook AND status = 'confirmed'`,
        [doc],
      ),
      2,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND status IN ('held', 'confirmed')`,
        [doc],
      ),
      2,
    );
    t.overbook.delete(doc);
  });

  test('BE11-F01 regression: 20 rounds of 100 different patients on fresh slots: every round has exactly one winner and never a deadlock (40P01)', async () => {
    const doc = (await t.doctor()).principalId;
    for (let round = 0; round < 20; round++) {
      const s = slotStart(nextDay());
      const casts = await Promise.all(
        Array.from({ length: 100 }, async (_, i) => {
          const pid = await t.bare(2000 + round * 100 + i);
          return { pid, scope: await t.patientScope(pid) };
        }),
      );
      const out = await Promise.all(casts.map((c) => book(c.scope, holdInput(c.pid, doc, s))));
      const odd = out.filter(
        (x): x is { ok: false; err: unknown } => !x.ok && !(x.err instanceof SlotTakenError),
      );
      assert.equal(
        odd.length,
        0,
        `round ${round}: ${odd.slice(0, 1).map((x) => String((x.err as { code?: unknown } | null)?.code ?? x.err))}`,
      );
      assert.equal(wins(out), 1, `round ${round}: exactly one winner`);
      assert.equal(await activeCount(doc, s), 1);
    }
  });

  test('an overbook cap of 0 (the default) refuses every overbook row', async () => {
    const doc = (await t.doctor()).principalId;
    t.overbook.set(doc, 'SESSION-0');
    const pid = await t.bare(500);
    const scope = await t.patientScope(pid);
    const r = await book(scope, holdInput(pid, doc, slotStart(nextDay()), { serviceId: SVC })); // SVC has no policy row: cap 0
    assert.ok(!r.ok && r.err instanceof SlotTakenError);
    t.overbook.delete(doc);
  });
});

describe('stale holds under a race (TC-BK-16, 17, SAR-09, SBR-01 (a), (b))', () => {
  test('TC-BK-16: A holds, the hold lapses, B and C race for the slot: exactly one wins and the loser is told the truth', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await t.bare(600 + round * 3);
      const b = await t.bare(601 + round * 3);
      const c = await t.bare(602 + round * 3);
      const [sa, sb, sc] = await Promise.all([a, b, c].map((p) => t.patientScope(p)));
      const doc = (await t.doctor()).principalId;
      const s = slotStart(nextDay());
      const ha = await t.as(sa as ScopeSettings, (tx) =>
        t.svc.hold(tx, meta, holdInput(a, doc, s)),
      );
      await t.age(ha.reservationId);
      const [rb, rc] = await Promise.all([
        book(sb as ScopeSettings, holdInput(b, doc, s)),
        book(sc as ScopeSettings, holdInput(c, doc, s)),
      ]);
      assert.equal(wins([rb, rc]), 1, `round ${round}: exactly one of B and C wins`);
      const lose = [rb, rc].find((x) => !x.ok) as { ok: false; err: unknown };
      assert.ok(
        lose.err instanceof SlotTakenError,
        `the loser's "taken" is true: the winner holds the slot`,
      );
      assert.equal(
        (
          await q<{ status: string }>(
            `SELECT status FROM scheduling.slot_occupancy WHERE id = $1`,
            [ha.reservationId],
          )
        )[0]?.status,
        'expired',
      );
      assert.equal(await activeCount(doc, s), 1);
    }
  });

  test('TC-BK-17: the same race for a ROOM (two different doctors, one room)', async () => {
    for (let round = 0; round < 5; round++) {
      const pa = await t.mkPatient(700 + round * 3);
      const pb = await t.mkPatient(701 + round * 3);
      const pc = await t.mkPatient(702 + round * 3);
      const staff = await t.staffScope([A1]);
      const [d1, d2, d3] = [
        (await t.doctor()).principalId,
        (await t.doctor()).principalId,
        (await t.doctor()).principalId,
      ];
      const s = slotStart(nextDay());
      const ha = await t.as(staff, (tx) =>
        t.svc.hold(tx, meta, holdInput(pa, d1, s, { roomId: ROOM1 })),
      );
      await t.age(ha.reservationId);
      const [rb, rc] = await Promise.all([
        book(staff, holdInput(pb, d2, s, { roomId: ROOM1 })),
        book(staff, holdInput(pc, d3, s, { roomId: ROOM1 })),
      ]);
      assert.equal(wins([rb, rc]), 1, `round ${round}: exactly one of B and C gets the room`);
      assert.ok(
        ([rb, rc].find((x) => !x.ok) as { ok: false; err: unknown }).err instanceof SlotTakenError,
      );
      assert.equal(
        await n(
          `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE room_id = $1 AND lower(period) = $2 AND status IN ('held', 'confirmed')`,
          [ROOM1, s.toISOString()],
        ),
        1,
      );
    }
  });
});

describe('38.2 item 15: one patient, overlapping times (TDR-07, BQ-9)', () => {
  test('two concurrent holds for one patient on different services and doctors with overlapping times: exactly one succeeds, the other is 422 overlapping_appointment', async () => {
    for (let round = 0; round < 8; round++) {
      const pid = await t.bare(800 + round);
      const scope = await t.patientScope(pid);
      const d1 = (await t.doctor()).principalId;
      const d2 = (await t.doctor()).principalId;
      const s = slotStart(nextDay());
      const [r1, r2] = await Promise.all([
        t
          .as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, d1, s)))
          .then(
            (x) => ({ ok: true as const, x }),
            (err: unknown) => ({ ok: false as const, err }),
          ),
        t
          .as(scope, (tx) =>
            t.svc.hold(
              tx,
              meta,
              holdInput(pid, d2, new Date(s.getTime() + 15 * 60_000), { serviceId: SVC2 }),
            ),
          )
          .then(
            (x) => ({ ok: true as const, x }),
            (err: unknown) => ({ ok: false as const, err }),
          ),
      ]);
      assert.equal([r1, r2].filter((x) => x.ok).length, 1, `round ${round}`);
      const lose = [r1, r2].find((x) => !x.ok) as { ok: false; err: unknown };
      assert.ok(lose.err instanceof OverlappingAppointmentError, String(lose.err));
      assert.equal((lose.err as OverlappingAppointmentError).status, 422);
      assert.equal(
        (lose.err as OverlappingAppointmentError).code,
        'scheduling.overlapping_appointment',
      );
      assert.equal(
        await n(`SELECT count(*) AS n FROM scheduling.slot_reservation WHERE patient_id = $1`, [
          pid,
        ]),
        1,
      );
    }
  });

  test('...and with one of the two holds made by the waitlist offer job (25.6): the same rule, the same answer', async () => {
    for (let round = 0; round < 5; round++) {
      const pid = await t.bare(900 + round);
      const scope = await t.patientScope(pid);
      const d1 = (await t.doctor()).principalId;
      const d2 = (await t.doctor()).principalId;
      const s = slotStart(nextDay());
      const job: ScopeSettings = {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [pid],
      };
      const [r1, r2] = await Promise.all([
        t
          .as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, d1, s)))
          .then(
            (x) => ({ ok: true as const, x }),
            (err: unknown) => ({ ok: false as const, err }),
          ),
        t.worker
          .withScope(job, (tx) =>
            t.svc.hold(
              tx,
              meta,
              holdInput(pid, d2, new Date(s.getTime() + 10 * 60_000), {
                serviceId: SVC2,
                onBehalfOfPrincipalId: scope.principalId as string,
              }),
              'waitlist',
            ),
          )
          .then(
            (x) => ({ ok: true as const, x }),
            (err: unknown) => ({ ok: false as const, err }),
          ),
      ]);
      assert.equal([r1, r2].filter((x) => x.ok).length, 1, `round ${round}`);
      assert.ok(
        ([r1, r2].find((x) => !x.ok) as { ok: false; err: unknown }).err instanceof
          OverlappingAppointmentError,
      );
      const via = await q<{ booked_via: string }>(
        `SELECT booked_via FROM scheduling.slot_reservation WHERE patient_id = $1`,
        [pid],
      );
      assert.equal(via.length, 1);
    }
  });
});

describe('merge participant (22.16, 38.2 items 1 and 11)', () => {
  /** A merged and a survivor patient with appointments in every state the rules distinguish. */
  async function twoPatients(base: number) {
    const S = await t.mkPatient(base);
    const D = await t.mkPatient(base + 1);
    const sc = (p: string) => t.patientScope(p);
    const [scS, scD] = [await sc(S), await sc(D)];
    const doc = (await t.doctor()).principalId;
    const confirm = async (
      scope: ScopeSettings,
      pid: string,
      start: Date,
      over: Partial<HoldInput> = {},
    ) => {
      const h = await t.as(scope, (tx) => t.svc.hold(tx, meta, holdInput(pid, doc, start, over)));
      await t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId));
      return h.reservationId;
    };
    const day0 = nextDay();
    const dConfirmed = await confirm(scD, D, slotStart(day0, 0));
    const dHeld = (
      await t.as(scD, (tx) => t.svc.hold(tx, meta, holdInput(D, doc, slotStart(day0, 4))))
    ).reservationId;
    const dCancelled = await confirm(scD, D, slotStart(day0, 8));
    await t.as(scD, (tx) => t.svc.cancel(tx, meta, dCancelled, { reason: 'changed my mind' }));
    // the survivor's own appointment overlaps the merged patient's confirmed one (on another doctor)
    const doc2 = (await t.doctor()).principalId;
    const sOverlap = await (async () => {
      const h = await t.as(scS, (tx) =>
        t.svc.hold(
          tx,
          meta,
          holdInput(S, doc2, new Date(slotStart(day0, 0).getTime() + 10 * 60_000), {
            serviceId: SVC2,
          }),
        ),
      );
      await t.as(scS, (tx) => t.svc.confirm(tx, meta, h.reservationId));
      return h.reservationId;
    })();
    return { S, D, scS, scD, doc, dConfirmed, dHeld, dCancelled, sOverlap };
  }
  const owner = (id: string) =>
    q<{ patient_id: string }>(`SELECT patient_id FROM scheduling.slot_reservation WHERE id = $1`, [
      id,
    ]).then((r) => r[0]?.patient_id);

  test('item 11: R reservations (held, confirmed) move to the survivor, the K one stays; found = re-pointed + resolved + kept; no appointment is cancelled', async () => {
    const x = await twoPatients(1000);
    const statusBefore = await q(
      `SELECT id, status FROM scheduling.slot_occupancy WHERE id = ANY($1) ORDER BY id`,
      [[x.dConfirmed, x.dHeld, x.dCancelled, x.sOverlap]],
    );
    const { requestId, result } = await t.merge(x.S, x.D);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const counts = (
      await q<{ counts: Record<string, Record<string, number>> }>(
        `SELECT counts FROM patient.merge_request WHERE id = $1`,
        [requestId],
      )
    )[0]?.counts['scheduling.slot_reservation'];
    assert.deepEqual(counts, { found: 3, repointed: 2, resolved: 0, kept: 1 });
    assert.equal(await owner(x.dConfirmed), x.S);
    assert.equal(await owner(x.dHeld), x.S);
    assert.equal(await owner(x.dCancelled), x.D, 'a K row stays on the merged ID');
    assert.deepEqual(
      await q(`SELECT id, status FROM scheduling.slot_occupancy WHERE id = ANY($1) ORDER BY id`, [
        [x.dConfirmed, x.dHeld, x.dCancelled, x.sOverlap],
      ]),
      statusBefore,
      'a merge never changes an appointment',
    );
    // overlaps_after_merge is reported for the requester's follow-up (22.16)
    const rep = await q<{ change: { overlapsAfterMerge: number } }>(
      `SELECT change FROM audit.event WHERE action = 'merge' AND resource_type = 'scheduling.slot_reservation' AND change->>'mergeRequestId' = $1`,
      [requestId],
    );
    assert.equal(rep.length, 1);
    assert.ok(rep[0]!.change.overlapsAfterMerge >= 1);
    // nothing writes to the kept row afterwards, for any role (K state, 21.5), and nobody can book for the merged ID
    await assert.rejects(
      t.worker.withScope(
        {
          audience: 'system',
          realm: 'worker',
          orgId: ORG,
          jobScope: 'patients',
          jobPatientIds: [x.D, x.S],
        },
        (tx) =>
          tx.query(`UPDATE scheduling.slot_reservation SET patient_id = $2 WHERE id = $1`, [
            x.dCancelled,
            x.S,
          ]),
      ),
      (e: { code?: string }) => e.code === 'PS001',
    );
    await assert.rejects(
      t.as(x.scD, (tx) => t.svc.hold(tx, meta, holdInput(x.D, x.doc, slotStart(nextDay())))),
      (e: unknown) => e instanceof PatientMergedError,
    );
  });

  test("the participant is registered through the registry with its rules, and the privacy export part returns the survivor's reservations", async () => {
    const regs = new ParticipantRegistries();
    registerIdentityParticipants(regs);
    registerNotificationsParticipants(regs);
    assert.ok(
      t.regs
        .mergeParticipants()
        .some((p) => p.module === 'scheduling' && p.tables.includes('scheduling.slot_reservation')),
    );
    assert.ok(t.regs.exportContributors().some((p) => p.module === 'scheduling'));
    assert.throws(
      () => t.regs.registerMergeParticipant(schedulingMergeParticipant),
      /already registered/,
    );
    assert.ok(schedulingMergeParticipant.conflictRules.length === 1);
    const x = await twoPatients(1010);
    await t.merge(x.S, x.D);
    const part = (await t.worker.withScope(
      {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [x.S, x.D],
      },
      (tx) => schedulingExportContributor.exportPart(tx, [x.S, x.D], randomUUID()),
    )) as { reservations: { id: string; patientId: string; status: string }[] };
    const ids = part.reservations.map((r) => r.id);
    for (const id of [x.dConfirmed, x.dHeld, x.dCancelled, x.sOverlap]) assert.ok(ids.includes(id));
    assert.equal(part.reservations.find((r) => r.id === x.dCancelled)?.status, 'cancelled_patient');
    assert.equal(part.reservations.find((r) => r.id === x.dConfirmed)?.patientId, x.S);
  });

  /** Waits until a backend running a statement that contains `text` is waiting for a lock. */
  async function blockedOn(text: string, timeoutMs = 8000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const r = await q(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1 AND pid <> pg_backend_pid()`,
        [`%${text}%`],
      );
      if (r.length > 0) return;
      await sleep(25);
    }
    throw new Error(`nothing was waiting on a lock in a statement containing ${text}`);
  }

  test('38.2 item 1, confirm first: a confirm that holds the patient root commits first, the merge waits for it, then counts and re-points the confirmed reservation', async () => {
    const S = await t.mkPatient(1020);
    const D = await t.mkPatient(1021);
    const scD = await t.patientScope(D);
    const doc = (await t.doctor()).principalId;
    const h = await t.as(scD, (tx) =>
      t.svc.hold(tx, meta, holdInput(D, doc, slotStart(nextDay()))),
    );
    const requestId = await t.approved(S, D);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let confirmed = false;
    const confirm = t.as(scD, async (tx) => {
      const a = await t.svc.confirm(tx, meta, h.reservationId);
      confirmed = true;
      await gate; // the transaction (and its root lock) stays open
      return a;
    });
    for (let i = 0; !confirmed && i < 500; i++) await sleep(10);
    assert.ok(confirmed, 'the confirm reached its gate');
    let mergeDone = false;
    const merge = t.run(requestId).then((r) => ((mergeDone = true), r));
    await blockedOn('lock_patients'); // the merge's first statement waits on the root the confirm holds (25.2 rule 1)
    await sleep(200);
    assert.equal(mergeDone, false, 'the merge must wait for the booking transaction');
    release();
    assert.equal((await confirm).status, 'confirmed');
    const res = await merge;
    assert.equal(res.status, 'completed', JSON.stringify(res));
    assert.equal(
      await owner(h.reservationId),
      S,
      'the confirmed reservation was found and re-pointed',
    );
    assert.equal(
      (
        await q<{ status: string }>(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [
          h.reservationId,
        ])
      )[0]?.status,
      'confirmed',
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id WHERE r.patient_id = $1 AND o.status IN ('held', 'confirmed', 'checked_in')`,
        [D],
      ),
      0,
      'no R row is left on the merged patient',
    );
  });

  test('38.2 item 1, merge first: a confirm that arrives while the merge holds the roots waits, then is refused whole; nothing is written for the merged ID', async () => {
    const S = await t.mkPatient(1030);
    const D = await t.mkPatient(1031);
    const scD = await t.patientScope(D);
    const doc = (await t.doctor()).principalId;
    const h = await t.as(scD, (tx) =>
      t.svc.hold(tx, meta, holdInput(D, doc, slotStart(nextDay()))),
    );
    const requestId = await t.approved(S, D);

    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const enteredP = new Promise<void>((r) => (entered = r));
    const blocker: MergeParticipant = {
      module: 'aaa_hold',
      tables: ['aaa_hold.item'],
      conflictRules: [],
      repointPatient: async () => {
        entered();
        await gate;
        return [
          { table: 'aaa_hold.item', found: 0, repointed: 0, resolved: 0, kept: 0, deleted: [] },
        ];
      },
    };
    const regs = new ParticipantRegistries();
    registerIdentityParticipants(regs);
    registerNotificationsParticipants(regs);
    regs.registerMergeParticipant(blocker);
    regs.registerMergeParticipant(schedulingMergeParticipant);

    const merge = t.run(requestId, { registries: regs });
    await enteredP; // the merge now holds both roots FOR UPDATE
    let settled = false;
    const confirm = t
      .as(scD, (tx) => t.svc.confirm(tx, meta, h.reservationId))
      .then(
        (x) => ((settled = true), { ok: true as const, x }),
        (err: unknown) => ((settled = true), { ok: false as const, err }),
      );
    await sleep(300);
    assert.equal(settled, false, 'the confirm waits for the merge');
    release();
    const res = await merge;
    assert.equal(res.status, 'completed', JSON.stringify(res));
    const c = await confirm;
    assert.equal(c.ok, false, 'the confirm is refused whole');
    if (!c.ok)
      assert.ok(
        c.err instanceof PatientMergedError || c.err instanceof ReservationNotFoundError,
        String(c.err),
      );
    assert.equal(
      (
        await q<{ status: string }>(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [
          h.reservationId,
        ])
      )[0]?.status,
      'held',
    );
    assert.equal(await owner(h.reservationId), S);
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM audit.event WHERE resource_id = $1 AND action = 'update'`,
        [h.reservationId],
      ),
      0,
    );
  });

  test('38.2 item 1, repeated: confirms racing a merge, 10 rounds, with no ordering forced: every round ends serialised and consistent', async () => {
    for (let round = 0; round < 10; round++) {
      const S = await t.mkPatient(1100 + round * 2);
      const D = await t.mkPatient(1101 + round * 2);
      const scD = await t.patientScope(D);
      const doc = (await t.doctor()).principalId;
      const h = await t.as(scD, (tx) =>
        t.svc.hold(tx, meta, holdInput(D, doc, slotStart(nextDay()))),
      );
      const requestId = await t.approved(S, D);
      const [m, c] = await Promise.all([
        t.run(requestId),
        t
          .as(scD, (tx) => t.svc.confirm(tx, meta, h.reservationId))
          .then(
            (x) => ({ ok: true as const, x }),
            (err: unknown) => ({ ok: false as const, err }),
          ),
      ]);
      assert.equal(m.status, 'completed', `round ${round}: ${JSON.stringify(m)}`);
      assert.equal(
        await owner(h.reservationId),
        S,
        `round ${round}: the reservation ends on the survivor`,
      );
      assert.equal(
        await n(
          `SELECT count(*) AS n FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id WHERE r.patient_id = $1 AND o.status IN ('held', 'confirmed', 'checked_in')`,
          [D],
        ),
        0,
      );
      const st = (
        await q<{ status: string }>(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [
          h.reservationId,
        ])
      )[0]?.status;
      if (c.ok)
        assert.equal(
          st,
          'confirmed',
          `round ${round}: a confirm that succeeded is confirmed and was counted by the merge`,
        );
      else assert.equal(st, 'held', `round ${round}: a confirm that failed changed nothing`);
    }
  });

  test("an expired hold of a merged patient is still just a stale hold: the survivor's confirm of it is 409 hold_expired", async () => {
    const x = await twoPatients(1200);
    await t.merge(x.S, x.D);
    await t.age(x.dHeld);
    const scS2 = await t.patientScope(x.S);
    await assert.rejects(
      t.as(scS2, (tx) => t.svc.confirm(tx, meta, x.dHeld)),
      (e: unknown) => e instanceof HoldExpiredError,
    );
  });
});
