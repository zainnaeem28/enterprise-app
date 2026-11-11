// Real-database tests for BE-04, request side: sessions (token hash only, no cache, immediate revocation, idle timeout with
// passive traffic), the authorization guard (permission, realm, scope, CSRF and Origin, elevation, assignment) and the
// scope builder. TC-AZ-* and TC-ID-* automated parts.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/identity/guard.dbtest.js
import { FIXTURE_STATES } from '../../platform/fixture-states.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assignRole,
  call,
  clock,
  id,
  ORG,
  PATIENT_HOST,
  PATIENT_NOT_FOUND,
  ProbeController,
  registerProbeResolver,
  seedPrincipal,
  seedSession,
  setup,
  STAFF_HOST,
  staffVisible,
  writeHeaders,
} from './testkit.js';
import type { Kit, SeededSession } from './testkit.js';
import { uuidv7 } from './ids.js';

const L1 = id(101);
const L2 = id(102);
const P1 = id(201); // a patient staff at L1 can see
const P2 = id(202); // a patient staff cannot see
const P3 = id(203);

let k: Kit;
before(async () => {
  k = await setup({
    name: 'guard',
    controllers: [ProbeController],
    fixtures: async ({ sa }) => {
      await sa.query(
        `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('${FIXTURE_STATES.licensed}', $1, 'Fixture state ${FIXTURE_STATES.licensed}')`,
        [ORG],
      );
      // Patient rows the identity fixtures point at: patient.guard_open_patient (BE-08, migration 0701) refuses writes for a patient that does not exist.
      let mrn = 8000000;
      for (const pid of [P1, P2, P3, id(301), id(302), id(303), id(304), id(305), id(306)])
        await sa.query(
          `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via) VALUES ($1, $2, $3, 'Fixture', 'Patient', '1980-01-01', '${FIXTURE_STATES.licensed}', 'front_desk')`,
          [pid, ORG, `MRN-${mrn++}`],
        );
      // The guard reads the patient root as its owner under row-level security, so this superuser session carries an organisation and an audience too.
      await sa.query(
        `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
        [ORG],
      );
      for (const [lid, name] of [
        [L1, 'Main'],
        [L2, 'Second'],
      ] as const)
        await sa.query(
          `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active) VALUES ($1, $2, $3, 'clinic', 'America/New_York', '${FIXTURE_STATES.licensed}', true)`,
          [lid, ORG, name],
        );
    },
  });
  registerProbeResolver(k);
});
after(async () => {
  await k?.close();
});
beforeEach(() => {
  clock.t = Date.now();
  staffVisible.clear();
  staffVisible.add(P1);
});

const get = (s: SeededSession | undefined, path: string, host = STAFF_HOST) =>
  call(k.base, 'GET', path, { host, ...(s === undefined ? {} : { cookie: s.cookie }) });
const staff = async (role: string, loc: string | undefined = L1) => {
  const p = await seedPrincipal(k, 'google', { email: `${role}${Math.random()}@example.com` });
  await assignRole(k, p.principalId, role, loc);
  return { p, s: await seedSession(k, p, 'google') };
};
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];

describe('session lookup (26.2, ADR-021)', () => {
  test('no cookie, a malformed cookie and an unknown token are all 401 auth.unauthenticated', async () => {
    const none = await get(undefined, '/api/v1/t/none');
    assert.equal(none.status, 401);
    assert.equal(code(none), 'auth.unauthenticated');
    for (const bad of ['', 'x', 'a'.repeat(43), `${'A'.repeat(42)}%`])
      assert.equal(
        (await call(k.base, 'GET', '/api/v1/t/none', { cookie: `__Host-sid=${bad}` })).status,
        401,
      );
  });

  test('a valid session passes; every response carries X-Session-Idle-Expires-At', async () => {
    const { s } = await staff('front_desk');
    const r = await get(s, '/api/v1/t/none');
    assert.equal(r.status, 200);
    const idle = new Date(String(r.headers['x-session-idle-expires-at'])).getTime();
    assert.ok(idle - clock.t > 14 * 60_000 && idle - clock.t <= 15 * 60_000 + 2000);
  });

  test('revocation is immediate: the very next request after the revoke is refused (no session cache)', async () => {
    const { s } = await staff('front_desk');
    assert.equal((await get(s, '/api/v1/t/none')).status, 200);
    await k.sa.query(
      `UPDATE identity.session SET revoked_at = now(), revoke_reason = 'kill_switch' WHERE id = $1`,
      [s.sessionId],
    );
    const r = await get(s, '/api/v1/t/none');
    assert.equal(r.status, 401);
    assert.equal(code(r), 'auth.unauthenticated');
  });

  test('the database is read on every request: moving the stored expiry into the past is seen at once', async () => {
    const { s } = await staff('front_desk');
    assert.equal((await get(s, '/api/v1/t/none')).status, 200);
    await k.sa.query(`UPDATE identity.session SET idle_expires_at = $2 WHERE id = $1`, [
      s.sessionId,
      new Date(clock.t - 1000),
    ]);
    const r = await get(s, '/api/v1/t/none');
    assert.equal(r.status, 401);
    assert.equal(code(r), 'auth.session_expired');
  });

  test('a disabled or suspended principal is refused although its session is live; its role assignments are inert', async () => {
    for (const status of ['disabled', 'suspended']) {
      const { p, s } = await staff('front_desk');
      assert.equal((await get(s, '/api/v1/t/none')).status, 200);
      await k.sa.query(`UPDATE identity.principal SET status = $2 WHERE id = $1`, [
        p.principalId,
        status,
      ]);
      assert.equal((await get(s, '/api/v1/t/none')).status, 401, status);
    }
  });

  test('absolute lifetime: 12 h staff; the session is revoked with reason absolute', async () => {
    const { s } = await staff('front_desk');
    clock.t += 12 * 3_600_000 + 1000;
    // keep it idle-live so only the absolute limit applies
    await k.sa.query(
      `UPDATE identity.session SET idle_expires_at = absolute_expires_at WHERE id = $1`,
      [s.sessionId],
    );
    const r = await get(s, '/api/v1/t/none');
    assert.equal(r.status, 401);
    assert.equal(code(r), 'auth.session_expired');
    assert.equal(
      (await k.q(`SELECT revoke_reason FROM identity.session WHERE id = $1`, [s.sessionId]))[0]?.[
        'revoke_reason'
      ],
      'absolute',
    );
  });
});

describe('idle timeout with passive traffic (38.2 item 14, TDR-06)', () => {
  const idleOf = async (s: SeededSession): Promise<number> =>
    (
      (await k.q(`SELECT idle_expires_at FROM identity.session WHERE id = $1`, [s.sessionId]))[0]?.[
        'idle_expires_at'
      ] as Date
    ).getTime();
  const min = (n: number): number => n * 60_000;

  test('an interactive request moves the expiry (at most once a minute); passive requests never do', async () => {
    const { s } = await staff('front_desk');
    const t0 = clock.t;
    assert.equal(await idleOf(s), t0 + min(15));
    clock.t = t0 + min(5);
    assert.equal((await get(s, '/api/v1/alerts')).status, 200); // interactive
    assert.equal(await idleOf(s), t0 + min(20));
    const v = (
      await k.q(`SELECT row_version FROM identity.session WHERE id = $1`, [s.sessionId])
    )[0]?.['row_version'];
    clock.t = t0 + min(5) + 30_000;
    assert.equal((await get(s, '/api/v1/alerts')).status, 200); // within the minute: no write
    assert.equal(
      (await k.q(`SELECT row_version FROM identity.session WHERE id = $1`, [s.sessionId]))[0]?.[
        'row_version'
      ],
      v,
    );
    assert.equal(await idleOf(s), t0 + min(20));
  });

  test('stream, open-ids poll and video waiting-room poll keep a tab open but never keep the session alive: signed out at 15 minutes', async () => {
    const { s } = await staff('front_desk');
    const t0 = clock.t;
    const stored = await idleOf(s);
    for (let m = 1; m <= 14; m++) {
      clock.t = t0 + min(m);
      for (const path of [
        '/api/v1/alerts/stream',
        '/api/v1/alerts/open-ids',
        `/api/v1/appointments/${id(900)}/video-session`,
      ]) {
        // The probe routes need different permissions; use whichever the session holds: front_desk reads alerts and holds no telehealth right.
        const r = await get(s, path);
        assert.ok(r.status === 200 || r.status === 403, `${path} -> ${r.status}`);
        assert.equal(
          r.status === 200
            ? new Date(String(r.headers['x-session-idle-expires-at'])).getTime()
            : stored,
          stored,
          'the expiry the client sees does not move',
        );
      }
      assert.equal(await idleOf(s), stored, `minute ${m}: nothing was written`);
    }
    clock.t = t0 + min(15) + 1000;
    const r = await get(s, '/api/v1/alerts/open-ids');
    assert.equal(r.status, 401);
    assert.equal(code(r), 'auth.session_expired');
    assert.equal(
      (await k.q(`SELECT revoke_reason FROM identity.session WHERE id = $1`, [s.sessionId]))[0]?.[
        'revoke_reason'
      ],
      'idle',
    );
  });

  test('user input at minute 10 moves the expiry to 25; passive polling until then is fine; at 25 the session ends', async () => {
    const { s } = await staff('front_desk');
    const t0 = clock.t;
    clock.t = t0 + min(10);
    assert.equal((await get(s, '/api/v1/alerts')).status, 200);
    clock.t = t0 + min(24);
    assert.equal((await get(s, '/api/v1/alerts/open-ids')).status, 200);
    clock.t = t0 + min(25) + 1000;
    assert.equal((await get(s, '/api/v1/alerts/open-ids')).status, 401);
  });

  test('POST /auth/session/extend (the "Stay signed in?" click) extends and is explicit, ignoring the once-a-minute limit', async () => {
    const { s } = await staff('front_desk');
    const t0 = clock.t;
    clock.t = t0 + min(1) + 1000;
    assert.equal((await get(s, '/api/v1/alerts')).status, 200); // touches
    clock.t += 10_000;
    const r = await call(k.base, 'POST', '/api/v1/auth/session/extend', {
      cookie: s.cookie,
      headers: writeHeaders(s),
    });
    assert.equal(r.status, 200);
    assert.equal(new Date(String(r.json()['idleExpiresAt'])).getTime(), clock.t + min(15));
    assert.equal(await idleOf(s), clock.t + min(15));
  });

  test('extend on an expired session is 401 auth.session_expired', async () => {
    const { s } = await staff('front_desk');
    clock.t += min(16);
    const r = await call(k.base, 'POST', '/api/v1/auth/session/extend', {
      cookie: s.cookie,
      headers: writeHeaders(s),
    });
    assert.equal(r.status, 401);
    assert.equal(code(r), 'auth.session_expired');
  });

  test('per-audience timeouts: admin 10 minutes, patient 30; the stored setting wins; never past the absolute expiry', async () => {
    const admin = await seedPrincipal(k, 'admin_pool');
    await assignRole(k, admin.principalId, 'org_admin');
    const a = await seedSession(k, admin, 'admin_pool', { idleMin: 10 });
    const t0 = clock.t;
    clock.t = t0 + min(5);
    await call(k.base, 'GET', '/api/v1/admin/t/thing', { cookie: a.cookie });
    assert.equal(await idleOf(a), t0 + min(15), 'admin: now + 10');

    const pat = await seedPrincipal(k, 'patient_pool');
    const ps = await seedSession(k, pat, 'patient_pool', { idleMin: 30 });
    clock.t = t0 + min(5);
    assert.equal(
      (await call(k.base, 'GET', '/api/v1/t/none', { host: PATIENT_HOST, cookie: ps.cookie }))
        .status,
      403,
    ); // authenticated, not a staff route
    assert.equal(await idleOf(ps), t0 + min(35), 'patient: now + 30');

    await k.sa.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, pre_auth) VALUES ($1, $2, 'staff_idle_minutes', '5', 'int>=1', true)`,
      [id(7301), ORG],
    );
    const { s } = await staff('front_desk');
    clock.t += min(2);
    const base = clock.t;
    await get(s, '/api/v1/alerts');
    assert.equal(await idleOf(s), base + min(5), 'setting = 5 minutes');
    await k.sa.query(`DELETE FROM kernel.setting WHERE key = 'staff_idle_minutes'`);

    // The absolute expiry is immutable after insert (trigger), so seed a session whose absolute lifetime is 10 minutes.
    const p2 = await seedPrincipal(k, 'google', { email: 'abs@example.com' });
    await assignRole(k, p2.principalId, 'front_desk', L1);
    const s2 = await seedSession(k, p2, 'google', { absoluteHours: 10 / 60 });
    const start2 = clock.t;
    clock.t += min(9);
    await get(s2, '/api/v1/alerts');
    assert.equal(await idleOf(s2), start2 + min(10), 'capped at the absolute expiry, not now + 15');
  });
});

