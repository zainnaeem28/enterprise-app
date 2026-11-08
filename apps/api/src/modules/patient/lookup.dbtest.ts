// Real-database tests for POST /patients/lookup (decision HEAAA-286, draft 8.3, 38.2 item 23): the minimised lookup for the seeded
// `doctor` role, and what a doctor still cannot read. PostgreSQL 17, the seeded roles, RLS, the identity guard and a real HTTP server;
// the chart routes of item (g) and (i) run through the notes testkit's stack (imported, not modified). Synthetic data only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/patient/lookup.dbtest.js
// The URL names a superuser on a throwaway server. Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
// The chart routes of items (g) and (i) need the notes testkit's stack, the only harness with the chart and the seeded doctor role
// (decision HEAAA-286, section 5 item 3). Test-only import; the same exemption as alerts.dbtest.ts (ALR-N8).
/* eslint-disable boundaries/module-boundaries */
import { A1, A2, adminUrl, setupNotes, staffMember } from '../clinical/notes/testkit.js';
import type { NotesKit, PatientKit, SeededSession } from '../clinical/notes/testkit.js';
/* eslint-enable boundaries/module-boundaries */
import { registerViaApi } from './testkit.js';

let t: NotesKit;
let seed = 3000;
const n = (): number => ++seed;
type Doc = Record<string, unknown>;

const rows = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
  t.k.q<T>(sql, p);
const lookup = (who: SeededSession, body: unknown) =>
  t.scall(who, 'POST', '/api/v1/patients/lookup', body);
const code = (r: { json(): Doc }): unknown => r.json()['code'];
const SIX = ['dateOfBirth', 'familyName', 'givenName', 'middleName', 'mrn', 'patientId'];
const ids = (r: { json(): Doc }): string[] =>
  (r.json()['items'] as Doc[]).map((x) => String(x['patientId']));

