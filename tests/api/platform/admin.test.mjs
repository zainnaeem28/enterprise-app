// TC-AD-01..15 (TEST-CASES 10.1). ENV-INT/ci: the admin realm (path B) with real WebAuthn enrolment, sign-in and elevation.
// ADM-1 and ADM-2 are two different people (different person_id). Vendor sandboxes and the secret store do not exist in ci:
// the cases that need them stay BLOCKED naming the missing piece.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  newPatient,
  newStaff,
  newService,
  setPolicy,
  login,
  sql,
  until,
  closeAdmin,
  search,
  book,
  soon,
  nextDay,
  SVC,
  A1,
  B1,
  uuid,
  asRole,
  ORG,
  anonymous,
} from './lib/world.mjs';
import { adminClient, elevate, signInAdmin } from './lib/admin.mjs';

after(() => closeAdmin());
const AD = '/api/v1/admin';
let adm1, adm2;
before(async () => {
  adm1 = await adminClient('ADM-1');
  assert.equal((await elevate(adm1)).status, 200, 'ADM-1 elevated (TC-SEC-02 grant)');
  adm2 = await adminClient('ADM-2');
});
const configAudit = (resourcePrefix, sinceIso) =>
  sql(
    `SELECT action, resource_type, resource_id, change, actor_person_id FROM audit.event WHERE action='config_change' AND resource_type LIKE $1 AND occurred_at >= $2 ORDER BY occurred_at`,
    [`${resourcePrefix}%`, sinceIso],
  );

