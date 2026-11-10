// TC-CL-01..03, 05, 07 and TC-SAF-05, 06, 08 (TEST-CASES 8.2, 8.3): the clinical note lifecycle and the consent gate, on ENV-INT/ci
// against the real API and database. Mechanics only: the safety-rule CONTENT (which consents, which red flags) is D-12a data and these
// tests make no clinical claim (TC-SAF acceptance stays BLOCKED, TC-SAF-07 is human and never recorded by QA).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sql, sqlTx, closeAdmin, newStaff, newDoctor, newPatient, state, ORG, A1, uuid, login } from '../../e2e/journeys/lib/world.mjs';
import { visit, checkIn, docClient, W, publishConsent, consentRow } from '../../e2e/journeys/lib/clinical.mjs';

after(closeAdmin);
const root = new URL('../../../', import.meta.url).pathname;
const pg = createRequire(root + 'package.json')('pg');

async function startEncounter(v, extra = {}) {
  await checkIn(v);
  const c = await docClient(v.doc);
  const r = await c.post('/api/v1/encounters', { reservationId: v.reservationId, ...extra });
  return { r, c };
}
async function draftNote(v) {
  const { r, c } = await startEncounter(v);
  assert.equal(r.status, 201, `encounter: ${r.status} ${r.text.slice(0, 300)}`);
  const n = await c.post(`/api/v1/encounters/${r.json.id}/notes`, {});
  assert.equal(n.status, 201, `note: ${n.status} ${n.text.slice(0, 300)}`);
  return { enc: r.json, note: n.json, c };
}

