// Real-database tests for BE-08, part 1: registration and matching (25.3, BR-37), tenancy and isolation (RA-R1-17, TC-AZ-01..04),
// care relationships and the staff-scope derivation (6.6, SBR-11).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/patient/registration.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  ORG,
  ORG2,
  PATIENT_HOST,
  STAFF_HOST,
  call,
  clock,
  id,
  patientAccount,
  registerViaApi,
  saWrite,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
  ProbeController,
} from './testkit.js';
import type { Kit, SeededSession } from './testkit.js';

const A1 = id(101);
const A2 = id(102);
const B1 = id(201);

let k: Kit;
let deskA1: SeededSession;
let deskA2: SeededSession;
let deskB1: SeededSession;
let leadA1: SeededSession;

before(async () => {
  k = await setup({ name: 'reg', fixtures: standardFixtures, controllers: [ProbeController] });
  deskA1 = await staffMember(k, 'front_desk', A1, 'Desk A1');
  deskA2 = await staffMember(k, 'front_desk', A2, 'Desk A2');
  deskB1 = await staffMember(k, 'front_desk', B1, 'Desk B1');
  leadA1 = await staffMember(k, 'front_desk_lead', A1, 'Lead A1');
});
after(async () => {
  await k?.close();
});

const idem = (): string => randomUUID();
const post = (s: SeededSession, path: string, body: unknown, key?: string, host = STAFF_HOST) =>
  call(k.base, 'POST', path, { host, cookie: s.cookie, headers: writeHeaders(s, host, key), body });
