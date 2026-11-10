// Real-database tests for SEC-03 F02..F05 (HEAAA-178): the booking and care-relationship definer functions are bound to the caller by
// the database, not by the API's earlier read (SHARED-BOUNDARIES 6.2 rule 3; TC-BK-11, TC-AZ-07). Each reproduction of the assessment
// (docs/security/SEC-03-rls-assessment.md, sections 5 and 8) is run as written and must end refused; the own-reservation flows stay.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/core/binding.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { A1, A2, B1, ORG, SVC, adminUrl, pg, setupScheduling, slotStart } from './testkit.js';
import type { SchedKit } from './testkit.js';
import type { HoldInput } from './index.js';
import type { ScopeSettings } from '@ehr/kernel';

let t: SchedKit;
before(async () => {
  t = await setupScheduling('bind');
});
after(async () => {
  await t?.close();
});

const meta = {
  get requestId(): string {
    return randomUUID();
  },
};
let day = 120;
const nextDay = (): number => ++day;
const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
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
const rejectsSql = (p: Promise<unknown>, code: string, what: string): Promise<void> =>
  assert.rejects(p, (e: { code?: string; message?: string }) => {
    assert.equal(e.code, code, `${what}: expected SQLSTATE ${code}, got ${e.code} (${e.message})`);
    return true;
  });
const statusOf = async (id: string): Promise<string> =>
  (
    (
      await q<{ status: string }>(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [
        id,
      ])
    )[0] as { status: string }
  ).status;

/** A confirmed appointment of patient `pid` at A1, booked through the service. */
async function confirmedAt(pid: string, scope: ScopeSettings): Promise<string> {
  const doc = (await t.doctor()).principalId;
  const h = await t.as(scope, (tx) =>
    t.svc.hold(tx, meta, holdInput(pid, doc, slotStart(nextDay()))),
  );
  await t.as(scope, (tx) => t.svc.confirm(tx, meta, h.reservationId));
  return h.reservationId;
}
const setStatus = (scope: ScopeSettings, id: string, from: string, to: string): Promise<unknown> =>
  t.as(scope, (tx) =>
    tx.query(`SELECT scheduling.set_status($1::uuid, $2, $3) AS r`, [id, from, to]),
  );