describe('TC-AD', () => {
  test('TC-AD-01 clinics, rooms, hours and holidays are saved, audited with before/after, and visible in the catalogue', async () => {
    const t0 = new Date(Date.now() - 1000).toISOString();
    const loc = await adm1.post(`${AD}/locations`, {
      name: 'QA05 Clinic',
      kind: 'clinic',
      timeZone: 'America/Chicago',
      stateCode: 'NY',
    });
    assert.equal(loc.status, 200, `location ${loc.status} ${loc.text.slice(0, 200)}`);
    const room = await adm1.post(`${AD}/rooms`, { locationId: loc.json.id, name: 'QA05 Room 1' });
    assert.equal(room.status, 200, `room ${room.status} ${room.text.slice(0, 200)}`);
    const hours = await adm1.post(`${AD}/opening-hours`, {
      locationId: loc.json.id,
      weekday: 1,
      opens: '08:00',
      closes: '17:00',
    });
    assert.equal(hours.status, 200, `hours ${hours.status} ${hours.text.slice(0, 200)}`);
    const hol = await adm1.post(`${AD}/holidays`, { date: '2027-07-04', name: 'QA05 holiday' });
    assert.equal(hol.status, 200, `holiday ${hol.status} ${hol.text.slice(0, 200)}`);
    const overlap = await adm1.post(`${AD}/opening-hours`, {
      locationId: loc.json.id,
      weekday: 1,
      opens: '09:00',
      closes: '12:00',
    });
    assert.equal(overlap.status, 400, 'overlapping hours are refused');
    const patch = await adm1.patch(
      `${AD}/locations`,
      { id: loc.json.id, name: 'QA05 Clinic renamed' },
      { headers: { 'if-match': loc.headers.etag } },
    );
    assert.equal(patch.status, 200);
    const noMatch = await adm1.patch(`${AD}/locations`, { id: loc.json.id, name: 'x' });
    assert.equal(noMatch.status, 428, 'PATCH without If-Match is 428');
    const stale = await adm1.patch(
      `${AD}/locations`,
      { id: loc.json.id, name: 'x' },
      { headers: { 'if-match': loc.headers.etag } },
    );
    assert.equal(stale.status, 412, 'a stale If-Match is 412');
    const a = await until(async () => {
      const r = await configAudit('organisation.', t0);
      return r.rows.length >= 5 ? r : null;
    });
    assert.ok(a, 'config_change events for location, room, hours, holiday and the rename');
    const renamed = a.rows.find((x) => JSON.stringify(x.change).includes('renamed'));
    assert.ok(
      renamed?.change?.before && renamed?.change?.after,
      'the audit change holds before and after',
    );
    const cat = await (await newPatient()).client.get('/api/v1/locations');
    assert.ok(
      JSON.stringify(cat.json).includes(loc.json.id),
      'the new location is in the catalogue the portals read',
    );
    // "appear in slot search": a new location has no clinician or template, so a slot search cannot show it; not asserted.
  });

  test('TC-AD-02 a service that reveals a condition needs a neutral patient-visible name, which is the only one patients see', async () => {
    const noNeutral = await adm1.post(`${AD}/services`, {
      internalName: 'Synthetic HIV clinic',
      durationMin: 20,
      mode: 'in_person',
      conditionRevealing: true,
    });
    assert.equal(noNeutral.status, 422, `${noNeutral.status} ${noNeutral.text.slice(0, 200)}`);
    assert.equal(noNeutral.json?.code, 'organisation.neutral_name_required');
    const same = await adm1.post(`${AD}/services`, {
      internalName: 'Synthetic HIV clinic',
      patientDisplayName: 'Synthetic HIV clinic',
      durationMin: 20,
      mode: 'in_person',
      conditionRevealing: true,
    });
    assert.equal(same.status, 422, 'the neutral name cannot repeat the internal one');
    const ok = await adm1.post(`${AD}/services`, {
      internalName: 'Synthetic HIV clinic QA05',
      patientDisplayName: 'General appointment QA05',
      durationMin: 20,
      mode: 'in_person',
      conditionRevealing: true,
    });
    assert.equal(ok.status, 200, `${ok.status} ${ok.text.slice(0, 200)}`);
    const sid = ok.json.id;
    await sql(
      `INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1,$2,$3)`,
      [ORG, sid, A1],
    );
    const patient = await newPatient();
    const cat = await patient.client.get('/api/v1/services');
    assert.equal(cat.status, 200);
    const mine = cat.json.items.find((x) => x.id === sid);
    assert.ok(mine, 'the service is in the patient catalogue');
    assert.equal(
      mine.name ?? mine.displayName ?? mine.patientDisplayName,
      'General appointment QA05',
    );
    assert.doesNotMatch(
      JSON.stringify(mine),
      /HIV/i,
      'the internal name of a condition-revealing service is never shown to patients',
    );
    // Observation (not a pass criterion): a condition-revealing name is only caught when the administrator ticks conditionRevealing;
    // an untick service named "Synthetic HIV clinic" is shown to patients as is (see QA05-O-01).
    const untick = await adm1.post(`${AD}/services`, {
      internalName: 'Synthetic HIV clinic untick',
      durationMin: 20,
      mode: 'in_person',
    });
    assert.equal(untick.status, 200);
    assert.equal(
      untick.json.patientDisplayName,
      'Synthetic HIV clinic untick',
      'without the flag the internal name becomes the patient-visible name',
    );
  });

  test('TC-AD-03 booking policy: block-only works; a fee is stored and nothing is charged (D-3 default)', async () => {
    const s = await adm1.post(`${AD}/services`, {
      internalName: 'QA05 policy service',
      durationMin: 20,
      mode: 'in_person',
      priceCents: 5000,
      currency: 'USD',
      feeCents: 2500,
    });
    assert.equal(s.status, 200, `${s.status} ${s.text.slice(0, 200)}`);
    assert.equal(s.json.feeCents, 2500, 'the fee is stored');
    const bp = await adm1.post(`${AD}/booking-policies`, {
      serviceId: s.json.id,
      lateChange: 'block',
      cutoffHours: 24,
    });
    assert.equal(bp.status, 200, `${bp.status} ${bp.text.slice(0, 200)}`);
    assert.equal(bp.json.lateChange, 'block');
    const pay = await adm1.get('/api/v1/payments');
    assert.equal(pay.status, 404, 'no payment route exists: nothing is charged in R1');
    const charges = await sql(
      `SELECT count(*)::int n FROM information_schema.tables WHERE table_name IN ('payment','charge','invoice')`,
    );
    assert.equal(charges.rows[0].n, 0, 'no payment table exists');
  });

  test(
    'TC-AD-04 message templates: variables restricted to the allowlist; a free-text binding is rejected',
    {
      skip: 'NOT DELIVERED: the API has no message-template admin route (probed /admin/message-templates: 404; README BE-23 N-BE23-4 lists message templates as not built). Coverage gap recorded as QA05-F07, not a pass',
    },
    () => {},
  );

  test('TC-AD-05 role assignment needs the second approver; no role is effective before approval', async () => {
    const staff = await newStaff([], { name: 'STF-AD05' });
    const before = await sql(
      `SELECT count(*)::int n FROM identity.role_assignment WHERE principal_id = $1`,
      [staff.id],
    );
    assert.equal(before.rows[0].n, 0);
    const req = await adm1.post(`${AD}/role-change-requests`, {
      subjectPrincipalId: staff.id,
      add: [{ roleKey: 'front_desk', locationId: A1 }],
    });
    assert.equal(req.status, 200, `request ${req.status} ${req.text.slice(0, 200)}`);
    assert.equal(req.json.status, 'requested');
    const mid = await sql(
      `SELECT count(*)::int n FROM identity.role_assignment WHERE principal_id = $1`,
      [staff.id],
    );
    assert.equal(mid.rows[0].n, 0, 'no role is effective before approval');
    const self = await adm1.post(`${AD}/role-change-requests/${req.json.id}/approve`, {});
    assert.ok(
      self.status === 403 || self.status === 409,
      `the requester cannot approve (${self.status})`,
    );
    await elevate(adm2);
    const ok = await adm2.post(`${AD}/role-change-requests/${req.json.id}/approve`, {});
    assert.equal(ok.status, 200, `approve ${ok.status} ${ok.text.slice(0, 200)}`);
    const after = await until(async () => {
      const r = await sql(
        `SELECT count(*)::int n FROM identity.role_assignment WHERE principal_id = $1`,
        [staff.id],
      );
      return r.rows[0].n === 1;
    });
    assert.ok(after, 'the role is effective after the second approver');
  });

  test('TC-AD-06 front desk cannot open admin routes', async () => {
    const fd = await login('staff', 'STF-FD-A');
    for (const p of [
      '/locations',
      '/services',
      '/feature-flags',
      '/settings',
      '/banners',
      '/integrations',
      '/audit-exports/00000000-0000-7000-8000-000000000001',
    ]) {
      const r = await fd.get(`${AD}${p}`);
      assert.ok([401, 403, 404].includes(r.status), `${p}: ${r.status}`);
      assert.notEqual(r.status, 200);
    }
    const w = await fd.post(`${AD}/locations`, {
      name: 'x',
      kind: 'clinic',
      timeZone: 'UTC',
      stateCode: 'NY',
    });
    assert.ok([401, 403, 404].includes(w.status), `write refused (${w.status})`);
  });

  test('TC-AD-07 future-appointment cap set in admin applies at the boundary', async () => {
    const svc = await newService({ internal: 'QA05 cap', display: 'QA05 cap' });
    await setPolicy(svc, { cutoff: 0, max: 50 });
    const bp = await adm1.get(`${AD}/booking-policies`);
    const row = bp.json.items.find((x) => x.serviceId === svc);
    assert.ok(row, 'the policy row exists');
    const set = await adm1.patch(
      `${AD}/booking-policies`,
      { id: row.id, maxFuturePerPatient: 2 },
      { headers: { 'if-match': `W/"${row.rowVersion}"` } },
    );
    assert.equal(set.status, 200, `${set.status} ${set.text.slice(0, 200)}`);
    const pat = await newPatient();
    const doc = await sql(
      `SELECT clinician_principal_id AS id FROM organisation.service_clinician WHERE service_id=$1 LIMIT 1`,
      [svc],
    );
    const slots = [];
    for (let i = 0; i < 3; i++) {
      const r = await search(pat.client, { serviceId: svc, clinicianId: doc.rows[0].id });
      slots.push(r.slots[0]);
    }
    const ok1 = await book(pat, slots[0], svc);
    const ok2 = await book(pat, slots[1], svc);
    assert.ok(ok1 && ok2, 'two bookings within the cap succeed');
    const third = await pat.client.post('/api/v1/holds', {
      patientId: pat.id,
      serviceId: svc,
      clinicianId: slots[2].clinicianId,
      locationId: slots[2].locationId,
      startsAt: slots[2].startsAt,
      mode: 'in_person',
    });
    assert.ok(
      third.status >= 400 && third.status < 500,
      `the third future appointment is refused (${third.status})`,
    );
  });

  test('TC-AD-08 a feature flag set for LOC-A1 only is stored per location, readable per location, and audited', async () => {
    const t0 = new Date(Date.now() - 1000).toISOString();
    const set = await adm1.put(`${AD}/feature-flags`, {
      key: 'qa05_probe_flag',
      enabled: true,
      locationId: A1,
    });
    assert.equal(set.status, 200, `${set.status} ${set.text.slice(0, 300)}`);
    const list = await adm1.get(`${AD}/feature-flags`);
    const rows = list.json.items.filter((x) => x.key === 'qa05_probe_flag');
    assert.deepEqual(
      rows.map((r) => r.locationId),
      [A1],
      'only LOC-A1 has the flag; LOC-B1 has none',
    );
    const a = await configAudit('organisation.', t0);
    assert.ok(
      a.rows.some((x) => JSON.stringify(x.change).includes('qa05_probe_flag')),
      'audited',
    );
    // "Behaviour appears at LOC-A1 and not LOC-B1": no route reads flags into behaviour except patient messaging (D-5); not asserted.
  });

  test('TC-AD-09 a maintenance banner is visible on all three hosts without PHI and removed cleanly', async () => {
    const t0 = new Date().toISOString();
    const end = new Date(Date.now() + 3600e3).toISOString();
    const phi = await adm1.put(`${AD}/banners`, {
      surface: 'site',
      message: 'Call back 5551234567 now',
      startsAt: t0,
      endsAt: end,
    });
    assert.equal(phi.status, 400, `a banner with a long digit run is refused (${phi.status})`);
    const ids = [];
    for (const surface of ['site', 'patient', 'staff']) {
      const ok = await adm1.put(`${AD}/banners`, {
        surface,
        message: `Planned maintenance tonight (QA-05 ${surface})`,
        startsAt: t0,
        endsAt: end,
      });
      assert.equal(ok.status, 200, `${surface}: ${ok.status} ${ok.text.slice(0, 300)}`);
      ids.push(ok.json.id);
    }
    // Visible on the hosts means a portal can read it. Probe every route a portal could plausibly use.
    const seen = [];
    for (const [who, c] of [
      ['patient', (await newPatient()).client],
      ['staff', await login('staff', 'STF-FD-A')],
      ['site', anonymous('patient')],
    ]) {
      for (const p of [
        '/api/v1/banners',
        '/api/v1/config',
        '/api/v1/auth/session',
        '/public/v1/banners',
        '/api/v1/maintenance',
      ]) {
        const r = await c.get(p);
        if (r.status === 200 && r.text.includes('Planned maintenance tonight'))
          seen.push(`${who}${p}`);
      }
    }
    for (const id of ids) {
      const rm = await adm1.put(`${AD}/banners`, { id, remove: true });
      assert.equal(rm.status, 200, 'removed cleanly');
    }
    assert.ok(
      seen.length >= 3,
      `QA05-F06: the banner is readable on ${seen.length} of 3 hosts (${seen.join(', ') || 'none'}): no route returns banners to a portal`,
    );
  });

  test('TC-AD-10 flag change without a live elevation grant is refused (C1)', async () => {
    const plain = await adminClient('CMP-2'); // signed in, never elevated; compliance role also lacks the permission
    const adm3 = await signInAdmin('ADM-2');
    const r = await adm3.client.put(`${AD}/feature-flags`, {
      key: 'qa05_probe_flag2',
      enabled: true,
    });
    assert.equal(r.status, 403, `${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.json?.code, 'identity.elevation_required');
    void plain;
    const rows = await sql(`SELECT 1 FROM organisation.feature_flag WHERE key='qa05_probe_flag2'`);
    assert.equal(rows.rowCount, 0, 'nothing was written');
  });

  test(
    'TC-AD-11 integration health shows OK/failed correctly with a real failure injected [sandboxes]',
    {
      skip: 'BLOCKED: no Google, e-mail, SMS, push or analytics sandbox in ENV-INT/ci (C-10); health depends on a real vendor probe',
    },
    () => {},
  );

  test(
    'TC-AD-12 secrets are write-only: never displayed, logged or exported [secret store]',
    {
      skip: 'BLOCKED: no secret store (OutboundSecretStore) in ENV-INT/ci (INT-N8); the write cannot complete without it. Needs ENV-INT/staging',
    },
    () => {},
  );

  test('TC-AD-13 integration setting change is audited with who, what, before and after', async () => {
    const id = uuid();
    await sql(
      `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, settings, enabled) VALUES ($1,$2,'email','qa05-vendor','{"from":"clinic-a"}'::jsonb,true)`,
      [id, ORG],
    );
    const list = await adm1.get(`${AD}/integrations`);
    const row = list.json.items.find((x) => x.id === id);
    assert.ok(row, 'the connection is listed');
    const t0 = new Date(Date.now() - 500).toISOString();
    const patch = await adm1.patch(
      `${AD}/integrations/${id}`,
      { settings: { from: 'clinic-b' } },
      { headers: { 'if-match': `W/"${row.rowVersion}"` } },
    );
    assert.equal(patch.status, 200, `${patch.status} ${patch.text.slice(0, 300)}`);
    const a = await until(async () => {
      const r = await sql(
        `SELECT change, actor_person_id FROM audit.event WHERE resource_id=$1 AND occurred_at >= $2 AND action IN ('config_change','update')`,
        [id, t0],
      );
      return r.rows[0] ?? null;
    });
    assert.ok(a, 'an audit event exists');
    assert.ok(a.actor_person_id, 'who');
    const flat = JSON.stringify(a.change);
    assert.ok(
      flat.includes('clinic-a') && flat.includes('clinic-b'),
      `before and after are in the change: ${flat}`,
    );
  });

  test('TC-AD-14 compromised api: the api role cannot write an approval or an inbound-verification secret itself', async () => {
    const id = uuid();
    await sql(
      `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, settings, enabled) VALUES ($1,$2,'sms','qa05-vendor','{}'::jsonb,true)`,
      [id, ORG],
    );
    const adminScope = (c) =>
      c.query(
        `SELECT set_config('app.org_id',$1,true), set_config('app.audience','staff',true), set_config('app.realm','admin_pool',true), set_config('app.principal_id',$2,true)`,
        [ORG, uuid()],
      );
    const tryInsert = (sqlText, params) =>
      asRole('app_api', async (c) => {
        await c.query('BEGIN');
        try {
          await adminScope(c);
          await c.query(sqlText, params);
          await c.query('ROLLBACK');
          return 'allowed';
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          return e.code;
        }
      });
    const outbound = await tryInsert(
      `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id) VALUES ($1,'qa05',$2,'outbound','/integration/outbound/qa05','v1')`,
      [id, ORG],
    );
    assert.equal(
      outbound,
      'allowed',
      'positive control: the api role may write an OUTBOUND reference (BD-11 split), so the scope is adequate',
    );
    const inbound = await tryInsert(
      `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id) VALUES ($1,'qa05in',$2,'inbound_verification','/integration/inbound/qa05','v1')`,
      [id, ORG],
    );
    assert.notEqual(
      inbound,
      'allowed',
      `the api role cannot write an inbound-verification reference (got ${inbound})`,
    );
    const approved = await tryInsert(
      `INSERT INTO integration_core.secret_change_request (id, organisation_id, connection_id, name, requested_by_person_id, approver_person_id, status, request_hash, expires_at) VALUES ($1,$2,$3,'qa05in',$4,$5,'approved',decode(repeat('ab',32),'hex'),now()+interval '1 hour')`,
      [uuid(), ORG, id, uuid(), uuid()],
    );
    assert.notEqual(
      approved,
      'allowed',
      `the api role cannot insert an already-approved request (got ${approved})`,
    );
    // The worker-side evidence check (O2-3/O2-4) needs two WebAuthn assertions through the worker verifier: not exercised here.
  });

  test(
    'TC-AD-15 disabling an integration makes dependent features fail visibly [sandboxes]',
    {
      skip: 'BLOCKED: needs a working e-mail integration and booking confirmation against a sandbox (C-10)',
    },
    () => {},
  );
});
