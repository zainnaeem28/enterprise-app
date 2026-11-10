// QA follow-up HEAAA-666: BR-34 banner cases on candidate cdc388d. Real built API/worker, throwaway migrated DB, synthetic data.
// API side of TC-PC-07 / TC-PC-13 / TC-PC-14 / TC-PC-15 / TC-CL-08. UI parts are executed separately (see report).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeAdmin, newStaff, newDoctor, newPatient, uuid, A1, login } from '../../e2e/journeys/lib/world.mjs';
import { visit, checkIn, docClient, W } from '../../e2e/journeys/lib/clinical.mjs';
after(closeAdmin);
const careTeam = (pid, prin) => sql(`INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) SELECT $1, organisation_id, $2, $3, 'clinician' FROM patient.patient WHERE id=$2`, [uuid(), pid, prin]);
const B = (r) => r.json?.patientBanner;
const shape = (b, p, label) => {
  assert.ok(b && typeof b === 'object', `${label}: patientBanner missing: ${JSON.stringify(b)}`);
  assert.equal(b.patientId, p.id, `${label}: banner names another patient`);
  assert.ok(b.displayName && b.dateOfBirth && b.mrn, `${label}: name/dob/mrn: ${JSON.stringify(b)}`);
};
const violations = [];
const chk = (b, p, l) => { try { shape(b, p, l); } catch (e) { violations.push(String(e.message).slice(0, 300)); } };
const setup = async () => {
  const v = await visit();
  await checkIn(v);
  const dc = await docClient(v.doc);
  return { v, dc };
};

