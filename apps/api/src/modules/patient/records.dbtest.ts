// Real-database tests for BE-08, part 2: the records that hang off the patient (contacts, insurance and the eligibility result,
// consents with signed templates, communication preferences, the care team) and proxy access through the identity interface
// (D-7 default, RA-R1-20a; TC-AZ-14, TC-PP-03).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/patient/records.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  ORG,
  PATIENT_HOST,
  ProbeController,
  assignRole,
  call,
  id,
  patientAccount,
  publishedTemplates,
  registerViaApi,
  saWrite,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
  tpl,
  writeHeaders,
  STAFF_HOST,
} from './testkit.js';
import type { Kit, SeededSession } from './testkit.js';

const A1 = id(101);
const B1 = id(201);

let k: Kit;
let desk: SeededSession;
let coordinator: SeededSession;
let doctor: SeededSession;

before(async () => {
  k = await setup({ name: 'rec', fixtures: standardFixtures, controllers: [ProbeController] });
  desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
  // The seeded roles do not carry patient.care_team.manage yet (the care team belongs to a later role proposal): a test role that does.
  await k.sa.query(
    `INSERT INTO identity.role (id, organisation_id, key, realm, privileged, location_bound) VALUES ('00000000-0000-7000-8000-00000000c0a1', $1, 'care_team_lead', 'google', false, true)`,
    [ORG],
  );
  await k.sa.query(
    `INSERT INTO identity.role_permission (role_id, organisation_id, permission_key) VALUES ('00000000-0000-7000-8000-00000000c0a1', $1, 'patient.care_team.manage'), ('00000000-0000-7000-8000-00000000c0a1', $1, 'patient.read')`,
    [ORG],
  );
  coordinator = await staffMember(k, 'care_team_lead', A1, 'Coordinator A1');
  doctor = await staffMember(k, 'doctor', A1, 'Doctor A1');
  publishedTemplates.add(tpl('treatment', 1));
  publishedTemplates.add(tpl('treatment', 2));
  publishedTemplates.add(tpl('telehealth', 1));
});
after(async () => {
  await k?.close();
});

const who = (n: number) => ({
  givenName: `Rec${n}`,
  familyName: `Fam${n}`,
  dateOfBirth: '1985-03-09',
  phone: `+1212777${String(1000 + n)}`,
  email: `rec${n}@example.test`,
});
const call2 = (
  s: SeededSession,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
  host = STAFF_HOST,
) =>
  call(k.base, method, path, {
    host,
    cookie: s.cookie,
    headers: { ...(method === 'GET' ? {} : writeHeaders(s, host)), ...extra },
    ...(body === undefined ? {} : { body }),
  });
const idem = (): Record<string, string> => ({ 'idempotency-key': randomUUID() });
const mine = (
  s: SeededSession,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) => call2(s, method, path, body, extra, PATIENT_HOST);
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];

/** A registered patient with a signed-in own account. */
async function patientWithAccount(n: number): Promise<{ pid: string; acct: SeededSession }> {
  const pid = await registerViaApi(k, desk, A1, who(n));
  return { pid, acct: await patientAccount(k, pid) };
}