describe('CSRF and Origin on state-changing requests (26.2)', () => {
  test('GET needs neither; POST needs the session token header AND an allowed Origin; both are checked before the session is touched', async () => {
    const { s } = await staff('front_desk');
    assert.equal((await call(k.base, 'POST', '/api/v1/t/write', { cookie: s.cookie })).status, 403);
    const noOrigin = await call(k.base, 'POST', '/api/v1/t/write', {
      cookie: s.cookie,
      headers: { 'x-csrf-token': s.csrf },
    });
    assert.equal(code(noOrigin), 'auth.csrf_failed');
    const badOrigin = await call(k.base, 'POST', '/api/v1/t/write', {
      cookie: s.cookie,
      headers: { 'x-csrf-token': s.csrf, origin: 'https://evil.example' },
    });
    assert.equal(code(badOrigin), 'auth.csrf_failed');
    const noToken = await call(k.base, 'POST', '/api/v1/t/write', {
      cookie: s.cookie,
      headers: { origin: `https://${STAFF_HOST}` },
    });
    assert.equal(code(noToken), 'auth.csrf_failed');
    const wrong = await call(k.base, 'POST', '/api/v1/t/write', {
      cookie: s.cookie,
      headers: { origin: `https://${STAFF_HOST}`, 'x-csrf-token': 'x'.repeat(43) },
    });
    assert.equal(code(wrong), 'auth.csrf_failed');
    // another session's token is not valid for this one
    const other = await staff('front_desk');
    const cross = await call(k.base, 'POST', '/api/v1/t/write', {
      cookie: s.cookie,
      headers: writeHeaders(other.s),
    });
    assert.equal(code(cross), 'auth.csrf_failed');
    // none of those refusals extended the session
    const row = (
      await k.q(`SELECT idle_expires_at FROM identity.session WHERE id = $1`, [s.sessionId])
    )[0];
    assert.equal((row?.['idle_expires_at'] as Date).getTime(), clock.t + 15 * 60_000);
    const ok = await call(k.base, 'POST', '/api/v1/t/write', {
      cookie: s.cookie,
      headers: writeHeaders(s),
    });
    assert.equal(ok.status, 201);
  });

  test('GET /auth/session returns the CSRF token that works, and it is the same on every call', async () => {
    const { s } = await staff('front_desk');
    const a = (await get(s, '/api/v1/auth/session')).json();
    const b = (await get(s, '/api/v1/auth/session')).json();
    assert.equal(a['csrfToken'], s.csrf);
    assert.equal(a['csrfToken'], b['csrfToken']);
  });
});

