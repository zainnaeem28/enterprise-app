// Synthetic fixtures for the QA-04 journeys (TEST-CASES 2 and 3.1). SQL, as the database administrator, on the throwaway ci
// database only. Staff and patient personas are rows in `identity.principal`; the sign-in goes through the real OIDC flow
// with the fixture IdP (subject `sub-<key>`, e-mail `<key>@example.com`). Nothing here is a real person.
import { randomUUID } from 'node:crypto';

export const ORG = '00000000-0000-7000-8000-0000000000a1';
export const id = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const A1 = id(101);
export const B1 = id(201);
export const ROOM_A1 = id(401);
export const ROOM_A1_2 = id(402);
export const SVC = {
  IN: id(301),
  VID: id(302),
  NEUTRAL: id(303),
  SENS: id(304),
};
export const SENS_INTERNAL_NAME = 'Synthetic HIV clinic';
export const SENS_DISPLAY_NAME = 'General appointment';

const emailOf = (key) => `${key.toLowerCase()}@example.com`;
export const subjectOf = (key) => `sub-${key}`;
export const personaEmail = emailOf;

// STAFF personas of TEST-CASES 2: key -> [role, location] pairs. Role keys per ARCHITECTURE 27.3 (TEST-CASES 20.2).
export const STAFF = {
  'STF-FD-A': [['front_desk', A1]],
  'STF-TRI-A': [['triage_nurse', A1]],
  'STF-TRI-A2': [['triage_nurse', A1]],
  'STF-COORD-A': [['care_coordinator', A1]],
  'STF-DR-A1': [['doctor', A1]],
  'STF-DR-A2': [['doctor', A1]],
  'STF-DR-B1': [['doctor', B1]],
  'STF-TRN-A': [['trainee_doctor', A1]],
  'STF-ONCALL': [
    ['doctor', A1],
    ['doctor', B1],
  ],
  'STF-MRO-A': [['medical_records', A1]],
  'STF-ASST-A': [['assistant', A1]],
  'STF-BILL-A': [], // no R1 role exists (TEST-CASES 2): a no-role principal
  'STF-FD-B': [['front_desk', B1]],
};
const DOCTORS = ['STF-DR-A1', 'STF-DR-A2', 'STF-DR-B1', 'STF-ONCALL', 'STF-TRN-A'];
const staffNum = Object.fromEntries(Object.keys(STAFF).map((k, i) => [k, 1000 + i * 2]));
export const principalId = (key) => id(staffNum[key]);
export const personId = (key) => id(staffNum[key] + 1);

export async function addStaff(sa, key, grants = STAFF[key]) {
  const P = principalId(key);
  const person = personId(key);
  await sa.query(
    `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [person, ORG, `Synthetic ${key}`],
  );
  await sa.query(
    `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status)
     VALUES ($1,$2,$3,'google',$4,$5,'active')`,
    [P, ORG, person, subjectOf(key), emailOf(key)],
  );
  await sa.query(
    `INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, directory_listed) VALUES ($1,$2,$3,$4)`,
    [P, ORG, `Synthetic ${key}`, DOCTORS.includes(key)],
  );
  for (const [role, loc] of grants) {
    const r = await sa.query('SELECT id FROM identity.role WHERE key = $1', [role]);
    if (!r.rows[0]) throw new Error(`role ${role} missing from the reference data`);
    await sa.query(
      `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), ORG, P, r.rows[0].id, loc, randomUUID()],
    );
  }
}

// PATIENTS: PAT-nn (1..) -> patient row + patient-realm principal + `self` link. n >= 1000 are the VOL-3 pool.
export const patientId = (n) => id(100000 + n * 3);
export const patientPrincipalId = (n) => id(100000 + n * 3 + 1);
const patientPersonId = (n) => id(100000 + n * 3 + 2);
export const patientKey = (n) => `PAT-${String(n).padStart(n >= 1000 ? 4 : 2, '0')}`;

