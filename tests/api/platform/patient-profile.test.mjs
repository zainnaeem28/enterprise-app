// TC-PP-01..07 (TEST-CASES 10.3). ENV-INT/ci. Profile and contact edits, hostile input and the proxy-request refusal run through the
// real portal routes. Insurance-card upload needs the object store (C-01), proxy rules are undecided (D-7 / G-07), and the
// pre-visit request/questionnaire/e-sign flow is QA-04's clinical journey: those parts stay BLOCKED naming the missing piece.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPatient, newStaff, sql, closeAdmin, A1 } from './lib/world.mjs';

after(() => closeAdmin());
const ATTACK = [
  '<script>alert(1)</script>',
  `'; DROP TABLE patient.patient; --`,
  '"><img src=x onerror=alert(1)>',
  '{{7*7}}',
  '\u0000',
];

describe('TC-PP', () => {
  test('TC-PP-01 the patient edits demographics, language, pharmacy and a contact; changes persist and are audited', async () => {
    const p = await newPatient();
    const t0 = new Date(Date.now() - 500).toISOString();
    const g = await p.client.get(`/api/v1/patients/${p.id}/profile`);
    assert.equal(g.status, 200, `${g.status} ${g.text.slice(0, 200)}`);
    const up = await p.client.patch(
      `/api/v1/patients/${p.id}/profile`,
      {
        preferredLanguage: 'es',
        preferredPharmacy: { name: 'Synthetic Pharmacy', phone: '+15555550100' },
      },
      { headers: { 'if-match': g.headers.etag } },
    );
    assert.equal(up.status, 200, `${up.status} ${up.text.slice(0, 300)}`);
    const c = await p.client.post(`/api/v1/patients/${p.id}/contacts`, {
      kind: 'emergency',
      name: 'Synthetic Contact',
      relationship: 'spouse',
      phone: '+15555550101',
    });
    assert.equal(c.status, 201, `contact ${c.status} ${c.text.slice(0, 300)}`);
    const again = await p.client.get(`/api/v1/patients/${p.id}/profile`);
    assert.equal(again.json.preferredLanguage, 'es');
    assert.ok(
      again.json.contacts.some((x) => x.name === 'Synthetic Contact'),
      'the contact survives a reload',
    );
    const au = await sql(
      `SELECT resource_type, action FROM audit.event WHERE occurred_at >= $1 AND resource_id::text = $2`,
      [t0, p.id],
    );
    assert.ok(au.rowCount >= 1, 'the change is audited against the patient');
    // the audit view as the compliance officer (CMP-1) is TC-AU's journey; the insurance card upload is BLOCKED (object store).
  });

  test('TC-PP-02 hostile and invalid input is rejected or stored as inert text', async () => {
    const p = await newPatient();
    const g = await p.client.get(`/api/v1/patients/${p.id}/profile`);
    let etag = g.headers.etag;
    const future = await p.client.patch(
      `/api/v1/patients/${p.id}/profile`,
      { dateOfBirth: '2999-01-01' },
      { headers: { 'if-match': etag } },
    );
    assert.ok(
      [400, 422].includes(future.status),
      `a future date of birth is refused (${future.status})`,
    );
    const long = await p.client.post(`/api/v1/patients/${p.id}/contacts`, {
      kind: 'emergency',
      name: 'x'.repeat(5000),
      relationship: 'friend',
      phone: '+15555550102',
    });
    assert.ok([400, 422].includes(long.status), `a very long name is refused (${long.status})`);
    for (const a of ATTACK) {
      const r = await p.client.post(`/api/v1/patients/${p.id}/contacts`, {
        kind: 'emergency',
        name: a,
        relationship: 'friend',
        phone: '+15555550103',
      });
      assert.ok(r.status !== 500, `${JSON.stringify(a)} no server error`);
      if (r.status === 201) {
        const back = await p.client.get(`/api/v1/patients/${p.id}/contacts`);
        assert.match(back.headers['content-type'], /application\/json/);
        assert.equal(back.headers['x-content-type-options'], 'nosniff');
      } else assert.ok([400, 422].includes(r.status), `${r.status}`);
    }
    const tables = await sql(`SELECT to_regclass('patient.patient') t`);
    assert.ok(tables.rows[0].t, 'the SQL fragment dropped nothing');
  });

  test('TC-PP-04 a proxy-link request is refused (not queued) while the verification rules are undecided (D-7)', async () => {
    const p = await newPatient();
    const r = await p.client.post(`/api/v1/patients/${p.id}/proxy-requests`, {
      relationship: 'parent',
    });
    assert.ok(
      [409, 422, 501, 503].includes(r.status) || r.json?.code?.includes('proxy'),
      `${r.status} ${r.text.slice(0, 200)}`,
    );
    assert.notEqual(r.status, 201, 'no request is recorded without rules');
  });

  const B = (w) => `BLOCKED: ${w}`;
  test(
    'TC-PP-03 proxy default view shows appointments only [proxy grant flow]',
    {
      skip: B(
        'needs a verified proxy grant, which cannot be created while D-7 is open; the isolation side is TC-AZ-14 (QA-02)',
      ),
    },
    () => {},
  );
  test(
    'TC-PP-05 age-out and revocation of a proxy [D-7 / G-07]',
    { skip: B('rule values do not exist yet (D-7 / G-07); case written when decided') },
    () => {},
  );
  test(
    'TC-PP-06 patient completes the pre-visit request, questionnaire and e-signs; staff see status [clinical flow]',
    {
      skip: B(
        'the pre-visit request/questionnaire/e-sign journey is the QA-04 clinical suite and insurance-card upload needs the object store (C-01)',
      ),
    },
    () => {},
  );
  test(
    'TC-PP-07 partial completion shows "incomplete" and which items [clinical flow]',
    { skip: B('same flow as TC-PP-06 (QA-04)') },
    () => {},
  );
});