describe('TC-CL clinical notes', () => {
  it('TC-CL-01 a note locks on signing; edits fail with note_locked; changes only by addendum (BR-11)', async () => {
    const v = await visit();
    const { note, c } = await draftNote(v);
    const s1 = await c.patch(`/api/v1/notes/${note.id}`, { sections: { subjective: 'synthetic text', plan: 'synthetic plan' } }, { headers: { 'if-match': W(note.version) } });
    assert.equal(s1.status, 200, s1.text);
    const sg = await c.post(`/api/v1/notes/${note.id}/sign`, {}, { headers: { 'if-match': W(s1.json.version) } });
    assert.equal(sg.status, 200, `sign: ${sg.status} ${sg.text.slice(0, 300)}`);
    assert.equal(sg.json.status, 'signed');
    const ed = await c.patch(`/api/v1/notes/${note.id}`, { sections: { subjective: 'changed' } }, { headers: { 'if-match': W(sg.json.version) } });
    assert.equal(ed.status, 409, ed.text);
    assert.equal(ed.json.code, 'clinical.note_locked');
  });

  it('TC-CL-02 / CL-07 step 3 addendum: author, time, original unchanged; the note row never changes', async () => {
    const v = await visit();
    const { note, c } = await draftNote(v);
    const s1 = await c.patch(`/api/v1/notes/${note.id}`, { sections: { plan: 'dose A (synthetic)' } }, { headers: { 'if-match': W(note.version) } });
    const sg = await c.post(`/api/v1/notes/${note.id}/sign`, {}, { headers: { 'if-match': W(s1.json.version) } });
    assert.equal(sg.status, 200, sg.text);
    const before = (await sql(`SELECT md5(n::text) h FROM clinical.note n WHERE id = $1`, [note.id])).rows[0].h;
    const a = await c.post(`/api/v1/notes/${note.id}/addenda`, { body: 'dose corrected to B (synthetic)' });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.authorPrincipalId, v.doc.id);
    assert.ok(a.json.signedAt);
    const after = (await sql(`SELECT md5(n::text) h FROM clinical.note n WHERE id = $1`, [note.id])).rows[0].h;
    assert.equal(after, before, 'the signed note row is byte-identical after the addendum');
    const rd = await c.get(`/api/v1/notes/${note.id}`);
    assert.equal(rd.json.body.sections.plan, 'dose A (synthetic)');
    assert.ok(rd.json.addenda.some((x) => x.body.includes('corrected')));
    const draft = await draftNote(await visit());
    const bad = await draft.c.post(`/api/v1/notes/${draft.note.id}/addenda`, { body: 'x' });
    assert.ok([409, 422].includes(bad.status), `addendum on an unsigned note is refused, got ${bad.status}`);
  });

  it('TC-CL-05 two sessions on one draft: the second save gets 412 and the draft stays recoverable', async () => {
    const v = await visit();
    const { note, c } = await draftNote(v);
    const c2 = await login('staff', v.doc.key);
    const a = await c.patch(`/api/v1/notes/${note.id}`, { sections: { subjective: 'first session' } }, { headers: { 'if-match': W(note.version) } });
    assert.equal(a.status, 200, a.text);
    const b = await c2.patch(`/api/v1/notes/${note.id}`, { sections: { subjective: 'second session' } }, { headers: { 'if-match': W(note.version) } });
    assert.equal(b.status, 412, b.text);
    const rd = await c2.get(`/api/v1/notes/${note.id}`);
    assert.equal(rd.json.body.sections.subjective, 'first session', 'nothing silently overwritten');
  });

  it('TC-CL-07 a signed note: PATCH with a valid If-Match, DELETE and SQL UPDATE/DELETE as app_api all fail; hash unchanged', async () => {
    const v = await visit();
    const { note, c } = await draftNote(v);
    const s1 = await c.patch(`/api/v1/notes/${note.id}`, { sections: { plan: 'p' } }, { headers: { 'if-match': W(note.version) } });
    const sg = await c.post(`/api/v1/notes/${note.id}/sign`, {}, { headers: { 'if-match': W(s1.json.version) } });
    assert.equal(sg.status, 200, sg.text);
    const h0 = (await sql(`SELECT md5(n::text) h FROM clinical.note n WHERE id = $1`, [note.id])).rows[0].h;
    const p = await c.patch(`/api/v1/notes/${note.id}`, { sections: { plan: 'q' } }, { headers: { 'if-match': W(sg.json.version) } });
    assert.equal(p.status, 409, p.text);
    const d = await c.delete(`/api/v1/notes/${note.id}`);
    assert.ok([404, 405].includes(d.status), `DELETE is not offered, got ${d.status}`);
    // SQL as the application's own role: write the note under the doctor's scope the way the API would, then try to change it.
    const u = new URL(process.env.EHR_TEST_ADMIN_URL);
    u.username = 'app_api';
    u.password = '';
    u.pathname = '/' + state().db;
    const cl = new pg.Client({ connectionString: u.toString() });
    await cl.connect();
    const attempt = async (text) => {
      await cl.query('BEGIN');
      try {
        await cl.query("SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'staff', true), set_config('app.principal_id', $2, true)", [ORG, v.doc.id]);
        const r = await cl.query(text, [note.id]);
        await cl.query('ROLLBACK');
        return { rows: r.rowCount };
      } catch (e) {
        await cl.query('ROLLBACK');
        return { err: e.code ?? e.message };
      }
    };
    const up = await attempt(`UPDATE clinical.note SET body = '{}'::jsonb WHERE id = $1`);
    const de = await attempt(`DELETE FROM clinical.note WHERE id = $1`);
    await cl.end();
    assert.ok(up.err || up.rows === 0, `UPDATE on a signed note must fail or touch no row: ${JSON.stringify(up)}`);
    assert.ok(de.err || de.rows === 0, `DELETE on a signed note must fail or touch no row: ${JSON.stringify(de)}`);
    const h1 = (await sql(`SELECT md5(n::text) h FROM clinical.note n WHERE id = $1`, [note.id])).rows[0].h;
    assert.equal(h1, h0, 'the note is unchanged (hash equal before/after)');
  });

  it('TC-CL-03 trainee note: release needs the supervisor; a non-supervisor co-sign is refused; supervisor co-sign releases', async (t) => {
    const sup = await newDoctor({ allDay: true });
    const trn = await newDoctor({ roleKey: 'trainee_doctor', allDay: true });
    trn.client = await login('staff', trn.key);
    await sql(`UPDATE identity.staff_profile SET supervisor_principal_id = $2 WHERE principal_id = $1`, [trn.id, sup.id]);
    const v = await visit({ doc: trn });
    await checkIn(v);
    const e = await trn.client.post('/api/v1/encounters', { reservationId: v.reservationId });
    if (e.status !== 201) t.diagnostic(`trainee encounter ${e.status} ${e.text.slice(0, 200)}`);
    assert.equal(e.status, 201, `trainee starts the encounter: ${e.status} ${e.text.slice(0, 200)}`);
    const n = await trn.client.post(`/api/v1/encounters/${e.json.id}/notes`, {});
    assert.equal(n.status, 201, n.text);
    const s1 = await trn.client.patch(`/api/v1/notes/${n.json.id}`, { sections: { plan: 'trainee plan' } }, { headers: { 'if-match': W(n.json.version) } });
    const sg = await trn.client.post(`/api/v1/notes/${n.json.id}/sign`, {}, { headers: { 'if-match': W(s1.json.version) } });
    assert.equal(sg.status, 200, sg.text);
    assert.equal(sg.json.status, 'pending_cosign', 'a trainee signature waits for co-signature, it does not release');
    const other = await newDoctor({ allDay: true });
    const oc = await login('staff', other.key);
    const bad = await oc.post(`/api/v1/notes/${n.json.id}/cosign`, {});
    assert.ok([403, 404].includes(bad.status), `co-sign by a non-supervisor refused, got ${bad.status}`);
    const sc = await login('staff', sup.key);
    const ok = await sc.post(`/api/v1/notes/${n.json.id}/cosign`, {});
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, 'signed');
    const aud = await sql(`SELECT count(*)::int c FROM audit.event WHERE resource_id = $1 AND action ILIKE '%cosign%'`, [n.json.id]);
    assert.ok(aud.rows[0].c >= 1, 'the co-signature is audited');
  });
});

