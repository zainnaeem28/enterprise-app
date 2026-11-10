// Real-database tests of the waitlist and its neighbours (BE-13): a freed slot becomes an offer through `scheduling.hold`, the first
// acceptance inside the window wins, the offer lapses cleanly, the pre-visit message skips cancelled bookings, and the module's merge
// participation for the check-in, queue, waitlist and offer tables (ARCHITECTURE 25.6, 22.16, 38.2 item 11; TC-BK-19..22). PostgreSQL 17,
// the real Nest application and guard, the worker's real job handlers; synthetic data only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/flow/waitlist.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ParticipantRegistries, RegistryError } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import { registerSchedulingParticipants } from '../core/merge.js';
import {
  A1,
  ORG,
  SVC,
  SVC2,
  SVC_IP,
  call,
  setupFlow,
  slotStart,
  workerJobs,
  writeHeaders,
} from './testkit.js';
import type { FlowKit, PatientKit, WorkerJobs } from './testkit.js';
import { registerSchedulingFlowParticipants, schedulingFlowMergeParticipant } from './index.js';

let t: FlowKit;
let W: WorkerJobs;
let staffScopeCache: ScopeSettings;
before(async () => {
  t = await setupFlow('wl');
  W = await workerJobs();
  await t.allowWaitlist(SVC);
  staffScopeCache = await t.staffScope([A1], 'front_desk');
});
after(async () => {
  await t?.close();
});

const HOST = 'my.example.test';
const meta = () => ({ requestId: randomUUID() });
const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const one = async <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R> =>
  (await q<R>(sql, p))[0] as R;
const nrows = async (sql: string, p?: unknown[]): Promise<number> =>
  Number((await one<{ n: string }>(sql, p)).n);
const occ = (id: string) =>
  one<{ status: string; expires_at: Date | null }>(
    `SELECT status, expires_at FROM scheduling.slot_occupancy WHERE id = $1`,
    [id],
  );
const offerOf = (id: string) =>
  one<{
    id: string;
    status: string;
    patient_id: string;
    occupancy_id: string;
    waitlist_entry_id: string;
    expires_at: Date;
    created_at: Date;
  }>(`SELECT * FROM scheduling.waitlist_offer WHERE id = $1`, [id]);
const entryStatus = async (id: string) =>
  (
    await one<{ status: string }>(`SELECT status FROM scheduling.waitlist_entry WHERE id = $1`, [
      id,
    ])
  ).status;
const iso = (d: Date): string => d.toISOString();
const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, code);
    return true;
  });
let day = 20;
const nextDay = (): number => (day += 2);
const sysScope = (): ScopeSettings => t.workerScope;

/** A doctor, a booked appointment of a booker at `start`, and the waitlist entries of the given patients (in that order), all for this doctor. */
async function scenario(opts: {
  start?: Date;
  waiters: number;
  staffBooker?: boolean;
  registered?: boolean;
  /** The doctor's window is overbookable (HEAAA-632): every booking of the slot is an overbook row while the stored cap is 2 or more. */
  overbook?: boolean;
}) {
  t.clock.at = undefined;
  const doc = (await t.doctor()).principalId;
  if (opts.overbook === true) t.overbook.set(doc, 'SESSION-OB');
  const booker = await t.patient(1000 + (day += 1));
  const start = opts.start ?? slotStart(nextDay());
  const rid = await t.confirmed(booker, doc, start);
  const people: PatientKit[] = [];
  const entries: string[] = [];
  for (let i = 0; i < opts.waiters; i++) {
    const p =
      opts.registered === true
        ? await t.patient(2000 + (day += 1) * 10 + i)
        : await t.bare(2000 + (day += 1) * 10 + i);
    people.push(p);
    const e = await t.as(p.scope, (tx) =>
      t.flow.waitlist.createEntry(tx, meta(), {
        patientId: p.patientId,
        serviceId: SVC,
        clinicianId: doc,
        from: iso(new Date(Date.now() + 3_600_000)),
        to: iso(new Date(Date.now() + 90 * 86_400_000)),
      }),
    );
    entries.push(e.id);
  }
  const free = async () => {
    if (opts.staffBooker === true) {
      const staff = await t.staffScope([A1], 'front_desk');
      await t.as(staff, (tx) => t.core.cancel(tx, meta(), rid, { reason: 'clinic cancelled' }));
    } else
      await t.as(booker.scope, (tx) => t.core.cancel(tx, meta(), rid, { reason: 'cannot come' }));
  };
  /** The event chain a freed occupancy starts: the handler, then the offer job (the worker's real handlers). */
  const chain = async (occupancyId: string) => {
    await W.runOnSlotFreed(t.jobs, { occupancyId });
    return W.runOfferWaitlist(t.jobs, { occupancyId });
  };
  return { doc, booker, start, rid, people, entries, free, chain };
}