describe("F02: scheduling.set_status acts only on the caller's own reservation (TC-BK-11, TC-AZ-07)", () => {
  test("P1c: patient B cannot cancel patient A's appointment, though B can read its occupancy row and id", async () => {
    const a = await t.bare(7001);
    const b = await t.bare(7002);
    const sa = await t.patientScope(a);
    const sb = await t.patientScope(b);
    const id = await confirmedAt(a, sa);
    const seen = await t.as(sb, (tx) =>
      tx.query(`SELECT id FROM scheduling.slot_occupancy WHERE id = $1`, [id]),
    );
    assert.equal(
      seen.rows.length,
      1,
      'the occupancy twin is organisation-wide by design (6.5): the ID is known to B',
    );
    await rejectsSql(setStatus(sb, id, 'confirmed', 'cancelled_patient'), 'P0002', 'patient B');
    assert.equal(await statusOf(id), 'confirmed');
  });

  test("P1d: staff of another location cannot cancel another clinic's appointment", async () => {
    const a = await t.bare(7003);
    const id = await confirmedAt(a, await t.patientScope(a));
    const staffB = await t.staffScope([B1]);
    await rejectsSql(
      setStatus(staffB, id, 'confirmed', 'cancelled_clinic'),
      'P0002',
      'staff of B1',
    );
    await rejectsSql(
      setStatus(staffB, id, 'confirmed', 'checked_in'),
      'P0002',
      'staff of B1 check-in',
    );
    assert.equal(await statusOf(id), 'confirmed');
  });

  test('a proxy of another patient and a patients-scope job for another patient are refused the same way', async () => {
    const a = await t.bare(7004);
    const other = await t.bare(7005);
    const id = await confirmedAt(a, await t.patientScope(a));
    await rejectsSql(
      setStatus(await t.patientScope(other, { proxy: true }), id, 'confirmed', 'cancelled_patient'),
      'P0002',
      'proxy of another patient',
    );
    const job: ScopeSettings = {
      audience: 'system',
      realm: 'worker',
      orgId: ORG,
      jobScope: 'patients',
      jobPatientIds: [other],
    };
    await rejectsSql(
      t.worker.withScope(job, (tx) =>
        tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'no_show')`, [id]),
      ),
      'P0002',
      'job of another patient',
    );
    assert.equal(await statusOf(id), 'confirmed');
  });

  test('own-reservation flows are unchanged: the patient, a proxy of the patient, the staff of the location and the organisation job', async () => {
    const a = await t.bare(7006);
    const sa = await t.patientScope(a);
    const id1 = await confirmedAt(a, sa);
    await setStatus(sa, id1, 'confirmed', 'cancelled_patient');
    assert.equal(await statusOf(id1), 'cancelled_patient');
    const id2 = await confirmedAt(a, sa);
    await setStatus(
      await t.patientScope(a, { proxy: true }),
      id2,
      'confirmed',
      'cancelled_patient',
    );
    assert.equal(await statusOf(id2), 'cancelled_patient');
    const id3 = await confirmedAt(a, sa);
    await setStatus(await t.staffScope([A1]), id3, 'confirmed', 'cancelled_clinic');
    assert.equal(await statusOf(id3), 'cancelled_clinic');
    const id4 = await confirmedAt(a, sa);
    await t.worker.withScope(t.workerScope, (tx) =>
      tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'no_show')`, [id4]),
    );
    assert.equal(await statusOf(id4), 'no_show');
  });

  test('a stale hold of somebody else is still expired by the next booking of that doctor (SAR-09)', async () => {
    const a = await t.bare(7007);
    const b = await t.bare(7008);
    const doc = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    const h = await t.as(await t.patientScope(a), (tx) =>
      t.svc.hold(tx, meta, holdInput(a, doc, s)),
    );
    await t.age(h.reservationId);
    await t.as(await t.patientScope(b), (tx) => t.svc.hold(tx, meta, holdInput(b, doc, s)));
    assert.equal(await statusOf(h.reservationId), 'expired');
  });
});

describe("F03: scheduling.occupy does not trust the caller's overbook flag and cap", () => {
  const occupy = (
    scope: ScopeSettings,
    doc: string,
    s: Date,
    key: string,
    cap: number,
  ): Promise<unknown> => {
    const id = randomUUID();
    return t.as(scope, async (tx) => {
      await tx.query(
        `SELECT scheduling.occupy($1::uuid, $2::uuid, $3::uuid, NULL, tstzrange($4::timestamptz, $4::timestamptz + interval '30 minutes', '[)'), 600, true, $5, $6)`,
        [id, A1, doc, s.toISOString(), key, cap],
      );
    });
  };

  test('P2: with no stored policy that allows overbooking, a made-up session and cap 100 end refused (23P01)', async () => {
    const a = await t.bare(7101);
    const b = await t.bare(7102);
    const doc = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    await t.as(await t.patientScope(a), (tx) => t.svc.hold(tx, meta, holdInput(a, doc, s)));
    const sb = await t.patientScope(b);
    await rejectsSql(
      occupy(sb, doc, s, 'made-up-session', 100),
      '23P01',
      'overbook without a policy',
    );
    assert.equal(
      Number(
        (
          (
            await q<{ n: string }>(
              `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND status IN ('held','confirmed')`,
              [doc],
            )
          )[0] as { n: string }
        ).n,
      ),
      1,
    );
  });

  test('with a stored cap of 2 at the location, the arguments cannot raise it: a third row under another invented key is refused (all active rows of the doctor count, HEAAA-632 T3)', async () => {
    await t.k.sa.query(
      `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, cutoff_hours, max_future_per_patient, overbook_cap_per_session)
       VALUES ($1, $2, $3, $4, 24, 3, 2) ON CONFLICT DO NOTHING`,
      [randomUUID(), ORG, SVC, A2],
    );
    const doc = (await t.doctor()).principalId;
    const s = slotStart(nextDay());
    const sa = await t.patientScope(await t.bare(7103));
    const sql = `SELECT scheduling.occupy($1::uuid, $2::uuid, $3::uuid, NULL, tstzrange($4::timestamptz, $4::timestamptz + interval '30 minutes', '[)'), 600, true, $5, 100)`;
    // The twin is checked at commit, so the whole transaction is rolled back at the end by an error of the test's own.
    await assert.rejects(
      t.as(sa, async (tx) => {
        await tx.query(sql, [randomUUID(), A2, doc, s.toISOString(), 'k1']);
        await tx.query(sql, [randomUUID(), A2, doc, s.toISOString(), 'k2']);
        await tx.query('SAVEPOINT third');
        await rejectsSql(
          tx.query(sql, [randomUUID(), A2, doc, s.toISOString(), 'k3']),
          '23P01',
          'third overbook row',
        );
        await tx.query('ROLLBACK TO SAVEPOINT third');
        throw new Error('rollback');
      }),
      /rollback/,
    );
  });
});