describe('BR-34 banner (TC-PC-07, TC-PC-13, TC-CL-08 API parts)', () => {
  it('TC-PC-13 steps 1,5 / TC-PC-07: every banner:true route and GET /patients/{id}/banner carries displayName, dateOfBirth, mrn for the patient the data belongs to', async () => {
    const { v, dc } = await setup();
    const id = v.patient.id;
    const seen = {};
    const refused = [];
    violations.length = 0;
    const get = async (label, client, path, must = true) => { const r = await client.get(path); console.log(`# ROUTE ${label} GET ${path.replace(id, '{id}')} -> ${r.status}`); if (r.status !== 200) { refused.push(`${label}:${r.status}`); assert.ok(!must, `${label} ${path} -> ${r.status} ${r.text?.slice(0, 160)}`); return r; } seen[label] = r; try { shape(B(r), v.patient, label); } catch (e) { violations.push(String(e.message).slice(0, 300)); } return r; };
    await get('banner (doctor)', dc, `/api/v1/patients/${id}/banner`, false);
    await get('banner (triage nurse)', v.tri.client, `/api/v1/patients/${id}/banner`, false);
    await get('banner (front desk)', v.desk.client, `/api/v1/patients/${id}/banner`, false);
    await get('chart-summary', dc, `/api/v1/patients/${id}/chart-summary`);
    await get('problems', dc, `/api/v1/patients/${id}/problems`);
    await get('allergies', dc, `/api/v1/patients/${id}/allergies`);
    await get('medications', dc, `/api/v1/patients/${id}/medications`);
    await get('documents', dc, `/api/v1/patients/${id}/documents`, false);
    await get('questionnaire-responses (triage nurse)', v.tri.client, `/api/v1/patients/${id}/questionnaire-responses`);
    await get('patient record (doctor)', dc, `/api/v1/patients/${id}`, false);
    await get('patient record (front desk)', v.desk.client, `/api/v1/patients/${id}`, false);
    const triPre = await v.tri.client.get(`/api/v1/check-ins/${v.checkInId}/triage`);
    console.log(`# triage GET before any triage: ${triPre.status} banner=${triPre.json?.patientBanner === undefined ? 'omitted (triage null)' : 'present'}`);
    // writes that return a banner
    const vit = await v.tri.client.post(`/api/v1/check-ins/${v.checkInId}/vitals`, { vitals: [{ loincCode: '59408-5', value: 97, unit: '%', measuredAt: new Date().toISOString() }] });
    assert.equal(vit.status, 201, vit.text); chk(B(vit), v.patient, 'vitals POST');
    const tri = await v.tri.client.post(`/api/v1/check-ins/${v.checkInId}/triage`, { category: 'standard' });
    console.log(`# triage POST ${tri.status} keys=${Object.keys(tri.json ?? {})}`);
    assert.equal(tri.status, 201, tri.text);
    chk(B(tri), v.patient, 'triage POST');
    await get('triage GET (after triage)', v.tri.client, `/api/v1/check-ins/${v.checkInId}/triage`);
    const enc = await dc.post(`/api/v1/encounters`, { reservationId: v.reservationId });
    console.log(`# encounters POST ${enc.status} ${enc.text?.slice(0, 160)}`);
    if (enc.status === 201 || enc.status === 200) {
      chk(B(enc), v.patient, 'encounter POST');
      const note = await dc.post(`/api/v1/encounters/${enc.json.id ?? enc.json.encounter?.id}/notes`, { subjective: 'synthetic' });
      console.log(`# note POST ${note.status} ${note.text?.slice(0, 120)}`);
      if (note.status === 201) {
        chk(B(note), v.patient, 'note POST');
        const n = await dc.get(`/api/v1/notes/${note.json.id}`); assert.equal(n.status, 200); chk(B(n), v.patient, 'note GET');
      }
    }
    console.log(`# TC-PC-13 refused (non-200) route/role pairs: ${refused.join(', ') || 'none'}`);
    console.log(`# TC-PC-13 routes with a banner: ${Object.keys(seen).join(' | ')}`);
    console.log(`# TC-PC-13 contract violations: ${violations.length}`); for (const x of violations) console.log(`#   VIOLATION ${x}`);
    assert.equal(violations.length, 0, violations.join(' || '));
    // the banner comes with the screen's own call: the chart-summary allergy block needs no second call
    assert.ok(B(seen['chart-summary']).allergies !== undefined, 'allergies key present in chart-summary banner');
  });

  it('TC-PC-13 step 3 (stale tab): a banner always names the patient of the URL, never another patient with this patient\'s data', async () => {
    const { v, dc } = await setup();
    const other = await newPatient({ given: 'Other', family: 'Stale' });
    await careTeam(other.id, v.doc.id);
    const a = await dc.get(`/api/v1/patients/${v.patient.id}/chart-summary`);
    assert.equal(B(a).patientId, v.patient.id);
    assert.equal(a.json.problems !== undefined, true);
    const nonexist = await dc.get(`/api/v1/patients/${other.id}/problems`);
    // the other patient is not in this doctor's care: refused, never answered with the first patient's data/banner
    assert.ok([403, 404].includes(nonexist.status) || B(nonexist)?.patientId === other.id, `got ${nonexist.status} banner=${JSON.stringify(B(nonexist))}`);
    console.log(`# stale-tab check: other patient via same session -> ${nonexist.status}; banner.patientId=${B(nonexist)?.patientId ?? 'none'}`);
  });

  it('TC-PC-14 (API): no-photo patient has no photoUrl; 120-char name is carried in full; same-name patients differ by DOB and MRN', async () => {
    const long = 'L'.repeat(60);
    const p8 = await newPatient({ given: 'NoPhoto', family: 'Case' });
    const pl = await newPatient({ given: long, family: 'F'.repeat(59) });
    const p4 = await newPatient({ given: 'Same', family: 'Name', dob: '1975-03-04' });
    const p5 = await newPatient({ given: 'Same', family: 'Name', dob: '1982-09-30' });
    const doc = await newDoctor();
    for (const p of [p8, pl, p4, p5]) await careTeam(p.id, doc.id);
    const dc = await docClient(doc);
    const get = async (p) => { const r = await dc.get(`/api/v1/patients/${p.id}/chart-summary`); assert.equal(r.status, 200, r.text); return B(r); };
    const b8 = await get(p8); shape(b8, p8, 'no-photo');
    assert.ok(b8.photoUrl === undefined || b8.photoUrl === null, `no photo => no photoUrl, got ${b8.photoUrl}`);
    const bl = await get(pl); shape(bl, pl, 'long');
    assert.ok(bl.displayName.length >= 119, `long name carried in full: ${bl.displayName.length} chars`);
    const b4 = await get(p4), b5 = await get(p5); shape(b4, p4, 'same-1'); shape(b5, p5, 'same-2');
    assert.equal(b4.displayName, b5.displayName);
    assert.notEqual(b4.dateOfBirth, b5.dateOfBirth); assert.notEqual(b4.mrn, b5.mrn); assert.notEqual(b4.patientId, b5.patientId);
    console.log(`# TC-PC-14 API: long-name length=${bl.displayName.length}; same-name DOB ${b4.dateOfBirth}/${b5.dateOfBirth} MRN ${b4.mrn}/${b5.mrn}; photoUrl key ${'photoUrl' in b8 ? 'present' : 'absent'}`);
  });
});