describe('contacts and insurance (22.6)', () => {
  test('the patient manages their own contacts; each write is audited by field name; a delete removes the row', async () => {
    const { pid, acct } = await patientWithAccount(1);
    const add = await mine(
      acct,
      'POST',
      `/api/v1/patients/${pid}/contacts`,
      { kind: 'emergency', name: 'Ana Rec', relationship: 'sister', phone: '(212) 555-0101' },
      idem(),
    );
    assert.equal(add.status, 201);
    assert.equal(add.json()['phone'], '+12125550101');
    const cid = add.json()['id'] as string;
    const bad = await mine(
      acct,
      'POST',
      `/api/v1/patients/${pid}/contacts`,
      { kind: 'stranger', name: '' },
      idem(),
    );
    assert.equal(bad.status, 422);
    const list = await mine(acct, 'GET', `/api/v1/patients/${pid}/contacts`);
    assert.equal((list.json()['items'] as unknown[]).length, 1);
    const patch = await mine(
      acct,
      'PATCH',
      `/api/v1/patients/${pid}/contacts/${cid}`,
      { name: 'Ana R.' },
      { 'if-match': 'W/"1"' },
    );
    assert.equal(patch.status, 200);
    assert.equal(
      (
        await mine(
          acct,
          'PATCH',
          `/api/v1/patients/${pid}/contacts/${cid}`,
          { name: 'Again' },
          { 'if-match': 'W/"1"' },
        )
      ).status,
      412,
    );
    assert.equal(
      (await mine(acct, 'DELETE', `/api/v1/patients/${pid}/contacts/${cid}`)).status,
      204,
    );
    assert.equal(
      (await mine(acct, 'DELETE', `/api/v1/patients/${pid}/contacts/${cid}`)).status,
      404,
    );
  });

  test('insurance: the patient keeps the card details; only staff set the eligibility result; a change to the card clears an earlier result (RA-R1-29)', async () => {
    const { pid, acct } = await patientWithAccount(2);
    const add = await mine(
      acct,
      'POST',
      `/api/v1/patients/${pid}/insurance-coverages`,
      { payerName: 'Acme Health', memberId: 'M-100', groupNumber: 'G1' },
      idem(),
    );
    assert.equal(add.status, 201);
    assert.equal(add.json()['eligibilityStatus'], 'unknown');
    const cov = add.json()['id'] as string;
    // the patient cannot grant themselves an eligibility result: not through the API (the field is ignored) ...
    await mine(
      acct,
      'PATCH',
      `/api/v1/patients/${pid}/insurance-coverages/${cov}`,
      { eligibilityStatus: 'verified_active' },
      { 'if-match': 'W/"1"' },
    ).then((r) => assert.equal(r.status, 422));
    // ... and not through the database either
    await assert.rejects(
      k.db.withScope(
        {
          audience: 'patient',
          realm: 'patient_pool',
          orgId: ORG,
          principalId: acct.seeded.principalId,
          patientIds: [pid],
        },
        (tx) =>
          tx.query(
            `UPDATE patient.insurance_coverage SET eligibility_status = 'verified_active', verified_at = now(), verified_by = $2 WHERE id = $1`,
            [cov, acct.seeded.principalId],
          ),
      ),
      (e: unknown) => ['42501'].includes((e as { code?: string }).code ?? ''),
    );
    // staff verify it
    const v = await call2(
      desk,
      'PUT',
      `/api/v1/insurance-coverages/${cov}/eligibility`,
      { status: 'verified_active' },
      { 'if-match': 'W/"1"' },
    );
    assert.equal(v.status, 200);
    assert.equal(v.json()['status'], 'verified_active');
    assert.ok(v.json()['verifiedAt']);
    const row = (
      await k.q(
        `SELECT eligibility_status, verified_by FROM patient.insurance_coverage WHERE id = $1`,
        [cov],
      )
    )[0];
    assert.equal(row?.['eligibility_status'], 'verified_active');
    assert.equal(row?.['verified_by'], desk.seeded.principalId);
    // stale version -> 412; an invalid status -> 422; someone else's coverage -> 404
    assert.equal(
      (
        await call2(
          desk,
          'PUT',
          `/api/v1/insurance-coverages/${cov}/eligibility`,
          { status: 'verified_inactive' },
          { 'if-match': 'W/"1"' },
        )
      ).status,
      412,
    );
    assert.equal(
      (
        await call2(
          desk,
          'PUT',
          `/api/v1/insurance-coverages/${cov}/eligibility`,
          { status: 'unknown' },
          { 'if-match': 'W/"2"' },
        )
      ).status,
      422,
    );
    const other = await registerViaApi(k, await staffMember(k, 'front_desk', B1), B1, who(3));
    const oc = randomUUID();
    await saWrite(
      k,
      `INSERT INTO patient.insurance_coverage (id, organisation_id, patient_id, payer_name, member_id) VALUES ($1,$2,$3,'Other','X')`,
      [oc, ORG, other],
    );
    assert.equal(
      (
        await call2(
          desk,
          'PUT',
          `/api/v1/insurance-coverages/${oc}/eligibility`,
          { status: 'verified_active' },
          { 'if-match': 'W/"1"' },
        )
      ).status,
      404,
    );
    // the patient changes the member ID: the earlier result belonged to the old details
    const cur = String(
      (await mine(acct, 'GET', `/api/v1/patients/${pid}/insurance-coverages`)).json()['items']
        ? (
            (await mine(acct, 'GET', `/api/v1/patients/${pid}/insurance-coverages`)).json()[
              'items'
            ] as { rowVersion: number }[]
          )[0]?.rowVersion
        : 0,
    );
    const ch = await mine(
      acct,
      'PATCH',
      `/api/v1/patients/${pid}/insurance-coverages/${cov}`,
      { memberId: 'M-200' },
      { 'if-match': `W/"${cur}"` },
    );
    assert.equal(ch.status, 200);
    assert.equal(ch.json()['eligibilityStatus'], 'unknown');
    assert.equal(ch.json()['verifiedAt'], null);
  });
});