describe('F04: patient.ensure_care_relationship needs a real event (BR-32, D-7, SBR-02)', () => {
  const scopeOfB = async (pid: string): Promise<number> =>
    Number(
      (
        (
          await q<{ n: string }>(
            `SELECT count(*) AS n FROM patient.staff_scope WHERE patient_id = $1 AND location_id = $2`,
            [pid, B1],
          )
        )[0] as { n: string }
      ).n,
    );
  const ensure = (
    scope: ScopeSettings,
    pid: string,
    loc: string,
    reason: string,
  ): Promise<unknown> =>
    t.as(scope, async (tx) => {
      await tx.lockPatients([pid], 'no_key_update');
      await tx.callScopeOwner(
        'patient.ensure_care_relationship',
        [randomUUID(), pid, loc, reason],
        [pid],
      );
    });

  test('P4: patient A cannot add clinic B as a referral; the staff of B still see nothing', async () => {
    const a = await t.bare(7201);
    const sa = await t.patientScope(a);
    await confirmedAt(a, sa);
    await rejectsSql(ensure(sa, a, B1, 'referral'), '42501', 'referral by the patient');
    await rejectsSql(
      ensure(await t.patientScope(a, { proxy: true }), a, B1, 'referral'),
      '42501',
      'referral by a proxy',
    );
    assert.equal(await scopeOfB(a), 0);
  });

  test('a booking relationship needs a confirmed appointment of that patient at that location', async () => {
    const a = await t.bare(7202);
    const sa = await t.patientScope(a);
    await confirmedAt(a, sa); // at A1
    await rejectsSql(
      ensure(sa, a, B1, 'booking'),
      '42501',
      'booking at a location without an appointment',
    );
    await rejectsSql(ensure(sa, a, A2, 'booking'), '42501', 'booking at another location');
    assert.equal(await scopeOfB(a), 0);
    const doc = (await t.doctor()).principalId;
    const held = await t.as(sa, (tx) =>
      t.svc.hold(tx, meta, holdInput(a, doc, slotStart(nextDay()), { locationId: A2 })),
    );
    await rejectsSql(ensure(sa, a, A2, 'booking'), '42501', 'a hold is not an appointment');
    await t.as(sa, (tx) => t.svc.confirm(tx, meta, held.reservationId));
    const rel = await q<{ n: string }>(
      `SELECT count(*) AS n FROM patient.care_relationship WHERE patient_id = $1 AND location_id = $2 AND ended_at IS NULL`,
      [a, A2],
    );
    assert.equal(
      Number((rel[0] as { n: string }).n),
      1,
      'a real confirm still creates the relationship',
    );
  });

  test('staff accept a referral at their own location only', async () => {
    const a = await t.bare(7203);
    await confirmedAt(a, await t.patientScope(a));
    const staffA = await t.staffScope([A1, A2]);
    // F08d (migration 2300): a referral relationship exists only for a sent internal referral with a pending inbox row at the
    // location, accepted through the referral-bound path (lock_referral_patient, ensure_referral_care_relationship).
    const referralId = randomUUID();
    // the sender, a staff member of A1 only, writes the referral as the front-door flow does: draft, sent, then the inbox row
    const sender = await t.staffScope([A1]);
    await t.as(sender, async (tx) => {
      await tx.query(
        `INSERT INTO clinical.referral (id, organisation_id, patient_id, from_location_id, from_principal_id, target_kind, target_location_id, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, 'internal_location', $6, 'binding dbtest referral', $5)`,
        [referralId, ORG, a, A1, sender.principalId, A2],
      );
      await tx.query(`UPDATE clinical.referral SET status = 'sent' WHERE id = $1`, [referralId]);
      await tx.query(
        `INSERT INTO clinical.referral_inbox (referral_id, organisation_id, target_location_id, patient_label_ref, created_by)
         VALUES ($1, $2, $3, $1, $4)`,
        [referralId, ORG, A2, sender.principalId],
      );
    });
    const accept = (scope: ScopeSettings): Promise<unknown> =>
      t.as(scope, async (tx) => {
        await tx.lockReferralPatient(referralId, a, 'no_key_update');
        await tx.callScopeOwner(
          'patient.ensure_referral_care_relationship',
          [randomUUID(), referralId],
          [a],
        );
      });
    const referralRows = async (): Promise<number> =>
      Number(
        (
          (
            await q<{ n: string }>(
              `SELECT count(*) AS n FROM patient.care_relationship WHERE patient_id = $1 AND location_id = $2 AND reason = 'referral'`,
              [a, A2],
            )
          )[0] as { n: string }
        ).n,
      );
    // staff of another location, and staff of A1 only (not the receiving A2), cannot accept; nothing is written
    await rejectsSql(ensure(staffA, a, B1, 'referral'), '42501', 'staff of another location');
    await rejectsSql(
      accept(await t.staffScope([A1])),
      'PM008',
      'staff not at the receiving location',
    );
    await rejectsSql(
      accept(await t.staffScope([B1])),
      'PM008',
      'staff of another location, bound path',
    );
    assert.equal(await referralRows(), 0);
    await accept(staffA);
    assert.equal(await referralRows(), 1);
  });
});

