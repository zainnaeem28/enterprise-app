// TC-AZ-01..04 and 09..16 (TEST-CASES 6): authorization and scope through the REAL API on ENV-INT/ci. The database-role half
// (TC-AZ-05..08) is rls.test.mjs. Every negative case has a positive control in the same test so that a refusal means the control
// refused, not that the fixture was wrong. Synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  login,
  anonymous,
  newPatient,
  newStaff,
  newDoctor,
  sql,
  sqlTx,
  closeAdmin,
  search,
  book,
  uuid,
  until,
  sleep,
  A1,
  B1,
  ORG,
  principalId,
  assign,
  fixtureDocument,
  clinical,
  stateOf,
} from '../identity/lib/ctx.mjs';
import { newAdmin, newRole, AD } from '../security/lib/admins.mjs';
import { asScope, attempt } from './lib/db.mjs';
import { elevate } from '../identity/lib/ctx.mjs';

after(() => closeAdmin());

const deniedSince = (since, actor, extra = '') =>
  sql(
    `SELECT action, outcome, denial_reason, resource_type, resource_id, patient_id, reason FROM audit.event WHERE occurred_at >= $1 AND actor_principal_id = $2 AND outcome = 'denied' ${extra} ORDER BY occurred_at`,
    [since, actor],
  );
const stamp = () => new Date(Date.now() - 500).toISOString();
const noLeak = (r, ...needles) => {
  for (const n of needles)
    assert.ok(!String(r.text).includes(n), `the response must not contain ${n}`);
};