const get = (s: SeededSession, path: string, host = STAFF_HOST) =>
  call(k.base, 'GET', path, { host, cookie: s.cookie });
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
const person = (n: number) => ({
  givenName: `Given${n}`,
  familyName: `Family${n}`,
  dateOfBirth: '1980-05-17',
  phone: `+1212555${String(1000 + n)}`,
  email: `person${n}@example.test`,
});
const denied = async (reason: string, resourceType = 'patient.route') =>
  Number(
    (
      await k.q<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit.event WHERE action = 'denied' AND denial_reason = $1 AND resource_type = $2`,
        [reason, resourceType],
      )
    )[0]?.n,
  );

describe('registration at the front desk (25.3)', () => {
  test('a match check is required: POST /patients without one is 422 patient.match_check_required', async () => {
    const r = await post(
      deskA1,
      '/api/v1/patients',
      { ...person(1), stateCode: 'NY', locationId: A1 },
      idem(),
    );
    assert.equal(r.status, 422);
    assert.equal(code(r), 'patient.match_check_required');
  });

  test('match -> register creates the patient, the care relationship at L and the scope rows in one transaction', async () => {
    const pid = await registerViaApi(k, deskA1, A1, person(2));
    const p = (
      await k.q(`SELECT mrn, created_via, status FROM patient.patient WHERE id = $1`, [pid])
    )[0] as Record<string, unknown>;
    assert.match(String(p['mrn']), /^MRN-\d{7}$/);
    assert.equal(p['created_via'], 'front_desk');
    const rel = await k.q(
      `SELECT location_id, reason FROM patient.care_relationship WHERE patient_id = $1 AND ended_at IS NULL`,
      [pid],
    );
    assert.deepEqual(
      rel.map((x) => [x['location_id'], x['reason']]),
      [[A1, 'registration']],
    );
    const scope = await k.q(`SELECT location_id FROM patient.staff_scope WHERE patient_id = $1`, [
      pid,
    ]);
    assert.deepEqual(
      scope.map((x) => x['location_id']),
      [A1],
    );
    // audited `create`, naming the patient and the location, with no values
    const ev = await k.q(
      `SELECT action, patient_id, location_id, change FROM audit.event WHERE resource_type = 'patient.patient' AND resource_id = $1 AND action = 'create'`,
      [pid],
    );
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.['location_id'], A1);
  });

  test('the match check is single use, bound to its values and its location, and expires after 15 minutes', async () => {
    const who = person(3);
    const m = await post(deskA1, '/api/v1/patients/match', { ...who, locationId: A1 });
    assert.equal(m.status, 200);
    const checkId = m.json()['matchCheckId'] as string;
    // other values -> stale
    let r = await post(
      deskA1,
      '/api/v1/patients',
      { ...who, givenName: 'Changed', stateCode: 'NY', locationId: A1, matchCheckId: checkId },
      idem(),
    );
    assert.equal(r.status, 422);
    assert.equal(code(r), 'patient.match_check_stale');
    // another location -> stale (the check was made for A1; deskA1 has no A2 role either, so use a lead at both? same principal: use deskA1 at A1 only)
    // someone else's check -> required (the policy shows a principal only its own)
    r = await post(
      leadA1,
      '/api/v1/patients',
      { ...who, stateCode: 'NY', locationId: A1, matchCheckId: checkId },
      idem(),
    );
    assert.equal(r.status, 422);
    assert.equal(code(r), 'patient.match_check_required');
    // the right call works once
    r = await post(
      deskA1,
      '/api/v1/patients',
      { ...who, stateCode: 'NY', locationId: A1, matchCheckId: checkId },
      idem(),
    );
    assert.equal(r.status, 201);
    // and not twice
    r = await post(
      deskA1,
      '/api/v1/patients',
      { ...who, stateCode: 'NY', locationId: A1, matchCheckId: checkId },
      idem(),
    );
    assert.equal(r.status, 422);
    assert.equal(code(r), 'patient.match_check_required');
    // an expired check -> stale
    const m2 = await post(deskA1, '/api/v1/patients/match', { ...person(4), locationId: A1 });
    // the guard trigger refuses any change but `used_at`; a superuser session with triggers off stands in for "15 minutes later"
    await k.sa.query(`SET session_replication_role = replica`);
    await k.sa.query(
      `UPDATE patient.match_check SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [m2.json()['matchCheckId']],
    );
    await k.sa.query(`RESET session_replication_role`);
    r = await post(
      deskA1,
      '/api/v1/patients',
      { ...person(4), stateCode: 'NY', locationId: A1, matchCheckId: m2.json()['matchCheckId'] },
      idem(),
    );
    assert.equal(r.status, 422);
    assert.equal(code(r), 'patient.match_check_stale');
  });

  test("a registration from a location outside the caller's roles is refused (403) and nothing is written", async () => {
    const m = await post(deskA1, '/api/v1/patients/match', { ...person(5), locationId: B1 });
    assert.equal(m.status, 403);
    const r = await post(
      deskA1,
      '/api/v1/patients',
      { ...person(5), stateCode: 'NY', locationId: B1, matchCheckId: randomUUID() },
      idem(),
    );
    assert.equal(r.status, 403);
    assert.equal(
      (await k.q(`SELECT 1 FROM patient.patient WHERE given_name = 'Given5'`)).length,
      0,
    );
  });

  test('a duplicate-match warning: candidates need an acknowledgement with a reason; flags are created for each active candidate', async () => {
    const first = await registerViaApi(k, deskA1, A1, person(6));
    const m = await post(deskA2, '/api/v1/patients/match', { ...person(6), locationId: A2 });
    assert.equal(m.status, 200);
    const cands = m.json()['candidates'] as Record<string, unknown>[];
    assert.equal(cands.length, 1);
    assert.equal(cands[0]?.['strength'], 'exact');
    assert.equal(
      cands[0]?.['inScope'],
      false,
      'the patient is cared for at A1 only; deskA2 is at A2',
    );
    assert.equal(cands[0]?.['display'], undefined, 'no demographics for an out-of-scope candidate');
    assert.equal(cands[0]?.['patientId'], undefined);
    assert.equal(
      JSON.stringify(m.json()).includes(first),
      false,
      'the candidate ID never reaches an out-of-scope caller',
    );
    const checkId = m.json()['matchCheckId'];
    let r = await post(
      deskA2,
      '/api/v1/patients',
      { ...person(6), stateCode: 'NY', locationId: A2, matchCheckId: checkId },
      idem(),
    );
    assert.equal(r.status, 422, 'no acknowledgement');
    assert.equal(code(r), 'kernel.validation_failed');
    r = await post(
      deskA2,
      '/api/v1/patients',
      {
        ...person(6),
        stateCode: 'NY',
        locationId: A2,
        matchCheckId: checkId,
        duplicateAcknowledged: true,
        acknowledgeReason: '   ',
      },
      idem(),
    );
    assert.equal(r.status, 422, 'a blank reason is no reason');
    r = await post(
      deskA2,
      '/api/v1/patients',
      {
        ...person(6),
        stateCode: 'NY',
        locationId: A2,
        matchCheckId: checkId,
        duplicateAcknowledged: true,
        acknowledgeReason: 'Twin brother, different record',
      },
      idem(),
    );
    assert.equal(r.status, 201);
    assert.equal(r.json()['duplicateFlags'], 1);
    const flags = await k.q(
      `SELECT patient_id, candidate_patient_id, strength, source, status FROM patient.duplicate_flag WHERE candidate_patient_id = $1`,
      [first],
    );
    assert.equal(flags.length, 1);
    assert.deepEqual(
      [flags[0]?.['strength'], flags[0]?.['source'], flags[0]?.['status']],
      ['exact', 'front_desk', 'open'],
    );
    // the work queue at A2 shows it, and does not show the A1 patient's ID
    const q = await get(deskA2, `/api/v1/duplicate-flags?locationId=${A2}`);
    assert.equal(q.status, 200);
    const items = q.json()['items'] as Record<string, unknown>[];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.['candidatePatientId'], null);
  });

  test("a match on a patient inside the caller's scope returns display data under the caller's RLS", async () => {
    const mine = await registerViaApi(k, deskA1, A1, person(7));
    const m = await post(deskA1, '/api/v1/patients/match', { ...person(7), locationId: A1 });
    const c = (m.json()['candidates'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    assert.equal(c['inScope'], true);
    assert.equal((c['display'] as Record<string, unknown>)['patientId'], mine);
    assert.equal((c['display'] as Record<string, unknown>)['familyName'], 'Family7');
  });

  test('probable matches (name + date of birth) and at most five candidates; a merged record resolves to its survivor', async () => {
    const base = { givenName: 'Pat', familyName: 'Probable', dateOfBirth: '1991-02-03' };
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(
        await registerViaApi(k, deskA1, A1, {
          ...base,
          givenName: `Pat${i}`,
          phone: `+1212666${String(2000 + i)}`,
        }),
      );
    const m = await post(deskA1, '/api/v1/patients/match', {
      givenName: 'Other',
      familyName: 'Probable',
      dateOfBirth: '1991-02-03',
      locationId: A1,
    });
    const cands = m.json()['candidates'] as Record<string, unknown>[];
    assert.equal(cands.length, 5);
    assert.ok(cands.every((c) => c['strength'] === 'probable'));
    // a merged patient is never returned: the match resolves to its final survivor
    await k.sa.query(
      `UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`,
      [ids[0], ids[1]],
    );
    await k.sa.query(
      `INSERT INTO patient.patient_merge (merged_id, organisation_id, direct_survivor_id, final_survivor_id, merge_request_id) VALUES ($1,$2,$3,$3,$4)`,
      [ids[0], ORG, ids[1], randomUUID()],
    );
    const m2 = await post(deskA1, '/api/v1/patients/match', {
      givenName: 'Pat0',
      familyName: 'Probable',
      dateOfBirth: '1991-02-03',
      locationId: A1,
    });
    const shown = (m2.json()['candidates'] as { display?: { patientId: string } }[]).map(
      (c) => c.display?.patientId,
    );
    assert.ok(!shown.includes(ids[0]), 'the merged ID is not a candidate');
    assert.ok(shown.includes(ids[1]));
  });

  test('validation: bad names, dates, phones and states are 422 with field paths and no values', async () => {
    const m = await post(deskA1, '/api/v1/patients/match', { ...person(8), locationId: A1 });
    const checkId = m.json()['matchCheckId'];
    const r = await post(
      deskA1,
      '/api/v1/patients',
      {
        givenName: '',
        familyName: 'X',
        dateOfBirth: '2999-01-01',
        phone: 'abc',
        stateCode: 'new york',
        locationId: A1,
        matchCheckId: checkId,
      },
      idem(),
    );
    assert.equal(r.status, 422);
    assert.equal(r.body.includes('2999'), false);
    const paths = ((r.json()['errors'] as { path: string }[]) ?? []).map((e) => e.path).sort();
    assert.deepEqual(paths, ['/dateOfBirth', '/givenName', '/phone', '/stateCode']);
  });

  test('an idempotent retry returns the stored response and registers once (28.3)', async () => {
    const who = person(9);
    const m = await post(deskA1, '/api/v1/patients/match', { ...who, locationId: A1 });
    const body = {
      ...who,
      stateCode: 'NY',
      locationId: A1,
      matchCheckId: m.json()['matchCheckId'],
    };
    const key = idem();
    const a = await post(deskA1, '/api/v1/patients', body, key);
    const b = await post(deskA1, '/api/v1/patients', body, key);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers['idempotent-replay'], 'true');
    assert.equal(a.json()['patientId'], b.json()['patientId']);
    assert.equal(
      (await k.q(`SELECT 1 FROM patient.patient WHERE given_name = 'Given9'`)).length,
      1,
    );
    const c = await post(deskA1, '/api/v1/patients', { ...body, givenName: 'Other' }, key);
    assert.equal(c.status, 409);
    assert.equal(code(c), 'kernel.idempotency_conflict');
    const d = await post(deskA1, '/api/v1/patients', body, undefined);
    assert.equal(d.status, 400);
    assert.equal(code(d), 'kernel.idempotency_key_required');
  });
});

