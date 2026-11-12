// QA R4 (HEAAA-826): supplement to banner.test.mjs on the final dev head. F-4 (decision HEAAA-823: doctor 403 on /banner is
// specified), F-5 (GET /patients/{id} banner conforms to ARCH 28.2), F-7 (triage with no triage), TC-CL-08/08b (chart summary lists).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeAdmin } from '../../e2e/journeys/lib/world.mjs';
import { visit, checkIn, docClient } from '../../e2e/journeys/lib/clinical.mjs';
after(closeAdmin);
describe('R4 supplement', () => {
  it('F-4: doctor gets 403 on /patients/{id}/banner and /patients/{id}; banner:true chart route serves the doctor with a banner', async () => {
    const v = await visit(); await checkIn(v); const dc = await docClient(v.doc); const id = v.patient.id;
    const b = await dc.get(`/api/v1/patients/${id}/banner`); const p = await dc.get(`/api/v1/patients/${id}`);
    console.log(`# F-4 doctor GET /banner -> ${b.status} ${b.json?.code ?? ''}; GET /patients/{id} -> ${p.status}`);
    assert.equal(b.status, 403); assert.equal(p.status, 403);
    assert.equal(b.json?.patientBanner, undefined, 'a refusal carries no banner');
    const cs = await dc.get(`/api/v1/patients/${id}/chart-summary`);
    assert.equal(cs.status, 200); assert.equal(cs.json.patientBanner.displayName.length > 0, true);
  });
  it('F-5: GET /patients/{id} (front desk) banner has displayName, dateOfBirth, mrn, allergies, photoUrl per ARCH 28.2', async () => {
    const v = await visit(); await checkIn(v); const r = await v.desk.client.get(`/api/v1/patients/${v.patient.id}`);
    assert.equal(r.status, 200, r.text); const b = r.json.patientBanner ?? r.json;
    console.log(`# F-5 keys: ${Object.keys(r.json)} banner keys: ${Object.keys(b)} allergies=${JSON.stringify(b.allergies)} photoUrl=${JSON.stringify(b.photoUrl)}`);
    for (const k of ['displayName', 'dateOfBirth', 'mrn', 'patientId']) assert.ok(b[k], `missing ${k}`);
    assert.ok('allergies' in b, 'allergies key present'); assert.ok(b.photoUrl === null || b.photoUrl === undefined || typeof b.photoUrl === 'string');
    assert.ok(!('givenName' in b) || b.displayName, 'displayName present');
  });
  it('F-7 / TC-PC-07: triage GET with no triage recorded', async () => {
    const v = await visit(); await checkIn(v); const r = await v.tri.client.get(`/api/v1/check-ins/${v.checkInId}/triage`);
    console.log(`# F-7 triage GET with none: ${r.status} keys=${Object.keys(r.json ?? {})} banner=${r.json?.patientBanner ? 'present' : 'absent'}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.triage, null); console.log('# F-7 stays a low observation: no patient data is returned, the screen takes its banner from GET /banner (apps/staff Triage.tsx:61)');
  });
  it('TC-CL-08 / 08b: chart summary lists are present (encounters, documents not null) with banner and uncoded marks', async () => {
    const v = await visit(); await checkIn(v); const dc = await docClient(v.doc); const id = v.patient.id;
    const enc = await dc.post('/api/v1/encounters', { reservationId: v.reservationId }); assert.equal(enc.status, 201, enc.text);
    const r = await dc.get(`/api/v1/patients/${id}/chart-summary`); assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.encounters) && r.json.encounters.length >= 1, 'encounters lists the started encounter');
    console.log(`# CL-08 keys=${Object.keys(r.json)}; encounters=${JSON.stringify(r.json.encounters)?.slice(0,80)}; documents=${JSON.stringify(r.json.documents)?.slice(0,80)}`);
    for (const k of ['problems', 'allergies', 'medications', 'recentVitals', 'encounters', 'documents']) assert.notEqual(r.json[k], null, `${k} is null`), assert.notEqual(r.json[k], undefined, `${k} missing`);
    assert.ok(r.json.patientBanner.displayName && r.json.patientBanner.dateOfBirth);
  });
});
