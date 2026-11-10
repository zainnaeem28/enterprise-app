// Shared helpers for the QA-04 suites: an administrator connection to the throwaway ci database (for inspection and for the
// fixtures the product has no endpoint for), on-demand synthetic patients, and slot helpers. Each test uses its own patient
// and its own calendar day, so cases do not interfere with each other.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  ensureGrantors,
  grantRole,
  addPatient,
  patientId,
  patientKey,
  ORG,
  SVC,
  A1,
  B1,
  principalId,
  addStaff,
  STAFF,
} from './seed.mjs';
import { login, state } from './client.mjs';

export { ORG, SVC, A1, B1, principalId, patientId, login, state, STAFF, addStaff };
const root = new URL('../../../../', import.meta.url).pathname;
const pg = createRequire(root + 'package.json')('pg');

let adminClient;
export async function admin() {
  if (adminClient) return adminClient;
  const u = new URL(process.env.EHR_TEST_ADMIN_URL);
  u.pathname = '/' + state().db;
  adminClient = new pg.Client({ connectionString: u.toString() });
  await adminClient.connect();
  return adminClient;
}
export async function closeAdmin() {
  if (adminClient) await adminClient.end();
  adminClient = undefined;
}
// One administrator connection: transactions must not interleave, so every use goes through this queue.
let chain = Promise.resolve();
const exclusive = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};
/** Runs SQL as the administrator inside an org-scoped system context (for fixtures and reads, never for the product's own paths). */
export function sql(text, params = []) {
  return exclusive(async () => {
    const c = await admin();
    await c.query('BEGIN');
    try {
      await c.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)",
        [ORG],
      );
      const r = await c.query(text, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}
/** Several statements in one administrator transaction. */
export function sqlTx(fn) {
  return exclusive(async () => {
    const c = await admin();
    await c.query('BEGIN');
    try {
      await c.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)",
        [ORG],
      );
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

let nextPat = 2000 + Math.floor(Math.random() * 4_000_000);
/** A fresh synthetic patient with a patient-realm principal. Returns {n, id, key, client}. */
export async function newPatient(over = {}) {
  const n = over.n ?? nextPat++;
  await sqlTx((c) => addPatient(c, n, over));
  const client = await login('patient', patientKey(n));
  if (client.sessionStatus !== 200)
    throw new Error(`patient sign-in failed ${client.sessionStatus}`);
  return { n, id: patientId(n), key: patientKey(n), client };
}
export async function patientClient(n) {
  return { n, id: patientId(n), key: patientKey(n), client: await login('patient', patientKey(n)) };
}

let dayCounter = 0;
/** A distinct future weekday (Mon-Fri) per call, at least 10 days out, as {from, to} covering that whole UTC day plus margin. */
export function nextDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 10);
  let found = 0;
  while (true) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      if (found === dayCounter) break;
      found++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  dayCounter++;
  const from = new Date(d);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(d);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from: from.toISOString(), to: to.toISOString(), date: d.toISOString().slice(0, 10) };
}

export async function search(
  client,
  {
    serviceId = SVC.IN,
    mode = 'in_person',
    day = nextDay(),
    clinicianId,
    locationId,
    extra = {},
  } = {},
) {
  const body = { serviceId, mode, from: day.from, to: day.to, ...extra };
  if (clinicianId) body.clinicianId = clinicianId;
  if (locationId) body.locationId = locationId;
  const r = await client.post('/api/v1/availability/search', body);
  return { ...r, slots: r.json?.slots ?? [], day };
}

export function holdBody(patient, slot, serviceId = SVC.IN, mode = 'in_person', extra = {}) {
  return {
    patientId: patient.id,
    serviceId,
    clinicianId: slot.clinicianId,
    locationId: slot.locationId,
    startsAt: slot.startsAt,
    mode,
    ...extra,
  };
}
export async function hold(patient, slot, serviceId, mode, extra, o) {
  return patient.client.post('/api/v1/holds', holdBody(patient, slot, serviceId, mode, extra), o);
}
export async function book(patient, slot, serviceId = SVC.IN, mode = 'in_person') {
  const h = await hold(patient, slot, serviceId, mode);
  if (h.status !== 201) throw new Error(`hold failed ${h.status} ${h.text}`);
  const c = await patient.client.post(`/api/v1/appointments/${h.json.reservationId}/confirm`, {});
  if (c.status !== 200) throw new Error(`confirm failed ${c.status} ${c.text}`);
  return { reservationId: h.json.reservationId, appointment: c.json };
}
export const uuid = randomUUID;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls fn until it returns a truthy value or the time runs out. */
export async function until(fn, { timeoutMs = 20000, everyMs = 500 } = {}) {
  const end = Date.now() + timeoutMs;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return v;
}

/** A fresh service linked to both locations and to every seeded doctor, so a test can set its own policy without touching others. */
export async function newService({
  internal = 'QA service',
  display = 'QA service',
  mode = 'in_person',
  duration = 20,
} = {}) {
  const sid = uuid();
  await sql(
    `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active)
     VALUES ($1,$2,$3,$4,$5,0,$6,true)`,
    [sid, ORG, internal, display, duration, mode],
  );
  for (const loc of [A1, B1])
    await sql(
      `INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1,$2,$3)`,
      [ORG, sid, loc],
    );
  for (const k of ['STF-DR-A1', 'STF-DR-A2', 'STF-DR-B1'])
    await sql(
      `INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1,$2,$3)`,
      [ORG, sid, principalId(k)],
    );
  return sid;
}
/** Sets the booking policy of a service (service-wide row). Unspecified fields keep the PRD 7.2 proposal values. */
export async function setPolicy(serviceId, o = {}) {
  await sql(
    `DELETE FROM organisation.booking_policy WHERE service_id = $1 AND location_id IS NULL`,
    [serviceId],
  );
  await sql(
    `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, lead_time_min, cutoff_hours, late_change, max_future_per_patient, waitlist_enabled, overbook_cap_per_session, hold_minutes, no_show_grace_min)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      uuid(),
      ORG,
      serviceId,
      o.lead ?? 0,
      o.cutoff ?? 24,
      o.late ?? 'block',
      o.max ?? 3,
      o.waitlist ?? false,
      o.overbook ?? 0,
      o.hold ?? null,
      o.grace ?? null,
    ],
  );
}
/** Changes one organisation-level setting (kernel.setting). Returns the previous value so a test can restore it. */
export async function setSetting(key, value) {
  const prev = await sql(
    `SELECT value FROM kernel.setting WHERE key = $1 AND location_id IS NULL`,
    [key],
  );
  await sql(`UPDATE kernel.setting SET value = $2::jsonb WHERE key = $1 AND location_id IS NULL`, [
    key,
    JSON.stringify(value),
  ]);
  return prev.rows[0]?.value;
}

/**
 * A fresh doctor at A1 who serves the given services with a Mon-Fri 09:00-12:00 template. `overbookable` marks the rule as an
 * overbookable session (the cap comes from the service's booking policy). Returns {id, key} (the id is the clinician id).
 */
let docSeq = Math.floor(Math.random() * 1_000_000);
export async function newDoctor({
  services = [SVC.IN],
  overbookable = false,
  location = A1,
  allDay = false,
  roleKey = 'doctor',
} = {}) {
  const n = 5_000_000 + docSeq++ * 2;
  const pid = `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const person = `00000000-0000-7000-8000-${String(n + 1).padStart(12, '0')}`;
  const key = `STF-DR-X${n}`;
  await sqlTx(async (c) => {
    await c.query(
      `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,$3)`,
      [person, ORG, `Synthetic ${key}`],
    );
    await c.query(
      `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status) VALUES ($1,$2,$3,'google',$4,$5,'active')`,
      [pid, ORG, person, `sub-${key}`, `${key.toLowerCase()}@example.com`],
    );
    await c.query(
      `INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, directory_listed) VALUES ($1,$2,$3,true)`,
      [pid, ORG, `Synthetic ${key}`],
    );
    await ensureGrantors(c);
    await grantRole(c, pid, roleKey, location);
    await c.query(
      `INSERT INTO identity.licensed_state (principal_id, jurisdiction_code, organisation_id, licence_number) VALUES ($1,$2,$3,$4)`,
      [pid, location === A1 ? 'NY' : 'CA', ORG, `SYNTH-${key}`],
    );
    for (const s of services)
      await c.query(
        `INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1,$2,$3)`,
        [ORG, s, pid],
      );
    const T = uuid();
    await c.query(
      `INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1,$2,$3,$4,'2020-01-01')`,
      [T, ORG, pid, location],
    );
    for (let d = allDay ? 0 : 1; d <= (allDay ? 6 : 5); d++)
      await c.query(
        `INSERT INTO scheduling.template_rule (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local, service_ids, mode, room_id, overbookable)
         VALUES ($1,$2,$3,$4,$5,$7,$8,NULL,'either',NULL,$6)`,
        [
          uuid(),
          ORG,
          T,
          pid,
          d,
          overbookable,
          allDay ? '00:00' : '09:00',
          allDay ? '23:40' : '12:00',
        ],
      );
  });
  return { id: pid, key };
}

/** A fresh staff principal holding the given roles ([[roleKey, locationId], ...]); returns {key, id, personId, client} (signed in). */
let staffSeq = Math.floor(Math.random() * 1_000_000);
export async function newStaff(grants, { name = 'STF-X' } = {}) {
  const n = 6_000_000 + staffSeq++ * 2;
  const pid = `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const person = `00000000-0000-7000-8000-${String(n + 1).padStart(12, '0')}`;
  const key = `${name}-${n}`;
  await sqlTx(async (c) => {
    await c.query(
      `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,$3)`,
      [person, ORG, `Synthetic ${key}`],
    );
    await c.query(
      `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status) VALUES ($1,$2,$3,'google',$4,$5,'active')`,
      [pid, ORG, person, `sub-${key}`, `${key.toLowerCase()}@example.com`],
    );
    await c.query(
      `INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, directory_listed) VALUES ($1,$2,$3,false)`,
      [pid, ORG, `Synthetic ${key}`],
    );
    await ensureGrantors(c);
    for (const [role, loc] of grants) await grantRole(c, pid, role, loc);
  });
  return { key, id: pid, personId: person, client: await login('staff', key) };
}

/** A window starting `fromH` hours from now and `spanH` long, for tests that need a visit today (all-day doctors only). */
export const soon = (fromH = 1, spanH = 5) => {
  const now = Date.now();
  return {
    from: new Date(now + fromH * 3600e3).toISOString(),
    to: new Date(now + (fromH + spanH) * 3600e3).toISOString(),
    date: 'rolling',
  };
};
/** Front desk checks the appointment in; returns the check-in response (the queue entry id equals the reservation id). */
export async function deskCheckIn(desk, appt) {
  return desk.client.post(
    `/api/v1/appointments/${appt.id}/check-in`,
    {},
    { headers: { 'if-match': `W/"${appt.version}"` } },
  );
}
export async function queueEntry(desk, locationId, id) {
  const q = await desk.client.get(`/api/v1/locations/${locationId}/queue`);
  return (q.json?.items ?? []).find((e) => e.id === id);
}
