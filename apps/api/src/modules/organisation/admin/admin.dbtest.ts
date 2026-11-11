/* eslint-disable boundaries/module-boundaries -- test support: drives the admin routes through the real identity guard, sessions and elevation kit (BE-04/BE-05), the way the composition root mounts them; production files of this module import only audit */
// Real-database tests for BE-23 (organisation admin routes): HTTP through the real guard (admin realm, permission, live
// elevation grant), the real services, FORCE-RLS tables and the audit store on PostgreSQL 17 with the migrations of the real pipeline.
// TC-AD-01..03, 06..10 (the data-level parts of 04/05 belong to the notifications and identity tickets) and INT03-F17 1(c).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/organisation/admin/admin.dbtest.js
// Missing configuration FAILS; nothing skips. All data is synthetic.
import { FIXTURE_STATES } from '../../organisation/fixture-states.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ORG, adminWith, api, orgAdminSetup, seedReference } from './testkit.js';
import type { Admin, OrgKit, Resp } from './testkit.js';

let k: OrgKit;
let adm: Admin;
before(async () => {
  k = await orgAdminSetup('orgadmin');
  await seedReference(k);
  adm = await adminWith(k, ['org_admin']);
});
after(async () => {
  await k.close();
});

const j = (r: Resp): Record<string, unknown> => r.json();
const items = (r: Resp): Record<string, unknown>[] => j(r)['items'] as Record<string, unknown>[];
const errors = (r: Resp): { path: string; code: string }[] =>
  j(r)['errors'] as { path: string; code: string }[];

async function audit(
  resourceType: string,
  where = 'true',
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return k.q(
    `SELECT action, outcome, denial_reason, resource_type, resource_id, location_id, actor_principal_id, realm, audience, change
       FROM audit.event WHERE resource_type = $1 AND ${where} ORDER BY occurred_at, event_id`,
    [resourceType, ...params],
  );
}

let locSeq = 0;
async function newLocation(name = `Clinic ${++locSeq}`): Promise<string> {
  const r = await api(k, adm, 'POST', '/locations', {
    name,
    kind: 'clinic',
    timeZone: 'America/New_York',
    stateCode: FIXTURE_STATES.licensed,
    address: { line1: '1 Main St', city: 'Albany' },
  });
  assert.equal(r.status, 200, r.body);
  return String(j(r)['id']);
}