describe('a freed slot becomes one offer at a time, in line order (25.6; TC-BK-19)', () => {
  test('PAT-01 is offered first, through scheduling.hold, for the offer time (30 min); the offer lapses cleanly and PAT-02 is offered next, PAT-01 is not offered again', async () => {
    const s = await scenario({ waiters: 2 });
    await s.free();
    // the freed slot published `slot_freed`; the handler schedules the offer job; one job per occupancy
    assert.ok(
      (await t.jobsInQueue('scheduling.on_slot_freed')).some(
        (j) => j.payload['occupancyId'] === s.rid,
      ),
    );
    await W.runOnSlotFreed(t.jobs, { occupancyId: s.rid });
    const queued = await t.jobsInQueue('scheduling.offer_waitlist');
    assert.equal(queued.filter((j) => j.payload['occupancyId'] === s.rid).length, 1);
    await W.runOnSlotFreed(t.jobs, { occupancyId: s.rid });
    assert.equal(
      (await t.jobsInQueue('scheduling.offer_waitlist')).filter(
        (j) => j.payload['occupancyId'] === s.rid,
      ).length,
      1,
      'a repeat event replaces, never adds',
    );

    const r = await W.runOfferWaitlist(t.jobs, { occupancyId: s.rid });
    assert.equal(r.outcome, 'offered', JSON.stringify(r));
    const [p1, p2] = s.people as [PatientKit, PatientKit];
    const offer = await one<{
      id: string;
      occupancy_id: string;
      patient_id: string;
      status: string;
      expires_at: Date;
      created_at: Date;
      waitlist_entry_id: string;
    }>(`SELECT * FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`, [s.entries[0]]);
    assert.equal(offer.id, r.offerId);
    assert.deepEqual([offer.status, offer.patient_id], ['offered', p1.patientId]);
    assert.equal(await entryStatus(s.entries[0] as string), 'offered');
    assert.equal(await entryStatus(s.entries[1] as string), 'active');
    // the hold: booked by the waitlist for PAT-01's own account, held, with the offer time as its life
    const res = await one<{
      booked_via: string;
      booked_by_principal_id: string;
      patient_id: string;
    }>(
      `SELECT booked_via, booked_by_principal_id, patient_id FROM scheduling.slot_reservation WHERE id = $1`,
      [offer.occupancy_id],
    );
    assert.deepEqual(
      [res.booked_via, res.booked_by_principal_id, res.patient_id],
      ['waitlist', p1.scope.principalId, p1.patientId],
    );
    assert.equal((await occ(offer.occupancy_id)).status, 'held');
    assert.equal(
      Number(
        (
          await one<{ s: string }>(
            `SELECT extract(epoch FROM (expires_at - created_at))::int AS s FROM scheduling.waitlist_offer WHERE id = $1`,
            [offer.id],
          )
        ).s,
      ),
      30 * 60,
    );
    assert.equal(
      iso((await occ(offer.occupancy_id)).expires_at as Date),
      iso(offer.expires_at),
      'the hold and the offer expire together',
    );
    // the message: PHI-free template, the patient, a dedupe key per offer
    const msg = await q<{
      template_key: string;
      patient_id: string;
      dedupe_key: string;
      variables: Record<string, string>;
    }>(
      `SELECT template_key, patient_id, dedupe_key, variables FROM notifications.notification WHERE dedupe_key LIKE $1`,
      [`waitlist_offer:${offer.id}:%`],
    );
    assert.ok(msg.length >= 1);
    for (const m of msg) {
      assert.equal(m.template_key, 'waitlist_offer');
      assert.equal(m.patient_id, p1.patientId);
      assert.deepEqual(Object.keys(m.variables).sort(), [
        'offer_expires_at',
        'portal_link',
        'start_at',
        'time_zone',
      ]);
      assert.ok(
        !m.dedupe_key.includes(p1.patientId),
        'a dedupe key never carries the patient ID (22.13)',
      );
    }
    // the expiry job is scheduled at the expiry, one per offer
    const exp = (await t.jobsInQueue('scheduling.expire_offer')).filter(
      (j) => j.payload['offerId'] === offer.id,
    );
    assert.equal(exp.length, 1);
    assert.equal(iso(exp[0]?.run_at as Date), iso(offer.expires_at));
    assert.deepEqual(exp[0]?.payload, { offerId: offer.id, patientId: p1.patientId });
    // audited, by the job
    const a = await one<{ action: string; job_id: string | null; patient_id: string }>(
      `SELECT action, job_id, patient_id FROM audit.event WHERE resource_type = 'scheduling.waitlist_offer' AND resource_id = $1 AND action = 'create'`,
      [offer.id],
    );
    assert.deepEqual([a.action, a.patient_id], ['create', p1.patientId]);
    assert.ok((a.job_id ?? '').startsWith('scheduling.offer_waitlist'));
    // a second run for the same slot offers nothing: one offer per slot at a time
    const again = await W.runOfferWaitlist(t.jobs, { occupancyId: s.rid });
    assert.equal(again.outcome, 'nothing_to_offer');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE status = 'offered' AND waitlist_entry_id = ANY($1)`,
        [s.entries],
      ),
      1,
    );

    // PAT-01 ignores it: the time passes, the job lapses it
    await t.age(offer.occupancy_id);
    const lapse = await W.runExpireOffer(t.jobs, { offerId: offer.id, patientId: p1.patientId });
    assert.equal(lapse, 'expired');
    assert.equal((await offerOf(offer.id)).status, 'expired');
    assert.equal((await occ(offer.occupancy_id)).status, 'expired');
    assert.equal(
      await entryStatus(s.entries[0] as string),
      'active',
      'PAT-01 keeps a place in line',
    );
    assert.equal(
      await W.runExpireOffer(t.jobs, { offerId: offer.id, patientId: p1.patientId }),
      'already_decided',
      'the lapse is idempotent',
    );
    // the lapse freed the hold: the chain offers the slot to PAT-02, never to PAT-01 again
    const next = await s.chain(offer.occupancy_id);
    assert.equal(next.outcome, 'offered', JSON.stringify(next));
    const second = await one<{ patient_id: string; status: string }>(
      `SELECT patient_id, status FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
      [s.entries[1]],
    );
    assert.deepEqual([second.patient_id, second.status], [p2.patientId, 'offered']);
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
        [s.entries[0]],
      ),
      1,
    );
    // and when PAT-02's lapses too, nobody is left: PAT-01 (already offered this slot) is not offered it again
    const o2 = await one<{ id: string; occupancy_id: string }>(
      `SELECT id, occupancy_id FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
      [s.entries[1]],
    );
    await t.age(o2.occupancy_id);
    assert.equal(
      await W.runExpireOffer(t.jobs, { offerId: o2.id, patientId: p2.patientId }),
      'expired',
    );
    const last = await s.chain(o2.occupancy_id);
    assert.equal(last.outcome, 'no_candidate', JSON.stringify(last));
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
        [s.entries[0]],
      ),
      1,
    );
  });

  test('the offer time is the stored setting: 15 minutes for a slot within 24 hours (TC-BK-21), and a changed setting applies to the next offer', async () => {
    t.clock.at = undefined;
    const soon = new Date(Date.now() + 3 * 3_600_000);
    soon.setUTCMinutes(0, 0, 0);
    const s = await scenario({ start: soon, waiters: 2, staffBooker: true });
    await s.free();
    const r = await s.chain(s.rid);
    assert.equal(r.outcome, 'offered', JSON.stringify(r));
    const o = await one<{ id: string; occupancy_id: string; s: string }>(
      `SELECT id, occupancy_id, extract(epoch FROM (expires_at - created_at))::int AS s FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
      [s.entries[0]],
    );
    assert.equal(Number(o.s), 15 * 60);
    // accepting inside the window books the slot
    const [p1, p2] = s.people as [PatientKit, PatientKit];
    const accepted = await t.as(p1.scope, (tx) => t.flow.waitlist.acceptOffer(tx, meta(), o.id));
    assert.equal(accepted.status, 'accepted');
    assert.equal((await occ(o.occupancy_id)).status, 'confirmed');
    void p2;
    // a second slot: the "16 minute" run. The offer is past its time: refused as "no longer available", and the offer passes to PAT-02
    const s2 = await scenario({
      start: new Date(soon.getTime() + 3_600_000),
      waiters: 2,
      staffBooker: true,
    });
    await s2.free();
    assert.equal((await s2.chain(s2.rid)).outcome, 'offered');
    const o2 = await one<{ id: string; occupancy_id: string }>(
      `SELECT id, occupancy_id FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
      [s2.entries[0]],
    );
    await t.age(o2.occupancy_id);
    await rejectsWith(
      t.as((s2.people[0] as PatientKit).scope, (tx) =>
        t.flow.waitlist.acceptOffer(tx, meta(), o2.id),
      ),
      'scheduling.offer_expired',
    );
    assert.equal((await occ(o2.occupancy_id)).status, 'held', 'a refused acceptance books nothing');
    assert.equal(
      await W.runExpireOffer(t.jobs, {
        offerId: o2.id,
        patientId: (s2.people[0] as PatientKit).patientId,
      }),
      'expired',
    );
    assert.equal((await s2.chain(o2.occupancy_id)).outcome, 'offered');
    assert.equal(
      (
        await one<{ patient_id: string }>(
          `SELECT patient_id FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
          [s2.entries[1]],
        )
      ).patient_id,
      (s2.people[1] as PatientKit).patientId,
    );
    // a slot more than 24 hours away: 30 minutes; the setting is read, not a number in code
    await t.k.sa.query(
      `UPDATE kernel.setting SET value = '{"default": 45, "within_24h": 20}'::jsonb WHERE key = 'waitlist_offer_minutes'`,
    );
    const far = await scenario({ waiters: 1 });
    await far.free();
    assert.equal((await far.chain(far.rid)).outcome, 'offered');
    assert.equal(
      Number(
        (
          await one<{ s: string }>(
            `SELECT extract(epoch FROM (expires_at - created_at))::int AS s FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
            [far.entries[0]],
          )
        ).s,
      ),
      45 * 60,
    );
    await t.k.sa.query(
      `UPDATE kernel.setting SET value = '{"default": 30, "within_24h": 15}'::jsonb WHERE key = 'waitlist_offer_minutes'`,
    );
  });

  test('the hold rules apply to each candidate: an overlapping appointment, no portal account, a window, a doctor, a service or a place that does not fit; a cancelled entry is skipped', async () => {
    t.clock.at = undefined;
    const doc = (await t.doctor()).principalId;
    const booker = await t.patient(1900);
    const start = slotStart(nextDay());
    const rid = await t.confirmed(booker, doc, start);
    const mk = async (
      n: number,
      over: Partial<{
        clinicianId: string | null;
        serviceId: string;
        locationId: string | null;
        from: Date;
        to: Date;
      }> = {},
    ) => {
      const p = await t.bare(n);
      const e = await t.as(p.scope, (tx) =>
        t.flow.waitlist.createEntry(tx, meta(), {
          patientId: p.patientId,
          serviceId: over.serviceId ?? SVC,
          clinicianId: over.clinicianId === undefined ? doc : over.clinicianId,
          locationId: over.locationId === undefined ? null : over.locationId,
          from: iso(over.from ?? new Date(Date.now() + 3_600_000)),
          to: iso(over.to ?? new Date(Date.now() + 90 * 86_400_000)),
        }),
      );
      return { p, e };
    };
    await t.allowWaitlist(SVC2);
    const overlapping = await mk(1901); // has an appointment of its own at that time: the overlap rule (BQ-9)
    const other = (await t.doctor()).principalId;
    await t.confirmed(overlapping.p, other, start);
    const wrongDoctor = await mk(1902, { clinicianId: (await t.doctor()).principalId });
    const wrongService = await mk(1903, { serviceId: SVC2 });
    const tooEarly = await mk(1904, {
      from: new Date(start.getTime() + 3_600_000),
      to: new Date(start.getTime() + 86_400_000),
    });
    const tooLate = await mk(1905, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(start.getTime() + 10 * 60_000),
    }); // ends inside the slot
    const cancelled = await mk(1906);
    await t.as(cancelled.p.scope, (tx) => t.flow.waitlist.cancelEntry(tx, meta(), cancelled.e.id));
    const noAccount = await (async () => {
      // a patient the desk registered and who never signed up for the portal: nobody to accept the offer
      const reg = await t.patient(1950);
      await t.k.sa.query(`DELETE FROM identity.patient_link WHERE patient_id = $1`, [
        reg.patientId,
      ]);
      const e = await t.as(sysScopeStaff(), (tx) =>
        t.flow.waitlist.createEntry(tx, meta(), {
          patientId: reg.patientId,
          serviceId: SVC,
          clinicianId: doc,
          from: iso(new Date(Date.now() + 3_600_000)),
          to: iso(new Date(Date.now() + 86_400_000 * 90)),
        }),
      );
      return { pid: reg.patientId, e };
    })();
    const winner = await mk(1907);
    await t.as(booker.scope, (tx) => t.core.cancel(tx, meta(), rid, { reason: 'x' }));
    const r = await W.runOfferWaitlist(t.jobs, { occupancyId: rid });
    assert.equal(r.outcome, 'offered', JSON.stringify(r));
    assert.equal(
      (
        await one<{ patient_id: string }>(
          `SELECT patient_id FROM scheduling.waitlist_offer WHERE id = $1`,
          [r.offerId],
        )
      ).patient_id,
      winner.p.patientId,
    );
    // the overlapping patient was tried first (line order) and skipped; the others never got an offer
    for (const x of [
      overlapping.e,
      wrongDoctor.e,
      wrongService.e,
      tooEarly.e,
      tooLate.e,
      cancelled.e,
      noAccount.e,
    ])
      assert.equal(
        await nrows(
          `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
          [x.id],
        ),
        0,
        x.id,
      );
    assert.equal(await entryStatus(overlapping.e.id), 'active');
    assert.equal(await entryStatus(noAccount.e.id), 'active');
    assert.equal(
      r.tried,
      3 + 0,
      'the entries that fit were tried in order: overlapping, no account, then the winner',
    );
  });
});