describe('permission, realm and location (27.1)', () => {
  test('a role without the permission is 403 auth.forbidden and the denial is audited', async () => {
    const { p, s } = await staff('medical_records'); // no scheduling or alert rights
    const r = await get(s, '/api/v1/alerts');
    assert.equal(r.status, 403);
    assert.equal(code(r), 'auth.forbidden');
    const ev = await k.q(
      `SELECT action, outcome, denial_reason, actor_principal_id, resource_type FROM audit.event WHERE actor_principal_id = $1 AND action = 'denied'`,
      [p.principalId],
    );
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.['denial_reason'], 'forbidden');
    assert.equal(ev[0]?.['resource_type'], 'notifications.route');
  });

  test('a principal with no role holds nothing', async () => {
    const p = await seedPrincipal(k, 'google', { email: 'norole@example.com' });
    const s = await seedSession(k, p, 'google');
    assert.equal((await get(s, '/api/v1/t/none')).status, 403);
  });

  test('realm: a patient session on a staff route and a google session on /admin are refused; the admin realm cannot reach staff routes', async () => {
    const pat = await seedPrincipal(k, 'patient_pool');
    const ps = await seedSession(k, pat, 'patient_pool');
    assert.equal(
      (await call(k.base, 'GET', '/api/v1/t/none', { host: PATIENT_HOST, cookie: ps.cookie }))
        .status,
      403,
    );
    const { s } = await staff('doctor');
    assert.equal(
      (await get(s, '/api/v1/admin/t/thing')).status,
      403,
      'google session on an admin route',
    );
    const adm = await seedPrincipal(k, 'admin_pool');
    await assignRole(k, adm.principalId, 'org_admin');
    const as = await seedSession(k, adm, 'admin_pool');
    assert.equal((await get(as, '/api/v1/admin/t/thing')).status, 200);
    assert.equal((await get(as, '/api/v1/t/none')).status, 403, 'admin session on a staff route');
    const pr = await call(k.base, 'GET', '/api/v1/t/staff-only-on-patient-host', {
      host: PATIENT_HOST,
      cookie: ps.cookie,
    });
    assert.equal(pr.status, 200, 'a patient session reaches a patient-realm route');
    assert.equal(
      (await get(s, '/api/v1/t/staff-only-on-patient-host')).status,
      403,
      'staff on a patient route',
    );
  });

  test('location-bound roles count only for resources at their locations', async () => {
    const { s } = await staff('front_desk', L1);
    staffVisible.add(P2);
    assert.equal((await get(s, `/api/v1/t/patients/${P1}?loc=${L1}`)).status, 200);
    const other = await get(s, `/api/v1/t/patients/${P1}?loc=${L2}`);
    assert.equal(other.status, 403);
    assert.equal(code(other), 'auth.forbidden');
  });

  test('a role held at two locations works at both, and nowhere else', async () => {
    const p = await seedPrincipal(k, 'google', { email: 'two@example.com' });
    await assignRole(k, p.principalId, 'front_desk', L1);
    await assignRole(k, p.principalId, 'front_desk', L2);
    const s = await seedSession(k, p, 'google');
    assert.equal((await get(s, `/api/v1/t/patients/${P1}?loc=${L2}`)).status, 200);
    assert.equal((await get(s, `/api/v1/t/patients/${P1}?loc=${id(103)}`)).status, 403);
  });

  test('a resource the staff scope cannot see is 404 kernel.not_found (audited not_visible), not 403; a missing resource is 404 too', async () => {
    const { p, s } = await staff('front_desk');
    const hidden = await get(s, `/api/v1/t/patients/${P2}?loc=${L1}`);
    assert.equal(hidden.status, 404);
    assert.equal(code(hidden), 'kernel.not_found');
    assert.equal((await get(s, `/api/v1/t/patients/${PATIENT_NOT_FOUND}`)).status, 404);
    const ev = await k.q(
      `SELECT denial_reason, patient_id FROM audit.event WHERE actor_principal_id = $1 AND action = 'denied' ORDER BY occurred_at`,
      [p.principalId],
    );
    assert.deepEqual(
      ev.map((e) => e['denial_reason']),
      ['not_visible', 'not_visible'],
    );
    assert.equal(ev[0]?.['patient_id'], P2);
  });

  test('a route naming a resolver nobody registered fails closed', async () => {
    const { s } = await staff('front_desk');
    assert.equal((await get(s, '/api/v1/t/unregistered')).status, 403);
  });

  test('a permission that needs elevation is refused without a valid elevation grant (identity.elevation_required)', async () => {
    const adm = await seedPrincipal(k, 'admin_pool');
    await assignRole(k, adm.principalId, 'org_admin');
    const as = await seedSession(k, adm, 'admin_pool');
    const r = await get(as, '/api/v1/admin/t/elevated');
    assert.equal(r.status, 403);
    assert.equal(code(r), 'identity.elevation_required');
    // QA-EXEC-F02: the refusal is audited as `denied` (8.1 rule 2).
    const ev = await k.q(
      `SELECT outcome, denial_reason FROM audit.event WHERE actor_principal_id = $1 AND action = 'denied'`,
      [adm.principalId],
    );
    assert.deepEqual(
      ev.map((e) => [e['outcome'], e['denial_reason']]),
      [['denied', 'forbidden']],
    );
  });

  test('a break-glass grant adds the patient to the scope, and the guard lets the staff route through it', async () => {
    const { p, s } = await staff('doctor');
    assert.equal((await get(s, `/api/v1/t/chart/${P3}`)).status, 404, 'not in the staff scope');
    await k.db.withScope(
      {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: p.principalId,
        personId: (
          await k.q(`SELECT person_id FROM identity.principal WHERE id = $1`, [p.principalId])
        )[0]?.['person_id'] as string,
      },
      (tx) =>
        k.audit.openBtg(tx, {
          requestId: id(5000),
          patientId: P3,
          reason: 'Emergency review of a synthetic chart',
        }),
    );
    assert.equal(
      (await get(s, `/api/v1/t/chart/${P3}`)).status,
      200,
      'the grant puts the patient in scope and satisfies the assignment rule',
    );
  });
});

