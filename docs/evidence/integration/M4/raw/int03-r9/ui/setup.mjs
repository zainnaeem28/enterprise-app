// Throwaway database for the r12 journey: real migrations, real reference-data worker job and settings catalogue, then SYNTHETIC
// fixtures by SQL (org catalogue, one clinician with a weekly template, one patient and its patient-realm principal).
// usage: node r12-setup.mjs <repoRoot>   (needs EHR_TEST_ADMIN_URL; prints API_URL=... on the last line). No credentials in output.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const pg = createRequire(root + '/package.json')('pg');
const ORG = '00000000-0000-7000-8000-0000000000a1';
const db = 'ehr_int03_r9_ui';
const admin = new URL(process.env.EHR_TEST_ADMIN_URL);
const url = (u) => { const x = new URL(admin); x.username = u; x.password = ''; x.pathname = '/' + db; return x.toString(); };
const a = new pg.Client({ connectionString: process.env.EHR_TEST_ADMIN_URL }); await a.connect();
await a.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await a.query(`CREATE DATABASE ${db}`); await a.end();
const env = { PATH: process.env.PATH, EHR_DB_ADMIN_URL: url(admin.username), EHR_DB_MIGRATE_URL: url('app_owner') };
for (const cmd of ['bootstrap', 'migrate']) execFileSync(process.execPath, [`${root}/db/tools/migrate.mjs`, cmd], { env, stdio: 'inherit' });
const imp = (p) => import(pathToFileURL(`${root}/${p}`).href);
await (await imp('packages/kernel/dist/queue/install.js')).installQueue(url('app_owner'));
const { KernelDb } = await imp('packages/kernel/dist/index.js');
const pool = new pg.Pool({ connectionString: url('app_worker'), max: 2 });
const wdb = new KernelDb(pool);
const w = await imp('apps/worker/dist/jobs/identity/index.js');
await w.runApplyReferenceData({ db: wdb, orgId: ORG });
const { OrganisationService } = await imp('apps/api/dist/src/modules/organisation/index.js');
await wdb.withScope({ audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }, (tx) => new OrganisationService().applySettingDefaults(tx, undefined));
await pool.end();
// r12: NO task-type sync here (INT02-R7-B1 fix, kept): the worker process syncs queue_api.task_type at start.
const sa = new pg.Client({ connectionString: url(admin.username) }); await sa.connect();
const q = (s, p) => sa.query(s, p);
await q('BEGIN');
await q("SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)", [ORG]);
const id = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const LOC = id(101), SVC = id(301), ROOM = id(401), DOC = id(501), DOCP = id(502), PAT = id(601), PP = id(602), PPP = id(603);
await q(`INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York')`, [ORG]);
await q(`INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active) VALUES ($1,$2,'Synthetic Clinic','clinic','America/New_York','NY',true)`, [LOC, ORG]);
await q(`INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active) VALUES ($1,$2,'Consult','General appointment',30,0,'in_person',true)`, [SVC, ORG]);
await q(`INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1,$2,$3)`, [ORG, SVC, LOC]);
await q(`INSERT INTO organisation.room (id, organisation_id, location_id, name, active) VALUES ($1,$2,$3,'Room 1',true)`, [ROOM, ORG, LOC]);
await q(`INSERT INTO organisation.operating_state (organisation_id, jurisdiction_code, telehealth_allowed, effective_from) VALUES ($1,'NY',true,'2020-01-01')`, [ORG]);
await q(`INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,'Synthetic Doctor')`, [DOCP, ORG]);
await q(`INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status) VALUES ($1,$2,$3,'google','sub-ci-doctor','doctor@example.com','active')`, [DOC, ORG, DOCP]);
await q(`INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, directory_listed) VALUES ($1,$2,'Dr. Synthetic',true)`, [DOC, ORG]);
await q(`INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1,$2,$3)`, [ORG, SVC, DOC]);
await q(`INSERT INTO identity.licensed_state (principal_id, jurisdiction_code, organisation_id, licence_number) VALUES ($1,'NY',$2,'SYNTH-NY-1')`, [DOC, ORG]);
const T = randomUUID();
await q(`INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1,$2,$3,$4,'2020-01-01')`, [T, ORG, DOC, LOC]);
for (let d = 0; d < 7; d++) await q(`INSERT INTO scheduling.template_rule (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local, service_ids, mode, room_id) VALUES ($1,$2,$3,$4,$5,'09:00','17:00',NULL,'either',$6)`, [randomUUID(), ORG, T, DOC, d, ROOM]);
await q(`INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via) VALUES ($1,$2,'MRN-9100001','Sam','Synthetic','1980-01-01','NY','front_desk')`, [PAT, ORG]);
await q(`INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,'Sam Synthetic')`, [PP, ORG]);
await q(`INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status) VALUES ($1,$2,$3,'patient_pool','sub-ci-patient','patient@example.org','active')`, [PPP, ORG, PP]);
await q(`INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1,$2,$3,'self')`, [PPP, PAT, ORG]);
// r12: a second service whose clinician has NO availability template, so the patient UI reaches "no times" and the waitlist (SQL fixture, disclosed)
const SVC2 = id(302), DOC2 = id(511), DOC2P = id(512);
await q(`INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active) VALUES ($1,$2,'Waitlist consult','Waitlist visit',30,0,'in_person',true)`, [SVC2, ORG]);
await q(`INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1,$2,$3)`, [ORG, SVC2, LOC]);
await q(`INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,'Synthetic Doctor Two')`, [DOC2P, ORG]);
await q(`INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status) VALUES ($1,$2,$3,'google','sub-ci-doctor2','doctor2@example.com','active')`, [DOC2, ORG, DOC2P]);
await q(`INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, directory_listed) VALUES ($1,$2,'Dr. Booked-Out',true)`, [DOC2, ORG]);
await q(`INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1,$2,$3)`, [ORG, SVC2, DOC2]);
// r12: waitlist is off by default per service (booking_policy.waitlist_enabled=false); the admin API that turns it on is not reachable (no staff UI), so SQL fixture, disclosed
await q(`INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, lead_time_min, cutoff_hours, late_change, max_future_per_patient, waitlist_enabled) VALUES ($1,$2,$3,NULL,0,2,'block',5,true)`, [randomUUID(), ORG, SVC2]);
// r12 (OBS-2): a VIDEO service served by clinician 1 (SQL fixture, disclosed) so a video booking can be rescheduled in the UI
const SVC3 = id(303);
await q(`INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active) VALUES ($1,$2,'Video consult','Video visit',30,0,'video',true)`, [SVC3, ORG]);
await q(`INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1,$2,$3)`, [ORG, SVC3, LOC]);
await q(`INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1,$2,$3)`, [ORG, SVC3, DOC]);
// r12: NO notification templates are seeded here (INT02-R10-B1 fix): the API boot provisioning must supply them.
// r8: the staff principal (DOC) holds the real seeded roles doctor + front_desk + care_coordinator at the clinic (SQL fixture, disclosed; the admin role-grant UI is not part of the build).
for (const key of ['doctor', 'front_desk', 'care_coordinator']) {
  const r = await q('SELECT id FROM identity.role WHERE key = $1', [key]);
  await q(`INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), ORG, DOC, r.rows[0].id, LOC, randomUUID()]);
}
// r9: a SECOND staff principal (front_desk + care_coordinator) so the staff-to-staff messaging journey (RA-R1-25, F17 option B) has a real recipient (SQL fixture, disclosed)
const STAFF2 = id(521), STAFF2P = id(522);
await q(`INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,'Synthetic Receptionist')`, [STAFF2P, ORG]);
await q(`INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status) VALUES ($1,$2,$3,'google','sub-ci-staff2','staff2@example.com','active')`, [STAFF2, ORG, STAFF2P]);
await q(`INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, directory_listed) VALUES ($1,$2,'Synthetic Receptionist',false)`, [STAFF2, ORG]);
for (const key of ['front_desk', 'care_coordinator']) {
  const r = await q('SELECT id FROM identity.role WHERE key = $1', [key]);
  await q(`INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), ORG, STAFF2, r.rows[0].id, LOC, randomUUID()]);
}
await q('COMMIT');
await sa.end();
console.log('API_URL=' + url('app_api'));