describe('TC-AD-01: clinics, rooms, hours, holidays are saved, audited with before and after, and read back', () => {
  test('location create and patch (If-Match) with before/after in the audit store', async () => {
    const created = await api(k, adm, 'POST', '/locations', {
      name: 'Synthetic North',
      kind: 'clinic',
      timeZone: 'America/Chicago',
      stateCode: FIXTURE_STATES.closed,
      phone: '555-0100',
    });
    assert.equal(created.status, 200, created.body);
    const loc = j(created);
    assert.equal(loc['active'], true);
    assert.equal(created.headers['etag'], `W/"${String(loc['rowVersion'])}"`);
    assert.equal(created.headers['cache-control'], 'no-store');

    const missing = await api(k, adm, 'PATCH', '/locations', { id: loc['id'], phone: '555-0101' });
    assert.equal(missing.status, 428);
    assert.equal(j(missing)['code'], 'kernel.precondition_required');
    const stale = await api(
      k,
      adm,
      'PATCH',
      '/locations',
      { id: loc['id'], phone: '555-0101' },
      { 'if-match': 'W/"99"' },
    );
    assert.equal(stale.status, 412);
    assert.equal(j(stale)['code'], 'kernel.precondition_failed');

    const patched = await api(
      k,
      adm,
      'PATCH',
      '/locations',
      { id: loc['id'], phone: '555-0101', active: false },
      { 'if-match': String(created.headers['etag']) },
    );
    assert.equal(patched.status, 200, patched.body);
    assert.equal(j(patched)['rowVersion'], Number(loc['rowVersion']) + 1);

    const rows = await audit('organisation.location', 'resource_id = $2', [loc['id']]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!['action'], 'config_change');
    assert.equal(
      rows[0]!['actor_principal_id'],
      adm.principalId,
      'who comes from the session, not the body',
    );
    assert.equal(rows[0]!['realm'], 'admin_pool');
    assert.equal(rows[0]!['location_id'], loc['id']);
    assert.equal((rows[0]!['change'] as { before: unknown }).before, null);
    assert.deepEqual(rows[1]!['change'], {
      before: { phone: '555-0100', active: true },
      after: { phone: '555-0101', active: false },
    });

    const list = await api(k, adm, 'GET', '/locations?active=false');
    assert.equal(list.status, 200);
    assert.ok(items(list).some((x) => x['id'] === loc['id']));
    assert.equal(j(list)['nextCursor'], null);
  });

  test('rooms, opening hours (several intervals a day, no overlap) and holidays; an active clinic is in the patient directory', async () => {
    const loc = await newLocation('Directory Clinic');
    const room = await api(k, adm, 'POST', '/rooms', { locationId: loc, name: 'Room 1' });
    assert.equal(room.status, 200, room.body);
    const dup = await api(k, adm, 'POST', '/rooms', { locationId: loc, name: 'Room 1' });
    assert.equal(dup.status, 400);
    assert.equal(errors(dup)[0]!.code, 'kernel.duplicate');
    const noLoc = await api(k, adm, 'POST', '/rooms', {
      locationId: '00000000-0000-7000-8000-00000000dead',
      name: 'R',
    });
    assert.equal(noLoc.status, 400);
    assert.deepEqual(errors(noLoc), [{ path: '/locationId', code: 'kernel.unknown_reference' }]);

    const am = await api(k, adm, 'POST', '/opening-hours', {
      locationId: loc,
      weekday: 1,
      opens: '08:00',
      closes: '12:00',
    });
    assert.equal(am.status, 200, am.body);
    const pm = await api(k, adm, 'POST', '/opening-hours', {
      locationId: loc,
      weekday: 1,
      opens: '13:00',
      closes: '17:30',
    });
    assert.equal(pm.status, 200, pm.body);
    const overlap = await api(k, adm, 'POST', '/opening-hours', {
      locationId: loc,
      weekday: 1,
      opens: '11:00',
      closes: '14:00',
    });
    assert.equal(overlap.status, 400);
    assert.equal(errors(overlap)[0]!.code, 'kernel.overlap');
    const backwards = await api(k, adm, 'POST', '/opening-hours', {
      locationId: loc,
      weekday: 2,
      opens: '12:00',
      closes: '08:00',
    });
    assert.equal(backwards.status, 400);
    const move = await api(
      k,
      adm,
      'PATCH',
      '/opening-hours',
      { locationId: loc, weekday: 1, opens: '08:00', closes: '12:30' },
      { 'if-match': String(am.headers['etag']) },
    );
    assert.equal(move.status, 200, move.body);
    assert.equal(j(move)['closes'], '12:30');
    const intoPm = await api(
      k,
      adm,
      'PATCH',
      '/opening-hours',
      { locationId: loc, weekday: 1, opens: '08:00', closes: '13:30' },
      { 'if-match': String(move.headers['etag']) },
    );
    assert.equal(intoPm.status, 400, 'a moved closing time may not run into the next interval');
    const gone = await api(
      k,
      adm,
      'PATCH',
      '/opening-hours',
      { locationId: loc, weekday: 1, opens: '13:00', remove: true },
      { 'if-match': String(pm.headers['etag']) },
    );
    assert.equal(gone.status, 200, gone.body);
    const hours = await api(k, adm, 'GET', `/opening-hours?locationId=${loc}`);
    assert.equal(items(hours).length, 1);
    const hrAudit = await audit('organisation.opening_hours', 'location_id = $2', [loc]);
    assert.equal(hrAudit.length, 4, 'two creates, one move, one removal');

    const hol = await api(k, adm, 'POST', '/holidays', {
      locationId: null,
      date: '2027-12-25',
      name: 'Winter holiday',
    });
    assert.equal(hol.status, 200, hol.body);
    const holDup = await api(k, adm, 'POST', '/holidays', {
      locationId: null,
      date: '2027-12-25',
      name: 'Again',
    });
    assert.equal(holDup.status, 400);
    const badDate = await api(k, adm, 'POST', '/holidays', { date: '2027-02-31', name: 'Nope' });
    assert.equal(badDate.status, 400);
    const holGone = await api(
      k,
      adm,
      'PATCH',
      '/holidays',
      { id: j(hol)['id'], remove: true },
      { 'if-match': String(hol.headers['etag']) },
    );
    assert.equal(holGone.status, 200);
    assert.equal(items(await api(k, adm, 'GET', '/holidays')).length, 0);

    // The patient directory (the C0 view of 22.5.1) shows the active clinic and not a deactivated one.
    const seen = await k.db.withScope({ audience: 'public', orgId: ORG }, (tx) =>
      k.organisation.directoryLocations(tx),
    );
    assert.ok(seen.some((l) => l.id === loc));
    const off = await api(
      k,
      adm,
      'PATCH',
      '/locations',
      { id: loc, active: false },
      {
        'if-match': String(
          (await api(k, adm, 'GET', '/locations')).body &&
            items(await api(k, adm, 'GET', '/locations')).find((x) => x['id'] === loc)![
              'rowVersion'
            ],
        ),
      },
    );
    assert.equal(off.status, 200, off.body);
    const seen2 = await k.db.withScope({ audience: 'public', orgId: ORG }, (tx) =>
      k.organisation.directoryLocations(tx),
    );
    assert.ok(!seen2.some((l) => l.id === loc));
  });
});