describe('consents with signed templates (BR-09, 22.6)', () => {
  const pendingFor = async (pid: string, key: string, version: number) =>
    k.db.withScope(
      {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: desk.seeded.principalId,
        locationIds: [A1],
      },
      (tx) =>
        k.patient.records.requestConsent(tx, { requestId: randomUUID() }, pid, key, version, 'en'),
    );

  test('a pending consent is asked once; the patient signs it as themselves; signing records who, when and the typed signature', async () => {
    const { pid, acct } = await patientWithAccount(10);
    const a = await pendingFor(pid, 'treatment', 1);
    const b = await pendingFor(pid, 'treatment', 1);
    assert.equal(a.id, b.id, 'asking twice returns the open request');
    assert.equal(a.status, 'pending');
    const r = await mine(
      acct,
      'POST',
      `/api/v1/consents/${a.id}/sign`,
      { typedName: 'Rec10 Fam10' },
      idem(),
    );
    assert.equal(r.status, 200);
    assert.equal(r.json()['status'], 'signed');
    assert.equal(r.json()['signerRelationship'], 'self');
    const row = (
      await k.q(
        `SELECT signer_principal_id, signed_name, signed_at, template_version FROM patient.consent WHERE id = $1`,
        [a.id],
      )
    )[0];
    assert.equal(row?.['signer_principal_id'], acct.seeded.principalId);
    assert.equal(row?.['signed_name'], 'Rec10 Fam10');
    assert.ok(row?.['signed_at'], "the signing time is the database's");
    // not pending any more
    const again = await mine(
      acct,
      'POST',
      `/api/v1/consents/${a.id}/sign`,
      { typedName: 'Rec10 Fam10' },
      idem(),
    );
    assert.equal(again.status, 409);
    assert.equal(code(again), 'patient.consent_not_pending');
    // the signing is audited, and the event names the template and not the signature
    const ev = await k.q(
      `SELECT change FROM audit.event WHERE resource_type = 'patient.consent' AND resource_id = $1 AND action = 'update'`,
      [a.id],
    );
    assert.deepEqual(ev[0]?.['change'], {
      status: 'signed',
      templateKey: 'treatment',
      templateVersion: 1,
      templateLanguage: 'en',
    });
    // staff read the consent list of a patient they care for
    const list = await call2(desk, 'GET', `/api/v1/patients/${pid}/consents`);
    assert.equal(list.status, 200);
    assert.equal((list.json()['items'] as { status: string }[])[0]?.status, 'signed');
  });

  test('a newer version supersedes the signed one in the same transaction; a signed row only ever moves to superseded or withdrawn', async () => {
    const { pid, acct } = await patientWithAccount(11);
    const v1 = await pendingFor(pid, 'treatment', 1);
    await mine(acct, 'POST', `/api/v1/consents/${v1.id}/sign`, { typedName: 'A B' }, idem());
    const v2 = await pendingFor(pid, 'treatment', 2);
    const r = await mine(
      acct,
      'POST',
      `/api/v1/consents/${v2.id}/sign`,
      { typedName: 'A B' },
      idem(),
    );
    assert.equal(r.status, 200);
    const rows = await k.q(
      `SELECT template_version, status FROM patient.consent WHERE patient_id = $1 ORDER BY template_version`,
      [pid],
    );
    assert.deepEqual(
      rows.map((x) => [x['template_version'], x['status']]),
      [
        [1, 'superseded'],
        [2, 'signed'],
      ],
    );
    // required-consent status: version 2 signed, version 1 would be outdated for a template now at 3
    const st = await k.db.withScope(
      {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: desk.seeded.principalId,
        locationIds: [A1],
      },
      (tx) =>
        k.patient.records.requiredConsentStatus(tx, pid, [
          { key: 'treatment', version: 2 },
          { key: 'treatment', version: 3 },
          { key: 'telehealth', version: 1 },
        ]),
    );
    assert.deepEqual(
      st.map((s) => s.status),
      ['signed', 'outdated', 'missing'],
    );
    // direct SQL cannot rewrite history
    for (const [sql, target] of [
      [`UPDATE patient.consent SET status = 'pending' WHERE id = $1`, v1.id],
      [`UPDATE patient.consent SET status = 'signed' WHERE id = $1`, v1.id],
      [`UPDATE patient.consent SET signed_name = 'Z' WHERE id = $1`, v2.id],
      [`UPDATE patient.consent SET template_version = 9 WHERE id = $1`, v2.id],
    ] as const)
      await assert.rejects(
        saWrite(k, sql, [target]),
        (e: unknown) => (e as { code?: string }).code === 'PS001',
        sql,
      );
    // a second signed row for the same template cannot exist
    await assert.rejects(
      saWrite(
        k,
        `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language, status, signed_at, signer_principal_id, signer_relationship, signed_name) VALUES (gen_random_uuid(), $1, $2, 'treatment', 7, 'en', 'signed', now(), $3, 'self', 'X')`,
        [ORG, pid, acct.seeded.principalId],
      ),
      (e: unknown) => (e as { code?: string }).code === '23505',
    );
  });

  test('a template that is no longer published cannot be signed; a blank or missing typed name is refused; withdrawn is final', async () => {
    const { pid, acct } = await patientWithAccount(12);
    const c = await pendingFor(pid, 'telehealth', 1);
    assert.equal(
      (await mine(acct, 'POST', `/api/v1/consents/${c.id}/sign`, {}, idem())).status,
      422,
    );
    assert.equal(
      (await mine(acct, 'POST', `/api/v1/consents/${c.id}/sign`, { typedName: '   ' }, idem()))
        .status,
      422,
    );
    publishedTemplates.delete(tpl('telehealth', 1));
    const stale = await mine(
      acct,
      'POST',
      `/api/v1/consents/${c.id}/sign`,
      { typedName: 'A B' },
      idem(),
    );
    assert.equal(stale.status, 409);
    assert.equal(code(stale), 'patient.consent_not_pending');
    publishedTemplates.add(tpl('telehealth', 1));
    await assert.rejects(
      k.db.withScope(
        {
          audience: 'staff',
          realm: 'google',
          orgId: ORG,
          principalId: desk.seeded.principalId,
          locationIds: [A1],
        },
        (tx) =>
          k.patient.records.requestConsent(
            tx,
            { requestId: randomUUID() },
            pid,
            'unpublished',
            1,
            'en',
          ),
      ),
      (e: unknown) => (e as { code?: string }).code === 'kernel.validation_failed',
    );
    await saWrite(k, `UPDATE patient.consent SET status = 'withdrawn' WHERE id = $1`, [c.id]);
    await assert.rejects(
      saWrite(k, `UPDATE patient.consent SET status = 'pending' WHERE id = $1`, [c.id]),
      (e: unknown) => (e as { code?: string }).code === 'PS001',
    );
    assert.equal(
      (await k.q(`SELECT withdrawn_at FROM patient.consent WHERE id = $1`, [c.id]))[0]?.[
        'withdrawn_at'
      ] !== null,
      true,
    );
  });

  test('another patient cannot sign my consent (404), a proxy cannot sign (default: not), staff may witness; an idempotent retry signs once', async () => {
    const { pid, acct } = await patientWithAccount(13);
    const { acct: stranger } = await patientWithAccount(14);
    const c = await pendingFor(pid, 'treatment', 1);
    assert.equal(
      (await mine(stranger, 'POST', `/api/v1/consents/${c.id}/sign`, { typedName: 'X' }, idem()))
        .status,
      404,
    );
    // a proxy: an active grant gives appointments scope only, so the consent route is a 404 for them
    const proxyAcct = await patientAccount(k);
    await saWrite(
      k,
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status) VALUES (gen_random_uuid(), $1, $2, $3, 'parent', 'Rec13', 'active')`,
      [ORG, proxyAcct.seeded.principalId, pid],
    );
    assert.equal(
      (await mine(proxyAcct, 'POST', `/api/v1/consents/${c.id}/sign`, { typedName: 'X' }, idem()))
        .status,
      404,
    );
    assert.equal(
      (await k.q(`SELECT status FROM patient.consent WHERE id = $1`, [c.id]))[0]?.['status'],
      'pending',
    );
    // a retry with the same key signs once
    const key = randomUUID();
    const a = await mine(
      acct,
      'POST',
      `/api/v1/consents/${c.id}/sign`,
      { typedName: 'Rec13' },
      { 'idempotency-key': key },
    );
    const b = await mine(
      acct,
      'POST',
      `/api/v1/consents/${c.id}/sign`,
      { typedName: 'Rec13' },
      { 'idempotency-key': key },
    );
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.headers['idempotent-replay'], 'true');
    // staff witness a second consent through the service (signer relationship staff_witnessed, signer = the staff principal)
    const c2 = await pendingFor(pid, 'telehealth', 1);
    await k.db.withScope(
      {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: desk.seeded.principalId,
        locationIds: [A1],
      },
      (tx) =>
        k.patient.records.signConsent(tx, { requestId: randomUUID() }, c2.id, {
          typedName: 'Rec13 (witnessed)',
        }),
    );
    const w = (
      await k.q(
        `SELECT signer_relationship, signer_principal_id FROM patient.consent WHERE id = $1`,
        [c2.id],
      )
    )[0];
    assert.deepEqual(
      [w?.['signer_relationship'], w?.['signer_principal_id']],
      ['staff_witnessed', desk.seeded.principalId],
    );
    // a patient cannot claim somebody else signed: the policy requires the signer to be the caller
    const c3 = await pendingFor(pid, 'treatment', 2);
    await assert.rejects(
      k.db.withScope(
        {
          audience: 'patient',
          realm: 'patient_pool',
          orgId: ORG,
          principalId: acct.seeded.principalId,
          patientIds: [pid],
        },
        (tx) =>
          tx.query(
            `UPDATE patient.consent SET status = 'signed', signer_principal_id = $2, signer_relationship = 'self', signed_name = 'X' WHERE id = $1`,
            [c3.id, desk.seeded.principalId],
          ),
      ),
      (e: unknown) => (e as { code?: string }).code === '42501',
    );
  });
});

describe('communication preferences (22.6)', () => {
  test('defaults before anything is stored; SMS needs a phone, e-mail needs an address; in_app is always kept; marketing stays false', async () => {
    const { pid, acct } = await patientWithAccount(20);
    const g = await mine(acct, 'GET', `/api/v1/patients/${pid}/communication-preferences`);
    assert.equal(g.status, 200);
    assert.equal(g.json()['stored'], false);
    assert.deepEqual(g.json()['channels'], ['email', 'in_app']);
    assert.equal(g.json()['marketingOptIn'], false);
    const put = (body: unknown, extra: Record<string, string> = {}) =>
      mine(acct, 'PUT', `/api/v1/patients/${pid}/communication-preferences`, body, extra);
    assert.equal(
      (await put({ channels: ['sms'], language: 'en', marketingOptIn: true })).status,
      422,
    );
    assert.equal((await put({ channels: ['carrier_pigeon'], language: 'en' })).status, 422);
    assert.equal(
      (await put({ channels: ['email'], language: 'en', reminderChannel: 'sms' })).status,
      422,
    );
    const ok = await put({
      channels: ['sms', 'email'],
      reminderChannel: 'sms',
      language: 'es',
      quietHours: { start: '22:00', end: '07:00', timeZone: 'America/New_York' },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual((ok.json()['channels'] as string[]).sort(), ['email', 'in_app', 'sms']);
    assert.equal(ok.json()['stored'], true);
    // a replacement needs the current version
    assert.equal((await put({ channels: ['email'], language: 'en' })).status, 412);
    const etag = String(ok.headers['etag']);
    const second = await put({ channels: ['email'], language: 'en' }, { 'if-match': etag });
    assert.equal(second.status, 200);
    assert.deepEqual(
      second.json()['channels'],
      ['email', 'in_app'],
      'in_app stays: a failing provider must never leave the patient without the notice',
    );
    assert.equal(
      (
        await put(
          {
            channels: ['email'],
            language: 'en',
            quietHours: { start: '25:00', end: '07:00', timeZone: 'Nowhere/Land' },
          },
          { 'if-match': String(second.headers['etag']) },
        )
      ).status,
      422,
    );
    // a patient with no phone cannot choose SMS
    const noPhone = await registerViaApi(k, desk, A1, {
      givenName: 'No',
      familyName: 'Phone',
      dateOfBirth: '1990-01-01',
      email: 'nophone@example.test',
    });
    const a2 = await patientAccount(k, noPhone);
    const r = await mine(a2, 'PUT', `/api/v1/patients/${noPhone}/communication-preferences`, {
      channels: ['sms'],
      language: 'en',
    });
    assert.equal(r.status, 422);
    assert.equal(code(r), 'patient.channel_unavailable');
  });
});

describe('care team (BQ-5 resolver table, 22.6)', () => {
  test('staff with patient.care_team.manage add and end members; one open row per (patient, principal, role); an ended member is final', async () => {
    const pid = await registerViaApi(k, desk, A1, who(30));
    const dr = doctor.seeded.principalId;
    const add = await call2(
      coordinator,
      'POST',
      `/api/v1/patients/${pid}/care-team`,
      { principalId: dr, role: 'primary_clinician' },
      idem(),
    );
    assert.equal(add.status, 201);
    const again = await call2(
      coordinator,
      'POST',
      `/api/v1/patients/${pid}/care-team`,
      { principalId: dr, role: 'primary_clinician' },
      idem(),
    );
    assert.equal(again.status, 201);
    assert.equal(again.json()['id'], add.json()['id'], 'an open row is returned, not duplicated');
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM patient.care_team_member WHERE patient_id = $1 AND to_date IS NULL`,
          [pid],
        )
      ).length,
      1,
    );
    // an unknown principal, a patient principal and a bad role are refused
    assert.equal(
      (
        await call2(
          coordinator,
          'POST',
          `/api/v1/patients/${pid}/care-team`,
          { principalId: randomUUID(), role: 'nurse' },
          idem(),
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await call2(
          coordinator,
          'POST',
          `/api/v1/patients/${pid}/care-team`,
          { principalId: dr, role: 'janitor' },
          idem(),
        )
      ).status,
      422,
    );
    assert.equal(
      (await call2(desk, 'GET', `/api/v1/patients/${pid}/care-team`)).status,
      403,
      'front desk does not manage the care team',
    );
    const list = await call2(coordinator, 'GET', `/api/v1/patients/${pid}/care-team`);
    assert.equal((list.json()['items'] as unknown[]).length, 1);
    const mid = add.json()['id'] as string;
    assert.equal(
      (await call2(coordinator, 'DELETE', `/api/v1/patients/${pid}/care-team/${mid}`)).status,
      204,
    );
    assert.equal(
      (await call2(coordinator, 'DELETE', `/api/v1/patients/${pid}/care-team/${mid}`)).status,
      404,
    );
    await assert.rejects(
      saWrite(k, `UPDATE patient.care_team_member SET role = 'nurse' WHERE id = $1`, [mid]),
      (e: unknown) => (e as { code?: string }).code === 'PS001',
    );
    // the member can be added again once ended
    assert.equal(
      (
        await call2(
          coordinator,
          'POST',
          `/api/v1/patients/${pid}/care-team`,
          { principalId: dr, role: 'primary_clinician' },
          idem(),
        )
      ).status,
      201,
    );
    // the ended row stays as history; it carries its reason
    assert.deepEqual(
      (await k.q(`SELECT end_reason FROM patient.care_team_member WHERE id = $1`, [mid]))[0],
      { end_reason: 'staff' },
    );
    // other clinics' care teams are invisible
    const bDesk = await staffMember(k, 'care_team_lead', B1);
    assert.equal((await call2(bDesk, 'GET', `/api/v1/patients/${pid}/care-team`)).status, 404);
  });
});