function sysScopeStaff(): ScopeSettings {
  return staffScopeCache;
}

describe('accept and decline (29.2; TC-BK-20)', () => {
  test('accepting confirms the held slot: care relationship, entry fulfilled, confirmation event; the same accept again, or by a stranger, changes nothing', async () => {
    const s = await scenario({ waiters: 2 });
    await s.free();
    const r = await s.chain(s.rid);
    assert.equal(r.outcome, 'offered');
    const [p1, p2] = s.people as [PatientKit, PatientKit];
    const o = await offerOf(r.offerId as string);
    const post = (
      who: PatientKit,
      offerId: string,
      action: 'accept' | 'decline',
      key = randomUUID(),
    ) =>
      call(t.k.base, 'POST', `/api/v1/waitlist-offers/${offerId}/${action}`, {
        host: HOST,
        cookie: who.session.cookie,
        headers: writeHeaders(who.session, HOST, key),
        body: {},
      });
    assert.equal(
      (await post(p2, o.id, 'accept')).status,
      404,
      "another patient's offer is not visible",
    );
    assert.equal((await occ(o.occupancy_id)).status, 'held');
    const key = randomUUID();
    const a = await post(p1, o.id, 'accept', key);
    assert.equal(a.status, 200, a.body);
    assert.equal(a.json()['status'], 'accepted');
    assert.equal(a.json()['reservationId'], o.occupancy_id);
    assert.equal((await occ(o.occupancy_id)).status, 'confirmed');
    assert.equal(await entryStatus(s.entries[0] as string), 'fulfilled');
    assert.equal((await offerOf(o.id)).status, 'accepted');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM patient.care_relationship WHERE patient_id = $1 AND location_id = $2`,
        [p1.patientId, A1],
      ),
      1,
    );
    assert.ok(
      (await t.jobsInQueue('scheduling.on_reservation_confirmed')).some(
        (j) => j.payload['reservationId'] === o.occupancy_id,
      ),
    );
    // replay of the same request, and a new request for the same state: the same answer, nothing new
    const replay = await post(p1, o.id, 'accept', key);
    assert.equal(replay.headers['idempotent-replay'], 'true');
    const fresh = await post(p1, o.id, 'accept');
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json()['status'], 'accepted');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'scheduling.waitlist_offer' AND resource_id = $1 AND change ->> 'status' = 'accepted'`,
        [o.id],
      ),
      1,
    );
    // the next entry's offer is not touched, and nobody else is offered an occupied slot
    assert.equal(await entryStatus(s.entries[1] as string), 'active');
    assert.equal((await s.chain(s.rid)).outcome, 'nothing_to_offer');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
        [s.entries[1]],
      ),
      0,
    );
  });

  test('declining releases the hold and the next entry gets the slot; declining twice is the same answer; accepting a declined offer is "no longer available"', async () => {
    const s = await scenario({ waiters: 2 });
    await s.free();
    const r = await s.chain(s.rid);
    const [p1, p2] = s.people as [PatientKit, PatientKit];
    const o = await offerOf(r.offerId as string);
    const post = (who: PatientKit, action: 'accept' | 'decline') =>
      call(t.k.base, 'POST', `/api/v1/waitlist-offers/${o.id}/${action}`, {
        host: HOST,
        cookie: who.session.cookie,
        headers: writeHeaders(who.session, HOST, randomUUID()),
        body: {},
      });
    const d = await post(p1, 'decline');
    assert.equal(d.status, 200, d.body);
    assert.equal(d.json()['status'], 'declined');
    assert.equal((await occ(o.occupancy_id)).status, 'cancelled_patient');
    assert.equal(await entryStatus(s.entries[0] as string), 'active');
    assert.equal(
      (
        await one<{ cancel_reason: string }>(
          `SELECT cancel_reason FROM scheduling.slot_reservation WHERE id = $1`,
          [o.occupancy_id],
        )
      ).cancel_reason,
      'Waitlist offer declined',
    );
    assert.equal((await post(p1, 'decline')).status, 200);
    const late = await post(p1, 'accept');
    assert.equal(late.status, 409);
    assert.equal(late.json()['code'], 'scheduling.offer_expired');
    assert.ok(
      (await t.jobsInQueue('scheduling.on_slot_freed')).some(
        (j) => j.payload['occupancyId'] === o.occupancy_id,
      ),
    );
    const next = await s.chain(o.occupancy_id);
    assert.equal(next.outcome, 'offered');
    assert.equal(
      (
        await one<{ patient_id: string }>(
          `SELECT patient_id FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
          [s.entries[1]],
        )
      ).patient_id,
      p2.patientId,
    );
    // the first entry is not offered the slot it declined
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1 AND status = 'offered'`,
        [s.entries[0]],
      ),
      0,
    );
  });

  test('ten acceptances at once (the patient on several devices): one booking, one set of side effects, everyone gets the accepted offer (TC-BK-20)', async () => {
    const s = await scenario({ waiters: 1 });
    await s.free();
    const r = await s.chain(s.rid);
    const p1 = s.people[0] as PatientKit;
    const o = await offerOf(r.offerId as string);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        t.as(p1.scope, (tx) => t.flow.waitlist.acceptOffer(tx, meta(), o.id)),
      ),
    );
    assert.ok(
      results.every((x) => x.status === 'fulfilled' && x.value.status === 'accepted'),
      JSON.stringify(results.filter((x) => x.status === 'rejected')),
    );
    assert.equal((await occ(o.occupancy_id)).status, 'confirmed');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'scheduling.waitlist_offer' AND resource_id = $1 AND change ->> 'status' = 'accepted'`,
        [o.id],
      ),
      1,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND status IN ('held', 'confirmed') AND period = (SELECT period FROM scheduling.slot_occupancy WHERE id = $2)`,
        [s.doc, o.occupancy_id],
      ),
      1,
    );
  });

  test('a second patient trying to book the held slot at the same moment as the first one accepts: only the first is booked, the other sees slot_taken', async () => {
    const s = await scenario({ waiters: 1 });
    await s.free();
    const r = await s.chain(s.rid);
    const p1 = s.people[0] as PatientKit;
    const rival = await t.bare(3000 + day);
    const o = await offerOf(r.offerId as string);
    const [acc, hold] = await Promise.allSettled([
      t.as(p1.scope, (tx) => t.flow.waitlist.acceptOffer(tx, meta(), o.id)),
      t.as(rival.scope, (tx) =>
        t.core.hold(tx, meta(), {
          patientId: rival.patientId,
          serviceId: SVC,
          locationId: A1,
          clinicianId: s.doc,
          startsAt: iso(s.start),
          mode: 'in_person',
        }),
      ),
    ]);
    assert.equal(acc.status, 'fulfilled');
    assert.equal(hold.status, 'rejected');
    assert.equal((hold as PromiseRejectedResult).reason.code, 'scheduling.slot_taken');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND status IN ('held', 'confirmed') AND period = (SELECT period FROM scheduling.slot_occupancy WHERE id = $2)`,
        [s.doc, o.occupancy_id],
      ),
      1,
    );
  });

  test('two offer jobs for the same freed slot at once: exactly one offer; accept against decline: exactly one wins and the slot and the offer agree', async () => {
    const s = await scenario({ waiters: 3 });
    await s.free();
    const results = await Promise.all([
      W.runOfferWaitlist(t.jobs, { occupancyId: s.rid }),
      W.runOfferWaitlist(t.jobs, { occupancyId: s.rid }),
      W.runOfferWaitlist(t.jobs, { occupancyId: s.rid }),
    ]);
    assert.equal(results.filter((x) => x.outcome === 'offered').length, 1, JSON.stringify(results));
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = ANY($1) AND status = 'offered'`,
        [s.entries],
      ),
      1,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_entry WHERE id = ANY($1) AND status = 'offered'`,
        [s.entries],
      ),
      1,
    );
    const o = await one<{ id: string; occupancy_id: string; patient_id: string }>(
      `SELECT id, occupancy_id, patient_id FROM scheduling.waitlist_offer WHERE waitlist_entry_id = ANY($1)`,
      [s.entries],
    );
    const who = s.people.find((p) => p.patientId === o.patient_id) as PatientKit;
    const [a, d] = await Promise.allSettled([
      t.as(who.scope, (tx) => t.flow.waitlist.acceptOffer(tx, meta(), o.id)),
      t.as(who.scope, (tx) => t.flow.waitlist.declineOffer(tx, meta(), o.id)),
    ]);
    const final = await offerOf(o.id);
    const st = (await occ(o.occupancy_id)).status;
    if (final.status === 'accepted') assert.equal(st, 'confirmed');
    else {
      assert.equal(final.status, 'declined');
      assert.equal(st, 'cancelled_patient');
    }
    assert.ok([a, d].some((x) => x.status === 'fulfilled'));
  });

  test('accept against the lapse job after the time: the acceptance is refused, the offer is expired, nothing is confirmed', async () => {
    const s = await scenario({ waiters: 1 });
    await s.free();
    const r = await s.chain(s.rid);
    const p1 = s.people[0] as PatientKit;
    const o = await offerOf(r.offerId as string);
    await t.age(o.occupancy_id);
    const [acc, lap] = await Promise.allSettled([
      t.as(p1.scope, (tx) => t.flow.waitlist.acceptOffer(tx, meta(), o.id)),
      W.runExpireOffer(t.jobs, { offerId: o.id, patientId: p1.patientId }),
    ]);
    assert.equal(acc.status, 'rejected');
    assert.equal((acc as PromiseRejectedResult).reason.code, 'scheduling.offer_expired');
    assert.equal(lap.status, 'fulfilled');
    assert.equal((await offerOf(o.id)).status, 'expired');
    assert.equal((await occ(o.occupancy_id)).status, 'expired');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND status = 'confirmed'`,
        [s.doc],
      ),
      0,
    );
  });
});

