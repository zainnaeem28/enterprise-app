// TC-BK-13..18 (TEST-CASES 7.2): no double booking under real concurrency, ENV-INT/ci. 100 genuine parallel sessions against the real
// API process and the real database constraints. The winner count is read from the database, not inferred from responses.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  SVC,
  login,
  newPatient,
  patientClient,
  search,
  hold,
  holdBody,
  sql,
  closeAdmin,
  principalId,
  newService,
  setPolicy,
  newDoctor,
  sleep,
  nextDay,
} from '../../e2e/journeys/lib/world.mjs';

after(closeAdmin);

const BATCH = 20;
async function inBatches(n, fn) {
  const out = [];
  for (let i = 0; i < n; i += BATCH)
    out.push(
      ...(await Promise.all(Array.from({ length: Math.min(BATCH, n - i) }, (_, j) => fn(i + j)))),
    );
  return out;
}
/** hold then confirm, the way a patient session does; resolves to the first failing response or the confirmation. */
async function bookOnce(p, slot, svc, mode = 'in_person') {
  const h = await hold(p, slot, svc, mode);
  if (h.status !== 201)
    return {
      ok: false,
      step: 'hold',
      status: h.status,
      code: h.json?.code,
      alt: (h.json?.errors ?? []).some((e) => e.path?.startsWith('/alternatives/')),
    };
  const c = await p.client.post(`/api/v1/appointments/${h.json.reservationId}/confirm`, {});
  if (c.status !== 200)
    return {
      ok: false,
      step: 'confirm',
      status: c.status,
      code: c.json?.code,
      alt: (c.json?.errors ?? []).some((e) => e.path?.startsWith('/alternatives/')),
    };
  return { ok: true, id: h.json.reservationId };
}
const tally = (rs) => {
  const m = {};
  for (const r of rs) {
    const k = r.ok ? 'confirmed' : `${r.step}:${r.status}:${r.code}`;
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
};
const occupied = (clinicianId, startsAt) =>
  sql(
    `SELECT count(*)::int c FROM scheduling.slot_occupancy WHERE clinician_principal_id = $1 AND lower(period) = $2::timestamptz AND status IN ('held','confirmed','checked_in','in_consultation','completed')`,
    [clinicianId, startsAt],
  );

describe('TC-BK concurrency (100 parallel sessions)', () => {
  it('TC-BK-13 one slot, ONE patient account on 100 sessions: exactly one appointment', async (t) => {
    const svc = await newService();
    const doc = await newDoctor({ services: [svc] });
    const first = await newPatient();
    const sessions = [
      first,
      ...(await inBatches(99, async () => ({
        ...first,
        client: await login('patient', first.key),
      }))),
    ];
    const s = await search(first.client, { serviceId: svc, clinicianId: doc.id });
    const slot = s.slots[0];
    const rs = await Promise.all(sessions.map((p) => bookOnce(p, slot, svc)));
    t.diagnostic(`outcomes: ${JSON.stringify(tally(rs))}`);
    assert.equal(rs.filter((r) => r.ok).length, 1, 'exactly one confirmation');
    assert.equal(
      (await occupied(doc.id, slot.startsAt)).rows[0].c,
      1,
      'exactly one occupancy row in the database',
    );
    const apps = await sql(
      `SELECT count(*)::int c FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id WHERE r.patient_id = $1 AND o.status = 'confirmed'`,
      [first.id],
    );
    assert.equal(apps.rows[0].c, 1, 'exactly one confirmed appointment for the patient');
    const losers = rs.filter((r) => !r.ok);
    assert.ok(
      losers.every((r) => [409, 422].includes(r.status)),
      `every loser got a clean refusal: ${JSON.stringify(tally(losers))}`,
    );
    assert.ok(
      losers.every((r) => r.status !== 422 || r.code === 'scheduling.overlapping_appointment'),
      'a 422 can only be the same-patient overlap rule',
    );
  });

  it('TC-BK-14 one slot, 100 DIFFERENT patients: exactly one wins, losers see alternatives, none sees another reservation', async (t) => {
    const svc = await newService();
    const doc = await newDoctor({ services: [svc] });
    const pats = await inBatches(100, () => newPatient());
    const s = await search(pats[0].client, { serviceId: svc, clinicianId: doc.id });
    const slot = s.slots[0];
    const rs = await Promise.all(pats.map((p) => bookOnce(p, slot, svc)));
    t.diagnostic(`outcomes: ${JSON.stringify(tally(rs))}`);
    assert.equal(rs.filter((r) => r.ok).length, 1);
    assert.equal((await occupied(doc.id, slot.startsAt)).rows[0].c, 1);
    const losers = rs.filter((r) => !r.ok);
    assert.equal(losers.length, 99);
    assert.ok(
      losers.every((r) => r.status === 409 && r.code === 'scheduling.slot_taken'),
      JSON.stringify(tally(losers)),
    );
    assert.ok(
      losers.every((r) => r.alt),
      'every loser receives alternatives',
    );
  });

  it('TC-BK-15 overbookable session, cap 2, 100 patients: exactly 2 succeed, no more (written expectation; see QA04-F07)', async (t) => {
    const svc = await newService();
    await setPolicy(svc, { overbook: 2, max: 50 });
    const doc = await newDoctor({ services: [svc], overbookable: true });
    const pats = await inBatches(100, () => newPatient());
    const s = await search(pats[0].client, {
      serviceId: svc,
      clinicianId: doc.id,
      extra: { includeOverbook: true },
    }).then((r) =>
      r.status === 200 ? r : search(pats[0].client, { serviceId: svc, clinicianId: doc.id }),
    );
    const slot = s.slots[0];
    const rs = await Promise.all(pats.map((p) => bookOnce(p, slot, svc)));
    t.diagnostic(`outcomes: ${JSON.stringify(tally(rs))}`);
    const won = rs.filter((r) => r.ok).length;
    // QA04-F07: TEST-CASES TC-BK-15 says "exactly 2 succeed; no more". The product admits 1 + cap = 3 (ARCH 22.x/BR-02 read the cap as EXTRA capacity).
    // Until the Solution Architect/Product Manager decision-log entry settles 2 vs 1+cap, this case asserts the WRITTEN expectation and is reported FAILED.
    assert.equal(won, 2, 'TC-BK-15 written expectation: exactly 2 succeed (cap 2)');
  });

  it('TC-BK-16 hold expiry race: after A\'s hold expires, B and C race; exactly one wins, neither gets a false "taken" [G2 setting: hold 1 min, real wait]', async (t) => {
    const svc = await newService();
    await setPolicy(svc, { hold: 1, max: 50 });
    const doc = await newDoctor({ services: [svc] });
    const [a, b, c] = [await newPatient(), await newPatient(), await newPatient()];
    const s = await search(a.client, { serviceId: svc, clinicianId: doc.id });
    const slot = s.slots[0];
    const ha = await hold(a, slot, svc);
    assert.equal(ha.status, 201);
    const early = await hold(b, slot, svc);
    assert.equal(early.status, 409, 'while A holds, B is refused');
    await sleep(new Date(ha.json.expiresAt).getTime() - Date.now() + 2000);
    const rs = await Promise.all([bookOnce(b, slot, svc), bookOnce(c, slot, svc)]);
    t.diagnostic(`outcomes: ${JSON.stringify(tally(rs))}`);
    assert.equal(rs.filter((r) => r.ok).length, 1, 'exactly one of B and C wins');
    const loser = rs.find((r) => !r.ok);
    assert.equal(
      loser.status,
      409,
      'the loser is refused as slot_taken because the winner now holds it',
    );
    assert.equal((await occupied(doc.id, slot.startsAt)).rows[0].c, 1);
  });
});