describe('F05: the scheduling merge guard holds for a writer that skipped patient.lock_patients (SBR-12, TC-MG-09)', () => {
  test('P3: a reservation written while a merge is uncommitted ends PM001 and leaves no row on the merged patient', async () => {
    const survivor = await t.bare(7301);
    const merged = await t.bare(7302);
    const doc = (await t.doctor()).principalId;
    const scope = await t.patientScope(merged);
    const id = randomUUID();
    const s = slotStart(nextDay());
    // the merge: root FOR UPDATE and the status written, not committed (the statements of begin_merge and complete_merge)
    const mc = new pg.Client({
      connectionString: t.k.urlFor(new URL(adminUrl as string).username),
    });
    await mc.connect();
    try {
      await mc.query('BEGIN');
      await mc.query(`SELECT id FROM patient.patient WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`, [
        survivor,
        merged,
      ]);
      await mc.query(
        `UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`,
        [merged, survivor],
      );
      // the writer never calls lock_patients: occupy, then the reservation insert under the caller's own RLS
      let settled = false;
      const writer = t
        .as(scope, async (tx) => {
          await tx.query(
            `SELECT scheduling.occupy($1::uuid, $2::uuid, $3::uuid, NULL, tstzrange($4::timestamptz, $4::timestamptz + interval '30 minutes', '[)'), 600, false, NULL, 0)`,
            [id, A1, doc, s.toISOString()],
          );
          await tx.query(
            `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, booked_by_principal_id, booked_via, created_by)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'in_person', $7::uuid, 'patient', $7::uuid)`,
            [id, ORG, merged, SVC, A1, doc, scope.principalId],
          );
        })
        .finally(() => {
          settled = true;
        });
      writer.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(settled, false, 'the writer waits for the merge on the root');
      await mc.query('COMMIT');
      await rejectsSql(writer, 'PM001', 'writer after the merge');
    } finally {
      await mc.query('ROLLBACK').catch(() => undefined);
      await mc.end();
    }
    assert.equal(
      Number(
        (
          (
            await q<{ n: string }>(
              `SELECT count(*) AS n FROM scheduling.slot_reservation WHERE patient_id = $1`,
              [merged],
            )
          )[0] as { n: string }
        ).n,
      ),
      0,
      'no orphan reservation on the merged patient',
    );
    assert.equal(
      Number(
        (
          (
            await q<{ n: string }>(
              `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE id = $1`,
              [id],
            )
          )[0] as { n: string }
        ).n,
      ),
      0,
    );
  });
});