describe('POST /patients/lookup (HEAAA-286, draft 8.3) on PostgreSQL 17', () => {
  let doctor: SeededSession;
  let inA1: PatientKit;
  let onlyA2: string;
  const fam = 'Lookupfam';

  before(async () => {
    assert.ok(adminUrl, 'EHR_TEST_ADMIN_URL must name a throwaway PostgreSQL 17 server');
    t = await setupNotes('be290p');
    doctor = await staffMember(t.k, 'doctor', A1, 'Doctor lookup');
    inA1 = await t.mkPatient(n());
    const deskA2 = await staffMember(t.k, 'front_desk', A2, 'Desk A2');
    onlyA2 = await registerViaApi(t.k, deskA2, A2, {
      givenName: 'Faraway',
      familyName: fam,
      dateOfBirth: '1971-02-03',
      phone: '+12125559001',
      email: 'faraway@example.test',
    });
  });
  after(async () => {
    await t?.close();
  });

  test('(a) an L1 doctor finds an L1 patient by name, MRN and patientIds; the item has exactly the six fields', async () => {
    const mrn = (
      await rows<{ mrn: string }>(`SELECT mrn FROM patient.patient WHERE id = $1`, [inA1.patientId])
    )[0]?.mrn as string;
    const nm = await rows<{ given_name: string; family_name: string }>(
      `SELECT given_name, family_name FROM patient.patient WHERE id = $1`,
      [inA1.patientId],
    );
    const name = `${nm[0]?.given_name} ${nm[0]?.family_name}`;
    for (const body of [
      { name },
      { name, dateOfBirth: '1980-05-17' },
      { mrn },
      { patientIds: [inA1.patientId] },
    ]) {
      const r = await lookup(doctor, body);
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(ids(r), [inA1.patientId], JSON.stringify(Object.keys(body)));
      assert.equal(r.json()['truncated'], false);
      const item = (r.json()['items'] as Doc[])[0] as Doc;
      assert.deepEqual(Object.keys(item).sort(), SIX);
      assert.equal(item['mrn'], mrn);
      assert.equal(item['dateOfBirth'], '1980-05-17');
    }
  });

  test('(b) a patient registered only at L2 is absent for every form, with 200 and the same shape', async () => {
    const mrn = (
      await rows<{ mrn: string }>(`SELECT mrn FROM patient.patient WHERE id = $1`, [onlyA2])
    )[0]?.mrn as string;
    for (const body of [
      { name: `Faraway ${fam}` },
      { name: 'Faraway', dateOfBirth: '1971-02-03' },
      { mrn },
      { patientIds: [onlyA2, randomUUID()] },
    ]) {
      const r = await lookup(doctor, body);
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(r.json(), { items: [], truncated: false });
    }
  });

  test('(c) phone, email, dateOfBirth alone, a one-character name word, more than four words, mixed forms and unknown members are kernel.validation_failed', async () => {
    for (const body of [
      { phone: '+12125551111' },
      { email: 'a@example.test' },
      { dateOfBirth: '1980-05-17' },
      { name: 'A Smith' },
      { name: 'one two three four five' },
      { name: 'Smith', phone: '+12125551111' },
      { name: 'Smith', mrn: 'MRN-1000001' },
      { mrn: 'MRN-1000001', patientIds: [randomUUID()] },
      { patientIds: [] },
      { patientIds: ['not-a-uuid'] },
      { patientIds: Array.from({ length: 26 }, () => randomUUID()) },
      { mrn: 'nonsense' },
      { name: 'Smith', dateOfBirth: 'x' },
      {},
    ]) {
      const r = await lookup(doctor, body);
      assert.equal(code(r), 'kernel.validation_failed', JSON.stringify(body));
    }
  });

  test('(d) more than 25 matches give 25 items and truncated: true, ordered by family and given name', async () => {
    const deskA1 = await staffMember(t.k, 'front_desk', A1, 'Desk A1 cap');
    for (let i = 0; i < 27; i += 1)
      await registerViaApi(t.k, deskA1, A1, {
        givenName: `Cap${String.fromCharCode(97 + (i % 26))}${i}`,
        familyName: 'Capfamily',
        dateOfBirth: `19${60 + (i % 30)}-0${1 + (i % 9)}-1${i % 9}`,
        phone: `+1212555${String(2000 + i)}`,
      });
    const r = await lookup(doctor, { name: 'Capfamily' });
    assert.equal(r.status, 200, r.body);
    const items = r.json()['items'] as Doc[];
    assert.equal(items.length, 25);
    assert.equal(r.json()['truncated'], true);
    const given = items.map((x) => String(x['givenName']).toLowerCase());
    assert.deepEqual(given, [...given].sort());
  });

  test('(e) the 31st call in a minute is 429 kernel.rate_limited with retryAfterSeconds; the counter is per principal and its own', async () => {
    const dr = await staffMember(t.k, 'doctor', A1, 'Doctor rate');
    const body = { mrn: 'MRN-9999999' };
    for (let i = 0; i < 30; i += 1)
      assert.equal((await lookup(dr, body)).status, 200, `call ${i + 1}`);
    const over = await lookup(dr, body);
    assert.equal(over.status, 429, over.body);
    assert.equal(code(over), 'kernel.rate_limited');
    assert.ok(Number(over.json()['retryAfterSeconds']) > 0);
    assert.equal((await lookup(doctor, body)).status, 200, 'another principal has its own counter');
  });

  test('(f) the audit search event has form, results and patientIds and no criteria values', async () => {
    const dr = await staffMember(t.k, 'doctor', A1, 'Doctor audit');
    const nm = await rows<{ given_name: string; family_name: string }>(
      `SELECT given_name, family_name FROM patient.patient WHERE id = $1`,
      [inA1.patientId],
    );
    const name = `${nm[0]?.given_name} ${nm[0]?.family_name}`;
    assert.equal((await lookup(dr, { name })).status, 200);
    assert.equal((await lookup(dr, { patientIds: [inA1.patientId, onlyA2] })).status, 200);
    const ev = await rows<{ change: Doc }>(
      `SELECT change FROM audit.event WHERE action = 'search' AND resource_type = 'patient.patient' AND actor_principal_id = $1 ORDER BY occurred_at`,
      [dr.seeded.principalId],
    );
    assert.equal(ev.length, 2, 'one event per call');
    assert.deepEqual(ev[0]?.change, { form: 'name', results: 1, patientIds: [inA1.patientId] });
    assert.deepEqual(ev[1]?.change, { form: 'ids', results: 1, patientIds: [inA1.patientId] });
    assert.equal(
      JSON.stringify(ev).includes(String(nm[0]?.family_name)),
      false,
      'no criteria values',
    );
  });

  test('(g) an in-scope unassigned patient: chart-summary is 403 clinical.not_assigned, then 200 after break-the-glass', async () => {
    const dr = await staffMember(t.k, 'doctor', A1, 'Doctor btg');
    const p = await t.mkPatient(n());
    const found = await lookup(dr, { patientIds: [p.patientId] });
    assert.deepEqual(ids(found), [p.patientId], 'lookup finds the in-location patient');
    const no = await t.scall(dr, 'GET', `/api/v1/patients/${p.patientId}/chart-summary`);
    assert.equal(no.status, 403, no.body);
    assert.equal(code(no), 'clinical.not_assigned');
    await t.as(t.staffScope(dr), (tx) =>
      t.k.audit.openBtg(tx, {
        requestId: randomUUID(),
        patientId: p.patientId,
        reason: 'Emergency review of a synthetic chart',
      }),
    );
    const ok = await t.scall(dr, 'GET', `/api/v1/patients/${p.patientId}/chart-summary`);
    assert.equal(ok.status, 200, ok.body);
  });

  test('(h) the doctor still cannot call POST /patients/search or read /patients/{id}, /banner, /consents, /contacts: 403 auth.forbidden', async () => {
    const pid = inA1.patientId;
    const search = await t.scall(doctor, 'POST', '/api/v1/patients/search', { name: 'Given' });
    assert.equal(search.status, 403, search.body);
    assert.equal(code(search), 'auth.forbidden');
    for (const path of [
      `/api/v1/patients/${pid}`,
      `/api/v1/patients/${pid}/banner`,
      `/api/v1/patients/${pid}/consents`,
      `/api/v1/patients/${pid}/contacts`,
      `/api/v1/patients/${pid}/insurance-coverages`,
    ]) {
      const r = await t.scall(doctor, 'GET', path);
      assert.equal(r.status, 403, `${path} ${r.body}`);
      assert.equal(code(r), 'auth.forbidden', path);
    }
  });

  test('(i) a chart-summary for a patient out of the doctor location scope is 404 kernel.not_found', async () => {
    const r = await t.scall(doctor, 'GET', `/api/v1/patients/${onlyA2}/chart-summary`);
    assert.equal(r.status, 404, r.body);
    assert.equal(code(r), 'kernel.not_found');
  });

  test('the lookup is refused to roles that do not hold patient.lookup (front desk, nurse): 403', async () => {
    for (const s of [t.desk, t.nurse]) {
      const r = await lookup(s, { mrn: 'MRN-1000001' });
      assert.equal(r.status, 403, r.body);
      assert.equal(code(r), 'auth.forbidden');
    }
  });
});
