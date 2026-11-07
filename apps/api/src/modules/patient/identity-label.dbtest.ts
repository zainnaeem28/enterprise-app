// Real-database API tests of POST /api/v1/admin/patient-labels (ARCHITECTURE 6.7, O-5, SEC01-F-10 conditions O5-1..O5-5): the
// referencing-record check lives in the API layer, so TC-AZ-08 step 3's negative case ("refused without a visible referencing
// record") runs here, through the real route, guard and database. The database function's own refusals (no key, no slice, wrong
// realm) stay in test/security/rls-matrix.dbtest.ts (SEC03-F08).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/patient/identity-label.dbtest.js
// Gap (recorded, not dropped): "exists but invisible under the caller's RLS" is not exercised separately, because no seeded role holds
// patient.label.read without the slice of the referencing table; to the API it is the same 404 as "does not exist".
// Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  ORG,
  STAFF_HOST,
  publishedTemplates,
  tpl,
  assignRole,
  call,
  id,
  registerViaApi,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
} from './testkit.js';
import type { Kit, SeededSession } from './testkit.js';

const A1 = id(101);
const PATH = '/api/v1/admin/patient-labels';

let k: Kit;
let desk: SeededSession;
let p1: string;
let p2: string;
let consent1: string;
let consent2: string;

before(async () => {
  k = await setup({ name: 'label', fixtures: standardFixtures });
  desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
  const person = (n: number) => ({
    givenName: `Label${n}`,
    familyName: `Person${n}`,
    dateOfBirth: '1975-03-09',
    phone: `+1212555${String(2000 + n)}`,
    email: `label${n}@example.test`,
  });
  p1 = await registerViaApi(k, desk, A1, person(1));
  p2 = await registerViaApi(k, desk, A1, person(2));
  publishedTemplates.add(tpl('treatment', 1));
  const ask = (pid: string) =>
    k.db.withScope(
      {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: desk.seeded.principalId,
        locationIds: [A1],
      },
      (tx) =>
        k.patient.records.requestConsent(tx, { requestId: randomUUID() }, pid, 'treatment', 1),
    );
  consent1 = (await ask(p1)).id;
  consent2 = (await ask(p2)).id;
});
after(async () => {
  await k?.close();
});

async function officer(role = 'compliance_officer'): Promise<SeededSession> {
  const p = await seedPrincipal(k, 'admin_pool', { name: 'Officer' });
  await assignRole(k, p.principalId, role);
  return seedSession(k, p, 'admin_pool');
}
const label = (s: SeededSession, body: unknown) =>
  call(k.base, 'POST', PATH, {
    cookie: s.cookie,
    headers: writeHeaders(s, STAFF_HOST, randomUUID()),
    body,
  });
const labelAudit = async (patientId: string): Promise<number> =>
  Number(
    (
      await k.q<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit.event WHERE action = 'view' AND resource_type = 'patient.consent' AND patient_id = $1 AND change->>'label' = 'true'`,
        [patientId],
      )
    )[0]?.n,
  );
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];

describe('POST /admin/patient-labels (TC-AZ-08 step 3, O-5)', () => {
  test('a visible referencing record of the same patient: 200 with the label and exactly one audit row naming the reference (O5-2, O5-5)', async () => {
    const o = await officer();
    const before = await labelAudit(p1);
    const r = await label(o, { patientId: p1, referenceType: 'consent', referenceId: consent1 });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json()['givenName'], 'Label1');
    assert.equal(r.json()['familyName'], 'Person1');
    assert.equal(r.json()['merged'], false);
    assert.equal(await labelAudit(p1), before + 1);
    const row = (
      await k.q(
        `SELECT resource_id FROM audit.event WHERE action = 'view' AND resource_type = 'patient.consent' AND patient_id = $1 AND change->>'label' = 'true' ORDER BY occurred_at DESC LIMIT 1`,
        [p1],
      )
    )[0] as Record<string, unknown>;
    assert.equal(row['resource_id'], consent1);
  });

  test('a referencing record that does not exist: 404 and the database function is never reached (no label audit row)', async () => {
    const o = await officer();
    const b1 = await labelAudit(p1);
    const r = await label(o, {
      patientId: p1,
      referenceType: 'consent',
      referenceId: randomUUID(),
    });
    assert.equal(r.status, 404, r.body);
    assert.equal(await labelAudit(p1), b1);
  });

  test('a referencing record that exists but belongs to another patient: 404 (O5-1) and no label audit row', async () => {
    const o = await officer();
    const b1 = await labelAudit(p1);
    const b2 = await labelAudit(p2);
    const r = await label(o, { patientId: p1, referenceType: 'consent', referenceId: consent2 });
    assert.equal(r.status, 404, r.body);
    assert.equal(await labelAudit(p1), b1);
    assert.equal(await labelAudit(p2), b2);
  });

  test('without the patient_label key or outside the admin realm: refused, no label audit row', async () => {
    const b1 = await labelAudit(p1);
    const noKey = await officer('org_admin');
    const r1 = await label(noKey, {
      patientId: p1,
      referenceType: 'consent',
      referenceId: consent1,
    });
    assert.ok([403, 404].includes(r1.status), `no key: ${r1.status} ${r1.body}`);
    const r2 = await label(desk, {
      patientId: p1,
      referenceType: 'consent',
      referenceId: consent1,
    });
    assert.ok([403, 404].includes(r2.status), `google realm: ${r2.status} ${r2.body}`);
    assert.equal(await labelAudit(p1), b1);
  });

  test('a malformed body is 422 and rate limiting applies per principal (labelLimitPerHour = 3 in this harness): the 4th call is 429', async () => {
    const o = await officer();
    const bad = await label(o, {
      patientId: 'nope',
      referenceType: 'consent',
      referenceId: consent1,
    });
    assert.equal(bad.status, 422, bad.body);
    const bad2 = await label(o, { patientId: p1, referenceType: 'bogus', referenceId: consent1 });
    assert.equal(bad2.status, 422, bad2.body);
    const ok = await label(o, { patientId: p1, referenceType: 'consent', referenceId: consent1 });
    assert.equal(ok.status, 200, ok.body);
    const limited = await label(o, {
      patientId: p1,
      referenceType: 'consent',
      referenceId: consent1,
    });
    assert.equal(limited.status, 429, limited.body);
    assert.equal(code(limited), 'kernel.rate_limited');
  });
});