describe('TC-SAF consent gate (mechanics; the required consents are D-12a data)', () => {
  it('TC-SAF-05 consultation cannot start without the required signed consent; the message names the template and carries no PHI', async () => {
    const ck = await publishConsent(1);
    const v = await visit({ consents: [ck] });
    const { r } = await startEncounter(v);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'clinical.consents_missing');
    assert.ok(r.text.includes(ck), 'names the missing consent template');
    for (const phi of [v.patient.id, 'Test', 'Patient', '1980-01-01']) assert.ok(!r.text.includes(phi), `no PHI (${phi}) in the refusal`);
    const n = await sql(`SELECT count(*)::int c FROM clinical.encounter WHERE reservation_id = $1`, [v.reservationId]);
    assert.equal(n.rows[0].c, 0, 'no encounter row was created');
  });

  it('TC-SAF-06 emergency exception: with a reason it starts and is recorded and audited; without a reason it is refused', async () => {
    const ck = await publishConsent(1);
    const v = await visit({ consents: [ck] });
    await checkIn(v);
    const c = await docClient(v.doc);
    const no = await c.post('/api/v1/encounters', { reservationId: v.reservationId, emergencyException: {} });
    assert.ok([409, 422].includes(no.status), `no reason refused, got ${no.status} ${no.text.slice(0, 200)}`);
    const blank = await c.post('/api/v1/encounters', { reservationId: v.reservationId, emergencyException: { reason: '   ' } });
    assert.ok([409, 422].includes(blank.status), `blank reason refused, got ${blank.status}`);
    const ok = await c.post('/api/v1/encounters', { reservationId: v.reservationId, emergencyException: { reason: 'synthetic emergency reason' } });
    assert.equal(ok.status, 201, ok.text);
    assert.ok(ok.json.consentExceptionId, 'the exception row id is returned');
    const row = await sql(`SELECT reason FROM clinical.consent_exception WHERE id = $1`, [ok.json.consentExceptionId]);
    assert.equal(row.rows[0]?.reason, 'synthetic emergency reason');
    const aud = await sql(`SELECT count(*)::int c FROM audit.event WHERE resource_id = $1`, [ok.json.consentExceptionId]);
    assert.ok(aud.rows[0].c >= 1, 'the exception is audited');
  });

  it('TC-SAF-08 two consents: only-A blocks naming B; superseded A blocks naming A; both valid starts; sign-then-reopen is immediate; withdrawal blocks again', async () => {
    const A = await publishConsent(2);
    const B = await publishConsent(2);
    // PAT-01: A v2 signed, B missing
    const p1 = await newPatient();
    await consentRow(p1, A, 2);
    const v1 = await visit({ consents: [A, B], patient: p1 });
    const r1 = (await startEncounter(v1)).r;
    assert.equal(r1.status, 409, r1.text);
    assert.ok(r1.text.includes(B) && !r1.text.includes(A), 'names B only');
    // PAT-01 signs B and reopens at once
    await consentRow(p1, B, 2);
    const again = await (await docClient(v1.doc)).post('/api/v1/encounters', { reservationId: v1.reservationId });
    assert.equal(again.status, 201, `starts at once after signing: ${again.status} ${again.text.slice(0, 200)}`);
    // PAT-02: A v1 superseded, B v2 signed
    const p2 = await newPatient();
    await consentRow(p2, A, 1, 'superseded');
    await consentRow(p2, B, 2);
    const v2 = await visit({ consents: [A, B], patient: p2 });
    const r2 = (await startEncounter(v2)).r;
    assert.equal(r2.status, 409, r2.text);
    assert.ok(r2.text.includes(A) && !r2.text.includes(B), 'the superseded version is not valid: names A only');
    // PAT-03: both v2 signed starts; after withdrawing A, a second visit is blocked
    const p3 = await newPatient();
    await consentRow(p3, A, 2);
    await consentRow(p3, B, 2);
    const v3 = await visit({ consents: [A, B], patient: p3 });
    assert.equal((await startEncounter(v3)).r.status, 201);
    // No withdraw endpoint exists in R1 and a signed row cannot be edited (trigger), so the withdrawn state is a fresh patient whose A row is withdrawn.
    const p4 = await newPatient();
    await consentRow(p4, A, 2, 'withdrawn');
    await consentRow(p4, B, 2);
    const v3b = await visit({ consents: [A, B], patient: p4 });
    const r3 = (await startEncounter(v3b)).r;
    assert.equal(r3.status, 409, r3.text);
    assert.ok(r3.text.includes(A));
  });
});
