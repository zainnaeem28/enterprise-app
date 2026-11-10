// TC-BK-19..21 (TEST-CASES 7.2, waitlist), ENV-INT/ci: the real API and the REAL worker process (offer, expiry and slot-freed jobs).
// Acceptance windows are [G2 setting]s: they are set to 1-2 minutes so a real wait stands in for the PRD's 30/15 minutes. The
// rule under test (who is offered first, lapse, pass-on, within-24-hour value) is the product's, not a mock.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  newPatient,
  search,
  book,
  sql,
  closeAdmin,
  newService,
  setPolicy,
  setSetting,
  newDoctor,
  sleep,
  until,
  nextDay,
  hold,
  uuid,
} from '../../e2e/journeys/lib/world.mjs';

after(closeAdmin);
const W = (v) => `W/"${v}"`;
const offerFor = (entryId) =>
  sql(
    `SELECT id, status, expires_at, created_at FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [entryId],
  );
async function join(p, svc, doc, slot) {
  const to = new Date(new Date(slot.startsAt).getTime() + 20 * 60000).toISOString();
  const r = await p.client.post('/api/v1/waitlist-entries', {
    patientId: p.id,
    serviceId: svc,
    clinicianId: doc.id,
    from: slot.startsAt,
    to,
  });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
}
async function cancel(p, id) {
  const cur = await p.client.get(`/api/v1/appointments/${id}`);
  const r = await p.client.post(
    `/api/v1/appointments/${id}/cancel`,
    { reason: 'qa' },
    { headers: { 'if-match': W(cur.json.version) } },
  );
  assert.equal(r.status, 200, r.text);
}

describe('TC-BK waitlist offers', () => {
  it('TC-BK-19 first on the list is offered first; ignoring lets the offer lapse and it passes to the next [G2 setting: 1 min]', async () => {
    const prev = await setSetting('waitlist_offer_minutes', { default: 1, within_24h: 1 });
    try {
      const svc = await newService();
      await setPolicy(svc, { waitlist: true, cutoff: 1, max: 50 });
      const doc = await newDoctor({ services: [svc] });
      const [a, b, c] = [await newPatient(), await newPatient(), await newPatient()];
      const s = await search(a.client, { serviceId: svc, clinicianId: doc.id });
      const slot = s.slots[0];
      const bk = await book(a, slot, svc);
      const eb = await join(b, svc, doc, slot);
      await sleep(100);
      const ec = await join(c, svc, doc, slot);
      await cancel(a, bk.reservationId);
      const ob = await until(async () => (await offerFor(eb)).rows[0]);
      assert.ok(ob, 'the first waitlisted patient is offered the freed slot');
      assert.equal(ob.status, 'offered');
      assert.equal(
        (await offerFor(ec)).rows.length,
        0,
        'the second patient is not offered while the first offer is open',
      );
      const minutes = (new Date(ob.expires_at) - new Date(ob.created_at)) / 60000;
      assert.ok(
        Math.abs(minutes - 1) < 0.2,
        `offer window is the configured minute, got ${minutes}`,
      );
      const oc = await until(async () => (await offerFor(ec)).rows[0], {
        timeoutMs: 150000,
        everyMs: 2000,
      });
      assert.ok(oc, 'after the first offer lapses the next patient is offered');
      assert.equal(
        (await offerFor(eb)).rows[0].status,
        'expired',
        'the first offer lapsed cleanly',
      );
    } finally {
      await setSetting('waitlist_offer_minutes', prev);
    }
  });

  it('TC-BK-20 accept races: two accepts of one offer, and an accept against a direct booking, yield exactly one appointment', async () => {
    const svc = await newService();
    await setPolicy(svc, { waitlist: true, cutoff: 1, max: 50 });
    const doc = await newDoctor({ services: [svc] });
    const [a, b, d] = [await newPatient(), await newPatient(), await newPatient()];
    const s = await search(a.client, { serviceId: svc, clinicianId: doc.id });
    const slot = s.slots[0];
    const bk = await book(a, slot, svc);
    const eb = await join(b, svc, doc, slot);
    await cancel(a, bk.reservationId);
    const ob = await until(async () => (await offerFor(eb)).rows[0]);
    assert.ok(ob, 'offer exists');
    // one offer, accepted twice at once by the same patient, while another patient tries to book the slot directly
    const [x, y, z] = await Promise.all([
      b.client.post(`/api/v1/waitlist-offers/${ob.id}/accept`, {}),
      b.client.post(`/api/v1/waitlist-offers/${ob.id}/accept`, {}),
      hold(d, slot, svc),
    ]);
    const confirmed = await sql(
      `SELECT count(*)::int c FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND lower(period) = $2::timestamptz AND status IN ('held','confirmed')`,
      [doc.id, slot.startsAt],
    );
    assert.equal(
      confirmed.rows[0].c,
      1,
      `exactly one occupancy for the slot (accept ${x.status}/${y.status}, direct hold ${z.status})`,
    );
    for (const r of [x, y, z])
      assert.ok(r.status < 500, `no server error: ${r.status} ${r.text.slice(0, 120)}`);
    const losers = [x, y, z].filter((r) => r.status >= 400);
    assert.ok(losers.length >= 1);
    assert.ok(
      losers.every((r) => [409, 422].includes(r.status)),
      `losers get a clean refusal, got ${losers.map((r) => r.status)}`,
    );
  });

  it('TC-BK-21 slot starting within 24 h uses the within-24-hours acceptance time; late accept is refused and the offer passes on [G2 setting: default 3 min, within 24 h 1 min]', async () => {
    const prev = await setSetting('waitlist_offer_minutes', { default: 3, within_24h: 1 });
    try {
      const svc = await newService();
      await setPolicy(svc, { waitlist: true, cutoff: 0, max: 50 });
      const doc = await newDoctor({ services: [svc], allDay: true });
      const [a, b, c] = [await newPatient(), await newPatient(), await newPatient()];
      const now = Date.now();
      const day = {
        from: new Date(now + 2 * 3600000).toISOString(),
        to: new Date(now + 20 * 3600000).toISOString(),
        date: 'rolling',
      };
      const s = await search(a.client, { serviceId: svc, clinicianId: doc.id, day });
      assert.ok(s.slots.length > 0, 'a slot starts within 24 hours (all-day doctor)');
      const slot = s.slots[0];
      const bk = await book(a, slot, svc);
      const eb = await join(b, svc, doc, slot);
      await sleep(100);
      const ec = await join(c, svc, doc, slot);
      await cancel(a, bk.reservationId);
      const ob = await until(async () => (await offerFor(eb)).rows[0]);
      assert.ok(ob);
      const minutes = (new Date(ob.expires_at) - new Date(ob.created_at)) / 60000;
      assert.ok(
        Math.abs(minutes - 1) < 0.2,
        `within 24 h the window is 1 minute (not the 3-minute default); got ${minutes}`,
      );
      await sleep(new Date(ob.expires_at).getTime() - Date.now() + 2000);
      const late = await b.client.post(`/api/v1/waitlist-offers/${ob.id}/accept`, {});
      assert.equal(late.status, 409, late.text);
      assert.equal(late.json.code, 'scheduling.offer_expired');
      const oc = await until(async () => (await offerFor(ec)).rows[0], {
        timeoutMs: 60000,
        everyMs: 1500,
      });
      assert.ok(oc, 'the offer passes to the next patient after the expiry');
      const ok = await c.client.post(`/api/v1/waitlist-offers/${oc.id}/accept`, {});
      assert.equal(
        ok.status,
        200,
        `an accept inside the window books the slot: ${ok.text.slice(0, 200)}`,
      );
    } finally {
      await setSetting('waitlist_offer_minutes', prev);
    }
  });
});