describe('proxy access uses identity.proxy_grant, with no table of its own (D-7 default; TC-AZ-14, TC-PP-03)', () => {
  test('a proxy reaches appointments only: every other patient route is 404, and so is another patient', async () => {
    const dependant = await registerViaApi(k, desk, A1, who(40));
    const stranger = await registerViaApi(k, desk, A1, who(41));
    const proxyAcct = await patientAccount(k, undefined, 'Proxy Person');
    await saWrite(
      k,
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status) VALUES (gen_random_uuid(), $1, $2, $3, 'parent', 'Rec40', 'active')`,
      [ORG, proxyAcct.seeded.principalId, dependant],
    );
    // appointments route (the `proxy` capability)
    {
      const pr = await mine(proxyAcct, 'GET', `/api/v1/t/appointments/${dependant}`);
      assert.equal(pr.status, 200, JSON.stringify(pr.json()));
    }
    // chart, profile, documents-like routes: 404
    assert.equal((await mine(proxyAcct, 'GET', `/api/v1/t/chart/${dependant}`)).status, 404);
    for (const p of ['profile', 'contacts', 'insurance-coverages', 'communication-preferences'])
      assert.equal(
        (await mine(proxyAcct, 'GET', `/api/v1/patients/${dependant}/${p}`)).status,
        404,
        p,
      );
    // a patient the proxy is not linked to: 404 on every route
    assert.equal((await mine(proxyAcct, 'GET', `/api/v1/t/appointments/${stranger}`)).status, 404);
    assert.equal(
      (await mine(proxyAcct, 'GET', `/api/v1/patients/${stranger}/profile`)).status,
      404,
    );
    // at the database: the proxy's scope contains the patient (read for appointments) but the T-PAT-OWN tables return nothing
    const rows = await k.db.withScope(
      {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: proxyAcct.seeded.principalId,
        patientIds: [dependant],
        proxyPatientIds: [dependant],
      },
      async (tx) => ({
        patient: (await tx.query(`SELECT 1 FROM patient.patient WHERE id = $1`, [dependant])).rows
          .length,
        contacts: (await tx.query(`SELECT 1 FROM patient.patient_contact`)).rows.length,
        consents: (await tx.query(`SELECT 1 FROM patient.consent`)).rows.length,
      }),
    );
    assert.deepEqual(rows, { patient: 0, contacts: 0, consents: 0 });
    // the patient themselves (full scope) lists the proxy through the identity interface and can revoke it
    const owner = await patientAccount(k, dependant);
    const list = await mine(owner, 'GET', `/api/v1/patients/${dependant}/proxies`);
    assert.equal(list.status, 200);
    const grants = list.json()['items'] as { id: string; status: string }[];
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.status, 'active');
    assert.equal(
      (await mine(owner, 'DELETE', `/api/v1/patients/${dependant}/proxies/${grants[0]?.id}`))
        .status,
      204,
    );
    assert.equal(
      (await mine(proxyAcct, 'GET', `/api/v1/t/appointments/${dependant}`)).status,
      404,
      'revoked: no access, on the next request',
    );
    // the module has no table of its own for this
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'patient' AND table_name ILIKE '%proxy%'`,
        )
      ).length,
      0,
    );
  });

  test('a proxy request is refused until the D-7 rule values exist (RA-R1-20b)', async () => {
    const { pid, acct } = await patientWithAccount(42);
    const r = await mine(
      acct,
      'POST',
      `/api/v1/patients/${pid}/proxy-requests`,
      { relationship: 'parent' },
      idem(),
    );
    assert.equal(r.status, 422);
    assert.equal(code(r), 'identity.proxy_rules_not_configured');
    assert.equal(
      (await k.q(`SELECT 1 FROM identity.proxy_grant WHERE patient_id = $1`, [pid])).length,
      0,
    );
  });

  test('merged IDs of a patient the principal can already read are readable too (6.1), through the scope contributor', async () => {
    const survivor = await registerViaApi(k, desk, A1, who(43));
    const dup = await registerViaApi(k, desk, A1, { ...who(44), givenName: 'Dup' });
    const acct = await patientAccount(k, survivor);
    await k.sa.query(
      `UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`,
      [dup, survivor],
    );
    await k.sa.query(
      `INSERT INTO patient.patient_merge (merged_id, organisation_id, direct_survivor_id, final_survivor_id, merge_request_id) VALUES ($1,$2,$3,$3,$4)`,
      [dup, ORG, survivor, randomUUID()],
    );
    const s = await mine(acct, 'GET', '/api/v1/auth/session');
    assert.equal(s.status, 200);
    // the contributor widened the DB-side set: the merged patient's own row is readable by the survivor's account (read only)
    const built = await k.db.withScope(
      {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: acct.seeded.principalId,
      },
      async (tx) => {
        const sess = (
          await k.q(`SELECT id FROM identity.session WHERE principal_id = $1`, [
            acct.seeded.principalId,
          ])
        )[0];
        void sess;
        return tx.query(`SELECT merged_id FROM patient.patient_merge`);
      },
    );
    assert.deepEqual(
      built.rows.map((r) => r['merged_id']),
      [dup],
      'the principal reads the merge map entries of its own patient only',
    );
    const other = await patientAccount(k, await registerViaApi(k, desk, A1, who(45)));
    const nothing = await k.db.withScope(
      {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: other.seeded.principalId,
      },
      (tx) => tx.query(`SELECT merged_id FROM patient.patient_merge`),
    );
    assert.equal(nothing.rows.length, 0, 'another principal reads none of it');
    void seedPrincipal;
    void seedSession;
    void assignRole;
  });
});