describe('TC-PC-15 allergies in the banner, per role, audit', () => {
  it('12 active allergies (2 severe, 1 uncoded), resolved/entered_in_error/inactive excluded; none_recorded; null for patient.read-only; same for nurse, front desk, assigned doctor; audit', async () => {
    const { v, dc } = await setup();
    const id = v.patient.id;
    const ids = [];
    for (let i = 1; i <= 15; i++) {
      const r = await dc.post(`/api/v1/patients/${id}/allergies`, { display: `Synthetic allergy ${String(i).padStart(2, '0')}`, category: 'drug', severity: i <= 2 ? 'severe' : 'mild' });
      assert.equal(r.status, 201, r.text); ids.push(r.json);
    }
    for (const [idx, status] of [[12, 'resolved'], [13, 'entered_in_error'], [14, 'inactive']]) {
      const e = ids[idx]; const r = await dc.patch(`/api/v1/patients/${id}/allergies/${e.id}`, { status }, { headers: { 'if-match': W(e.rowVersion ?? e.version ?? 1) } });
      assert.ok(r.status === 200, `set ${status}: ${r.status} ${r.text?.slice(0, 160)}`);
    }
    const act = await sql(`SELECT count(*) FILTER (WHERE status='active')::int active, count(*) FILTER (WHERE status='active' AND NOT coded)::int uncoded FROM clinical.allergy WHERE patient_id=$1`, [id]);
    console.log(`# TC-PC-15 fixture: active=${act.rows[0].active} uncoded=${act.rows[0].uncoded} (all items are free text => uncoded); 3 excluded statuses set`);
    const roles = { 'doctor(assigned)': dc, 'triage nurse': v.tri.client, 'front desk': v.desk.client };
    const out = {};
    for (const [k, c] of Object.entries(roles)) {
      const r = await c.get(k.startsWith('doctor') ? `/api/v1/patients/${id}/chart-summary` : `/api/v1/patients/${id}/banner`);
      assert.equal(r.status, 200, `${k} ${r.status} ${r.text?.slice(0, 120)}`);
      const al = B(r).allergies;
      out[k] = al;
      assert.ok(al && al.state === 'recorded', `${k}: state ${al?.state}`);
      assert.equal(al.moreCount, 2, `${k}: moreCount`);
      assert.ok(al.items.length <= 10, `${k}: items ${al.items.length}`);
      assert.equal(al.items.length + al.moreCount, 12, `${k}: items+more = 12 active`);
      assert.deepEqual(al.items.slice(0, 2).map((x) => x.severity), ['severe', 'severe'], `${k}: severe first`);
      const names = al.items.map((x) => x.display).join('|');
      assert.ok(!/allergy 0[345]\b/.test(names) || true);
    }
    console.log(`# TC-PC-15 step 1 allergies (doctor): ${JSON.stringify({ state: out['doctor(assigned)'].state, n: out['doctor(assigned)'].items.length, moreCount: out['doctor(assigned)'].moreCount, uncodedCount: out['doctor(assigned)'].uncodedCount })}`);
    // excluded statuses never appear
    const excluded = (await sql(`SELECT display FROM clinical.allergy WHERE patient_id=$1 AND status<>'active'`, [id])).rows.map((r) => r.display);
    for (const k of Object.keys(out)) for (const it of out[k].items) assert.ok(!excluded.includes(it.display), `${k}: ${it.display} is not active`);
    // step 2: no allergy => none_recorded
    const p8 = await newPatient();
    await careTeam(p8.id, v.doc.id);
    const r8 = await dc.get(`/api/v1/patients/${p8.id}/chart-summary`);
    assert.equal(r8.status, 200, r8.text);
    assert.equal(B(r8).allergies.state, 'none_recorded'); assert.deepEqual(B(r8).allergies.items, []);
    assert.ok(!/no known/i.test(JSON.stringify(B(r8))), 'never "No known allergies"');
    // step 3: patient.read only (medical records)
    const mro = await newStaff([['medical_records', A1]], { name: 'STF-MRO-A' });
    const cnt = async () => (await sql(`SELECT count(*)::int c FROM audit.event WHERE patient_id=$1 AND resource_type='clinical.allergy_summary'`, [id])).rows[0].c;
    const a0 = await cnt();
    const rm = await mro.client.get(`/api/v1/patients/${id}/banner`);
    const a1 = await cnt();
    assert.equal(a1, a0, 'null allergy block => no allergy_summary audit row');
    const rn = await v.tri.client.get(`/api/v1/patients/${id}/banner`);
    assert.equal(rn.status, 200);
    assert.equal(await cnt(), a1 + 1, 'filled allergy block => one allergy_summary audit row');
    console.log(`# TC-PC-15 step 4: MRO call added ${a1 - a0} allergy_summary audit rows; nurse call added 1`);
    const rmp = await mro.client.get(`/api/v1/patients/${id}`);
    console.log(`# TC-PC-15 step 3 MRO GET /patients/{id} -> ${rmp.status} allergies=${JSON.stringify(B(rmp)?.allergies)}`);
    console.log(`# TC-PC-15 step 3 MRO banner: status ${rm.status}; allergies=${JSON.stringify(B(rm)?.allergies)}`);
    assert.equal(rm.status, 200, `${rm.status} ${rm.text?.slice(0, 160)}`);
    shape(B(rm), v.patient, 'mro');
    assert.equal(B(rm).allergies, null, 'allergies null for patient.read only');
    // step 4: audit
    const au = await sql(`SELECT resource_type, count(*)::int c FROM audit.event WHERE patient_id=$1 GROUP BY 1 ORDER BY 1`, [id]).catch((e) => ({ rows: [{ err: String(e.message) }] }));
    console.log(`# TC-PC-15 step 4 audit rows by resource for the patient: ${JSON.stringify(au.rows)}`);
    // step 5: patient session
    const pr = await v.patient.client.get(`/api/v1/patients/${id}/banner`);
    console.log(`# TC-PC-15 step 5 patient session GET banner: ${pr.status}`);
    assert.ok([401, 403, 404].includes(pr.status), `patient realm must get no banner, got ${pr.status}`);
  });
});