describe('assignment (27.4, BQ-5)', () => {
  const sources = {
    careTeam: new Set<string>(),
    reservation: new Set<string>(),
    authored: new Set<string>(),
  };
  const key = (pr: string, pa: string): string => `${pr}:${pa}`;
  before(() => {
    k.identity.assignment.registerSource('care_team', (_tx, pr, pa) =>
      Promise.resolve(sources.careTeam.has(key(pr, pa))),
    );
    k.identity.assignment.registerSource('reservation', (_tx, pr, pa) =>
      Promise.resolve(sources.reservation.has(key(pr, pa))),
    );
    k.identity.assignment.registerSource('authored', (_tx, pr, pa) =>
      Promise.resolve(sources.authored.has(key(pr, pa))),
    );
  });
  beforeEach(() => {
    for (const s of Object.values(sources)) s.clear();
  });

  for (const rule of ['careTeam', 'reservation', 'authored'] as const)
    test(`rule ${rule} grants access to the chart`, async () => {
      const { p, s } = await staff('doctor');
      assert.equal((await get(s, `/api/v1/t/chart/${P1}`)).status, 403);
      sources[rule].add(key(p.principalId, P1));
      assert.equal((await get(s, `/api/v1/t/chart/${P1}`)).status, 200);
    });

  test('none of the rules: 403 clinical.not_assigned with btgAvailable semantics; then break-glass lets the next request pass', async () => {
    const { p, s } = await staff('doctor');
    const r = await get(s, `/api/v1/t/chart/${P1}`);
    assert.equal(r.status, 403);
    assert.equal(code(r), 'clinical.not_assigned');
    const ev = await k.q(
      `SELECT denial_reason FROM audit.event WHERE actor_principal_id = $1 AND action = 'denied'`,
      [p.principalId],
    );
    assert.equal(ev.length, 1);
    const personId = (
      await k.q(`SELECT person_id FROM identity.principal WHERE id = $1`, [p.principalId])
    )[0]?.['person_id'] as string;
    await k.db.withScope(
      { audience: 'staff', realm: 'google', orgId: ORG, principalId: p.principalId, personId },
      (tx) =>
        k.audit.openBtg(tx, {
          requestId: id(5001),
          patientId: P1,
          reason: 'Emergency review of a synthetic chart',
        }),
    );
    assert.equal((await get(s, `/api/v1/t/chart/${P1}`)).status, 200);
  });

  test('an assistant is assigned through the doctor they support (staff_support) and a trainee through the supervisor', async () => {
    const doc = await staff('doctor');
    const asst = await staff('assistant');
    assert.equal((await get(asst.s, `/api/v1/t/chart/${P1}`)).status, 403);
    sources.careTeam.add(key(doc.p.principalId, P1));
    assert.equal(
      (await get(asst.s, `/api/v1/t/chart/${P1}`)).status,
      403,
      'not supporting that doctor yet',
    );
    await k.sa.query(
      `INSERT INTO identity.staff_support (id, organisation_id, assistant_principal_id, supported_principal_id, from_date) VALUES ($1, $2, $3, $4, current_date - 1)`,
      [id(7400), ORG, asst.p.principalId, doc.p.principalId],
    );
    assert.equal((await get(asst.s, `/api/v1/t/chart/${P1}`)).status, 200);
    await k.sa.query(`UPDATE identity.staff_support SET to_date = current_date - 1 WHERE id = $1`, [
      id(7400),
    ]);
    assert.equal(
      (await get(asst.s, `/api/v1/t/chart/${P1}`)).status,
      403,
      'an ended support row grants nothing',
    );

    const tr = await staff('trainee_doctor');
    await k.sa.query(
      `INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, is_trainee, supervisor_principal_id) VALUES ($1, $2, 'Trainee', true, $3)`,
      [tr.p.principalId, ORG, doc.p.principalId],
    );
    assert.equal((await get(tr.s, `/api/v1/t/chart/${P1}`)).status, 200);
  });

  test('the look-back months come from the setting assignment_lookback_months (default 24)', async () => {
    let seen = 0;
    const real = k.identity.assignment;
    const { p } = await staff('doctor');
    await k.db.withScope(
      { audience: 'staff', realm: 'google', orgId: ORG, principalId: p.principalId },
      async (tx) => {
        seen = await real.lookbackMonths(tx);
      },
    );
    assert.equal(seen, 24);
    await k.sa.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES ($1, $2, 'assignment_lookback_months', '6', 'int>=1')`,
      [id(7500), ORG],
    );
    await k.db.withScope(
      { audience: 'staff', realm: 'google', orgId: ORG, principalId: p.principalId },
      async (tx) => {
        seen = await real.lookbackMonths(tx);
      },
    );
    assert.equal(seen, 6);
    await k.sa.query(`DELETE FROM kernel.setting WHERE key = 'assignment_lookback_months'`);
  });
});

describe('GET /auth/session and sign-out', () => {
  test('GET /me (INT03-obs): a patient session gets its principal and linked patients; a staff session is refused', async () => {
    const pat = await seedPrincipal(k, 'patient_pool');
    const ps = await seedSession(k, pat, 'patient_pool');
    const r = await call(k.base, 'GET', '/api/v1/me', { host: PATIENT_HOST, cookie: ps.cookie });
    assert.equal(r.status, 200);
    const b = r.json() as Record<string, unknown>;
    assert.equal(b['principalId'], pat.principalId);
    assert.equal(b['realm'], 'patient_pool');
    assert.ok(Array.isArray(b['patients']));
    const { s } = await staff('front_desk', L1);
    assert.equal((await get(s, '/api/v1/me')).status, 403);
  });

  test('shape: principal, realm, audience, name, csrf token, idle expiry, roles with locations, permissions, patients', async () => {
    const { s } = await staff('front_desk', L1);
    const b = (await get(s, '/api/v1/auth/session')).json() as Record<string, unknown>;
    assert.equal(b['realm'], 'google');
    assert.equal(b['audience'], 'staff');
    assert.deepEqual(b['roles'], [{ key: 'front_desk', locationId: L1 }]);
    assert.ok((b['permissions'] as string[]).includes('patient.read'));
    assert.ok(!(b['permissions'] as string[]).includes('clinical.chart.read'));
    assert.deepEqual(b['patients'], []);
    assert.ok(typeof b['idleExpiresAt'] === 'string' && typeof b['displayName'] === 'string');
  });

  test('sign-out revokes the session (sign_out), audits it, clears the cookie, and the session is refused at once', async () => {
    const { p, s } = await staff('front_desk');
    const r = await call(k.base, 'POST', '/api/v1/auth/sign-out', {
      cookie: s.cookie,
      headers: writeHeaders(s),
    });
    assert.equal(r.status, 204);
    assert.ok(r.setCookies.some((c) => /^__Host-sid=;.*Max-Age=0/.test(c)));
    assert.equal((await get(s, '/api/v1/auth/session')).status, 401);
    const row = (
      await k.q(`SELECT revoke_reason FROM identity.session WHERE id = $1`, [s.sessionId])
    )[0];
    assert.equal(row?.['revoke_reason'], 'sign_out');
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM audit.event WHERE actor_principal_id = $1 AND action = 'sign_out' AND resource_id = $2`,
          [p.principalId, s.sessionId],
        )
      ).length,
      1,
    );
  });

  test('sign-out needs the CSRF token', async () => {
    const { s } = await staff('front_desk');
    assert.equal(
      (await call(k.base, 'POST', '/api/v1/auth/sign-out', { cookie: s.cookie })).status,
      403,
    );
    assert.equal((await get(s, '/api/v1/auth/session')).status, 200);
  });
});

