// QA supplement (HEAAA-661) for PRD rows RA-R1-21, 23, 24 and 29 on candidate cdc388d: real built API/worker, throwaway migrated DB.
// Each test uses its own synthetic doctor/patient/day. Limitations are stated in the case title ([no object store], [human]).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeAdmin, newStaff, newDoctor, newPatient, newService, setPolicy, search, nextDay, ORG, A1, uuid, login, book } from '../../e2e/journeys/lib/world.mjs';
import { visit, checkIn, docClient, W, publishQuestionnaire, publishConsent, requireConsents } from '../../e2e/journeys/lib/clinical.mjs';

after(closeAdmin);
const doctorWithService = async () => {
  const svc = await newService({ internal: 'QA supplement', display: 'Appointment' });
  await setPolicy(svc, { cutoff: 0, max: 50 });
  const doc = await newDoctor({ services: [svc] });
  return { svc, doc, c: await docClient(doc) };
};
const tmpl = (dateStr, rules) => ({ locationId: A1, validFrom: '2020-01-01', rules });
const wd = (day) => new Date(day.date + 'T12:00:00Z').getUTCDay();

describe('RA-R1-23 doctor availability, leave and blocked time (TC-DR)', () => {
  it('TC-DR-01 leave and blocked time change slot search at once; removing them restores the slots; a template edit is reflected', async () => {
    const { svc, doc, c } = await doctorWithService();
    const pat = await newPatient();
    const day = nextDay();
    const base = await search(pat.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.equal(base.status, 200, base.text);
    assert.ok(base.slots.length >= 3, `baseline slots: ${base.slots.length}`);
    // blocked time over the first slot only
    const first = base.slots[0];
    const bt = await c.post(`/api/v1/clinicians/${doc.id}/blocked-times`, { startsAt: first.startsAt, endsAt: new Date(Date.parse(first.startsAt) + 40 * 60e3).toISOString(), kind: 'blocked', note: 'synthetic' });
    assert.equal(bt.status, 201, bt.text);
    const afterBlock = await search(pat.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.ok(!afterBlock.slots.some((s) => s.startsAt === first.startsAt), 'the blocked slot is no longer offered');
    assert.ok(afterBlock.slots.length < base.slots.length, 'fewer slots after the blocked time');
    // whole-day leave
    const leave = await c.post(`/api/v1/clinicians/${doc.id}/blocked-times`, { startsAt: day.from, endsAt: day.to, kind: 'leave' });
    assert.equal(leave.status, 201, leave.text);
    const onLeave = await search(pat.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.equal(onLeave.slots.length, 0, 'no slots on a day of leave');
    // remove both: slots come back
    assert.equal((await c.delete(`/api/v1/clinicians/${doc.id}/blocked-times/${leave.json.id}`)).status, 204);
    assert.equal((await c.delete(`/api/v1/clinicians/${doc.id}/blocked-times/${bt.json.id}`)).status, 204);
    const restored = await search(pat.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.equal(restored.slots.length, base.slots.length, 'the original slots are back after removal');
    // the doctor defines a new template through the API: retire the old one, post a narrower one (same weekday, a 2 hour rule)
    const list = await c.get(`/api/v1/clinicians/${doc.id}/availability-templates?status=active`);
    assert.equal(list.status, 200, list.text);
    for (const t of list.json.items) {
      const del = await c.delete(`/api/v1/clinicians/${doc.id}/availability-templates/${t.id}`, { headers: { 'if-match': W(t.version) } });
      assert.equal(del.status, 200, del.text);
    }
    const empty = await search(pat.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.equal(empty.slots.length, 0, 'no active template means no slots');
    const created = await c.post(`/api/v1/clinicians/${doc.id}/availability-templates`, tmpl(day.date, [{ weekday: wd(day), startLocal: '14:00', endLocal: '16:00', mode: 'either' }]));
    assert.equal(created.status, 201, created.text);
    const narrow = await search(pat.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.ok(narrow.slots.length > 0 && narrow.slots.length <= 6, `the new 2 hour rule offers 1..6 slots, got ${narrow.slots.length}`);
    assert.ok(!narrow.slots.some((s) => base.slots.some((b) => b.startsAt === s.startsAt)), 'none of the old 09:00-12:00 slots remain');
    const au = await sql(`SELECT count(*)::int c FROM audit.event WHERE actor_principal_id = $1 AND resource_type LIKE 'scheduling.%'`, [doc.id]);
    assert.ok(au.rows[0].c >= 5, `template and blocked-time changes are audited (${au.rows[0].c})`);
  });

  it('TC-DR-02 leave over a booked slot warns of the conflict (dry run) and never cancels the appointment silently', async () => {
    const { svc, doc, c } = await doctorWithService();
    const pat = await newPatient();
    const day = nextDay();
    const s = await search(pat.client, { serviceId: svc, clinicianId: doc.id, day });
    const b = await book(pat, s.slots[0], svc);
    const body = { startsAt: day.from, endsAt: day.to, kind: 'leave' };
    const dry = await c.post(`/api/v1/clinicians/${doc.id}/blocked-times`, { ...body, dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.saved, false);
    assert.ok(dry.json.conflicts.total >= 1 && dry.json.conflicts.confirmed >= 1, JSON.stringify(dry.json));
    const noAck = await c.post(`/api/v1/clinicians/${doc.id}/blocked-times`, body);
    assert.ok(noAck.status >= 400 && noAck.status < 500, `saving over a booking without acknowledgement is refused, got ${noAck.status} ${noAck.text.slice(0, 200)}`);
    const none = await c.get(`/api/v1/clinicians/${doc.id}/blocked-times`);
    assert.equal(none.json.items.length, 0, 'nothing saved without acknowledgement');
    const ack = await c.post(`/api/v1/clinicians/${doc.id}/blocked-times`, { ...body, acknowledgeConflicts: true });
    assert.equal(ack.status, 201, ack.text);
    const st = await sql(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [b.reservationId]);
    assert.equal(st.rows[0].status, 'confirmed', 'the appointment stays confirmed: no silent cancellation');
  });

  it('TC-DR-03 another doctor cannot read or change this doctor’s availability, leave or blocked time; nothing changes', async () => {
    const a1 = await doctorWithService();
    const a2 = await doctorWithService();
    const day = nextDay();
    const t0 = (await a1.c.get(`/api/v1/clinicians/${a1.doc.id}/availability-templates`)).json.items[0];
    const probes = [
      ['GET templates', a2.c.get(`/api/v1/clinicians/${a1.doc.id}/availability-templates`)],
      ['POST template', a2.c.post(`/api/v1/clinicians/${a1.doc.id}/availability-templates`, tmpl(day.date, [{ weekday: 1, startLocal: '09:00', endLocal: '10:00', mode: 'either' }]))],
      ['DELETE template', a2.c.delete(`/api/v1/clinicians/${a1.doc.id}/availability-templates/${t0.id}`, { headers: { 'if-match': W(t0.version) } })],
      ['GET blocked', a2.c.get(`/api/v1/clinicians/${a1.doc.id}/blocked-times`)],
      ['POST blocked', a2.c.post(`/api/v1/clinicians/${a1.doc.id}/blocked-times`, { startsAt: day.from, endsAt: day.to, kind: 'leave' })],
      ['admin route', a2.c.get(`/api/v1/admin/clinicians/${a1.doc.id}/availability-templates`)],
    ];
    for (const [name, p] of probes) {
      const r = await p;
      assert.ok([403, 404].includes(r.status), `${name} as another doctor must be refused, got ${r.status} ${r.text.slice(0, 160)}`);
    }
    const after = await a1.c.get(`/api/v1/clinicians/${a1.doc.id}/availability-templates`);
    assert.equal(after.json.items.length, 1);
    assert.equal(after.json.items[0].version, t0.version, 'template unchanged');
    assert.equal((await a1.c.get(`/api/v1/clinicians/${a1.doc.id}/blocked-times`)).json.items.length, 0, 'no blocked time was created');
    const den = await sql(`SELECT count(*)::int c FROM audit.event WHERE actor_principal_id = $1 AND outcome <> 'success'`, [a2.doc.id]);
    console.log(`# TC-DR-03 audit denied/failed events for the other doctor: ${den.rows[0].c}`);
  });
});

describe('RA-R1-24 doctor chart summary with name, DOB and photo (TC-CL-08)', () => {
  it('TC-CL-08 chart summary shows problems, allergies, medications, vitals, history, documents, with name, date of birth and MRN on the banner; uncoded items are marked [photo: no object store]', async () => {
    const v = await visit();
    await checkIn(v);
    const dc = await docClient(v.doc);
    const p1 = await dc.post(`/api/v1/patients/${v.patient.id}/problems`, { display: 'Synthetic problem (uncoded)' });
    assert.equal(p1.status, 201, p1.text);
    const al = await dc.post(`/api/v1/patients/${v.patient.id}/allergies`, { display: 'Synthetic allergy (uncoded)', category: 'drug', severity: 'mild' });
    assert.equal(al.status, 201, al.text);
    const me = await dc.post(`/api/v1/patients/${v.patient.id}/medications`, { display: 'Synthetic medication (uncoded)', doseText: '1 tab daily' });
    assert.equal(me.status, 201, me.text);
    const vit = await v.tri.client.post(`/api/v1/check-ins/${v.reservationId}/vitals`, { vitals: [{ loincCode: '59408-5', value: 97, unit: '%', measuredAt: new Date().toISOString() }] });
    assert.equal(vit.status, 201, vit.text);
    const r = await dc.get(`/api/v1/patients/${v.patient.id}/chart-summary`);
    assert.equal(r.status, 200, r.text);
    const j = r.json;
    assert.equal(j.level, 'chart');
    assert.ok(j.patientBanner.displayName && j.patientBanner.dateOfBirth && j.patientBanner.mrn, `banner: ${JSON.stringify(j.patientBanner)}`);
    assert.equal(j.patientBanner.patientId, v.patient.id);
    assert.ok(j.problems.some((x) => x.display.includes('problem')) && j.allergies.length === 1 && j.medications.length === 1, 'lists present');
    for (const x of [...j.problems, ...j.allergies, ...j.medications]) assert.equal(x.coded, false, 'uncoded items are marked coded:false');
    assert.ok(j.recentVitals.length >= 1, 'vitals present');
    assert.ok('encounters' in j && 'documents' in j, 'history (encounters) and documents sections are part of the summary');
    console.log(`# TC-CL-08 banner keys: ${Object.keys(j.patientBanner).join(',')}; encounters=${JSON.stringify(j.encounters)?.slice(0, 60)}; documents=${JSON.stringify(j.documents)?.slice(0, 60)}; photoUrl=${j.patientBanner.photoUrl ?? 'absent (no photo document / object store)'}`);
    const au = await sql(`SELECT count(*)::int c FROM audit.event WHERE patient_id = $1 AND actor_principal_id = $2`, [v.patient.id, v.doc.id]);
    assert.ok(au.rows[0].c >= 1, 'chart access is audited');
    // negative: a doctor with no care relationship is refused, not shown a partial chart
    const other = await newDoctor();
    const oc = await docClient(other);
    const no = await oc.get(`/api/v1/patients/${v.patient.id}/chart-summary`);
    assert.ok([403, 404].includes(no.status), `an unassigned doctor must not see the summary, got ${no.status}`);
  });
});

describe('RA-R1-24 history and documents parts of the chart summary (TC-CL-08b)', () => {
  it('TC-CL-08b the chart summary returns the encounter history and the documents list (arrays, not null)', async () => {
    const v = await visit();
    await checkIn(v);
    const dc = await docClient(v.doc);
    const r = await dc.get(`/api/v1/patients/${v.patient.id}/chart-summary`);
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.encounters), `history: encounters must be a list, got ${JSON.stringify(r.json.encounters)}`);
    assert.ok(Array.isArray(r.json.documents), `documents must be a list, got ${JSON.stringify(r.json.documents)}`);
  });
});

describe('RA-R1-29 manual insurance verification (TC-PC-10)', () => {
  it('TC-PC-10 staff record a verification status and date; it is saved and audited; no outbound call is made [card image: no object store]', async () => {
    const pat = await newPatient();
    const cov = await pat.client.post(`/api/v1/patients/${pat.id}/insurance-coverages`, { payerName: 'Synthetic Payer', memberId: 'SYN-' + uuid().slice(0, 8) });
    assert.equal(cov.status, 201, cov.text);
    const staff = await newStaff([['front_desk', A1], ['medical_records', A1], ['care_coordinator', A1]], { name: 'STF-INS' });
    // staff need the patient in their location scope: give the patient an appointment at A1
    const svc = await newService();
    await setPolicy(svc, { cutoff: 0, max: 50 });
    const doc = await newDoctor({ services: [svc] });
    const s = await search(pat.client, { serviceId: svc, clinicianId: doc.id });
    await book(pat, s.slots[0], svc);
    const out0 = await sql(`SELECT count(*)::int c FROM integration_core.outbound_call`);
    const before = Date.now();
    let res;
    let ver = cov.json.rowVersion;
    assert.ok(Number.isInteger(ver), `coverage rowVersion: ${JSON.stringify(cov.json)}`);
    for (const status of ['verified_active', 'verified_inactive', 'unable_to_verify']) {
      const cur = { rowVersion: ver };
      res = await staff.client.put(`/api/v1/insurance-coverages/${cov.json.id}/eligibility`, { status }, { headers: { 'if-match': W(cur.rowVersion) } });
      assert.equal(res.status, 200, `${status}: ${res.status} ${res.text.slice(0, 200)}`);
      assert.equal(res.json.status, status);
      assert.ok(Date.parse(res.json.verifiedAt) >= before - 5000, 'verification date is now');
      ver = Number(res.headers['etag'].replace(/\D/g, ''));
    }
    const bad = await staff.client.put(`/api/v1/insurance-coverages/${cov.json.id}/eligibility`, { status: 'verified_electronically' }, { headers: { 'if-match': W(ver) } });
    assert.ok(bad.status >= 400 && bad.status < 500, `an unknown status is rejected, got ${bad.status}`);
    const row = await sql(`SELECT eligibility_status, verified_at, verified_by FROM patient.insurance_coverage WHERE id = $1`, [cov.json.id]);
    assert.equal(row.rows[0].eligibility_status, 'unable_to_verify');
    assert.equal(row.rows[0].verified_by, staff.id);
    const au = await sql(`SELECT count(*)::int c FROM audit.event WHERE resource_id = $1 AND action = 'update'`, [cov.json.id]);
    assert.ok(au.rows[0].c >= 3, `each verification is audited (${au.rows[0].c})`);
    const out1 = await sql(`SELECT count(*)::int c FROM integration_core.outbound_call`);
    assert.equal(out1.rows[0].c, out0.rows[0].c, 'no outbound integration call was recorded');
    // the patient cannot verify their own coverage
    const self = await pat.client.put(`/api/v1/insurance-coverages/${cov.json.id}/eligibility`, { status: 'verified_active' }, { headers: { 'if-match': W(1) } });
    assert.ok([403, 404].includes(self.status), `a patient cannot record eligibility, got ${self.status}`);
  });
});

describe('RA-R1-21 pre-visit questionnaire, consents, insurance and staff-visible status (TC-PP-06, TC-PP-07)', () => {
  const run = async ({ consent, questionnaire, insurance }) => {
    const ck = await publishConsent(1);
    const qk = await publishQuestionnaire({ rules: [], advice: null });
    const v = await visit({ consents: [ck] });
    const pv0 = await v.patient.client.get(`/api/v1/appointments/${v.reservationId}/previsit`);
    assert.equal(pv0.status, 200, pv0.text);
    assert.deepEqual([pv0.json.questionnaire, pv0.json.consents, pv0.json.insurance], [false, false, false], 'nothing done yet');
    if (consent) {
      const open = await v.patient.client.post(`/api/v1/appointments/${v.reservationId}/previsit/consents`, {});
      assert.equal(open.status, 200, open.text);
      const item = open.json.requiredConsents.find((c) => c.templateKey === ck);
      assert.ok(item?.id, `a pending consent row was opened: ${JSON.stringify(open.json)}`);
      const sign = await v.patient.client.post(`/api/v1/consents/${item.id}/sign`, { typedName: 'Synthetic Patient' });
      assert.equal(sign.status, 200, sign.text);
      const cons = await sql(`SELECT status, template_version, signed_at FROM patient.consent WHERE id = $1`, [item.id]);
      assert.equal(cons.rows[0].status, 'signed');
      assert.equal(cons.rows[0].template_version, 1, 'the signed version is stored');
      assert.ok(cons.rows[0].signed_at, 'with its date');
    }
    if (questionnaire) {
      const put = await v.patient.client.put(`/api/v1/questionnaire-responses/${uuid()}`, { reservationId: v.reservationId, templateKey: qk, answers: { q_flag_a: false, q_flag_b: 'green', q_score: 1 } });
      assert.equal(put.status, 201, put.text);
      const sub = await v.patient.client.post(`/api/v1/questionnaire-responses/${put.json.id}/submit`, {}, { headers: { 'if-match': put.headers['etag'] } });
      assert.equal(sub.status, 200, sub.text);
    }
    if (insurance) {
      // the record only: the card IMAGE upload needs the object store, which this environment does not have (blocked)
      const cov = await v.patient.client.post(`/api/v1/patients/${v.patient.id}/insurance-coverages`, { payerName: 'Synthetic Payer', memberId: 'SYN-' + uuid().slice(0, 8) });
      assert.equal(cov.status, 201, cov.text);
    }
    const ci = await checkIn(v);
    const snap = await sql(`SELECT previsit_status FROM scheduling.check_in WHERE id = $1 OR patient_id = $2 ORDER BY checked_in_at DESC LIMIT 1`, [v.reservationId, v.patient.id]);
    return { v, ci, snap: snap.rows[0]?.previsit_status };
  };

  it('TC-PP-07 partial completion (consent only): staff see the visit incomplete and exactly which items are open', async () => {
    const { ci, snap } = await run({ consent: true });
    assert.deepEqual(ci.json.previsit, { questionnaire: false, consents: true, insurance: false }, JSON.stringify(ci.json.previsit));
    console.log(`# TC-PP-07 stored check-in snapshot: ${JSON.stringify(snap)}`);
    assert.ok(Object.values(ci.json.previsit).includes(false), 'incomplete');
  });

  it('TC-PP-06 questionnaire submitted, consent e-signed with its version and date, insurance record added: staff see all three complete [card image upload: blocked, no object store; send-time 72 h setting not exercised]', async () => {
    const { ci, snap } = await run({ consent: true, questionnaire: true, insurance: true });
    assert.deepEqual(ci.json.previsit, { questionnaire: true, consents: true, insurance: true }, JSON.stringify(ci.json.previsit));
    console.log(`# TC-PP-06 stored check-in snapshot: ${JSON.stringify(snap)}`);
  });
});