describe('TC-AD-02 / 03: services (neutral name) and booking policy (block-only, fee stored not charged)', () => {
  test('a condition-revealing service needs a different patient-visible name: 422 on create and on patch, DB check behind it', async () => {
    const bad = await api(k, adm, 'POST', '/services', {
      internalName: 'Synthetic HIV clinic',
      durationMin: 30,
      mode: 'either',
      conditionRevealing: true,
    });
    assert.equal(bad.status, 422);
    assert.equal(j(bad)['code'], 'organisation.neutral_name_required');
    const same = await api(k, adm, 'POST', '/services', {
      internalName: 'Synthetic HIV clinic',
      patientDisplayName: ' synthetic hiv CLINIC ',
      durationMin: 30,
      mode: 'either',
      conditionRevealing: true,
    });
    assert.equal(same.status, 422);
    assert.equal(
      (await k.q(`SELECT 1 FROM organisation.service WHERE internal_name = 'Synthetic HIV clinic'`))
        .length,
      0,
    );

    const ok = await api(k, adm, 'POST', '/services', {
      internalName: 'Synthetic HIV clinic',
      patientDisplayName: 'Specialist consultation',
      durationMin: 30,
      mode: 'either',
      conditionRevealing: true,
      priceCents: 12000,
      currency: 'USD',
    });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(j(ok)['priceCents'], 12000);
    const patch = await api(
      k,
      adm,
      'PATCH',
      '/services',
      { id: j(ok)['id'], patientDisplayName: 'Synthetic HIV clinic' },
      { 'if-match': String(ok.headers['etag']) },
    );
    assert.equal(patch.status, 422);
    assert.equal(j(patch)['code'], 'organisation.neutral_name_required');

    const plain = await api(k, adm, 'POST', '/services', {
      internalName: 'General visit',
      durationMin: 20,
      mode: 'in_person',
    });
    assert.equal(plain.status, 200, plain.body);
    assert.equal(
      j(plain)['patientDisplayName'],
      'General visit',
      'defaults to the internal name when nothing is revealed',
    );
    assert.equal(j(plain)['bufferMin'], 0);
    const noCurrency = await api(k, adm, 'POST', '/services', {
      internalName: 'Priced',
      durationMin: 20,
      mode: 'video',
      priceCents: 100,
    });
    assert.equal(noCurrency.status, 400);
  });

  test('booking policy defaults to block and takes cut-off and cap from the settings; fee is stored only', async () => {
    const svc = String(
      j(
        await api(k, adm, 'POST', '/services', {
          internalName: 'Policy service',
          durationMin: 20,
          mode: 'either',
        }),
      )['id'],
    );
    const p = await api(k, adm, 'POST', '/booking-policies', { serviceId: svc });
    assert.equal(p.status, 200, p.body);
    assert.equal(j(p)['lateChange'], 'block');
    assert.equal(j(p)['cutoffHours'], 24);
    assert.equal(j(p)['maxFuturePerPatient'], 3);
    const dup = await api(k, adm, 'POST', '/booking-policies', { serviceId: svc });
    assert.equal(dup.status, 400);
    assert.equal(errors(dup)[0]!.code, 'kernel.duplicate');

    const loc = await newLocation();
    const fee = await api(k, adm, 'POST', '/booking-policies', {
      serviceId: svc,
      locationId: loc,
      lateChange: 'fee',
      maxFuturePerPatient: 5,
    });
    assert.equal(fee.status, 200, fee.body);
    assert.equal(j(fee)['lateChange'], 'fee');
    const effective = await k.db.withScope(
      { audience: 'staff', realm: 'admin_pool', orgId: ORG, principalId: adm.principalId },
      (tx) => k.organisation.bookingPolicy(tx, svc, loc),
    );
    assert.equal(effective.lateChange, 'fee');
    assert.equal(effective.maxFuturePerPatient, 5);
    const cap = await api(
      k,
      adm,
      'PATCH',
      '/booking-policies',
      { id: j(p)['id'], maxFuturePerPatient: 4 },
      { 'if-match': String(p.headers['etag']) },
    );
    assert.equal(cap.status, 200, cap.body);
    const immut = await api(
      k,
      adm,
      'PATCH',
      '/booking-policies',
      { id: j(p)['id'], serviceId: svc },
      { 'if-match': String(cap.headers['etag']) },
    );
    assert.equal(immut.status, 400);
    assert.deepEqual(errors(immut), [{ path: '/serviceId', code: 'kernel.immutable' }]);
    // HEAAA-632 T6, R5: the cap is the most patients in one slot; scheduling.occupy accepts 100 at most, so the API does too.
    const over = await api(
      k,
      adm,
      'PATCH',
      '/booking-policies',
      { id: j(p)['id'], overbookCapPerSession: 101 },
      { 'if-match': String(cap.headers['etag']) },
    );
    assert.equal(over.status, 400, over.body);
    assert.equal(errors(over)[0]!.path, '/overbookCapPerSession');
    const max = await api(
      k,
      adm,
      'PATCH',
      '/booking-policies',
      { id: j(p)['id'], overbookCapPerSession: 100 },
      { 'if-match': String(cap.headers['etag']) },
    );
    assert.equal(max.status, 200, max.body);
    assert.equal(j(max)['overbookCapPerSession'], 100);
  });
});

