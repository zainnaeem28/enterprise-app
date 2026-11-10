const W = await import('/tmp/qa666/cand/tests/e2e/journeys/lib/world.mjs');
const C = await import('/tmp/qa666/cand/tests/e2e/journeys/lib/clinical.mjs');
const v = await C.visit(); await C.checkIn(v);
const dc = await C.docClient(v.doc);
const r = await dc.get(`/api/v1/patients/${v.patient.id}/chart-summary`);
const j = r.json; console.log('CL08', r.status, Object.keys(j).join(','), 'encounters=', JSON.stringify(j.encounters), 'documents=', JSON.stringify(j.documents), 'photoUrl=', j.patientBanner.photoUrl);
await W.closeAdmin();