describe('waitlist entries (29.2, 29.3)', () => {
  test('create and cancel over HTTP: disabled for a service without the policy, validation, own patient only, staff list; cancelling an entry with an open offer declines it', async () => {
    t.clock.at = undefined;
    const doc = (await t.doctor()).principalId;
    const p = await t.bare(4000);
    const other = await t.bare(4001);
    const post = (who: PatientKit, body: unknown, key = randomUUID()) =>
      call(t.k.base, 'POST', '/api/v1/waitlist-entries', {
        host: HOST,
        cookie: who.session.cookie,
        headers: writeHeaders(who.session, HOST, key),
        body,
      });
    const body = {
      patientId: p.patientId,
      serviceId: SVC,
      clinicianId: doc,
      from: iso(new Date(Date.now() + 86_400_000)),
      to: iso(new Date(Date.now() + 30 * 86_400_000)),
    };
    const none = await post(p, { ...body, serviceId: SVC_IP });
    assert.equal(none.status, 422);
    assert.equal(none.json()['code'], 'scheduling.waitlist_disabled');
    for (const bad of [
      { from: 'tomorrow' },
      { to: iso(new Date(Date.now() - 86_400_000)) },
      { serviceId: 'x' },
      { clinicianId: 'x' },
      { to: iso(new Date(Date.now() + 400 * 86_400_000)) },
    ]) {
      const r = await post(p, { ...body, ...bad });
      assert.equal(r.status, 422, JSON.stringify(bad));
    }
    assert.equal(
      (await post(other, body)).status,
      404,
      "another patient's ID is not in this session's scope",
    );
    const key = randomUUID();
    const ok = await post(p, body, key);
    assert.equal(ok.status, 201, ok.body);
    const id = ok.json()['id'] as string;
    assert.equal(ok.json()['status'], 'active');
    assert.equal(ok.headers['location'], `/api/v1/waitlist-entries/${id}`);
    assert.equal((await post(p, body, key)).headers['idempotent-replay'], 'true');
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.waitlist_entry WHERE patient_id = $1`, [
        p.patientId,
      ]),
      1,
    );
    // staff see the open entries in line order
    const staff = await call(t.k.base, 'GET', `/api/v1/waitlist?serviceId=${SVC}`, {
      cookie: t.lead.cookie,
    });
    assert.equal(staff.status, 200, staff.body);
    // the cancel: own entry only; twice is the same answer; a cancelled entry is final
    const del = (who: PatientKit) =>
      call(t.k.base, 'DELETE', `/api/v1/waitlist-entries/${id}`, {
        host: HOST,
        cookie: who.session.cookie,
        headers: writeHeaders(who.session, HOST, randomUUID()),
      });
    assert.equal((await del(other)).status, 404);
    const c = await del(p);
    assert.equal(c.status, 200, c.body);
    assert.deepEqual([c.json()['status'], c.json()['cancelReason']], ['cancelled', 'patient']);
    assert.equal((await del(p)).status, 200);

    // an entry with an open offer: the patient's cancel declines the offer first, the held slot goes to the next entry; staff cannot
    const s = await scenario({ waiters: 2 });
    await s.free();
    const r = await s.chain(s.rid);
    const o = await offerOf(r.offerId as string);
    const staffDel = await call(t.k.base, 'DELETE', `/api/v1/waitlist-entries/${s.entries[0]}`, {
      cookie: t.lead.cookie,
      headers: writeHeaders(t.lead, undefined, randomUUID()),
    });
    assert.ok(
      [403, 404].includes(staffDel.status),
      `a staff session is not a patient route (${staffDel.status})`,
    );
    await t.as((s.people[0] as PatientKit).scope, (tx) =>
      t.flow.waitlist.cancelEntry(tx, meta(), s.entries[0] as string),
    );
    assert.equal((await offerOf(o.id)).status, 'declined');
    assert.equal((await occ(o.occupancy_id)).status, 'cancelled_patient');
    assert.equal(await entryStatus(s.entries[0] as string), 'cancelled');
    assert.equal((await s.chain(o.occupancy_id)).outcome, 'offered');
  });
});

describe('pre-visit send (33.1): the invitation is scheduled at start minus the setting, sent once, and skips a cancelled booking', () => {
  test('scheduled by the confirmation event, PHI-free, deduplicated; a booking cancelled before the time is skipped', async () => {
    t.clock.at = undefined;
    const doc = (await t.doctor()).principalId;
    const p = await t.patient(4100);
    const start = slotStart(nextDay() + 20);
    const rid = await t.confirmed(p, doc, start);
    const ev = (await t.jobsInQueue('scheduling.on_reservation_confirmed')).find(
      (j) => j.payload['reservationId'] === rid,
    );
    assert.deepEqual(ev?.payload, { reservationId: rid, patientId: p.patientId });
    assert.equal(
      await W.runOnReservationConfirmed(t.jobs, ev?.payload as Record<string, unknown>),
      'scheduled',
    );
    const job = (await t.jobsInQueue('scheduling.send_previsit')).find(
      (j) => j.payload['reservationId'] === rid,
    );
    assert.equal(
      iso(job?.run_at as Date),
      iso(new Date(start.getTime() - 72 * 3_600_000)),
      'at start minus the 72 hours of the setting',
    );
    assert.equal(
      await W.runOnReservationConfirmed(t.jobs, ev?.payload as Record<string, unknown>),
      'scheduled',
    );
    assert.equal(
      (await t.jobsInQueue('scheduling.send_previsit')).filter(
        (j) => j.payload['reservationId'] === rid,
      ).length,
      1,
      'one job per reservation',
    );

    assert.equal(
      await W.runSendPrevisit(t.jobs, { reservationId: rid, patientId: p.patientId }),
      'sent',
    );
    const rows = await q<{
      template_key: string;
      patient_id: string;
      variables: Record<string, string>;
    }>(
      `SELECT template_key, patient_id, variables FROM notifications.notification WHERE dedupe_key LIKE $1`,
      [`previsit:${rid}:%`],
    );
    assert.ok(rows.length >= 1);
    for (const m of rows) {
      assert.deepEqual([m.template_key, m.patient_id], ['previsit_request', p.patientId]);
      assert.deepEqual(Object.keys(m.variables).sort(), ['portal_link', 'start_at', 'time_zone']);
    }
    assert.equal(
      await W.runSendPrevisit(t.jobs, { reservationId: rid, patientId: p.patientId }),
      'duplicate',
      'a second run sends nothing',
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM notifications.notification WHERE dedupe_key LIKE $1`, [
        `previsit:${rid}:%`,
      ]),
      rows.length,
    );

    // inside the 72 hours the invitation is due at once; a cancelled booking is skipped
    const p2 = await t.patient(4101);
    const near = new Date(Date.now() + 2 * 86_400_000);
    near.setUTCHours(10, 0, 0, 0);
    const rid2 = await t.confirmed(p2, (await t.doctor()).principalId, near);
    await W.runOnReservationConfirmed(t.jobs, { reservationId: rid2, patientId: p2.patientId });
    const due = (await t.jobsInQueue('scheduling.send_previsit')).find(
      (j) => j.payload['reservationId'] === rid2,
    );
    assert.ok((due?.run_at as Date).getTime() <= Date.now() + 1000);
    await t.as(p2.scope, (tx) =>
      t.core
        .cancel(tx, meta(), rid2, { reason: 'cannot come', acceptFee: true })
        .catch(() => undefined),
    );
    await t.as(await t.staffScope([A1], 'front_desk'), (tx) =>
      t.core.cancel(tx, meta(), rid2, { reason: 'clinic cancelled' }).catch(() => undefined),
    );
    assert.ok(['cancelled_patient', 'cancelled_clinic'].includes((await occ(rid2)).status));
    assert.equal(
      await W.runSendPrevisit(t.jobs, { reservationId: rid2, patientId: p2.patientId }),
      'skipped',
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM notifications.notification WHERE dedupe_key LIKE $1`, [
        `previsit:${rid2}:%`,
      ]),
      0,
      'nothing is sent for a cancelled booking',
    );
    // a held (unconfirmed) reservation is not an appointment either
    const held = await t.as(p2.scope, (tx) =>
      t.core.hold(tx, meta(), {
        patientId: p2.patientId,
        serviceId: SVC,
        locationId: A1,
        clinicianId: doc,
        startsAt: iso(slotStart(nextDay() + 30)),
        mode: 'in_person',
      }),
    );
    assert.equal(
      await W.runSendPrevisit(t.jobs, {
        reservationId: held.reservationId,
        patientId: p2.patientId,
      }),
      'skipped',
    );
    assert.equal(
      await W.runOnReservationConfirmed(t.jobs, {
        reservationId: held.reservationId,
        patientId: p2.patientId,
      }),
      'skipped',
    );
  });
});

describe('merge participant and export part for the flow tables (22.16, 38.2 item 11; TC-BK-22)', () => {
  const counts = async (requestId: string): Promise<Record<string, Record<string, number>>> =>
    (
      await one<{ counts: Record<string, Record<string, number>> }>(
        `SELECT counts FROM patient.merge_request WHERE id = $1`,
        [requestId],
      )
    ).counts;
  const ownerOf = (table: string, id: string) =>
    one<{ patient_id: string }>(`SELECT patient_id FROM ${table} WHERE id = $1`, [id]).then(
      (r) => r.patient_id,
    );
  const sysQ = async (sql: string, p: unknown[] = []) => {
    await t.k.sa.query('BEGIN');
    try {
      await t.k.sa.query(`SET LOCAL session_replication_role = replica`);
      await t.k.sa.query(sql, p);
      await t.k.sa.query('COMMIT');
    } catch (e) {
      await t.k.sa.query('ROLLBACK');
      throw e;
    }
  };

  test('the module registers once for every scheduling table with a patient: both participants together are refused', () => {
    const regs = new ParticipantRegistries();
    registerSchedulingFlowParticipants(regs);
    assert.deepEqual(regs.mergeParticipants().find((x) => x.module === 'scheduling')?.tables, [
      'scheduling.slot_reservation',
      'scheduling.check_in',
      'scheduling.queue_entry',
      'scheduling.waitlist_entry',
      'scheduling.waitlist_offer',
    ]);
    assert.equal(regs.exportContributors().filter((x) => x.module === 'scheduling').length, 1);
    assert.throws(() => registerSchedulingParticipants(regs), RegistryError);
    assert.deepEqual(schedulingFlowMergeParticipant.conflictRules.map((r) => r.table).sort(), [
      'scheduling.check_in',
      'scheduling.queue_entry',
      'scheduling.slot_reservation',
      'scheduling.waitlist_entry',
      'scheduling.waitlist_offer',
    ]);
  });

  test('counts add up for every table; R rows move, K rows stay; the conflict rule keeps the earlier entry; an open offer resolves on the survivor and is never duplicated', async () => {
    t.clock.at = undefined;
    const S = await t.patient(5000);
    const D = await t.patient(5001);
    const doc = (await t.doctor()).principalId;
    const doc2 = (await t.doctor()).principalId;
    // the merged patient's visits: checked in (R), in consultation (check-in K, queue entry R), completed with its queue entry done (K, K)
    const checkIn = async (p: PatientKit, offset: number) => {
      const rid = await t.seed(
        p,
        (await t.doctor()).principalId,
        new Date(Date.UTC(2031, 2, 4, 15, 30 + offset * 40)),
      );
      t.clock.at = new Date('2031-03-04T15:00:00.000Z');
      await t.as(await t.staffScope([A1], 'front_desk'), (tx) =>
        t.flow.checkIn(tx, meta(), rid, { method: 'desk' }),
      );
      t.clock.at = undefined;
      return rid;
    };
    const v1 = await checkIn(D, 0);
    const v2 = await checkIn(D, 1);
    const v3 = await checkIn(D, 2);
    await sysQ(`UPDATE scheduling.slot_occupancy SET status = 'in_consultation' WHERE id = $1`, [
      v2,
    ]);
    await sysQ(`UPDATE scheduling.queue_entry SET stage = 'done' WHERE id = $1`, [v3]);
    await sysQ(`UPDATE scheduling.slot_occupancy SET status = 'completed' WHERE id = $1`, [v3]);

    const win = {
      from: iso(new Date(Date.now() + 3_600_000)),
      to: iso(new Date(Date.now() + 90 * 86_400_000)),
    };
    const entry = (p: PatientKit, clinicianId: string | null, w = win) =>
      t
        .as(p.scope, (tx) =>
          t.flow.waitlist.createEntry(tx, meta(), {
            patientId: p.patientId,
            serviceId: SVC,
            clinicianId,
            ...w,
          }),
        )
        .then((e) => e.id);
    const dEarly = await entry(D, doc); // earlier than the survivor's entry for the same doctor: it stays, the survivor's duplicate is cancelled
    const sLate = await entry(S, doc);
    const sEarly = await entry(S, doc2); // earlier than the merged patient's entry for the same doctor: the merged one is the duplicate
    const dLate = await entry(D, doc2);
    const dOther = await entry(D, (await t.doctor()).principalId); // no conflict: re-pointed
    const dGone = await entry(D, null);
    await t.as(D.scope, (tx) => t.flow.waitlist.cancelEntry(tx, meta(), dGone)); // K
    // an open offer of the merged patient: a held slot, the offer, its entry
    const booker = await t.patient(5002);
    const slotDoc = (await t.doctor()).principalId;
    const rid = await t.confirmed(booker, slotDoc, slotStart(nextDay()));
    const dOffered = await entry(D, slotDoc);
    await t.as(booker.scope, (tx) => t.core.cancel(tx, meta(), rid, { reason: 'x' }));
    const third = await t.bare(5003);
    const thirdEntry = await entry(third, slotDoc);
    const offerRun = await W.runOfferWaitlist(t.jobs, { occupancyId: rid });
    assert.equal(offerRun.outcome, 'offered');
    const offer = await offerOf(offerRun.offerId as string);
    assert.equal(offer.patient_id, D.patientId);

    // sanity of the starting rows
    assert.equal(await entryStatus(dOffered), 'offered');
    const before = {
      sLatePos: iso(
        (
          await one<{ position_at: Date }>(
            `SELECT position_at FROM scheduling.waitlist_entry WHERE id = $1`,
            [sLate],
          )
        ).position_at,
      ),
    };
    void before;

    const { requestId, result } = await t.merge(S.patientId, D.patientId);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const c = await counts(requestId);
    assert.deepEqual(c['scheduling.check_in'], { found: 3, repointed: 1, resolved: 0, kept: 2 });
    assert.deepEqual(c['scheduling.queue_entry'], { found: 3, repointed: 2, resolved: 0, kept: 1 });
    assert.deepEqual(c['scheduling.waitlist_entry'], {
      found: 5,
      repointed: 3,
      resolved: 1,
      kept: 1,
    });
    assert.deepEqual(c['scheduling.waitlist_offer'], {
      found: 1,
      repointed: 1,
      resolved: 0,
      kept: 0,
    });
    assert.deepEqual(c['scheduling.slot_reservation'], {
      found: 4,
      repointed: 2,
      resolved: 0,
      kept: 2,
    });
    for (const k of [
      'scheduling.check_in',
      'scheduling.queue_entry',
      'scheduling.waitlist_entry',
      'scheduling.waitlist_offer',
      'scheduling.slot_reservation',
    ]) {
      const x = c[k] as Record<string, number>;
      assert.equal(
        x['found'],
        (x['repointed'] as number) + (x['resolved'] as number) + (x['kept'] as number),
        k,
      );
    }
    // R rows moved, K rows stayed
    assert.equal(await ownerOf('scheduling.check_in', v1), S.patientId);
    assert.equal(await ownerOf('scheduling.check_in', v2), D.patientId);
    assert.equal(await ownerOf('scheduling.check_in', v3), D.patientId);
    assert.equal(await ownerOf('scheduling.queue_entry', v1), S.patientId);
    assert.equal(await ownerOf('scheduling.queue_entry', v2), S.patientId);
    assert.equal(await ownerOf('scheduling.queue_entry', v3), D.patientId);
    // the conflict rule: the earlier position stays (and moves), the later is cancelled as a merged duplicate
    assert.equal(await entryStatus(dEarly), 'active');
    assert.equal(await ownerOf('scheduling.waitlist_entry', dEarly), S.patientId);
    assert.equal(await entryStatus(sLate), 'cancelled');
    assert.equal(
      (
        await one<{ cancel_reason: string }>(
          `SELECT cancel_reason FROM scheduling.waitlist_entry WHERE id = $1`,
          [sLate],
        )
      ).cancel_reason,
      'merged_duplicate',
    );
    assert.equal(await entryStatus(sEarly), 'active');
    assert.equal(await entryStatus(dLate), 'cancelled');
    assert.equal(
      (
        await one<{ cancel_reason: string }>(
          `SELECT cancel_reason FROM scheduling.waitlist_entry WHERE id = $1`,
          [dLate],
        )
      ).cancel_reason,
      'merged_duplicate',
    );
    assert.equal(
      await ownerOf('scheduling.waitlist_entry', dLate),
      D.patientId,
      'a resolved row is K and stays',
    );
    assert.equal(await entryStatus(dOther), 'active');
    assert.equal(await ownerOf('scheduling.waitlist_entry', dOther), S.patientId);
    assert.equal(await ownerOf('scheduling.waitlist_entry', dGone), D.patientId);
    // an offered entry is never cancelled by the rule: it moved with its offer and its held reservation
    assert.equal(await entryStatus(dOffered), 'offered');
    assert.equal(await ownerOf('scheduling.waitlist_entry', dOffered), S.patientId);
    assert.equal(await ownerOf('scheduling.waitlist_offer', offer.id), S.patientId);
    assert.equal(await ownerOf('scheduling.slot_reservation', offer.occupancy_id), S.patientId);
    // no R row is left on the merged ID in any flow table
    for (const [table, r] of [
      [
        'scheduling.check_in',
        `id IN (SELECT id FROM scheduling.slot_occupancy WHERE status = 'checked_in')`,
      ],
      ['scheduling.queue_entry', `stage <> 'done'`],
      ['scheduling.waitlist_entry', `status IN ('active', 'offered')`],
      ['scheduling.waitlist_offer', `status = 'offered'`],
    ] as const)
      assert.equal(
        await nrows(`SELECT count(*) AS n FROM ${table} WHERE patient_id = $1 AND ${r}`, [
          D.patientId,
        ]),
        0,
        table,
      );

    // the job in flight names the merged ID: it resolves on the survivor and is not duplicated
    await t.age(offer.occupancy_id);
    assert.equal(
      await W.runExpireOffer(t.jobs, { offerId: offer.id, patientId: D.patientId }),
      'expired',
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE occupancy_id = $1`, [
        offer.occupancy_id,
      ]),
      1,
      'resolved, not duplicated',
    );
    assert.equal((await offerOf(offer.id)).status, 'expired');
    assert.equal(await entryStatus(dOffered), 'active', 'the survivor keeps the place in line');
    // the freed hold goes to the next entry in line: the survivor already had this slot and is not offered it twice
    const next = await W.runOfferWaitlist(t.jobs, { occupancyId: offer.occupancy_id });
    assert.equal(next.outcome, 'offered', JSON.stringify(next));
    assert.equal(
      (
        await one<{ patient_id: string }>(
          `SELECT patient_id FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
          [thirdEntry],
        )
      ).patient_id,
      third.patientId,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
        [dOffered],
      ),
      1,
    );
    // writes for the merged ID are refused from now on
    await assert.rejects(
      t.as(D.scope, (tx) =>
        t.flow.waitlist.createEntry(tx, meta(), {
          patientId: D.patientId,
          serviceId: SVC,
          clinicianId: doc,
          ...win,
        }),
      ),
      (e: { code?: string }) => ['patient.merged', 'kernel.not_found'].includes(e.code as string),
    );
  });

  test('TC-BK-22: a waitlisted patient is merged into another; the slot frees; the offer job resolves to the survivor and offers once', async () => {
    const s = await scenario({ waiters: 1, registered: true });
    const survivor = await t.patient(6000);
    const merged = s.people[0] as PatientKit;
    const { result } = await t.merge(survivor.patientId, merged.patientId);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(
      await ownerOf('scheduling.waitlist_entry', s.entries[0] as string),
      survivor.patientId,
    );
    await s.free();
    const r = await s.chain(s.rid);
    assert.equal(r.outcome, 'offered', JSON.stringify(r));
    const o = await offerOf(r.offerId as string);
    assert.equal(o.patient_id, survivor.patientId);
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE patient_id = $1`, [
        merged.patientId,
      ]),
      0,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
        [s.entries[0]],
      ),
      1,
    );
    // a rerun of the job offers nothing more
    assert.equal(
      (await W.runOfferWaitlist(t.jobs, { occupancyId: s.rid })).outcome,
      'nothing_to_offer',
    );
  });

  test("the privacy export part carries the module's rows for the patient: check-ins, queue entries, waitlist entries and offers (identifiers, states, times)", async () => {
    t.clock.at = undefined;
    const P = await t.patient(7000);
    const rid = await t.seed(
      P,
      (await t.doctor()).principalId,
      new Date('2031-03-04T15:30:00.000Z'),
    );
    t.clock.at = new Date('2031-03-04T15:00:00.000Z');
    await t.as(await t.staffScope([A1], 'front_desk'), (tx) =>
      t.flow.checkIn(tx, meta(), rid, { method: 'desk' }),
    );
    t.clock.at = undefined;
    const e = await t.as(P.scope, (tx) =>
      t.flow.waitlist.createEntry(tx, meta(), {
        patientId: P.patientId,
        serviceId: SVC,
        from: iso(new Date(Date.now() + 3_600_000)),
        to: iso(new Date(Date.now() + 5 * 86_400_000)),
      }),
    );
    const contributor = t.regs.exportContributors().find((x) => x.module === 'scheduling');
    assert.ok(contributor);
    const part = (await t.asWorker(
      {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [P.patientId],
      },
      (tx) =>
        (contributor as NonNullable<typeof contributor>).exportPart(
          tx,
          [P.patientId],
          randomUUID(),
        ),
    )) as Record<string, Record<string, unknown>[]>;
    assert.deepEqual(Object.keys(part).sort(), [
      'checkIns',
      'queueEntries',
      'reservations',
      'waitlistEntries',
      'waitlistOffers',
    ]);
    assert.equal(part['checkIns']?.length, 1);
    assert.equal(part['checkIns']?.[0]?.['reservationId'], rid);
    assert.deepEqual(Object.keys(part['checkIns']?.[0]?.['previsit'] as object).sort(), [
      'consents',
      'insurance',
      'questionnaire',
    ]);
    assert.equal(part['queueEntries']?.[0]?.['stage'], 'waiting');
    assert.equal(part['waitlistEntries']?.[0]?.['id'], e.id);
    assert.equal(part['reservations']?.length, 1);
    // a job scoped to another patient reads none of this patient's rows, whatever IDs it asks for
    const other = await t.bare(7001);
    const leak = (await t.asWorker(
      {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [other.patientId],
      },
      (tx) =>
        (contributor as NonNullable<typeof contributor>).exportPart(
          tx,
          [P.patientId],
          randomUUID(),
        ),
    )) as Record<string, unknown[]>;
    assert.deepEqual(
      Object.values(leak).map((x) => x.length),
      [0, 0, 0, 0, 0],
    );
  });
});

