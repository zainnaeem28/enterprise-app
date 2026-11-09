// TC-BK-17, TC-BK-18, TC-BK-22 (TEST-CASES 7.2): room race, no leakage of other patients' data, waitlist after a merge. ENV-INT/ci.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  SVC, A1, newPatient, nextDay, soon, deskCheckIn, queueEntry, search, book, hold, sql, closeAdmin, newService, setPolicy, newDoctor, newStaff, state, until,
} from '../../e2e/journeys/lib/world.mjs';

after(closeAdmin);
const W = (v) => `W/"${v}"`;
const ROOM_A = '00000000-0000-7000-8000-000000000401';
const ROOM_B = '00000000-0000-7000-8000-000000000402';

function publicGet(path) {
  const port = state().ports.api;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: 'integrations.localhost', 'x-forwarded-for': '10.201.0.9', 'x-client-release': 'r1.000000000000' } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('TC-BK rooms, leakage, merge', () => {
  it('TC-BK-17 room: three checked-in visits at one time, three parallel assignments of the SAME room: exactly one succeeds (SAR-09)', async (t) => {
    const svc = await newService();
    await setPolicy(svc, { cutoff: 0, max: 50 });
    const docs = [await newDoctor({ services: [svc], allDay: true }), await newDoctor({ services: [svc], allDay: true }), await newDoctor({ services: [svc], allDay: true })];
    const desk = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const day = soon(1, 5);
    const entries = [];
    let start;
    for (const d of docs) {
      const p = await newPatient();
      const s = await search(p.client, { serviceId: svc, clinicianId: d.id, day });
      start ??= s.slots[0].startsAt;
      const slot = s.slots.find((x) => x.startsAt === start);
      const appt = (await book(p, slot, svc)).appointment;
      const ci = await deskCheckIn(desk, appt);
      assert.equal(ci.status, 200, ci.text);
      entries.push(await queueEntry(desk, A1, appt.id));
    }
    assert.ok(entries.every(Boolean), 'all three are in the queue');
    const res = await Promise.all(
      entries.map((e) => desk.client.put(`/api/v1/appointments/${e.id}/assignment`, { roomId: ROOM_A }, { headers: { 'if-match': W(e.version) } })),
    );
    t.diagnostic(`assignment statuses: ${res.map((r) => r.status + ':' + (r.json?.code ?? 'ok')).join(', ')}`);
    assert.ok(res.every((r) => r.status < 500), 'no server error');
    assert.equal(res.filter((r) => r.status === 200).length, 1, 'exactly one assignment succeeds');
    assert.ok(res.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.json.code === 'scheduling.slot_taken'), 'the others get slot_taken');
    const n = await sql(`SELECT count(*)::int c FROM scheduling.slot_occupancy WHERE room_id = $1 AND lower(period) = $2::timestamptz AND status IN ('held','confirmed','checked_in')`, [ROOM_A, start]);
    assert.equal(n.rows[0].c, 1, 'one occupancy holds the room');
  });

  it('TC-BK-18 slot search and /public/v1 show no identifiers of other patients, reservations or rooms', async () => {
    const svc = await newService();
    const doc = await newDoctor({ services: [svc] });
    const [p1, p2, p3] = [await newPatient(), await newPatient(), await newPatient()];
    const s = await search(p1.client, { serviceId: svc, clinicianId: doc.id });
    const b1 = await book(p1, s.slots[0], svc);
    const b2 = await book(p2, s.slots[1], svc);
    const h3 = await hold(p3, s.slots[2], svc);
    assert.equal(h3.status, 201);
    const forbidden = [p2.id, p3.id, b1.reservationId, b2.reservationId, h3.json.reservationId, ROOM_A, ROOM_B];
    const view = await search(p1.client, { serviceId: svc, clinicianId: doc.id });
    assert.equal(view.status, 200);
    for (const id of forbidden) assert.ok(!view.text.includes(id), `search response must not contain ${id}`);
    const keys = new Set(['startsAt', 'endsAt', 'clinicianId', 'locationId', 'mode']);
    assert.ok(view.slots.every((x) => Object.keys(x).every((k) => keys.has(k))), 'slot objects carry only documented keys');
    assert.deepEqual(Object.keys(view.json).sort(), ['availabilityStale', 'slots']);
    const taken = new Set([s.slots[0].startsAt, s.slots[1].startsAt, s.slots[2].startsAt]);
    assert.ok(view.slots.every((x) => !taken.has(x.startsAt)), 'booked and held starts are not offered to another patient');
    for (const path of ['/public/v1/clinicians', '/public/v1/locations', '/public/v1/services', `/public/v1/clinicians?serviceId=${svc}`]) {
      const r = await publicGet(path);
      assert.equal(r.status, 200, `${path}: ${r.status} ${r.text.slice(0, 120)}`);
      for (const id of forbidden) assert.ok(!r.text.includes(id), `${path} must not contain ${id}`);
    }
  });
});

describe('TC-BK waitlist and merge', () => {
  it('TC-BK-22 a waitlisted patient is merged into another: the freed slot is offered once, to the survivor', async () => {
    const svc = await newService();
    await setPolicy(svc, { waitlist: true, cutoff: 1, max: 50 });
    const doc = await newDoctor({ services: [svc] });
    const [a, dup, survivor] = [await newPatient(), await newPatient(), await newPatient()];
    const s = await search(a.client, { serviceId: svc, clinicianId: doc.id });
    const slot = s.slots[0];
    const bk = await book(a, slot, svc);
    const to = new Date(new Date(slot.startsAt).getTime() + 20 * 60000).toISOString();
    const j = await dup.client.post('/api/v1/waitlist-entries', { patientId: dup.id, serviceId: svc, clinicianId: doc.id, from: slot.startsAt, to });
    assert.equal(j.status, 201, j.text);
    const lead = await newStaff([['front_desk_lead', A1]], { name: 'STF-FDL' });
    const mro = await newStaff([['medical_records', A1]], { name: 'STF-MRO' });
    const m = await lead.client.post('/api/v1/patient-merges', { survivorId: survivor.id, mergedId: dup.id, reason: 'Same person registered twice (QA)' });
    assert.equal(m.status, 200, m.text);
    const ap = await mro.client.post(`/api/v1/patient-merges/${m.json.id}/approve`, {});
    assert.equal(ap.status, 200, ap.text);
    const done = await until(async () => {
      const g = await mro.client.get(`/api/v1/patient-merges/${m.json.id}`);
      return g.json?.status === 'completed' || g.json?.status === 'done' ? g : null;
    }, { timeoutMs: 60000, everyMs: 1500 });
    assert.ok(done, 'the real worker completes the merge');
    const cur = await a.client.get(`/api/v1/appointments/${bk.reservationId}`);
    const c = await a.client.post(`/api/v1/appointments/${bk.reservationId}/cancel`, { reason: 'qa' }, { headers: { 'if-match': W(cur.json.version) } });
    assert.equal(c.status, 200, c.text);
    const offers = await until(async () => {
      const r = await sql(`SELECT o.id, o.status, e.patient_id FROM scheduling.waitlist_offer o JOIN scheduling.waitlist_entry e ON e.id = o.waitlist_entry_id WHERE e.id = $1`, [j.json.id]);
      return r.rows.length > 0 ? r : null;
    }, { timeoutMs: 30000 });
    assert.ok(offers, 'an offer was made');
    assert.equal(offers.rows.length, 1, 'no duplicate offer');
    assert.equal(offers.rows[0].patient_id, survivor.id, 'the offer resolves to the survivor');
  });
});
