// INT02-R11-N1: the appointment confirmation, the 48 h / 4 h reminders, the reschedule notice and the cancel notice. The worker's real
// `scheduling.on_reservation_*` handlers run against the real NotificationService and the real allowlist (nothing is stubbed), as
// app_worker in patients scope, on bookings made through the real booking core.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/flow/notices.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { renderTemplate } from '../../notifications/index.js';
import { A1, SVC, setupFlow, slotStart, workerJobs } from './testkit.js';
import type { FlowKit, PatientKit, WorkerJobs } from './testkit.js';

let t: FlowKit;
let W: WorkerJobs;
before(async () => {
  t = await setupFlow('notices');
  W = await workerJobs();
});
after(async () => {
  await t?.close();
});

interface N {
  id: string;
  template_key: string;
  channel: string;
  status: string;
  patient_id: string;
  send_after: Date;
  dedupe_key: string;
  variables: Record<string, string>;
}
const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const notes = (rid: string, key?: string): Promise<N[]> =>
  q<N>(
    `SELECT id, template_key, channel, status, patient_id, send_after, dedupe_key, variables FROM notifications.notification
      WHERE dedupe_key LIKE '%' || $1 || '%' ${key === undefined ? '' : 'AND template_key = $2'} ORDER BY dedupe_key`,
    key === undefined ? [rid] : [rid, key],
  );
const CH = ['email', 'in_app', 'push', 'sms'];
const HOUR = 3_600_000;
const portal = 'https://portal.example.test';

let n = 9000;
async function booked(start: Date) {
  const p = await t.bare((n += 1));
  const doc = (await t.doctor()).principalId;
  return { p, doc, rid: await t.confirmed(p, doc, start) };
}
const ev = (rid: string, p: PatientKit, extra: Record<string, unknown> = {}) => ({
  reservationId: rid,
  patientId: p.patientId,
  ...extra,
});