describe('TC-AD-06 / 10: realm, permission and elevation are enforced by the server', () => {
  const READS = [
    'locations',
    'rooms',
    'opening-hours',
    'holidays',
    'services',
    'booking-policies',
    'feature-flags',
    'banners',
    'settings',
    'operating-states',
  ];
  test('no session is 401; an admin without the permission is 403; an unelevated admin is refused with identity.elevation_required and nothing is written', async () => {
    for (const p of READS) assert.equal((await api(k, undefined, 'GET', `/${p}`)).status, 401, p);

    const bare = await adminWith(k, [], { elevated: true }); // admin_pool principal with no role: no permission at all
    for (const p of [...READS, 'consent-templates', 'questionnaire-templates']) {
      const r = await api(k, bare, 'GET', `/${p}`);
      assert.equal(r.status, 403, `${p}: ${r.body}`);
      assert.equal(j(r)['code'], 'auth.forbidden');
    }
    const w = await api(k, bare, 'PUT', '/feature-flags', { key: 'self_check_in', enabled: true });
    assert.equal(w.status, 403);

    const plain = await adminWith(k, ['org_admin'], { elevated: false });
    const loc = await newLocation();
    const flag = await api(k, plain, 'PUT', '/feature-flags', {
      key: 'self_check_in',
      locationId: loc,
      enabled: true,
    });
    assert.equal(flag.status, 403);
    assert.equal(j(flag)['code'], 'identity.elevation_required');
    assert.equal(
      (await k.q(`SELECT 1 FROM organisation.feature_flag WHERE key = 'self_check_in'`)).length,
      0,
    );
    for (const [m, p, b] of [
      ['POST', '/locations', { name: 'X', kind: 'clinic', timeZone: 'UTC', stateCode: FIXTURE_STATES.licensed }],
      ['POST', '/services', { internalName: 'X', durationMin: 20, mode: 'video' }],
      [
        'PUT',
        '/banners',
        {
          surface: 'site',
          message: 'x',
          startsAt: '2030-01-01T00:00:00Z',
          endsAt: '2030-01-02T00:00:00Z',
        },
      ],
      ['PUT', '/settings', { key: 'hold_minutes', value: 12 }],
      [
        'PUT',
        '/operating-states',
        { jurisdictionCode: FIXTURE_STATES.licensed, effectiveFrom: '2030-01-01', telehealthAllowed: true },
      ],
      ['GET', '/settings', undefined],
    ] as const) {
      const r = await api(k, plain, m, p, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(j(r)['code'], 'identity.elevation_required');
    }
    // Templates too: the contract lists their reads and drafts as not elevated, but the permission needs elevation (catalogue).
    const tpl = await api(k, plain, 'GET', '/consent-templates');
    assert.equal(tpl.status, 403);
    assert.equal(j(tpl)['code'], 'identity.elevation_required');
  });

  test('a clinical-staff realm session cannot reach the admin routes', async () => {
    // The admin host routes accept only the admin realm: a google-realm session is refused by the realm check.
    const { seedPrincipal, seedSession, assignRole } = await import('../../identity/testkit.js');
    const s = await seedPrincipal(k, 'google', { email: 'fd@example.com', name: 'Front desk' });
    await assignRole(k, s.principalId, 'front_desk', await newLocation('Front desk clinic'));
    const sess = await seedSession(k, s, 'google');
    const { call } = await import('./testkit.js');
    const r = await call(k.adminBase, 'GET', '/api/v1/admin/locations', { cookie: sess.cookie });
    assert.ok([401, 403].includes(r.status), String(r.status));
    assert.equal(
      r.status === 403 ? j(r)['code'] : 'auth.unauthenticated',
      r.status === 403 ? 'auth.forbidden' : 'auth.unauthenticated',
    );
  });
});

describe('TC-AD-08 / 10 and INT03-F17 1(c): feature flags', () => {
  test('a flag turned on for one location is on there only; every change is audited with before and after', async () => {
    const a = await newLocation('Flag A');
    const b = await newLocation('Flag B');
    const on = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'self_check_in',
      locationId: a,
      enabled: true,
    });
    assert.equal(on.status, 200, on.body);
    const list = items(await api(k, adm, 'GET', '/feature-flags')).filter(
      (x) => x['key'] === 'self_check_in',
    );
    assert.deepEqual(
      list.map((x) => [x['locationId'], x['enabled']]),
      [[a, true]],
    );
    assert.ok(!list.some((x) => x['locationId'] === b));
    const off = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'self_check_in',
      locationId: a,
      enabled: false,
    });
    assert.equal(off.status, 200);
    assert.equal(j(off)['id'], j(on)['id'], 'the same row is updated');
    await api(k, adm, 'PUT', '/feature-flags', {
      key: 'self_check_in',
      locationId: a,
      enabled: false,
    }); // no-op: no audit row
    const rows = await audit('organisation.feature_flag', "change->>'key' = 'self_check_in'");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1]!['change'], {
      key: 'self_check_in',
      before: { enabled: true },
      after: { enabled: false },
    });
    assert.equal(rows[1]!['location_id'], a);

    const bad = await api(k, adm, 'PUT', '/feature-flags', { key: 'Bad Key', enabled: true });
    assert.equal(bad.status, 400);
    const both = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'self_check_in',
      enabled: true,
      remove: true,
    });
    assert.equal(both.status, 400);
    const unknownLoc = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'self_check_in',
      locationId: '00000000-0000-7000-8000-00000000dead',
      enabled: true,
    });
    assert.equal(unknownLoc.status, 400);
    const gone = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'self_check_in',
      locationId: a,
      remove: true,
    });
    assert.equal(gone.status, 200);
    assert.equal(
      (
        await api(k, adm, 'PUT', '/feature-flags', {
          key: 'self_check_in',
          locationId: a,
          remove: true,
        })
      ).status,
      404,
    );
  });

  test('patient_messaging cannot be turned on, organisation-wide or per location: 400, a denial audit row, no flag row; off and removal stay allowed', async () => {
    const loc = await newLocation('Messaging');
    const count = async (): Promise<number> =>
      (await k.q(`SELECT 1 FROM organisation.feature_flag WHERE key = 'patient_messaging'`)).length;
    assert.equal(await count(), 0);

    const org = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'patient_messaging',
      enabled: true,
    });
    assert.equal(org.status, 400, org.body);
    assert.equal(j(org)['code'], 'kernel.validation_failed');
    assert.deepEqual(errors(org), [{ path: '/enabled', code: 'kernel.invalid_value' }]);
    const per = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'patient_messaging',
      locationId: loc,
      enabled: true,
    });
    assert.equal(per.status, 400, per.body);
    assert.equal(await count(), 0, 'no organisation.feature_flag row was written');

    const denied = await audit(
      'organisation.feature_flag',
      "action = 'denied' AND change->>'key' = 'patient_messaging'",
    );
    assert.equal(denied.length, 2, 'both refused attempts are audited');
    assert.equal(denied[0]!['outcome'], 'denied');
    assert.equal(denied[0]!['actor_principal_id'], adm.principalId, 'who');
    assert.deepEqual(denied[0]!['change'], {
      key: 'patient_messaging',
      rule: 'patient_messaging_off_in_r1',
      before: null,
      attempted: { enabled: true },
    });
    assert.equal(denied[1]!['location_id'], loc);

    // Off is allowed, and a later attempt to turn it on records the current value as "before".
    const off = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'patient_messaging',
      enabled: false,
    });
    assert.equal(off.status, 200, off.body);
    assert.equal(await count(), 1);
    const again = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'patient_messaging',
      enabled: true,
    });
    assert.equal(again.status, 400);
    assert.equal(await count(), 1);
    assert.equal(
      (
        await k.q(`SELECT enabled FROM organisation.feature_flag WHERE key = 'patient_messaging'`)
      )[0]!['enabled'],
      false,
      'the stored value is untouched',
    );
    const denied2 = await audit(
      'organisation.feature_flag',
      "action = 'denied' AND change->>'key' = 'patient_messaging'",
    );
    assert.equal(denied2.length, 3);
    assert.deepEqual((denied2[2]!['change'] as { before: unknown }).before, { enabled: false });
    const accepted = await audit(
      'organisation.feature_flag',
      "action = 'config_change' AND change->>'key' = 'patient_messaging'",
    );
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0]!['change'], {
      key: 'patient_messaging',
      before: null,
      after: { enabled: false },
    });

    const removed = await api(k, adm, 'PUT', '/feature-flags', {
      key: 'patient_messaging',
      remove: true,
    });
    assert.equal(removed.status, 200);
    assert.equal(await count(), 0);
  });

  test('concurrent writes of one flag leave exactly one row and a consistent audit trail', async () => {
    const loc = await newLocation('Race');
    const rs = await Promise.all(
      [true, false, true, false, true, false].map((enabled) =>
        api(k, adm, 'PUT', '/feature-flags', { key: 'race_flag', locationId: loc, enabled }),
      ),
    );
    assert.deepEqual(
      rs.map((r) => r.status),
      [200, 200, 200, 200, 200, 200],
    );
    assert.equal(
      (await k.q(`SELECT 1 FROM organisation.feature_flag WHERE key = 'race_flag'`)).length,
      1,
    );
    const trail = await audit('organisation.feature_flag', "change->>'key' = 'race_flag'");
    // audit.event.occurred_at is the transaction START time (DEFAULT now()), taken before the per-flag advisory lock is won, so
    // (occurred_at, event_id) order can differ from the order the writes were serialised in (INT04-F34). The serialised order is
    // therefore not read from timestamps: the audited changes must form one chain null -> ... -> final that uses every row once,
    // each "before" being the previous "after".
    type Edge = { from: boolean | null; to: boolean };
    const edges: Edge[] = trail.map((t) => {
      const c = t['change'] as { before: { enabled: boolean } | null; after: { enabled: boolean } };
      return { from: c.before === null ? null : c.before.enabled, to: c.after.enabled };
    });
    const final = (
      await k.q(`SELECT enabled FROM organisation.feature_flag WHERE key = 'race_flag'`)
    )[0]!['enabled'] as boolean;
    const chains = (at: boolean | null, left: Edge[]): boolean =>
      left.length === 0
        ? at === final
        : left.some(
            (e, i) => e.from === at && chains(e.to, [...left.slice(0, i), ...left.slice(i + 1)]),
          );
    assert.ok(
      chains(null, edges),
      'each audited "before" is the previous audited "after", ending at the stored value',
    );
  });
});