describe('TC-AZ authorization, scope and break-the-glass', () => {
  test('TC-AZ-01 a front-desk user at LOC-A1 cannot find or open a patient cared for at LOC-B1 only; the denial is audited as not_visible', async () => {
    const hidden = await newPatient({
      given: 'Hidden',
      family: `OnlyB${Math.floor(Math.random() * 1e6)}`,
      locations: [B1],
      dob: '1971-03-04',
    });
    const visible = await newPatient({
      given: 'Shown',
      family: `AtA${Math.floor(Math.random() * 1e6)}`,
      locations: [A1],
    });
    const fd = await login('staff', 'STF-FD-A');
    const t0 = stamp();
    const hiddenFamily = (
      await sql(`SELECT family_name f, phone_e164 p FROM patient.patient WHERE id=$1`, [hidden.id])
    ).rows[0];
    const control = await fd.post('/api/v1/patients/search', {
      name: `Shown ${(await sql(`SELECT family_name f FROM patient.patient WHERE id=$1`, [visible.id])).rows[0].f}`,
    });
    assert.equal(control.status, 200);
    assert.equal(control.json.items.length, 1, 'positive control: a patient at LOC-A1 is found');
    for (const body of [
      { name: `Hidden ${hiddenFamily.f}` },
      { name: hiddenFamily.f, dateOfBirth: '1971-03-04' },
      { phone: hiddenFamily.p },
    ]) {
      const r = await fd.post('/api/v1/patients/search', body);
      assert.equal(r.status, 200, `${JSON.stringify(body)} -> ${r.status}`);
      assert.ok(
        !r.json.items.some((x) => x.id === hidden.id || x.patientId === hidden.id),
        'the LOC-B1 patient is not in the result',
      );
      noLeak(r, hiddenFamily.f, hidden.id);
    }
    const byId = await fd.get(`/api/v1/patients/${hidden.id}`);
    assert.equal(byId.status, 404, 'by-ID is 404, not 403');
    noLeak(byId, hiddenFamily.f);
    const ev = await until(async () => {
      const r = await deniedSince(t0, fd.session.principalId, `AND denial_reason = 'not_visible'`);
      return r.rowCount ? r : null;
    });
    assert.ok(ev, 'a denied audit event with reason not_visible exists');
    // The 404 for a patient that exists and the 404 for an ID that does not exist are indistinguishable.
    const absent = await fd.get(`/api/v1/patients/${uuid()}`);
    assert.equal(absent.status, 404);
    assert.deepEqual(Object.keys(byId.json).sort(), Object.keys(absent.json).sort());
    assert.equal(byId.json.code, absent.json.code);
  });

  test("TC-AZ-02 a patient who changes IDs in URLs gets 404 for another patient's appointments, documents, notes, profile and threads, and the denials are audited", async () => {
    const owner = await clinical.visit(); // PAT-owner: appointment, doctor, visit
    await clinical.checkIn(owner);
    const dc = await clinical.docClient(owner.doc);
    const enc = await dc.post('/api/v1/encounters', { reservationId: owner.reservationId });
    assert.equal(enc.status, 201, enc.text);
    const note = await dc.post(`/api/v1/encounters/${enc.json.id}/notes`, {});
    assert.equal(note.status, 201, note.text);
    const doc = await fixtureDocument({ patientId: owner.patient.id, uploadedBy: owner.doc.id });
    const other = await newPatient();
    const mine = other.client;
    const t0 = stamp();
    const apptId = owner.appt.id ?? owner.appt.appointmentId ?? owner.reservationId;
    // positive control: the owner sees all of their own
    for (const p of [
      `/api/v1/patients/${owner.patient.id}/appointments`,
      `/api/v1/patients/${owner.patient.id}/profile`,
    ]) {
      assert.equal((await owner.patient.client.get(p)).status, 200, `positive control ${p}`);
    }
    const probes = [
      ['GET', `/api/v1/patients/${owner.patient.id}/appointments`],
      ['GET', `/api/v1/appointments/${apptId}`],
      ['GET', `/api/v1/patients/${owner.patient.id}/profile`],
      ['GET', `/api/v1/patients/${owner.patient.id}/contacts`],
      ['GET', `/api/v1/patients/${owner.patient.id}/documents`],
      ['POST', `/api/v1/documents/${doc}/download-url`],
      ['GET', `/api/v1/patients/${owner.patient.id}/threads`],
      ['GET', `/api/v1/appointments/${apptId}/previsit`],
    ];
    const seen = [];
    for (const [m, p] of probes) {
      const r = m === 'GET' ? await mine.get(p) : await mine.post(p, {});
      seen.push(`${m} ${p.replace(/[0-9a-f-]{36}/g, ':id')} ${r.status}`);
      assert.ok([403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
      noLeak(r, owner.patient.id, 'Patient ');
    }
    // staff-only routes: a patient session is refused by permission (403) or the route does not exist for the audience (404); never data
    for (const p of ['consents', 'care-team', 'chart-summary']) {
      const real = await mine.get(`/api/v1/patients/${owner.patient.id}/${p}`);
      const fake = await mine.get(`/api/v1/patients/${uuid()}/${p}`);
      assert.ok([403, 404].includes(real.status), `staff-only ${p} -> ${real.status}`);
      assert.equal(
        real.status,
        fake.status,
        `${p}: an existing and a non-existing patient ID answer the same (no existence oracle)`,
      );
      noLeak(real, owner.patient.id);
    }
    const realNote = await mine.get(`/api/v1/notes/${note.json.id}`);
    const fakeNote = await mine.get(`/api/v1/notes/${uuid()}`);
    assert.ok([403, 404].includes(realNote.status));
    assert.equal(realNote.status, fakeNote.status, 'a real and an unknown note ID answer the same');
    const fourOhFour = seen.filter((s) => s.endsWith(' 404')).length;
    assert.equal(fourOhFour, probes.length, `every probe is 404 (not 403): ${seen.join('; ')}`);
    const ev = await until(async () => {
      const r = await deniedSince(t0, other.client.session.principalId);
      return r.rowCount ? r : null;
    });
    assert.ok(ev, 'denied events are logged with the patient session');
    assert.ok(
      ev.rowCount >= 3,
      `several of the ${probes.length} refused calls are audited (got ${ev.rowCount})`,
    );
    assert.ok(
      ev.rows.some((e) => e.denial_reason === 'not_visible'),
      'at least one event has reason not_visible (the others are permission refusals of staff-only routes)',
    );
    assert.ok(
      ev.rows.every((e) => e.patient_id === null || e.patient_id === owner.patient.id),
      'the denied events name the requested patient only',
    );
  });

  test('TC-AZ-03 a doctor of ORG-1 cannot find or open a patient of ORG-2; the denial is logged', async () => {
    const ORG2 = '00000000-0000-7000-8000-0000000000b2';
    const pid = uuid();
    const fam = `OrgTwo${Math.floor(Math.random() * 1e6)}`;
    await sqlTx(async (c) => {
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG2]);
      await c.query(
        `INSERT INTO organisation.organisation (id, organisation_id, name, default_time_zone) VALUES ($1,$1,'QA second clinic','UTC') ON CONFLICT DO NOTHING`,
        [ORG2],
      );
      await c.query(
        `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via, email, phone_e164)
         VALUES ($1,$2,$3,'Otherorg',$4,'1969-02-03','NY','front_desk','org2@patient.qa-test.invalid','+15555559988')`,
        [pid, ORG2, `MRN-${9800000 + Math.floor(Math.random() * 99999)}`, fam],
      );
    });
    const dr = await login('staff', 'STF-DR-A1');
    const fd = await login('staff', 'STF-FD-A');
    const t0 = stamp();
    const s = await fd.post('/api/v1/patients/search', { name: fam });
    assert.equal(s.status, 200);
    assert.equal(s.json.items.length, 0, 'ORG-2 patient is not found by search');
    const lookup = await dr.post('/api/v1/patients/lookup', { name: fam });
    assert.ok(
      lookup.status === 200 || lookup.status === 404 || lookup.status === 400,
      `lookup ${lookup.status}`,
    );
    noLeak(lookup, fam);
    for (const c of [fd, dr]) {
      const r = await c.get(`/api/v1/patients/${pid}`);
      assert.ok([403, 404].includes(r.status), `open by ID -> ${r.status}`);
      noLeak(r, fam);
    }
    const chart = await dr.get(`/api/v1/patients/${pid}/chart-summary`);
    assert.ok([403, 404].includes(chart.status), `chart -> ${chart.status}`);
    assert.notEqual(
      chart.json?.code,
      'clinical.not_assigned',
      'no BTG offer for an organisation the user does not belong to',
    );
    const ev = await until(async () => {
      const r = await sql(
        `SELECT 1 FROM audit.event WHERE occurred_at >= $1 AND outcome='denied' AND actor_principal_id = ANY($2)`,
        [t0, [fd.session.principalId, dr.session.principalId]],
      );
      return r.rowCount ? r : null;
    });
    assert.ok(ev, 'the refused attempts are logged');
    const control = await newPatient();
    assert.equal(
      (await fd.get(`/api/v1/patients/${control.id}`)).status,
      200,
      'positive control: a patient of ORG-1 opens',
    );
  });

  test("TC-AZ-04 visibility follows the care relationship at the user's location: invisible, booked at LOC-A1 (visible), relationship ended (invisible again)", async () => {
    const fam = `CareRel${Math.floor(Math.random() * 1e6)}`;
    const p = await newPatient({ given: 'Cross', family: fam, locations: [B1] });
    const fd = await login('staff', 'STF-FD-A');
    const seeIt = async () => {
      const s = await fd.post('/api/v1/patients/search', { name: `Cross ${fam}` });
      const o = await fd.get(`/api/v1/patients/${p.id}`);
      return { search: s.json?.items?.length ?? -1, open: o.status };
    };
    assert.deepEqual(
      await seeIt(),
      { search: 0, open: 404 },
      'step 1: cared for at LOC-B1 only, not visible at LOC-A1',
    );
    // step 2: the patient books at LOC-A1 (the real booking path creates the care relationship)
    const doc = await newDoctor({ location: A1, allDay: true });
    const svc = (
      await sql(
        `SELECT id FROM organisation.service WHERE internal_name = 'Consult in person' LIMIT 1`,
      )
    ).rows[0].id;
    await sql(
      `INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [ORG, svc, doc.id],
    );
    const found = await search(p.client, {
      serviceId: svc,
      clinicianId: doc.id,
      locationId: A1,
      day: {
        from: new Date(Date.now() + 3600e3).toISOString(),
        to: new Date(Date.now() + 8 * 3600e3).toISOString(),
      },
    });
    assert.ok(
      found.slots.length,
      `a slot at LOC-A1 exists (${found.status} ${found.text.slice(0, 120)})`,
    );
    await book(p, found.slots[0], svc);
    const rel = await sql(
      `SELECT 1 FROM patient.care_relationship WHERE patient_id=$1 AND location_id=$2 AND ended_at IS NULL`,
      [p.id, A1],
    );
    assert.equal(rel.rowCount, 1, 'booking at LOC-A1 opened a care relationship there');
    assert.deepEqual(
      await seeIt(),
      { search: 1, open: 200 },
      'step 3: visible while the relationship exists',
    );
    // step 4: end the relationship through the owner function the staff service calls (R1 has no HTTP route for it, 6.6)
    const ended = await asScope(
      'app_api',
      {
        'app.org_id': ORG,
        'app.audience': 'staff',
        'app.realm': 'google',
        'app.principal_id': principalId('STF-FD-A'),
        'app.location_ids': A1,
      },
      async (c) => {
        const r = await c.query(
          `SELECT patient.end_care_relationship($1::uuid, $2::uuid, $3::uuid, 'qa03 end relationship') AS ended`,
          [uuid(), p.id, A1],
        );
        await c.query('COMMIT');
        return r.rows[0].ended;
      },
    );
    assert.equal(ended, true, 'the relationship at LOC-A1 was open and is now ended');
    assert.deepEqual(
      await seeIt(),
      { search: 0, open: 404 },
      'step 4: not visible once the relationship has ended',
    );
    // Cross-location chart visibility beyond this is BQ-1 (open): not asserted, only that visibility never exceeded the least-privilege reading.
  });

  test('TC-AZ-09 the staff-scope drift check finds and corrects a missing and an extra row and raises the alerts', async () => {
    const p = await newPatient({ locations: [A1] });
    const row = (
      await sql(`SELECT 1 FROM patient.staff_scope WHERE patient_id=$1 AND location_id=$2`, [
        p.id,
        A1,
      ])
    ).rowCount;
    assert.equal(row, 1, 'setup: the derived scope row exists');
    // drift 1 (missing): delete the derived row; drift 2 (extra): add a row for a location without a relationship
    await sql(`ALTER TABLE patient.staff_scope DISABLE TRIGGER USER`);
    try {
      await sql(`DELETE FROM patient.staff_scope WHERE patient_id=$1 AND location_id=$2`, [
        p.id,
        A1,
      ]);
      await sql(
        `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1,$2,$3)`,
        [p.id, B1, ORG],
      );
    } finally {
      await sql(`ALTER TABLE patient.staff_scope ENABLE TRIGGER USER`);
    }
    const t0 = new Date(Date.now() - 2000).toISOString();
    const fdA = await login('staff', 'STF-FD-A');
    assert.equal(
      (await fdA.get(`/api/v1/patients/${p.id}`)).status,
      404,
      'while drifted, the LOC-A1 desk cannot see the patient (history hidden)',
    );
    await sql(`SELECT queue.add_job('patient.verify_staff_scope', '{}'::json)`);
    const repaired = await until(
      async () => {
        const a = await sql(
          `SELECT 1 FROM patient.staff_scope WHERE patient_id=$1 AND location_id=$2`,
          [p.id, A1],
        );
        const b = await sql(
          `SELECT 1 FROM patient.staff_scope WHERE patient_id=$1 AND location_id=$2`,
          [p.id, B1],
        );
        return a.rowCount === 1 && b.rowCount === 0 ? true : null;
      },
      { timeoutMs: 40000 },
    );
    assert.ok(repaired, 'the worker job restored the missing row and removed the extra row');
    const summary = await sql(
      `SELECT change FROM audit.event WHERE occurred_at >= $1 AND resource_type = 'patient.staff_scope' AND job_id LIKE 'patient.verify_staff_scope:%' ORDER BY occurred_at DESC LIMIT 1`,
      [t0],
    );
    assert.ok(summary.rowCount, 'the run wrote its summary audit row');
    assert.ok(
      summary.rows[0].change.missingRows >= 1 && summary.rows[0].change.extraRows >= 1,
      `both kinds counted ${JSON.stringify(summary.rows[0].change)}`,
    );
    const alerts = await until(
      async () => {
        const r = await sql(
          `SELECT type, target_kind FROM notifications.staff_alert WHERE created_at >= $1 AND type = 'scope_drift'`,
          [t0],
        );
        return r.rowCount >= 1 ? r : null;
      },
      { timeoutMs: 20000 },
    );
    assert.ok(
      alerts,
      'an alert for the drift was raised (operations for missing, compliance for extra)',
    );
    assert.equal(
      (await fdA.get(`/api/v1/patients/${p.id}`)).status,
      200,
      'after the repair the LOC-A1 desk sees the patient again',
    );
  });

  test('TC-AZ-10 an unassigned doctor is blocked until a reason is entered; BTG then grants access and alerts compliance', async () => {
    const p = await newPatient();
    const a2 = await login('staff', 'STF-DR-A2');
    const t0 = stamp();
    const blocked = await a2.get(`/api/v1/patients/${p.id}/chart-summary`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'clinical.not_assigned');
    const open = await a2.post(`/api/v1/patients/${p.id}/break-glass`, {
      reason: 'QA03 emergency access, synthetic',
    });
    assert.ok(
      open.status === 200 || open.status === 201,
      `POST /patients/{id}/break-glass must open a grant (got ${open.status} ${open.text.slice(0, 160)}). The route is not mounted: README of the audit module lists it as not built`,
    );
    assert.equal(
      blocked.json.btgAvailable,
      true,
      'the refusal offers break-the-glass (btgAvailable)',
    );
    const after2 = await a2.get(`/api/v1/patients/${p.id}/chart-summary`);
    assert.equal(after2.status, 200, 'access is granted after BTG');
    const alert = await until(async () => {
      const r = await sql(
        `SELECT 1 FROM audit.event WHERE occurred_at >= $1 AND action='btg_open' AND actor_principal_id=$2`,
        [t0, a2.session.principalId],
      );
      return r.rowCount ? r : null;
    });
    assert.ok(alert, 'a btg_open audit event exists');
  });

  test('TC-AZ-11 BTG review: justified / not_justified are recorded and audited; the opener cannot review; a reviewer needs the permission', async () => {
    const p = await newPatient();
    const holder = await newStaff([['doctor', A1]], { name: 'STF-DR-BTG' });
    const grantA = uuid();
    const grantB = uuid();
    for (const g of [grantA, grantB])
      await sql(
        `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason, expires_at) VALUES ($1,$2,$3,$4,'google',$5,'QA03 synthetic emergency reason',now()+interval '1 hour')`,
        [g, ORG, holder.id, holder.personId, p.id],
      );
    const cmp = await newAdmin({ roles: ['compliance_officer'], name: 'CMP', elevated: true });
    const t0 = stamp();
    const ok = await cmp.client.post(`${AD}/btg-grants/${grantA}/review`, {
      outcome: 'justified',
      note: 'synthetic',
    });
    assert.equal(ok.status, 200, `${ok.status} ${ok.text.slice(0, 200)}`);
    const no = await cmp.client.post(`${AD}/btg-grants/${grantB}/review`, {
      outcome: 'not_justified',
      note: 'synthetic',
    });
    assert.equal(no.status, 200, `${no.status} ${no.text.slice(0, 200)}`);
    const rows = await sql(`SELECT id, review_status FROM audit.btg_grant WHERE id = ANY($1)`, [
      [grantA, grantB],
    ]);
    assert.deepEqual(Object.fromEntries(rows.rows.map((r) => [r.id, r.review_status])), {
      [grantA]: 'justified',
      [grantB]: 'not_justified',
    });
    const evt = await sql(
      `SELECT 1 FROM audit.event WHERE occurred_at >= $1 AND action = 'btg_review'`,
      [t0],
    );
    assert.ok(evt.rowCount >= 2, 'both decisions are audited');
    const again = await cmp.client.post(`${AD}/btg-grants/${grantA}/review`, {
      outcome: 'not_justified',
    });
    assert.ok(
      again.status >= 400 && again.status < 500,
      `a decided grant cannot be decided again (${again.status})`,
    );
    // the opener: an admin_pool person who holds BOTH the reviewer permission and is the holder of a grant (same person_id rule)
    const selfGrant = uuid();
    await sql(
      `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason, expires_at) VALUES ($1,$2,$3,$4,'admin_pool',$5,'QA03 synthetic self reason',now()+interval '1 hour')`,
      [selfGrant, ORG, cmp.principalId, cmp.personId, p.id],
    );
    const self = await cmp.client.post(`${AD}/btg-grants/${selfGrant}/review`, {
      outcome: 'justified',
    });
    assert.ok(
      self.status === 403 || self.status === 409,
      `the opener cannot review their own grant (${self.status} ${self.text.slice(0, 120)})`,
    );
    assert.equal(
      (await sql(`SELECT review_status FROM audit.btg_grant WHERE id=$1`, [selfGrant])).rows[0]
        .review_status,
      'pending',
    );
    // a person without the BTG review permission
    const plainRole = await newRole(['privacy.request.manage']);
    const plain = await newAdmin({ roles: [plainRole], name: 'NOBTG', elevated: true });
    const denied = await plain.client.post(`${AD}/btg-grants/${grantB}/review`, {
      outcome: 'justified',
    });
    assert.equal(denied.status, 403);
  });

  test('TC-AZ-12 public routes are GET only, cacheable and PHI free (rate-limit step is a WAF check on staging)', async () => {
    const pub = anonymous('integrations');
    const routes = ['services', 'locations', 'clinicians'];
    for (const r of routes) {
      const res = await pub.get(`/public/v1/${r}`);
      assert.equal(res.status, 200, `/public/v1/${r}: ${res.status} ${res.text.slice(0, 120)}`);
      assert.match(
        res.headers['cache-control'] ?? '',
        /max-age=60/,
        'public routes are cacheable for 60 s',
      );
      assert.doesNotMatch(
        res.text,
        /patientId|patient_id|reservation|roomId|room_id|appointmentId|\bmrn\b|dateOfBirth|date_of_birth|email|startsAt|\bslot/i,
        `/public/v1/${r} contains no patient, reservation or room data`,
      );
      for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const m = await pub.send(verb, `/public/v1/${r}`, {
          body: {},
          headers: { 'content-type': 'application/json' },
        });
        assert.ok(
          [404, 405, 401, 403].includes(m.status),
          `${verb} /public/v1/${r} -> ${m.status}`,
        );
      }
    }
    // Step 4 (rate limit, 429 + Retry-After): the /public/v1 limits are WAF-only (ARCHITECTURE 21.3, 31.3), so the API process
    // has nothing to assert in ENV-INT/ci. It stays a staging/WAF check (ENV-INT/staging, DEVOPS-PLAN OPEN-4); never claimed here.
  });

  test("TC-AZ-14 a proxy sees the linked patient's appointments only; everything else is 404; another patient never opens", async () => {
    const dependant = await newPatient({
      given: 'Dep',
      family: `Child${Math.floor(Math.random() * 1e6)}`,
    });
    const proxy = await newPatient();
    const stranger = await newPatient();
    // an accepted proxy grant with the D-7 default scope (appointments only)
    const cols = (
      await sql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='identity' AND table_name='proxy_grant' ORDER BY ordinal_position`,
      )
    ).rows.map((r) => r.column_name);
    const gid = uuid();
    const vals = {
      id: gid,
      organisation_id: ORG,
      proxy_principal_id: (
        await sql(
          `SELECT principal_id FROM identity.patient_link WHERE patient_id=$1 AND kind='self'`,
          [proxy.id],
        )
      ).rows[0].principal_id,
      patient_id: dependant.id,
      status: 'active',
      relationship: 'parent',
      scope: 'appointments',
      patient_display_name: 'Synthetic dependant',
    };
    const use = cols.filter((c) => c in vals);
    const rowCols = (
      await sql(
        `SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns WHERE table_schema='identity' AND table_name='proxy_grant'`,
      )
    ).rows;
    void rowCols;
    await sql(
      `INSERT INTO identity.proxy_grant (${use.join(',')}) VALUES (${use.map((_, i) => '$' + (i + 1)).join(',')})`,
      use.map((c) => vals[c]),
    );
    const px = await login('patient', proxy.key);
    const me = await px.get('/api/v1/me');
    assert.equal(me.status, 200);
    const linked = me.json.patients.find((x) => x.patientId === dependant.id);
    assert.ok(linked, `the proxy sees the dependant in /me (${JSON.stringify(me.json.patients)})`);
    const appts = await px.get(`/api/v1/patients/${dependant.id}/appointments`);
    assert.equal(
      appts.status,
      200,
      `proxy opens the dependant's appointments (${appts.status} ${appts.text.slice(0, 160)})`,
    );
    for (const p of [
      'profile',
      'documents',
      'contacts',
      'threads',
      'insurance-coverages',
      'communication-preferences',
    ]) {
      const r = await px.get(`/api/v1/patients/${dependant.id}/${p}`);
      assert.equal(r.status, 404, `proxy ${p} -> ${r.status} (default D-7: appointments only)`);
    }
    for (const p of ['consents', 'chart-summary', 'care-team']) {
      const r = await px.get(`/api/v1/patients/${dependant.id}/${p}`);
      assert.ok([403, 404].includes(r.status), `proxy on staff-only ${p} -> ${r.status}`);
      noLeak(r, 'Synthetic dependant');
    }
    const other = await px.get(`/api/v1/patients/${stranger.id}/appointments`);
    assert.equal(other.status, 404, "another patient's data never opens");
  });

  test('TC-AZ-15 an assistant cannot sign, prescribe or run EPCS actions', async () => {
    const v = await clinical.visit();
    await clinical.checkIn(v);
    const dc = await clinical.docClient(v.doc);
    const enc = await dc.post('/api/v1/encounters', { reservationId: v.reservationId });
    const note = await dc.post(`/api/v1/encounters/${enc.json.id}/notes`, {});
    const asst = await login('staff', 'STF-ASST-A');
    assert.ok(
      !asst.session.permissions.includes('clinical.note.sign'),
      'the assistant holds no sign permission',
    );
    const sign = await asst.post(
      `/api/v1/notes/${note.json.id}/sign`,
      {},
      { headers: { 'if-match': clinical.W(note.json.version) } },
    );
    assert.ok(
      [401, 403, 404].includes(sign.status),
      `assistant sign -> ${sign.status} ${sign.text.slice(0, 120)}`,
    );
    assert.notEqual(sign.status, 200);
    const status = await sql(`SELECT status FROM clinical.note WHERE id=$1`, [note.json.id]);
    assert.equal(status.rows[0].status, 'draft', 'the note stays a draft');
    for (const p of [
      '/api/v1/prescriptions',
      '/api/v1/orders',
      '/api/v1/epcs',
      '/api/v1/medications/prescribe',
    ]) {
      const r = await asst.post(p, { patientId: v.patient.id });
      assert.ok(
        [404, 405, 403].includes(r.status) && r.status !== 200,
        `${p} -> ${r.status}: nothing is signed, prescribed or sent`,
      );
    }
    // What an assistant may PREPARE is BLOCKED on G-10 (open decision); only the refusal half is asserted here.
  });

  test('TC-AZ-16 break-the-glass reason boundaries: empty, spaces, one character and over-maximum are refused; minimum and maximum are accepted', async () => {
    const a2 = await login('staff', 'STF-DR-A2');
    const mk = async (reason) => {
      const p = await newPatient();
      const r = await a2.post(`/api/v1/patients/${p.id}/break-glass`, { reason });
      const chart = await a2.get(`/api/v1/patients/${p.id}/chart-summary`);
      return { r, chart, p };
    };
    const route = (await mk('x'.repeat(10))).r;
    assert.ok(
      route.status !== 404,
      'POST /patients/{id}/break-glass must exist (it is 404: the route is not mounted in the API, audit README "Not built")',
    );
    for (const [name, reason] of [
      ['empty', ''],
      ['spaces only', '          '],
      ['one character', 'a'],
      ['nine characters', 'abcdefghi'],
      ['over the maximum', 'x'.repeat(501)],
    ]) {
      const { r, chart } = await mk(reason);
      assert.ok(r.status === 400 || r.status === 422, `${name}: refused (${r.status})`);
      assert.equal(chart.status, 403, `${name}: no access was granted`);
    }
    for (const [name, reason] of [
      ['minimum length', 'abcdefghij'],
      ['maximum length', 'y'.repeat(500)],
    ]) {
      const { r, chart, p } = await mk(reason);
      assert.ok(r.status === 200 || r.status === 201, `${name}: accepted (${r.status})`);
      assert.equal(chart.status, 200);
      const g = await sql(
        `SELECT reason FROM audit.btg_grant WHERE patient_id=$1 AND holder_principal_id=$2`,
        [p.id, a2.session.principalId],
      );
      assert.equal(
        g.rows[0]?.reason,
        reason,
        'the grant (and the compliance review queue) carries the exact reason text',
      );
    }
  });
});
void sleep;
void assign;
void attempt;
void elevate;
void stateOf;