describe('an overbookable slot and the waitlist (HEAAA-632 T9 d, R8)', () => {
  const setCap = (cap: number): Promise<unknown> =>
    t.k.sa.query(
      `UPDATE organisation.booking_policy SET overbook_cap_per_session = $2 WHERE service_id = $1 AND location_id IS NULL`,
      [SVC, cap],
    );

  test('cancelling the only booking of an overbookable slot offers it to the waitlist; cancelling one of two does not', async () => {
    await setCap(2);
    try {
      const only = await scenario({ waiters: 1, overbook: true });
      assert.equal(
        await nrows(
          `SELECT count(*) AS n FROM scheduling.slot_occupancy WHERE id = $1 AND overbook`,
          [only.rid],
        ),
        1,
        'the first booking of an overbookable slot is an overbook row',
      );
      await only.free();
      const r1 = await only.chain(only.rid);
      assert.equal(r1.outcome, 'offered', JSON.stringify(r1));

      const two = await scenario({ waiters: 1, overbook: true });
      const second = await t.patient(9000 + (day += 1));
      await t.confirmed(second, two.doc, two.start);
      await two.free();
      const r2 = await two.chain(two.rid);
      assert.notEqual(r2.outcome, 'offered', JSON.stringify(r2));
      assert.equal(
        await nrows(
          `SELECT count(*) AS n FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
          [two.entries[0]],
        ),
        0,
        'the slot still holds the other booking: nothing is offered',
      );
    } finally {
      await setCap(0);
    }
  });
});

void sysScope;
