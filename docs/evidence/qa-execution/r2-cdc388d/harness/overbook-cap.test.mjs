// TC-BK-15 companions (HEAAA-632 ruling D-F11-1, T7): the overbook cap is the TOTAL number of active bookings in one slot, the first
// included. Cap 1 and cap 0 admit one, cap 3 admits three, and two slots of one session each admit the cap. Real API, real constraints.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPatient, search, hold, sql, closeAdmin, newService, setPolicy, newDoctor } from '../../e2e/journeys/lib/world.mjs';

after(closeAdmin);

async function inBatches(n, fn) {
  const out = [];
  for (let i = 0; i < n; i += 20) out.push(...(await Promise.all(Array.from({ length: Math.min(20, n - i) }, (_, j) => fn(i + j)))));
  return out;
}
async function bookOnce(p, slot, svc) {
  const h = await hold(p, slot, svc, 'in_person');
  if (h.status !== 201) return { ok: false, status: h.status, code: h.json?.code };
  const c = await p.client.post(`/api/v1/appointments/${h.json.reservationId}/confirm`, {});
  return c.status === 200 ? { ok: true } : { ok: false, status: c.status, code: c.json?.code };
}
const active = (clinicianId, startsAt) =>
  sql(
    `SELECT count(*)::int c FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND lower(period) = $2::timestamptz AND status IN ('held','confirmed','checked_in','in_consultation','completed')`,
    [clinicianId, startsAt],
  );
async function slots(pats, svc, doc) {
  const q = { serviceId: svc, clinicianId: doc.id };
  const withOverbook = await search(pats[0].client, { ...q, extra: { includeOverbook: true } });
  return (withOverbook.status === 200 ? withOverbook : await search(pats[0].client, q)).slots;
}

describe('TC-BK-15 cap variants (D-F11-1)', () => {
  for (const [cap, want] of [[1, 1], [0, 1], [3, 3]]) {
    it(`cap ${cap} on an overbookable session, 40 parallel patients: exactly ${want} succeed`, async (t) => {
      const svc = await newService();
      await setPolicy(svc, { overbook: cap, max: 50 });
      const doc = await newDoctor({ services: [svc], overbookable: true });
      const pats = await inBatches(40, () => newPatient());
      const slot = (await slots(pats, svc, doc))[0];
      const rs = await Promise.all(pats.map((p) => bookOnce(p, slot, svc)));
      t.diagnostic(`outcomes: ${JSON.stringify(rs.reduce((m, r) => ((m[r.ok ? 'ok' : `${r.status}:${r.code}`] = (m[r.ok ? 'ok' : `${r.status}:${r.code}`] ?? 0) + 1), m), {}))}`);
      assert.equal(rs.filter((r) => r.ok).length, want, `cap ${cap}: exactly ${want} succeed`);
      assert.equal((await active(doc.id, slot.startsAt)).rows[0].c, want, 'the database holds exactly that many active rows in the slot');
      assert.ok(rs.filter((r) => !r.ok).every((r) => r.status === 409), 'every refused request is a clean 409');
    });
  }

  it('cap 2, two slots of one session: exactly 2 + 2, the first slot being full does not hide or fill the second', async (t) => {
    const svc = await newService();
    await setPolicy(svc, { overbook: 2, max: 50 });
    const doc = await newDoctor({ services: [svc], overbookable: true });
    const pats = await inBatches(40, () => newPatient());
    const all = await slots(pats, svc, doc);
    const a = all[0];
    const b = all.find((s) => new Date(s.startsAt) >= new Date(a.endsAt ?? new Date(new Date(a.startsAt).getTime() + 1)));
    assert.ok(b && b.startsAt !== a.startsAt, 'the session offers a second, non-overlapping slot');
    const rs = await Promise.all(pats.map((p, i) => bookOnce(p, i % 2 ? b : a, svc)));
    t.diagnostic(`confirmed ${rs.filter((r) => r.ok).length} of ${rs.length}`);
    assert.equal(rs.filter((r) => r.ok).length, 4, 'exactly 2 + 2 succeed');
    assert.equal((await active(doc.id, a.startsAt)).rows[0].c, 2, 'slot A holds exactly 2');
    assert.equal((await active(doc.id, b.startsAt)).rows[0].c, 2, 'slot B holds exactly 2');
  });
});