export async function addPatient(sa, n, over = {}) {
  const key = patientKey(n);
  const given = over.given ?? 'Test';
  const family = over.family ?? `Patient ${String(n).padStart(2, '0')}`;
  await sa.query(
    `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
     VALUES ($1,$2,$3,$4,$5,$6,'NY','front_desk')`,
    [patientId(n), ORG, `MRN-${String(9100000 + n)}`, given, family, over.dob ?? '1980-01-01'],
  );
  await sa.query(`INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,$3)`, [
    patientPersonId(n),
    ORG,
    `${given} ${family}`,
  ]);
  await sa.query(
    `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status)
     VALUES ($1,$2,$3,'patient_pool',$4,$5,'active')`,
    [patientPrincipalId(n), ORG, patientPersonId(n), subjectOf(key), emailOf(key)],
  );
  await sa.query(
    `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1,$2,$3,'self')`,
    [patientPrincipalId(n), patientId(n), ORG],
  );
}

export async function seed(sa) {
  const q = (s, p) => sa.query(s, p);
  await q('BEGIN');
  await q("SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)", [ORG]);
  await q(`INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York'), ('CA', $1, 'California')`, [ORG]);
  await q(
    `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active) VALUES
       ($1,$3,'Synthetic Clinic A1','clinic','America/New_York','NY',true),
       ($2,$3,'Synthetic Clinic B1','clinic','America/Los_Angeles','CA',true)`,
    [A1, B1, ORG],
  );
  await q(
    `INSERT INTO organisation.operating_state (organisation_id, jurisdiction_code, telehealth_allowed, effective_from)
     VALUES ($1,'NY',true,'2020-01-01'), ($1,'CA',true,'2020-01-01')`,
    [ORG],
  );
  await q(
    `INSERT INTO organisation.room (id, organisation_id, location_id, name, active) VALUES ($1,$3,$4,'Room 1',true), ($2,$3,$4,'Room 2',true)`,
    [ROOM_A1, ROOM_A1_2, ORG, A1],
  );
  const svc = (sid, internal, display, mode) =>
    q(
      `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active)
       VALUES ($1,$2,$3,$4,20,0,$5,true)`,
      [sid, ORG, internal, display, mode],
    );
  await svc(SVC.IN, 'Consult in person', 'General appointment', 'in_person');
  await svc(SVC.VID, 'Consult video', 'Video visit', 'video');
  await svc(SVC.NEUTRAL, 'Neutral consult', 'Neutral consult', 'in_person');
  await svc(SVC.SENS, SENS_INTERNAL_NAME, SENS_DISPLAY_NAME, 'in_person');
  for (const s of Object.values(SVC))
    for (const loc of [A1, B1])
      await q(`INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1,$2,$3)`, [ORG, s, loc]);

  for (const key of Object.keys(STAFF)) await addStaff({ query: (s, p) => sa.query(s, p) }, key);
  // Doctors: licensed, serve every service, DOC-TPL-1 (Mon-Fri 09:00-12:00) at their own location.
  for (const key of DOCTORS) {
    const loc = key === 'STF-DR-B1' ? B1 : A1;
    const state = key === 'STF-DR-B1' ? 'CA' : 'NY';
    await q(`INSERT INTO identity.licensed_state (principal_id, jurisdiction_code, organisation_id, licence_number) VALUES ($1,$2,$3,$4)`, [
      principalId(key),
      state,
      ORG,
      `SYNTH-${key}`,
    ]);
    for (const s of Object.values(SVC))
      await q(`INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1,$2,$3)`, [
        ORG,
        s,
        principalId(key),
      ]);
    if (key === 'STF-TRN-A' || key === 'STF-ONCALL') continue;
    const T = randomUUID();
    await q(`INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1,$2,$3,$4,'2020-01-01')`, [
      T,
      ORG,
      principalId(key),
      loc,
    ]);
    for (let d = 1; d <= 5; d++)
      await q(
        `INSERT INTO scheduling.template_rule (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local, service_ids, mode, room_id)
         VALUES ($1,$2,$3,$4,$5,'09:00','12:00',NULL,'either',$6)`,
        [randomUUID(), ORG, T, principalId(key), d, loc === A1 ? ROOM_A1 : null],
      );
  }
  for (const n of [1, 2, 3, 8]) await addPatient({ query: (s, p) => sa.query(s, p) }, n);
  await q('COMMIT');
  return {
    org: ORG,
    locations: { A1, B1 },
    services: SVC,
    staff: Object.fromEntries(Object.keys(STAFF).map((k) => [k, principalId(k)])),
    patients: Object.fromEntries([1, 2, 3, 8].map((n) => [patientKey(n), patientId(n)])),
  };
}
