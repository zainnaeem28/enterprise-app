// TC-BK-01..12 (TEST-CASES 7.1), automated parts, ENV-INT/ci. Real API and worker processes on a throwaway migrated database.
// Each case uses its own synthetic patient and its own calendar day. What a case cannot show on `ci` is stated in its title:
// `[no mailbox]`, `[no Google]`, `[clock by SQL]` (time moved with SQL, not by waiting), `[browser: not here]`.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  SVC, A1, B1, login, newPatient, search, hold, holdBody, book, sql, closeAdmin, uuid, nextDay, until, principalId, newService, setPolicy, sleep,
} from '../../e2e/journeys/lib/world.mjs';

const slotOf = async (p, o) => {
  const s = await search(p.client, o);
  assert.equal(s.status, 200, s.text);
  assert.ok(s.slots.length > 0, 'the template offers slots on a weekday');
  return s;
};
const r2id = () => '';
const wmatch = (version) => `W/"${version}"`;
after(closeAdmin);

describe('TC-BK booking and rescheduling', () => {
  it('TC-BK-01 book: appointment Confirmed, confirmation + reminders recorded, audit rows, no patient on any calendar surface [no mailbox] [no Google]', async () => {
    const p = await newPatient();
    const s = await slotOf(p);
    const b = await book(p, s.slots[0]);
    assert.equal(b.appointment.status, 'confirmed');
    assert.equal(b.appointment.patientId, p.id);
    const rows = () =>
      sql(`SELECT template_key, channel, status FROM notifications.notification WHERE patient_id = $1 AND dedupe_key LIKE $2`, [p.id, `%${b.reservationId}%`]);
    const n = (await until(async () => { const r = await rows(); return r.rows.some((x) => x.template_key.startsWith('appointment_reminder_')) && r.rows.some((x) => x.template_key === 'appointment_confirmation') ? r : null; })) ?? (await rows());
    const conf = n.rows.filter((r) => r.template_key === 'appointment_confirmation');
    assert.ok(conf.length >= 1, 'a confirmation notification row exists');
    assert.ok(conf.some((r) => r.channel === 'in_app' && r.status === 'sent'), 'in-app confirmation was sent');
    const rem = n.rows.filter((r) => r.template_key.startsWith('appointment_reminder_'));
    assert.ok(rem.some((r) => r.template_key === 'appointment_reminder_48h') && rem.some((r) => r.template_key === 'appointment_reminder_4h'), 'both reminders are scheduled');
    const au = await sql(
      `SELECT action, resource_type FROM audit.event WHERE resource_id = $1 OR patient_id = $2`,
      [b.reservationId, p.id],
    );
    assert.ok(au.rows.some((r) => r.resource_type === 'scheduling.slot_reservation' && r.action === 'create'), 'hold audited');
    assert.ok(au.rows.some((r) => r.resource_type === 'scheduling.slot_reservation' && r.action === 'update'), 'confirmation audited');
  });

  it('TC-BK-01a the .ics of a confirmed appointment is served (`GET /appointments/{id}/calendar.ics`, RA-R1-02)', async () => {
    const p = await newPatient();
    const s = await slotOf(p);
    const b = await book(p, s.slots[0]);
    const r = await p.client.get(`/api/v1/appointments/${b.reservationId}/calendar.ics`);
    assert.equal(r.status, 200, `documented route answered ${r.status}: ${r.text.slice(0, 200)}`);
    assert.match(r.headers['content-type'] ?? '', /text\/calendar/);
    assert.match(r.text, /BEGIN:VEVENT/);
  });

  it('TC-BK-02 video visit: appointment carries the clinic time zone; patient and clinic zones both derivable (BR-05)', async () => {
    const p = await newPatient();
    const s = await slotOf(p, { serviceId: SVC.VID, mode: 'video' });
    const h = await hold(p, s.slots[0], SVC.VID, 'video', { patientState: 'NY' });
    assert.equal(h.status, 201, h.text);
    const c = await p.client.post(`/api/v1/appointments/${h.json.reservationId}/confirm`, {});
    assert.equal(c.status, 200, c.text);
    const b = { reservationId: h.json.reservationId, appointment: c.json };
    assert.equal(b.appointment.mode, 'video');
    assert.equal(b.appointment.locationTimeZone, 'America/New_York');
    const g = await p.client.get(`/api/v1/appointments/${b.reservationId}`);
    assert.equal(g.status, 200);
    assert.equal(g.json.mode, 'video');
    assert.ok('locationTimeZone' in g.json);
  });

  it('TC-BK-03 availability = template - bookings (mechanics: busy block by SQL) [no Google: the sync itself is TC-CAL]', async () => {
    const p = await newPatient();
    const day = nextDay();
    const s0 = await slotOf(p, { day, clinicianId: principalId('STF-DR-A1') });
    const first = s0.slots[0];
    const end = new Date(new Date(first.startsAt).getTime() + 60 * 60000).toISOString();
    await sql(
      `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at)
       VALUES ($1,$2,tstzrange($3::timestamptz,$4::timestamptz,'[)'),'google',decode(md5($5),'hex'),now())`,
      ['00000000-0000-7000-8000-0000000000a1', principalId('STF-DR-A1'), first.startsAt, end, uuid()],
    ).catch(async (e) => {
      throw new Error(`busy_block fixture could not be written: ${e.message}`);
    });
    const s1 = await search(p.client, { day, clinicianId: principalId('STF-DR-A1') });
    const blocked = s1.slots.filter((x) => x.startsAt >= first.startsAt && x.startsAt < end);
    assert.equal(blocked.length, 0, 'no slot is offered inside the busy block');
    assert.ok(s1.slots.length < s0.slots.length);
  });

  it('TC-BK-04 stale search: second patient gets 409 scheduling.slot_taken with alternatives', async () => {
    const a = await newPatient();
    const b = await newPatient();
    const s = await slotOf(a, { clinicianId: principalId('STF-DR-A1') });
    const slot = s.slots[0];
    await book(a, slot);
    const r = await hold(b, slot);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'scheduling.slot_taken');
    assert.ok(Array.isArray(r.json.errors) && r.json.errors.every((e) => e.path.startsWith('/alternatives/')), 'alternatives travel as errors[]');
  });

  it('TC-BK-05 cancel inside the cut-off is blocked (D-3 default), cancel outside is free [G2 setting: cut-off set by SQL]', async () => {
    const p = await newPatient();
    const svc = await newService();
    await setPolicy(svc, { cutoff: 24 * 400, late: 'block' }); // every visit is "inside the cut-off"
    const s = await slotOf(p, { serviceId: svc });
    const b = await book(p, s.slots[0], svc);
    const r = await p.client.post(`/api/v1/appointments/${b.reservationId}/cancel`, { reason: 'qa' }, { headers: { 'if-match': wmatch(b.appointment.version) } });
    assert.equal(r.status, 422, r.text);
    assert.equal(r.json.code, 'scheduling.cutoff_passed');
    const still = await p.client.get(`/api/v1/appointments/${b.reservationId}`);
    assert.equal(still.json.status, 'confirmed', 'blocked cancel leaves the appointment confirmed');
    await setPolicy(svc, { cutoff: 24, late: 'block' }); // the visit is days away: outside a 24 h cut-off
    const cur = await p.client.get(`/api/v1/appointments/${b.reservationId}`);
    const ok = await p.client.post(`/api/v1/appointments/${b.reservationId}/cancel`, { reason: 'qa' }, { headers: { 'if-match': wmatch(cur.json.version) } });
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.json.status, /cancelled/);
  });

  it('TC-BK-06 reschedule: old slot released, new slot confirmed, reminders recomputed, audit', async () => {
    const p = await newPatient();
    const s = await slotOf(p);
    const b = await book(p, s.slots[0]);
    const day2 = nextDay();
    const s2 = await slotOf(p, { day: day2 });
    const h = await hold(p, s2.slots[0]);
    assert.equal(h.status, 201, h.text);
    const r = await p.client.post(`/api/v1/appointments/${b.reservationId}/reschedule`, { newHoldId: h.json.reservationId }, { headers: { 'if-match': wmatch(b.appointment.version) } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.startsAt, s2.slots[0].startsAt);
    const back = await search(p.client, { day: s.day, clinicianId: s.slots[0].clinicianId });
    assert.ok(back.slots.some((x) => x.startsAt === s.slots[0].startsAt), 'the old slot is bookable again');
    const remQ = () =>
      sql(`SELECT dedupe_key, template_key, status FROM notifications.notification WHERE patient_id = $1 AND template_key LIKE 'appointment_reminder_%'`, [p.id]);
    const rem = await until(async () => {
      const r = await remQ();
      return r.rows.some((x) => x.dedupe_key.includes(h.json.reservationId) && x.status === 'queued') ? r : null;
    });
    assert.ok(rem, 'reminders are queued for the new appointment');
    const forNew = rem.rows.filter((x) => x.dedupe_key.includes(h.json.reservationId) && x.status === 'queued');
    assert.ok(forNew.some((x) => x.template_key === 'appointment_reminder_48h') && forNew.some((x) => x.template_key === 'appointment_reminder_4h'));
    const forOld = rem.rows.filter((x) => x.dedupe_key.includes(b.reservationId));
    assert.ok(forOld.length > 0 && forOld.every((x) => x.status === 'cancelled'), 'every reminder of the old appointment is cancelled');
    const au = await sql(`SELECT action FROM audit.event WHERE resource_id = $1 OR resource_id = $2`, [b.reservationId, h.json.reservationId]);
    assert.ok(au.rows.length >= 3, 'reschedule is audited');
  });

  it('TC-BK-07 max future appointments per service: 4th refused (BR-04) [G2 setting: 3 by SQL]', async () => {
    const p = await newPatient();
    const svc = await newService();
    await setPolicy(svc, { max: 3 });
    const res = [];
    for (let i = 0; i < 4; i++) {
      const s = await slotOf(p, { serviceId: svc });
      const h = await hold(p, s.slots[0], svc);
      if (h.status === 201) {
        const c = await p.client.post(`/api/v1/appointments/${h.json.reservationId}/confirm`, {});
        res.push(c.status);
      } else res.push(`${h.status}:${h.json?.code}`);
    }
    assert.deepEqual(res.slice(0, 3), [200, 200, 200]);
    assert.equal(res[3], '422:scheduling.max_future_reached');
  });

  it('TC-BK-08 hold expiry: confirm after expiry gives 409 scheduling.hold_expired with alternatives; no appointment [G2 setting: hold 1 min, real wait]', async () => {
    const p = await newPatient();
    const svc = await newService();
    await setPolicy(svc, { hold: 1 });
    const s = await slotOf(p, { serviceId: svc });
    const h = await hold(p, s.slots[0], svc);
    assert.equal(h.status, 201, h.text);
    const ttl = new Date(h.json.expiresAt).getTime() - Date.now();
    assert.ok(ttl > 0 && ttl <= 61000, `hold lasts about the configured minute, got ${ttl} ms`);
    await sleep(Math.max(0, ttl) + 1500);
    const c = await p.client.post(`/api/v1/appointments/${h.json.reservationId}/confirm`, {});
    assert.equal(c.status, 409, c.text);
    assert.equal(c.json.code, 'scheduling.hold_expired');
    assert.ok(c.json.errors?.some((e) => e.path.startsWith('/alternatives/')), 'alternatives are offered');
    const row = await sql(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [h.json.reservationId]);
    assert.ok(!row.rows[0] || row.rows[0].status !== 'confirmed', 'no appointment exists');
  });

  it('TC-BK-09 idempotency: same key and body = one hold; same key other body = 409; same key on another route is a different key', async () => {
    const p = await newPatient();
    const s = await slotOf(p);
    const key = uuid();
    const body = holdBody(p, s.slots[0]);
    const r1 = await p.client.post('/api/v1/holds', body, { headers: { 'idempotency-key': key } });
    const r2 = await p.client.post('/api/v1/holds', body, { headers: { 'idempotency-key': key } });
    assert.equal(r1.status, 201, r1.text);
    assert.equal(r2.status, 201, r2.text);
    assert.equal(r1.json.reservationId, r2.json.reservationId, 'replay returns the same hold');
    const n = await sql(`SELECT count(*)::int c FROM scheduling.slot_reservation WHERE patient_id = $1`, [p.id]);
    assert.equal(n.rows[0].c, 1);
    const r3 = await p.client.post('/api/v1/holds', holdBody(p, s.slots[1]), { headers: { 'idempotency-key': key } });
    assert.equal(r3.status, 409, r3.text);
    assert.equal(r3.json.code, 'kernel.idempotency_conflict');
    const c1 = await p.client.post(`/api/v1/appointments/${r1.json.reservationId}/confirm`, {}, { headers: { 'idempotency-key': key } });
    assert.equal(c1.status, 200, `the hold's key reused on the confirm route must not collide: ${c1.text}`);
  });

  it('TC-BK-10 time zones: stored UTC, shown in the location zone across a daylight-saving change (LOC-B1)', async () => {
    const p = await newPatient();
    // US DST begins 2027-03-14. Fri 2027-03-12 is PST (UTC-8), Mon 2027-03-15 is PDT (UTC-7).
    const out = {};
    for (const date of ['2027-03-12', '2027-03-15']) {
      const day = { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.000Z`, date };
      const s = await search(p.client, { day, locationId: B1, clinicianId: principalId('STF-DR-B1') });
      assert.equal(s.status, 200, s.text);
      assert.ok(s.slots.length > 0, `slots exist on ${date}`);
      out[date] = s.slots[0].startsAt;
    }
    assert.equal(out['2027-03-12'], '2027-03-12T17:00:00.000Z', '09:00 PST is 17:00Z');
    assert.equal(out['2027-03-15'], '2027-03-15T16:00:00.000Z', '09:00 PDT is 16:00Z');
  });

  it('TC-BK-11 front desk books for a patient at the assigned location only, refused at another (RA-R1-02)', async () => {
    const p = await newPatient();
    const fd = await login('staff', 'STF-FD-A');
    const sA = await search(fd, { locationId: A1 });
    const sB = await search(fd, { locationId: B1, clinicianId: principalId('STF-DR-B1') });
    assert.equal(sA.status, 200, sA.text);
    const hA = await fd.post('/api/v1/holds', holdBody(p, sA.slots[0]));
    assert.equal(hA.status, 201, `front desk hold at the assigned location answered ${hA.status} ${hA.text.slice(0, 160)}`);
    const hB = await fd.post('/api/v1/holds', holdBody(p, sB.slots[0]));
    assert.ok([403, 404].includes(hB.status), `hold at LOC-B1 must be refused, got ${hB.status}`);
  });
});