describe('scope builder (21.3, SHARED-BOUNDARIES 6.1)', () => {
  const scopeOf = async (
    s: SeededSession,
    p: { principalId: string },
    realm: 'google' | 'patient_pool' | 'admin_pool',
  ) => {
    const session = (await k.identity.sessions.lookup(
      (await import('./tokens.js')).hashPresentedToken(s.token) as string,
    )) as { state: 'live'; session: never };
    return k.db
      .withScope(k.identity.sessions.scopeOf(session.session), (tx) =>
        k.identity.scopes.build(tx, session.session),
      )
      .then((b) => ({ ...b, realm, p }));
  };

  test('staff: audience, realm, principal, person, the locations of location-bound assignments, and BTG patients', async () => {
    const p = await seedPrincipal(k, 'google', { email: 'scope@example.com' });
    await assignRole(k, p.principalId, 'doctor', L1);
    await assignRole(k, p.principalId, 'front_desk', L2);
    const s = await seedSession(k, p, 'google');
    const b = await scopeOf(s, p, 'google');
    assert.equal(b.scope.audience, 'staff');
    assert.equal(b.scope.realm, 'google');
    assert.equal(b.scope.principalId, p.principalId);
    assert.equal(b.scope.personId, p.personId);
    assert.equal(b.scope.orgId, ORG);
    assert.deepEqual([...(b.scope.locationIds ?? [])].sort(), [L1, L2].sort());
    assert.equal(b.scope.btgPatientIds, undefined);
    assert.equal(b.scope.patientIds, undefined);
    assert.ok(b.grants.has('clinical.chart.read', L1));
    assert.ok(!b.grants.has('clinical.chart.read', L2), 'doctor only at L1');
    assert.ok(b.grants.has('patient.read', L2));
    await k.db.withScope(
      {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: p.principalId,
        personId: p.personId,
      },
      (tx) =>
        k.audit.openBtg(tx, {
          requestId: id(5002),
          patientId: P2,
          reason: 'Emergency review of a synthetic chart',
        }),
    );
    assert.deepEqual((await scopeOf(s, p, 'google')).scope.btgPatientIds, [P2]);
  });

  test('a revoked assignment is gone from the next scope', async () => {
    const p = await seedPrincipal(k, 'google', { email: 'revoke@example.com' });
    await assignRole(k, p.principalId, 'front_desk', L1);
    const s = await seedSession(k, p, 'google');
    assert.ok((await scopeOf(s, p, 'google')).grants.has('patient.read'));
    await k.sa.query(
      `UPDATE identity.role_assignment SET revoked_at = now() WHERE principal_id = $1`,
      [p.principalId],
    );
    const b = await scopeOf(s, p, 'google');
    assert.ok(!b.grants.has('patient.read'));
    assert.equal(b.scope.locationIds, undefined);
  });

  test('patient: patient ids from self links; a proxy gets the patient in patient_ids AND proxy_patient_ids (appointments only); self wins over proxy', async () => {
    const pat = await seedPrincipal(k, 'patient_pool');
    await k.sa.query(
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [pat.principalId, P1, ORG],
    );
    const prox = async (patientId: string, status: string, validUntil: string | null = null) =>
      k.sa.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status, valid_until) VALUES ($1,$2,$3,$4,'parent','Sam J',$5,$6)`,
        [uuidv7(), ORG, pat.principalId, patientId, status, validUntil],
      );
    await prox(P2, 'active');
    await prox(P1, 'active'); // also a proxy for the patient they are: self keeps full access
    const s = await seedSession(k, pat, 'patient_pool');
    const b = await scopeOf(s, pat, 'patient_pool');
    assert.equal(b.scope.audience, 'patient');
    assert.deepEqual([...(b.scope.patientIds ?? [])].sort(), [P1, P2].sort());
    assert.deepEqual(b.scope.proxyPatientIds, [P2]);
    assert.deepEqual(
      b.patients.map((x) => [x.patientId, x.relation, x.scope]).sort(),
      [
        [P1, 'self', 'full'],
        [P2, 'proxy', 'appointments'],
      ].sort(),
    );
    assert.equal(b.scope.locationIds, undefined);
  });

  test('only ACTIVE, unexpired proxy grants count: requested, verified, revoked, expired and past valid_until add nothing', async () => {
    const pat = await seedPrincipal(k, 'patient_pool');
    const s = await seedSession(k, pat, 'patient_pool');
    const patients = [id(301), id(302), id(303), id(304), id(305), id(306)];
    const statuses: [string, string | null][] = [
      ['requested', null],
      ['verified', null],
      ['revoked', null],
      ['expired', null],
      ['active', '2000-01-01'],
      ['active', null],
    ];
    for (const [i, [st, until]] of statuses.entries())
      await k.sa.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status, valid_until, revoked_at, revoke_reason)
         VALUES ($1,$2,$3,$4,'carer','Pat',$5,$6, CASE WHEN $5 = 'revoked' THEN now() END, CASE WHEN $5 = 'revoked' THEN 'staff' WHEN $5 = 'expired' THEN 'age_out' END)`,
        [id(7600 + i), ORG, pat.principalId, patients[i], st, until],
      );
    const b = await scopeOf(s, pat, 'patient_pool');
    assert.deepEqual(b.scope.patientIds, [patients[5]]);
  });

  test('module scope contributors add only what the interface allows', async () => {
    const p = await seedPrincipal(k, 'google', { email: 'contrib@example.com' });
    await assignRole(k, p.principalId, 'front_desk', L1);
    const s = await seedSession(k, p, 'google');
    k.identity.scopes.registerScopeContributor(() =>
      Promise.resolve({ btgPatientIds: [P3], audience: 'system', orgId: id(1) } as never),
    );
    const b = await scopeOf(s, p, 'google');
    assert.deepEqual(b.scope.btgPatientIds, [P3]);
    assert.equal(b.scope.audience, 'staff', 'a contributor cannot change the audience');
    assert.equal(b.scope.orgId, ORG, 'nor the organisation');
  });
});