describe('TC-AD-09: maintenance banner', () => {
  test('post, change and remove a banner; no-PHI guard; time range; audited', async () => {
    const posted = await api(k, adm, 'PUT', '/banners', {
      surface: 'site',
      message: 'Scheduled maintenance tonight 22:00-23:00. Booking is unavailable.',
      startsAt: '2030-01-01T22:00:00Z',
      endsAt: '2030-01-01T23:00:00Z',
    });
    assert.equal(posted.status, 200, posted.body);
    const id = String(j(posted)['id']);
    assert.equal(j(posted)['startsAt'], '2030-01-01T22:00:00.000Z');
    const bad = await api(k, adm, 'PUT', '/banners', {
      surface: 'site',
      message: 'Call jane.doe@example.com',
      startsAt: '2030-01-01T22:00:00Z',
      endsAt: '2030-01-01T23:00:00Z',
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(errors(bad), [{ path: '/message', code: 'kernel.invalid_format' }]);
    const range = await api(k, adm, 'PUT', '/banners', { id, endsAt: '2030-01-01T21:00:00Z' });
    assert.equal(range.status, 400);
    assert.deepEqual(errors(range), [{ path: '/endsAt', code: 'kernel.invalid_range' }]);
    const changed = await api(k, adm, 'PUT', '/banners', { id, endsAt: '2030-01-02T01:00:00Z' });
    assert.equal(changed.status, 200, changed.body);
    assert.equal(
      items(await api(k, adm, 'GET', '/banners?surface=site')).filter((x) => x['id'] === id).length,
      1,
    );
    const removed = await api(k, adm, 'PUT', '/banners', { id, remove: true });
    assert.equal(removed.status, 200, removed.body);
    assert.equal(
      items(await api(k, adm, 'GET', '/banners')).filter((x) => x['id'] === id).length,
      0,
    );
    assert.equal((await api(k, adm, 'PUT', '/banners', { id, remove: true })).status, 404);
    const rows = await audit('organisation.banner', 'resource_id = $2', [id]);
    assert.equal(rows.length, 3, 'post, change, removal');
    assert.equal((rows[2]!['change'] as { after: unknown }).after, null);
  });
});

describe('settings and operating states: schema-validated, audited, reference data protected', () => {
  test('PUT /settings validates the value against the key schema and records before and after', async () => {
    const list = await api(k, adm, 'GET', '/settings?limit=100');
    assert.equal(list.status, 200);
    assert.ok(items(list).some((x) => x['key'] === 'hold_minutes' && x['value'] === 10));
    const ok = await api(k, adm, 'PUT', '/settings', { key: 'hold_minutes', value: 12 });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(j(ok)['value'], 12);
    assert.equal(
      await k.db.withScope(
        { audience: 'staff', realm: 'admin_pool', orgId: ORG, principalId: adm.principalId },
        (tx) => k.organisation.setting(tx, 'hold_minutes'),
      ),
      12,
    );
    for (const [key, value] of [
      ['hold_minutes', 0],
      ['hold_minutes', '12'],
      ['no_show_grace_min', { default: 1 }],
      ['telehealth_licensing_mode', 'maybe'],
    ] as const) {
      const bad = await api(k, adm, 'PUT', '/settings', { key, value });
      assert.equal(bad.status, 400, `${key}=${JSON.stringify(value)}`);
      assert.deepEqual(errors(bad), [{ path: '/value', code: 'kernel.invalid_format' }]);
    }
    assert.equal(
      (await api(k, adm, 'PUT', '/settings', { key: 'not_a_setting', value: 1 })).status,
      400,
    );
    const loc = await newLocation('Setting loc');
    const perLoc = await api(k, adm, 'PUT', '/settings', {
      key: 'hold_minutes',
      value: 20,
      locationId: loc,
    });
    assert.equal(perLoc.status, 200, perLoc.body);
    const rows = await audit('kernel.setting', "change->>'key' = 'hold_minutes'");
    assert.deepEqual(rows[0]!['change'], {
      key: 'hold_minutes',
      before: { value: 10 },
      after: { value: 12 },
    });
    assert.deepEqual(rows[1]!['change'], {
      key: 'hold_minutes',
      before: null,
      after: { value: 20 },
    });
    assert.equal(rows[1]!['location_id'], loc);
  });

  test('a setting readable before sign-in is reference data: refused with 403 and audited as a denial; its stored value is untouched', async () => {
    const before = (
      await k.q(`SELECT value FROM kernel.setting WHERE key = 'staff_idle_minutes'`)
    )[0]!['value'];
    const r = await api(k, adm, 'PUT', '/settings', { key: 'staff_idle_minutes', value: 60 });
    assert.equal(r.status, 403);
    assert.equal(j(r)['code'], 'auth.forbidden');
    assert.equal(
      (await k.q(`SELECT value FROM kernel.setting WHERE key = 'staff_idle_minutes'`))[0]!['value'],
      before,
    );
    const d = await audit(
      'kernel.setting',
      "action = 'denied' AND change->>'key' = 'staff_idle_minutes'",
    );
    assert.equal(d.length, 1);
  });

  test('operating states upsert by (state, effective date), feed the licensing check and are audited', async () => {
    const put = await api(k, adm, 'PUT', '/operating-states', {
      jurisdictionCode: FIXTURE_STATES.licensed,
      effectiveFrom: '2020-01-01',
      telehealthAllowed: true,
    });
    assert.equal(put.status, 200, put.body);
    const put2 = await api(k, adm, 'PUT', '/operating-states', {
      jurisdictionCode: FIXTURE_STATES.licensed,
      effectiveFrom: '2020-01-01',
      telehealthAllowed: false,
    });
    assert.equal(put2.status, 200);
    const list = items(await api(k, adm, 'GET', '/operating-states')).filter(
      (x) => x['jurisdictionCode'] === FIXTURE_STATES.licensed,
    );
    assert.equal(list.length, 1);
    assert.equal(list[0]!['telehealthAllowed'], false);
    const scope = {
      audience: 'staff',
      realm: 'admin_pool',
      orgId: ORG,
      principalId: adm.principalId,
    } as const;
    assert.equal(
      await k.db.withScope(scope, (tx) => k.organisation.licensingCheck(tx, [FIXTURE_STATES.licensed], FIXTURE_STATES.licensed)),
      'refused_not_operating',
    );
    await api(k, adm, 'PUT', '/operating-states', {
      jurisdictionCode: FIXTURE_STATES.licensed,
      effectiveFrom: '2021-01-01',
      telehealthAllowed: true,
    });
    assert.equal(
      await k.db.withScope(scope, (tx) => k.organisation.licensingCheck(tx, [FIXTURE_STATES.licensed], FIXTURE_STATES.licensed)),
      'allowed',
    );
    const unknown = await api(k, adm, 'PUT', '/operating-states', {
      jurisdictionCode: 'ZZ',
      effectiveFrom: '2021-01-01',
      telehealthAllowed: true,
    });
    assert.equal(unknown.status, 400);
    assert.deepEqual(errors(unknown), [
      { path: '/jurisdictionCode', code: 'kernel.unknown_reference' },
    ]);
    const rows = await audit('organisation.operating_state');
    assert.equal(rows.length, 3);
    assert.deepEqual((rows[1]!['change'] as { before: unknown }).before, {
      telehealthAllowed: true,
    });
  });
});

describe('consent and questionnaire templates: drafts, publish, red-flag sign-off', () => {
  test('drafts get the next version; publish is elevated, once, and a published version is immutable', async () => {
    const text = {
      title: 'Telehealth consent',
      bodyText: 'I agree to a video visit.\nSecond line.',
    };
    const v1 = await api(k, adm, 'POST', '/consent-templates', {
      key: 'telehealth',
      language: 'en',
      ...text,
    });
    assert.equal(v1.status, 200, v1.body);
    assert.equal(j(v1)['version'], 1);
    assert.equal(j(v1)['status'], 'draft');
    assert.equal(j(v1)['title'], text.title);
    assert.equal(j(v1)['bodyText'], text.bodyText);
    assert.equal('bodyDocumentId' in j(v1), false);
    const v2 = await api(k, adm, 'POST', '/consent-templates', {
      key: 'telehealth',
      language: 'en',
      ...text,
    });
    assert.equal(j(v2)['version'], 2);
    const es = await api(k, adm, 'POST', '/consent-templates', {
      key: 'telehealth',
      language: 'es',
      ...text,
    });
    assert.equal(j(es)['version'], 1, 'versions count per language');
    const pub = await api(k, adm, 'POST', `/consent-templates/${String(j(v1)['id'])}/publish`, {});
    assert.equal(pub.status, 200, pub.body);
    assert.equal(j(pub)['status'], 'published');
    assert.equal(j(pub)['bodyText'], text.bodyText);
    assert.equal(
      (await api(k, adm, 'POST', `/consent-templates/${String(j(v1)['id'])}/publish`, {})).status,
      412,
    );
    assert.equal(
      (await api(k, adm, 'POST', '/consent-templates/not-a-uuid/publish', {})).status,
      404,
    );
    assert.equal(
      (
        await api(
          k,
          adm,
          'POST',
          '/consent-templates/00000000-0000-7000-8000-00000000dead/publish',
          {},
        )
      ).status,
      404,
    );
    const unelevated = await adminWith(k, ['org_admin'], { elevated: false });
    const refused = await api(
      k,
      unelevated,
      'POST',
      `/consent-templates/${String(j(v2)['id'])}/publish`,
      {},
    );
    assert.equal(refused.status, 403);
    assert.equal(j(refused)['code'], 'identity.elevation_required');
    assert.equal(
      (
        await k.q(`SELECT status FROM organisation.consent_template WHERE id = $1`, [j(v2)['id']])
      )[0]!['status'],
      'draft',
    );
    const listed = await api(k, adm, 'GET', '/consent-templates?key=telehealth&status=published');
    assert.equal(listed.status, 200);
    assert.equal(items(listed).length, 1);
    // Concurrent drafts get distinct versions.
    const many = await Promise.all(
      [1, 2, 3, 4].map(() =>
        api(k, adm, 'POST', '/consent-templates', {
          key: 'concurrent',
          language: 'en',
          ...text,
        }),
      ),
    );
    assert.deepEqual(many.map((r) => j(r)['version']).sort(), [1, 2, 3, 4]);
  });

  test('consent text: required, closed body, code-point limits, legacy textless draft cannot publish', async () => {
    const post = (b: Record<string, unknown>) =>
      api(k, adm, 'POST', '/consent-templates', { key: 'texty', language: 'en', ...b });
    const ok = { title: 'T', bodyText: 'B' };
    const noTitle = await post({ bodyText: 'B' });
    assert.equal(noTitle.status, 400);
    assert.deepEqual(errors(noTitle), [{ path: '/title', code: 'kernel.required' }]);
    const noBody = await post({ title: 'T' });
    assert.deepEqual(errors(noBody), [{ path: '/bodyText', code: 'kernel.required' }]);
    const doc = await post({ ...ok, bodyDocumentId: '00000000-0000-7000-8000-00000000d0c1' });
    assert.equal(doc.status, 400);
    assert.deepEqual(errors(doc), [{ path: '/bodyDocumentId', code: 'kernel.unknown_field' }]);
    for (const bad of [
      { title: 'x'.repeat(201) },
      { title: '   ' },
      { title: 5 },
      { bodyText: 'y'.repeat(20_001) },
      { bodyText: ' \n ' },
    ]) {
      const r = await post({ ...ok, ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40));
      assert.equal(errors(r)[0]!.code, 'kernel.invalid_format');
    }
    const astral = await post({ ...ok, title: '\u{1F600}'.repeat(200) });
    assert.equal(astral.status, 200, astral.body);
    const max = await post({ ...ok, bodyText: 'y'.repeat(20_000) });
    assert.equal(max.status, 200, max.body);
    const trimmed = await post({ ...ok, title: '  padded  ' });
    assert.equal(j(trimmed)['title'], 'padded');
    // A draft from before migration 2003 has no text: publish refuses it and names the fields; the row stays a draft.
    const legacy = '00000000-0000-7000-8000-00000000dd01';
    await k.q(
      `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, status)
       VALUES ($1, $2, 'legacy', 1, 'en', 'draft')`,
      [legacy, ORG],
    );
    const refused = await api(k, adm, 'POST', `/consent-templates/${legacy}/publish`, {});
    assert.equal(refused.status, 400, refused.body);
    assert.deepEqual(errors(refused), [
      { path: '/title', code: 'kernel.required' },
      { path: '/bodyText', code: 'kernel.required' },
    ]);
    assert.equal(
      (await k.q(`SELECT status FROM organisation.consent_template WHERE id = $1`, [legacy]))[0]![
        'status'
      ],
      'draft',
    );
  });

  test('a questionnaire with red-flag rules needs the safety reviewer note to publish and records it', async () => {
    const rules = {
      fields: [],
      red_flag_rules: [{ id: 'chest-pain', when: { field: 'q1', equals: 'yes' } }],
    };
    const d = await api(k, adm, 'POST', '/questionnaire-templates', {
      key: 'intake',
      schema: rules,
    });
    assert.equal(d.status, 200, d.body);
    const id = String(j(d)['id']);
    const noNote = await api(k, adm, 'POST', `/questionnaire-templates/${id}/publish`, {});
    assert.equal(noNote.status, 400);
    assert.deepEqual(errors(noNote), [{ path: '/approvedByNote', code: 'kernel.required' }]);
    const short = await api(k, adm, 'POST', `/questionnaire-templates/${id}/publish`, {
      approvedByNote: 'ok',
    });
    assert.equal(short.status, 400);
    const pub = await api(k, adm, 'POST', `/questionnaire-templates/${id}/publish`, {
      approvedByNote: 'Reviewed by clinical safety lead, D-12a',
    });
    assert.equal(pub.status, 200, pub.body);
    assert.equal(j(pub)['status'], 'published');
    assert.equal(j(pub)['approvedByNote'], 'Reviewed by clinical safety lead, D-12a');
    const a = await audit(
      'organisation.questionnaire_template',
      "action = 'config_change' AND change ? 'redFlagRules' AND resource_id = $2",
      [id],
    );
    assert.equal(a.length, 1);
    assert.equal((a[0]!['change'] as { redFlagRules: number }).redFlagRules, 1);
    const plain = await api(k, adm, 'POST', '/questionnaire-templates', {
      key: 'plain',
      schema: { fields: [] },
    });
    const ok = await api(
      k,
      adm,
      'POST',
      `/questionnaire-templates/${String(j(plain)['id'])}/publish`,
      {},
    );
    assert.equal(ok.status, 200, 'no rules, no note needed');
    const badRules = await api(k, adm, 'POST', '/questionnaire-templates', {
      key: 'bad',
      schema: { red_flag_rules: 'x' },
    });
    assert.equal(badRules.status, 400);
    const edit = await k.sa
      .query(`UPDATE organisation.questionnaire_template SET schema = '{}'::jsonb WHERE id = $1`, [
        id,
      ])
      .then(
        () => 'edited',
        (e: { code?: string }) => e.code,
      );
    assert.equal(edit, '42501', 'a published version is immutable in the database');
  });
});

describe('request hygiene, secrets and integrity', () => {
  test('strict bodies: unknown fields, wrong types and bad cursors are 400 with paths only; no value is echoed', async () => {
    const r = await api(k, adm, 'POST', '/locations', {
      name: 'Zed',
      kind: 'clinic',
      timeZone: 'Mars/Base',
      stateCode: FIXTURE_STATES.licensed,
      secretNote: 'x',
      extra: 1,
    });
    assert.equal(r.status, 400);
    const e = errors(r);
    assert.ok(e.some((x) => x.path === '/timeZone'));
    assert.ok(e.some((x) => x.path === '/secretNote' && x.code === 'kernel.unknown_field'));
    assert.ok(!r.body.includes('Mars'), 'the offending value is never echoed');
    assert.equal((await api(k, adm, 'POST', '/locations', ['x'])).status, 400);
    assert.equal((await api(k, adm, 'GET', '/locations?limit=0')).status, 400);
    assert.equal((await api(k, adm, 'GET', '/locations?cursor=AAAA')).status, 400);
    assert.equal((await api(k, adm, 'GET', '/rooms?locationId=nope')).status, 400);
    assert.equal(
      (await api(k, adm, 'PATCH', '/locations', { id: 'x', name: 'a' }, { 'if-match': 'W/"1"' }))
        .status,
      400,
    );
    assert.equal(
      (
        await api(
          k,
          adm,
          'PATCH',
          '/locations',
          { id: '00000000-0000-7000-8000-00000000dead', name: 'a' },
          { 'if-match': 'W/"1"' },
        )
      ).status,
      404,
    );
  });

  test('paging walks the whole list with no repeat', async () => {
    for (let i = 0; i < 4; i++) await newLocation(`Page ${i}`);
    const seen: string[] = [];
    let cursor = '';
    for (let guard = 0; guard < 50; guard++) {
      const r = await api(
        k,
        adm,
        'GET',
        `/locations?limit=3${cursor === '' ? '' : `&cursor=${cursor}`}`,
      );
      assert.equal(r.status, 200, r.body);
      for (const x of items(r)) seen.push(String(x['id']));
      const next = j(r)['nextCursor'];
      if (next === null) break;
      cursor = String(next);
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(
      seen.length,
      Number((await k.q(`SELECT count(*)::int AS n FROM organisation.location`))[0]!['n']),
    );
  });

  test('responses and audit rows never carry secret-looking keys', async () => {
    const secretKey = /(secret|password|passphrase|token|private_?key|api_?key|credential)/i;
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v !== null && typeof v === 'object')
        for (const [key, x] of Object.entries(v as Record<string, unknown>)) {
          assert.ok(!secretKey.test(key) || (key === 'approvedByNote') === false, `${path}.${key}`);
          walk(x, `${path}.${key}`);
        }
    };
    for (const p of [
      'locations',
      'rooms',
      'opening-hours',
      'holidays',
      'services',
      'booking-policies',
      'consent-templates',
      'questionnaire-templates',
      'feature-flags',
      'banners',
      'operating-states',
    ])
      walk(j(await api(k, adm, 'GET', `/${p}`)), p);
    const rows = await k.q(
      `SELECT change FROM audit.event WHERE action = 'config_change' AND resource_type LIKE 'organisation.%'`,
    );
    for (const r of rows) walk(r['change'], 'audit');
  });

  test('a change and its audit row commit together: when the audit write fails nothing is changed', async () => {
    const { OrganisationAdminService } = await import('./service.js');
    const failing = new OrganisationAdminService({
      db: k.db,
      audit: {
        record: () => Promise.reject(new Error('audit store down')),
        recordDenied: () => Promise.resolve({ recorded: false }),
      },
      organisation: k.organisation,
    });
    const scope = {
      audience: 'staff',
      realm: 'admin_pool',
      orgId: ORG,
      principalId: adm.principalId,
    } as const;
    await assert.rejects(() =>
      failing.createLocation(
        scope,
        { name: 'Ghost', kind: 'clinic', timeZone: 'UTC', stateCode: FIXTURE_STATES.licensed },
        { requestId: null, ip: null, userAgent: null },
      ),
    );
    assert.equal((await k.q(`SELECT 1 FROM organisation.location WHERE name = 'Ghost'`)).length, 0);
    await assert.rejects(() =>
      failing.putSetting(
        scope,
        { key: 'hold_minutes', value: 99 },
        { requestId: null, ip: null, userAgent: null },
      ),
    );
    assert.equal(
      (
        await k.q(
          `SELECT value FROM kernel.setting WHERE key = 'hold_minutes' AND location_id IS NULL`,
        )
      )[0]!['value'],
      12,
    );
  });

  test('concurrent PATCHes with the same If-Match: exactly one wins, the other gets 412', async () => {
    const loc = await newLocation('Contended');
    const first = await api(k, adm, 'GET', '/locations');
    const row = items(first).find((x) => x['id'] === loc)!;
    const tag = `W/"${String(row['rowVersion'])}"`;
    const rs = await Promise.all(
      ['A', 'B', 'C'].map((n) =>
        api(
          k,
          adm,
          'PATCH',
          '/locations',
          { id: loc, name: `Contended ${n}` },
          { 'if-match': tag },
        ),
      ),
    );
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 412, 412]);
  });

  test('concurrent overlapping opening hours: exactly one interval is stored', async () => {
    const loc = await newLocation('Hours race');
    const rs = await Promise.all(
      [
        ['08:00', '12:00'],
        ['10:00', '14:00'],
        ['11:00', '15:00'],
      ].map(([opens, closes]) =>
        api(k, adm, 'POST', '/opening-hours', { locationId: loc, weekday: 3, opens, closes }),
      ),
    );
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400, 400]);
    assert.equal(
      (await k.q(`SELECT 1 FROM organisation.opening_hours WHERE location_id = $1`, [loc])).length,
      1,
    );
  });
});