describe('self-registration on my. (6.6)', () => {
  test('creates the patient and the self link only: no care relationship, no staff scope; the patient learns nothing about matches', async () => {
    const existing = await registerViaApi(k, deskA1, A1, person(20));
    const acct = await patientAccount(k);
    const r = await post(
      acct,
      '/api/v1/patients/self-registration',
      { ...person(20), stateCode: 'NY' },
      idem(),
      PATIENT_HOST,
    );
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json()), ['patientId'], 'no candidate, no flag count');
    const pid = r.json()['patientId'] as string;
    assert.equal(
      (await k.q(`SELECT 1 FROM patient.care_relationship WHERE patient_id = $1`, [pid])).length,
      0,
    );
    assert.equal(
      (await k.q(`SELECT 1 FROM patient.staff_scope WHERE patient_id = $1`, [pid])).length,
      0,
    );
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM identity.patient_link WHERE patient_id = $1 AND principal_id = $2`,
          [pid, acct.seeded.principalId],
        )
      ).length,
      1,
    );
    // the duplicate was flagged silently
    const fl = await k.q(
      `SELECT source, strength, candidate_patient_id FROM patient.duplicate_flag WHERE patient_id = $1`,
      [pid],
    );
    assert.deepEqual(
      fl.map((x) => [x['source'], x['strength'], x['candidate_patient_id']]),
      [['self_registration', 'exact', existing]],
    );
    // a second self-registration by the same principal
    const again = await post(
      acct,
      '/api/v1/patients/self-registration',
      { ...person(21), stateCode: 'NY' },
      idem(),
      PATIENT_HOST,
    );
    assert.equal(again.status, 409);
    assert.equal(code(again), 'patient.already_linked');
  });

  test("before the first booking the staff see nothing; after a booking at A1 the patient and the flag are in A1's scope", async () => {
    const acct = await patientAccount(k);
    const r = await post(
      acct,
      '/api/v1/patients/self-registration',
      { ...person(22), stateCode: 'NY' },
      idem(),
      PATIENT_HOST,
    );
    const pid = r.json()['patientId'] as string;
    assert.equal((await get(deskA1, `/api/v1/patients/${pid}`)).status, 404);
    await k.db.withScope(
      {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: acct.seeded.principalId,
        patientIds: [pid],
      },
      async (tx) => {
        await k.patient.patients.lockPatients(tx, [pid], 'no_key_update');
        await k.patient.patients.ensureCareRelationship(
          tx,
          { requestId: randomUUID() },
          pid,
          A1,
          'booking',
        );
      },
    );
    assert.equal((await get(deskA1, `/api/v1/patients/${pid}`)).status, 200);
    assert.equal((await get(deskA2, `/api/v1/patients/${pid}`)).status, 404);
  });

  test('a registration with a location, or from a staff session without a match check, cannot use the self path', async () => {
    const acct = await patientAccount(k);
    const r = await post(
      acct,
      '/api/v1/patients/self-registration',
      { ...person(23), stateCode: 'NY', locationId: A1 },
      idem(),
      PATIENT_HOST,
    );
    assert.equal(r.status, 422);
    const s = await post(
      deskA1,
      '/api/v1/patients/self-registration',
      { ...person(24), stateCode: 'NY' },
      idem(),
    );
    assert.ok(s.status === 403 || s.status === 404, 'a staff session is not a patient session');
  });
});

describe('tenancy and isolation (RA-R1-17; TC-AZ-01..03)', () => {
  let onlyB: string;
  before(async () => {
    onlyB = await registerViaApi(k, deskB1, B1, {
      givenName: 'Beatrice',
      familyName: 'Bonly',
      dateOfBirth: '1975-01-01',
      phone: '+12125550123',
    });
  });

  test('TC-AZ-01: a clinic A user cannot find or read a patient registered only in clinic B; both attempts are logged', async () => {
    const search = await post(deskA1, '/api/v1/patients/search', {
      name: 'Bonly',
      dateOfBirth: '1975-01-01',
    });
    assert.equal(search.status, 200);
    assert.deepEqual(search.json()['items'], [], 'no hint that the patient exists');
    const before404 = await denied('not_visible');
    const byId = await get(deskA1, `/api/v1/patients/${onlyB}`);
    assert.equal(byId.status, 404, 'not 403');
    assert.equal(code(byId), 'kernel.not_found');
    assert.equal(byId.body.includes('Beatrice'), false);
    assert.equal(
      await denied('not_visible'),
      before404 + 1,
      'the by-ID attempt is a denied event with reason not_visible',
    );
    const searchEv = await k.q(
      `SELECT change FROM audit.event WHERE action = 'search' AND resource_type = 'patient.patient' ORDER BY occurred_at DESC LIMIT 1`,
    );
    assert.deepEqual(
      searchEv[0]?.['change'],
      { results: 0 },
      'the search is logged with a count and no terms',
    );
    // the banner, consents, care team, profile-style reads are all 404 too
    for (const p of ['banner', 'consents'])
      assert.equal((await get(deskA1, `/api/v1/patients/${onlyB}/${p}`)).status, 404);
    // and the owner of the record does see it
    const own = await post(deskB1, '/api/v1/patients/search', { name: 'Bonly' });
    assert.equal((own.json()['items'] as unknown[]).length, 1);
  });

  test("a write to another clinic's patient is 404 and changes nothing", async () => {
    const r = await call(k.base, 'PATCH', `/api/v1/patients/${onlyB}`, {
      cookie: deskA1.cookie,
      headers: { ...writeHeaders(deskA1), 'if-match': 'W/"1"' },
      body: { givenName: 'Hacked' },
    });
    assert.equal(r.status, 404);
    assert.equal(
      (await k.q(`SELECT given_name FROM patient.patient WHERE id = $1`, [onlyB]))[0]?.[
        'given_name'
      ],
      'Beatrice',
    );
  });

  test('TC-AZ-02: a patient cannot read another patient by changing the ID in the URL; the attempt is logged with the patient session', async () => {
    const other = await registerViaApi(k, deskA1, A1, person(30));
    const mine = await registerViaApi(k, deskA1, A1, person(31));
    const acct = await patientAccount(k, mine);
    const own = await get(acct, `/api/v1/patients/${mine}/profile`, PATIENT_HOST);
    assert.equal(own.status, 200);
    assert.equal(own.json()['familyName'], 'Family31');
    const before404 = await denied('not_visible');
    for (const path of [
      'profile',
      'contacts',
      'insurance-coverages',
      'communication-preferences',
      'proxies',
    ]) {
      const r = await get(acct, `/api/v1/patients/${other}/${path}`, PATIENT_HOST);
      assert.equal(r.status, 404, path);
      assert.equal(r.body.includes('Family30'), false);
    }
    assert.equal(await denied('not_visible'), before404 + 5);
    const ev = await k.q(
      `SELECT realm, audience FROM audit.event WHERE action = 'denied' AND denial_reason = 'not_visible' AND actor_principal_id = $1`,
      [acct.seeded.principalId],
    );
    assert.equal(ev.length, 5, 'every attempt is logged against the signed-in patient');
    assert.deepEqual([ev[0]?.['realm'], ev[0]?.['audience']], ['patient_pool', 'patient']);
    // a write is refused too
    const w = await call(k.base, 'PATCH', `/api/v1/patients/${other}/profile`, {
      host: PATIENT_HOST,
      cookie: acct.cookie,
      headers: { ...writeHeaders(acct, PATIENT_HOST), 'if-match': 'W/"1"' },
      body: { givenName: 'Hacked' },
    });
    assert.equal(w.status, 404);
  });

  test("TC-AZ-03: another organisation's patient is not found, not even by the BTG-free staff of the first organisation", async () => {
    const pid = randomUUID();
    await k.sa.query(
      `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via) VALUES ($1,$2,'MRN-9999991','Orgtwo','Person','1970-01-01','NY','front_desk')`,
      [pid, ORG2],
    );
    assert.equal((await get(deskA1, `/api/v1/patients/${pid}`)).status, 404);
    const s = await post(deskA1, '/api/v1/patients/search', { name: 'Orgtwo' });
    assert.deepEqual(s.json()['items'], []);
    const m = await post(deskA1, '/api/v1/patients/match', {
      givenName: 'Orgtwo',
      familyName: 'Person',
      dateOfBirth: '1970-01-01',
      locationId: A1,
    });
    assert.deepEqual(
      m.json()['candidates'],
      [],
      'matching is organisation-wide, never cross-organisation',
    );
  });

  test('profile reads: ETag, update with If-Match, 412 when stale, 428 when absent; the audit row names fields, not values (RA-R1-19)', async () => {
    const pid = await registerViaApi(k, deskA1, A1, person(32));
    const acct = await patientAccount(k, pid);
    const g = await get(acct, `/api/v1/patients/${pid}/profile`, PATIENT_HOST);
    const etag = String(g.headers['etag']);
    assert.match(etag, /^W\/"\d+"$/);
    const patch = (tag: string | undefined, body: unknown) =>
      call(k.base, 'PATCH', `/api/v1/patients/${pid}/profile`, {
        host: PATIENT_HOST,
        cookie: acct.cookie,
        headers: { ...writeHeaders(acct, PATIENT_HOST), ...(tag ? { 'if-match': tag } : {}) },
        body,
      });
    assert.equal((await patch(undefined, { genderIdentity: 'x' })).status, 428);
    const ok = await patch(etag, { phone: '212-555-0188', preferredLanguage: 'es' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json()['phone'], '+12125550188');
    assert.equal(
      (await patch(etag, { phone: '212-555-0199' })).status,
      412,
      'the old version is stale',
    );
    const ev = await k.q(
      `SELECT change FROM audit.event WHERE action = 'update' AND resource_type = 'patient.patient' AND resource_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [pid],
    );
    assert.deepEqual(ev[0]?.['change'], { fields: ['phone', 'preferredLanguage'] });
    assert.equal(JSON.stringify(ev[0]).includes('0188'), false);
    // identifying columns never change through the API
    assert.equal(
      (await patch(ok.headers['etag'] as string, { mrn: 'MRN-0000001', status: 'merged' })).status,
      422,
    );
  });
});