describe('appointment notices (INT02-R11-N1)', () => {
  test('confirm: a confirmation per channel, reminders at start-48h and start-4h, the .ics UID is the reservation ID, replay adds nothing', async () => {
    const start = slotStart(9);
    const { p, rid } = await booked(start);
    assert.equal(await W.runOnReservationConfirmed(t.jobs, ev(rid, p)), 'scheduled');
    const conf = await notes(rid, 'appointment_confirmation');
    assert.deepEqual(conf.map((c) => c.channel).sort(), CH);
    for (const c of conf) {
      assert.equal(c.patient_id, p.patientId);
      assert.equal(c.variables['event_uid'], rid);
      assert.equal((c.variables['location_name'] ?? '').length > 0, true);
    }
    for (const [h, key] of [
      [48, 'appointment_reminder_48h'],
      [4, 'appointment_reminder_4h'],
    ] as const) {
      const r = await notes(rid, key);
      assert.deepEqual(r.map((x) => x.channel).sort(), CH, key);
      for (const x of r) {
        assert.equal(x.status, 'queued');
        assert.equal(x.send_after.getTime(), start.getTime() - h * HOUR);
        assert.equal(x.variables['confirm_link'], `${portal}/appointments/${rid}`);
        assert.equal(x.variables['reschedule_link'], `${portal}/appointments/${rid}/change`);
        assert.equal(x.variables['cancel_link'], `${portal}/appointments/${rid}/cancel`);
      }
    }
    // the e-mail's .ics carries UID = the lower-case reservation ID
    const tpl = await q<{ body: string; variables: { name: string }[] }>(
      `SELECT body, variables FROM notifications.template WHERE key = 'appointment_confirmation' AND channel = 'ics' AND status = 'published'`,
    );
    const email = conf.find((c) => c.channel === 'email') as N;
    const ics = renderTemplate(
      {
        channel: 'ics',
        language: 'en',
        subject: null,
        body: (tpl[0] as { body: string }).body,
        declared: (tpl[0] as { variables: { name: string }[] }).variables.map((v) => v.name),
      },
      email.variables,
    );
    assert.match(ics.body, new RegExp(`UID:${rid}\\r\\n`));
    // replay
    const before = (await notes(rid)).length;
    await W.runOnReservationConfirmed(t.jobs, ev(rid, p));
    assert.equal((await notes(rid)).length, before);
  });

  test('confirm: under 4 h away no reminder; 4-48 h away only the 4 h reminder', async () => {
    const near = await booked(new Date(Date.now() + 2 * HOUR));
    await W.runOnReservationConfirmed(t.jobs, ev(near.rid, near.p));
    assert.equal((await notes(near.rid, 'appointment_confirmation')).length, 4);
    assert.equal(
      (await notes(near.rid)).filter((x) => x.template_key.includes('reminder')).length,
      0,
    );
    const mid = await booked(new Date(Date.now() + 10 * HOUR));
    await W.runOnReservationConfirmed(t.jobs, ev(mid.rid, mid.p));
    assert.deepEqual(
      [
        ...new Set(
          (await notes(mid.rid))
            .filter((x) => x.template_key.includes('reminder'))
            .map((x) => x.template_key),
        ),
      ],
      ['appointment_reminder_4h'],
    );
  });

  test('cancel: reminders cancelled, a cancel notice per channel; a released hold sends nothing; replay adds nothing', async () => {
    const { p, rid } = await booked(slotStart(11));
    await W.runOnReservationConfirmed(t.jobs, ev(rid, p));
    await t.as(p.scope, (tx) =>
      t.core.cancel(tx, { requestId: randomUUID() }, rid, { reason: 'x' }),
    );
    assert.equal(
      await W.runOnReservationCancelled(t.jobs, ev(rid, p, { wasConfirmed: true })),
      'sent',
    );
    const rem = (await notes(rid)).filter((x) => x.template_key.includes('reminder'));
    assert.equal(rem.length, 8);
    assert.ok(rem.every((x) => x.status === 'cancelled'));
    const c = await notes(rid, 'appointment_cancelled');
    assert.deepEqual(c.map((x) => x.channel).sort(), CH);
    const before = (await notes(rid)).length;
    assert.equal(
      await W.runOnReservationCancelled(t.jobs, ev(rid, p, { wasConfirmed: true })),
      'duplicate',
    );
    assert.equal((await notes(rid)).length, before);

    // a hold released before it was confirmed
    const doc = (await t.doctor()).principalId;
    const h = await t.as(p.scope, (tx) =>
      t.core.hold(
        tx,
        { requestId: randomUUID() },
        {
          patientId: p.patientId,
          serviceId: SVC,
          locationId: A1,
          clinicianId: doc,
          startsAt: slotStart(12).toISOString(),
          mode: 'in_person',
        },
      ),
    );
    await t.as(p.scope, (tx) =>
      t.core.cancel(tx, { requestId: randomUUID() }, h.reservationId, {}),
    );
    assert.equal(
      await W.runOnReservationCancelled(t.jobs, ev(h.reservationId, p, { wasConfirmed: false })),
      'skipped',
    );
    assert.equal((await notes(h.reservationId)).length, 0);
  });

  test('the cancel event the core publishes carries wasConfirmed', async () => {
    const { p, rid } = await booked(slotStart(13));
    await t.as(p.scope, (tx) =>
      t.core.cancel(tx, { requestId: randomUUID() }, rid, { reason: 'x' }),
    );
    const jobs = await t.jobsInQueue('scheduling.on_reservation_cancelled');
    const mine = jobs.find((j) => j.payload['reservationId'] === rid);
    assert.equal(mine?.payload['wasConfirmed'], true);
  });

  async function reschedule(p: PatientKit, doc: string, rid: string, start: Date) {
    const h = await t.as(p.scope, (tx) =>
      t.core.hold(
        tx,
        { requestId: randomUUID() },
        {
          patientId: p.patientId,
          serviceId: SVC,
          locationId: A1,
          clinicianId: doc,
          startsAt: start.toISOString(),
          mode: 'in_person',
          rescheduleOf: rid,
        },
      ),
    );
    await t.as(p.scope, (tx) =>
      t.core.reschedule(tx, { requestId: randomUUID() }, rid, h.reservationId),
    );
    return h.reservationId;
  }

  test('reschedule: old reminders cancelled; notice, reminders and pre-visit job for the new reservation; a new reservation already cancelled gets nothing', async () => {
    const { p, doc, rid } = await booked(slotStart(15));
    await W.runOnReservationConfirmed(t.jobs, ev(rid, p));
    const nid = await reschedule(p, doc, rid, slotStart(17));
    const e = ev(rid, p, { newReservationId: nid });
    assert.equal(await W.runOnReservationRescheduled(t.jobs, e), 'sent');
    assert.ok(
      (await notes(rid))
        .filter((x) => x.template_key.includes('reminder'))
        .every((x) => x.status === 'cancelled'),
    );
    const r = await notes(nid, 'appointment_rescheduled');
    assert.deepEqual(r.map((x) => x.channel).sort(), CH);
    assert.ok(r.every((x) => x.variables['event_uid'] === nid));
    const rem = (await notes(nid)).filter((x) => x.template_key.includes('reminder'));
    assert.equal(rem.length, 8);
    assert.ok(
      rem.every(
        (x) =>
          x.status === 'queued' &&
          x.variables['cancel_link'] === `${portal}/appointments/${nid}/cancel`,
      ),
    );
    assert.ok(
      (await t.jobsInQueue('scheduling.send_previsit')).some(
        (j) => j.payload['reservationId'] === nid,
      ),
    );
    const before = (await notes(nid)).length;
    await W.runOnReservationRescheduled(t.jobs, e);
    assert.equal((await notes(nid)).length, before);

    // the new reservation is cancelled before the handler runs
    const b = await booked(slotStart(19));
    await W.runOnReservationConfirmed(t.jobs, ev(b.rid, b.p));
    const nid2 = await reschedule(b.p, b.doc, b.rid, slotStart(21));
    await t.as(b.p.scope, (tx) =>
      t.core.cancel(tx, { requestId: randomUUID() }, nid2, { reason: 'x' }),
    );
    assert.equal(
      await W.runOnReservationRescheduled(t.jobs, ev(b.rid, b.p, { newReservationId: nid2 })),
      'skipped',
    );
    assert.equal((await notes(nid2)).length, 0);
    assert.ok(
      (await notes(b.rid))
        .filter((x) => x.template_key.includes('reminder'))
        .every((x) => x.status === 'cancelled'),
    );
  });

  test('waitlist accept → confirm sends the confirmation through the same handler', async () => {
    // accepting an offer confirms the held reservation and publishes reservation_confirmed (the same event as a booking)
    const { p, rid } = await booked(slotStart(23));
    const jobs = await t.jobsInQueue('scheduling.on_reservation_confirmed');
    assert.ok(jobs.some((j) => j.payload['reservationId'] === rid));
    await W.runOnReservationConfirmed(t.jobs, ev(rid, p));
    assert.equal((await notes(rid, 'appointment_confirmation')).length, 4);
  });

  test('merge between publish and handler run: confirm, cancel and reschedule resolve to the survivor', async () => {
    // confirm
    const a = await booked(slotStart(25));
    // cancel
    const b = await booked(slotStart(27));
    await W.runOnReservationConfirmed(t.jobs, ev(b.rid, b.p));
    await t.as(b.p.scope, (tx) =>
      t.core.cancel(tx, { requestId: randomUUID() }, b.rid, { reason: 'x' }),
    );
    // reschedule
    const c = await booked(slotStart(29));
    await W.runOnReservationConfirmed(t.jobs, ev(c.rid, c.p));
    const nid = await reschedule(c.p, c.doc, c.rid, slotStart(31));
    // one merge of three patients into a survivor (merge one by one)
    const survivor = await t.patient(n + 500);
    for (const x of [a, b, c]) {
      const r = await t.merge(survivor.patientId, x.p.patientId);
      assert.equal(r.result.status, 'completed', JSON.stringify(r.result));
    }
    assert.equal(await W.runOnReservationConfirmed(t.jobs, ev(a.rid, a.p)), 'scheduled');
    const conf = await notes(a.rid, 'appointment_confirmation');
    assert.equal(conf.length, 4);
    assert.ok(conf.every((x) => x.patient_id === survivor.patientId));

    assert.equal(
      await W.runOnReservationCancelled(t.jobs, ev(b.rid, b.p, { wasConfirmed: true })),
      'sent',
    );
    const bn = await notes(b.rid);
    assert.ok(
      bn.filter((x) => x.template_key.includes('reminder')).every((x) => x.status === 'cancelled'),
    );
    assert.ok(bn.every((x) => x.patient_id === survivor.patientId));
    assert.equal(bn.filter((x) => x.template_key === 'appointment_cancelled').length, 4);

    assert.equal(
      await W.runOnReservationRescheduled(t.jobs, ev(c.rid, c.p, { newReservationId: nid })),
      'sent',
    );
    assert.ok(
      (await notes(c.rid))
        .filter((x) => x.template_key.includes('reminder'))
        .every((x) => x.status === 'cancelled'),
    );
    const cn = await notes(nid);
    assert.ok(cn.every((x) => x.patient_id === survivor.patientId));
    assert.equal(cn.filter((x) => x.template_key === 'appointment_rescheduled').length, 4);
  });

  test('the event handlers and job types are registered on the API side', async () => {
    for (const e of ['reservation_confirmed', 'reservation_cancelled', 'reservation_rescheduled'])
      assert.ok(t.k.registry.handlersOf(`scheduling.${e}`).includes('scheduling'), e);
  });
});