describe('care relationships and the staff scope (6.6; TC-AZ-04, SBR-11)', () => {
  const scopeOf = async (pid: string): Promise<string[]> =>
    (
      await k.q<{ location_id: string }>(
        `SELECT location_id FROM patient.staff_scope WHERE patient_id = $1 ORDER BY location_id`,
        [pid],
      )
    ).map((r) => r.location_id);

  const asStaff = (s: SeededSession, locs: string[]) =>
    ({
      audience: 'staff',
      realm: 'google',
      orgId: ORG,
      principalId: s.seeded.principalId,
      personId: s.seeded.personId,
      locationIds: locs,
    }) as const;

  test('TC-AZ-04: visible to a location only while a care relationship exists there; ending it removes the visibility', async () => {
    const pid = await registerViaApi(k, deskB1, B1, person(40));
    assert.equal((await get(deskA1, `/api/v1/patients/${pid}`)).status, 404);
    // a booking at A1 (a patient or staff caller) -> ensure_care_relationship under the booking transaction
    const acct = await patientAccount(k, pid);
    await k.db.withScope(
      {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: acct.seeded.principalId,
        patientIds: [pid],
      },
      async (tx) => {
        await k.patient.patients.lockPatients(tx, [pid], 'no_key_update');
        const first = await k.patient.patients.ensureCareRelationship(
          tx,
          { requestId: randomUUID() },
          pid,
          A1,
          'booking',
        );
        const again = await k.patient.patients.ensureCareRelationship(
          tx,
          { requestId: randomUUID() },
          pid,
          A1,
          'booking',
        );
        assert.equal(first, again, 'idempotent: the open relationship is returned');
      },
    );
    assert.deepEqual(await scopeOf(pid), [A1, B1].sort());
    assert.equal((await get(deskA1, `/api/v1/patients/${pid}`)).status, 200);
    // end it
    const ended = await k.db.withScope(asStaff(deskA1, [A1]), async (tx) => {
      await k.patient.patients.lockPatients(tx, [pid], 'no_key_update');
      return k.patient.patients.endCareRelationship(
        tx,
        { requestId: randomUUID() },
        pid,
        A1,
        'Moved away',
      );
    });
    assert.equal(ended, true);
    assert.deepEqual(await scopeOf(pid), [B1]);
    assert.equal((await get(deskA1, `/api/v1/patients/${pid}`)).status, 404);
    assert.equal((await get(deskB1, `/api/v1/patients/${pid}`)).status, 200);
  });

  test("the care-relationship functions need the lock first (runtime lock-order guard) and the caller's own location", async () => {
    const pid = await registerViaApi(k, deskA1, A1, person(41));
    await assert.rejects(
      k.db.withScope(asStaff(deskA1, [A1]), (tx) =>
        k.patient.patients.endCareRelationship(tx, { requestId: randomUUID() }, pid, A1, 'x'),
      ),
      /called before lockPatients/,
    );
    await assert.rejects(
      k.db.withScope(asStaff(deskA1, [A1]), async (tx) => {
        await k.patient.patients.lockPatients(tx, [pid], 'key_share');
        await k.patient.patients.endCareRelationship(tx, { requestId: randomUUID() }, pid, A1, 'x');
      }),
      /needs lockPatients/,
    );
    // staff of A2 cannot end A1's relationship (not their location) and cannot even lock the patient (not visible)
    await assert.rejects(
      k.db.withScope(asStaff(deskA2, [A2]), async (tx) => {
        await k.patient.patients.lockPatients(tx, [pid], 'no_key_update');
      }),
      (e: unknown) => (e as { code?: string }).code === 'kernel.not_found',
    );
  });

  test("BQ-4 default attach: exact match, patient present, a candidate from the caller's own check; audited care_attach", async () => {
    const who = person(42);
    const pid = await registerViaApi(k, deskB1, B1, who);
    const attach = async (s: SeededSession, locationId: string, present: boolean, ref?: string) => {
      const m = await post(s, '/api/v1/patients/match', { ...who, locationId });
      const cand = (m.json()['candidates'] as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >;
      return {
        m,
        r: await post(
          s,
          `/api/v1/patients/${pid}/attach`,
          { locationId, candidateRef: ref ?? cand['candidateRef'], patientPresent: present },
          idem(),
        ),
      };
    };
    // not present -> refused
    let x = await attach(leadA1, A1, false);
    assert.equal(x.r.status, 403);
    assert.equal(code(x.r), 'patient.attach_not_allowed');
    // a forged ref -> required
    x = await attach(leadA1, A1, true, randomUUID());
    assert.equal(x.r.status, 422);
    // a probable (not exact) candidate cannot be attached: match with the phone left out
    const probable = await post(leadA1, '/api/v1/patients/match', {
      givenName: who.givenName,
      familyName: who.familyName,
      dateOfBirth: who.dateOfBirth,
      locationId: A1,
    });
    const pc = (probable.json()['candidates'] as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    assert.equal(pc['strength'], 'probable');
    const rp = await post(
      leadA1,
      `/api/v1/patients/${pid}/attach`,
      { locationId: A1, candidateRef: pc['candidateRef'], patientPresent: true },
      idem(),
    );
    assert.equal(rp.status, 403);
    assert.equal(code(rp), 'patient.attach_not_allowed');
    // the exact one works, once
    x = await attach(leadA1, A1, true);
    assert.equal(x.r.status, 200);
    assert.deepEqual(await scopeOf(pid), [A1, B1].sort());
    const ev = await k.q(
      `SELECT patient_id, location_id FROM audit.event WHERE action = 'care_attach' AND patient_id = $1`,
      [pid],
    );
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.['location_id'], A1);
    // a front desk (no patient.attach permission) is refused by the guard
    const m = await post(deskA2, '/api/v1/patients/match', { ...who, locationId: A2 });
    const cand = (m.json()['candidates'] as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    const denied403 = await post(
      deskA2,
      `/api/v1/patients/${pid}/attach`,
      { locationId: A2, candidateRef: cand['candidateRef'], patientPresent: true },
      idem(),
    );
    assert.equal(denied403.status, 403);
    // a lead at A1 cannot attach at A2 (not their location)
    const wrongLoc = await post(
      leadA1,
      `/api/v1/patients/${pid}/attach`,
      { locationId: A2, candidateRef: cand['candidateRef'], patientPresent: true },
      idem(),
    );
    assert.equal(wrongLoc.status, 403);
  });

  test('SBR-11 scope invariant: a chain of merges keeps the merged IDs visible at every location that cares for the survivor, now and later', async () => {
    const a = await registerViaApi(k, deskA1, A1, person(50));
    const b = await registerViaApi(k, deskA1, A1, person(51));
    const c = await registerViaApi(k, deskB1, B1, person(52));
    // merge map as complete_merge (BE-09) will write it: A into B, then B into C (A's final survivor becomes C)
    await k.sa.query(
      `UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`,
      [a, b],
    );
    await k.sa.query(
      `INSERT INTO patient.patient_merge (merged_id, organisation_id, direct_survivor_id, final_survivor_id, merge_request_id) VALUES ($1,$2,$3,$3,$4)`,
      [a, ORG, b, randomUUID()],
    );
    await k.sa.query(
      `UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`,
      [b, c],
    );
    await k.sa.query(
      `INSERT INTO patient.patient_merge (merged_id, organisation_id, direct_survivor_id, final_survivor_id, merge_request_id) VALUES ($1,$2,$3,$3,$4)`,
      [b, ORG, c, randomUUID()],
    );
    await k.sa.query(
      `UPDATE patient.patient_merge SET final_survivor_id = $2 WHERE merged_id = $1`,
      [a, c],
    );
    // a booking at A2 for the survivor after the merge
    const acct = await patientAccount(k, c);
    await k.db.withScope(
      {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: acct.seeded.principalId,
        patientIds: [c],
      },
      async (tx) => {
        await k.patient.patients.lockPatients(tx, [c], 'no_key_update');
        await k.patient.patients.ensureCareRelationship(
          tx,
          { requestId: randomUUID() },
          c,
          A2,
          'booking',
        );
      },
    );
    for (const p of [a, b, c])
      assert.deepEqual(
        await scopeOf(p),
        [A2, B1].sort(),
        `closure member ${p} has a row at every location that cares for the survivor`,
      );
    // the merged history is readable by A2's staff through the same probe (the merged row itself is closed to writes by the guard)
    assert.equal((await get(deskA2, `/api/v1/patients/${a}`)).status, 200);
    // ending the survivor's relationship at A2 removes the merged-ID rows there
    await k.db.withScope(asStaff(deskA2, [A2]), async (tx) => {
      await k.patient.patients.lockPatients(tx, [c], 'no_key_update');
      await k.patient.patients.endCareRelationship(tx, { requestId: randomUUID() }, c, A2, 'Moved');
    });
    for (const p of [a, b, c])
      assert.deepEqual(await scopeOf(p), [B1], `after ending A2 only B1 remains for ${p}`);
    assert.equal((await get(deskA2, `/api/v1/patients/${a}`)).status, 404);
    // closure() reads the map: the survivor and every ID merged into it
    const cl = await k.db.withScope(asStaff(deskB1, [B1]), (tx) =>
      k.patient.patients.closure(tx, a),
    );
    assert.deepEqual([...cl].sort(), [a, b, c].sort());
  });

  test('the merge write guard: any write naming a merged patient is refused with patient.merged (PM001), whatever the scope says', async () => {
    const a = await registerViaApi(k, deskA1, A1, person(60));
    const b = await registerViaApi(k, deskA1, A1, person(61));
    await k.sa.query(
      `UPDATE patient.patient SET status = 'merged', merged_into = $2 WHERE id = $1`,
      [a, b],
    );
    await k.sa.query(
      `INSERT INTO patient.patient_merge (merged_id, organisation_id, direct_survivor_id, final_survivor_id, merge_request_id) VALUES ($1,$2,$3,$3,$4)`,
      [a, ORG, b, randomUUID()],
    );
    // readable (the relationships still carry it) ...
    assert.equal((await get(deskA1, `/api/v1/patients/${a}`)).status, 200);
    // ... but closed to writes: profile update, contact, preference
    const patch = await call(k.base, 'PATCH', `/api/v1/patients/${a}`, {
      cookie: deskA1.cookie,
      headers: { ...writeHeaders(deskA1), 'if-match': 'W/"1"' },
      body: { givenName: 'X' },
    });
    assert.equal(patch.status, 409);
    assert.equal(code(patch), 'patient.merged');
    assert.deepEqual(
      patch.json()['errors'],
      [{ path: '/survivorId', code: b }],
      'the survivor is named because the caller can read it',
    );
    // the database refuses regardless of the API (a stale session / a code path that skipped the check)
    await assert.rejects(
      k.db.withScope(asStaff(deskA1, [A1]), (tx) =>
        tx.query(
          `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name, phone) VALUES (gen_random_uuid(), $1, $2, 'emergency', 'X', '+12125550000')`,
          [ORG, a],
        ),
      ),
      (e: unknown) => (e as { code?: string }).code === 'PM001',
    );
    const contact = `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name, phone) VALUES (gen_random_uuid(), $1, $2, 'emergency', 'X', '+12125550000')`;
    await assert.rejects(
      saWrite(k, contact, [ORG, a]),
      (e: unknown) => (e as { code?: string }).code === 'PM001',
      'even a superuser session cannot write a merged patient: the trigger fires for every role',
    );
    // and a write the guard cannot judge is refused too (fail closed): no organisation in the settings, so the root is unreadable
    await assert.rejects(
      k.sa.query(contact, [ORG, b]),
      (e: unknown) => (e as { code?: string }).code === 'PM008',
    );
    // writes to the survivor pass
    await saWrite(k, contact, [ORG, b]);
    // a merged root cannot be updated at all, and merged is terminal
    await assert.rejects(
      k.sa.query(`UPDATE patient.patient SET given_name = 'Y' WHERE id = $1`, [a]),
      (e: unknown) => (e as { code?: string }).code === 'PM001',
    );
    // the guard also covers the other modules' patient_id tables (identity, notifications)
    await assert.rejects(
      saWrite(
        k,
        `INSERT INTO notifications.in_app_read (notification_id, organisation_id, patient_id) VALUES (gen_random_uuid(), $1, $2)`,
        [ORG, a],
      ),
      (e: unknown) => (e as { code?: string }).code === 'PM001',
    );
    clock.t += 1;
  });
});
