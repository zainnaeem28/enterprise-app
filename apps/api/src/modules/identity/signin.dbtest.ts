// Real-database tests for BE-04, sign-in side: TC-ID-* automated parts against the local OIDC conformance IdP on
// PostgreSQL 17 (first sign-in provisioning, pre-registered binding exactly once, callback refusals, sign-in limits,
// patient realm, re-authentication). TC-ID-01 against the real Workspace test tenant stays BLOCKED (C-10).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/identity/signin.dbtest.js
// Missing configuration FAILS; nothing skips. Synthetic data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Defect, Login } from './idp.fixture.js';
import {
  browserSignIn,
  call,
  cookieValue,
  id,
  ORG,
  PATIENT_HOST,
  queuedJobs,
  seedPrincipal,
  setup,
  STAFF_HOST,
} from './testkit.js';
import type { Kit } from './testkit.js';

let k: Kit;
before(async () => {
  k = await setup({ name: 'signin' });
});
after(async () => {
  await k?.close();
});

let n = 0;
const fresh = (over: Partial<Login> = {}): Login => ({
  sub: `g-${++n}-${process.pid}`,
  email: `user${n}@example.com`,
  email_verified: true,
  hd: 'example.com',
  name: `User ${n}`,
  ...over,
});
const count = async (sql: string, p: unknown[] = []): Promise<number> =>
  Number((await k.q<{ n: string }>(sql, p))[0]?.n);
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

describe('google realm: first sign-in provisioning (TDR-01, 38.2 item 12)', () => {
  test('creates a person and a principal with NO roles, and a session; sets a __Host- cookie; stores only the token hash', async () => {
    const login = fresh({ email: 'Dr.First@Example.com', name: 'Dr First' });
    const r = await browserSignIn(k, STAFF_HOST, login, { returnTo: '/patients?x=1' });
    assert.equal(r.status, 302);
    assert.equal(r.headers['location'], '/patients?x=1');
    const sid = r.setCookies.find((c) => c.startsWith('__Host-sid='));
    assert.ok(sid, 'session cookie set');
    assert.match(sid, /; Secure/);
    assert.match(sid, /; HttpOnly/);
    assert.match(sid, /; Path=\//);
    assert.match(sid, /; SameSite=Strict/);
    assert.ok(!/domain=/i.test(sid));
    assert.ok(
      r.setCookies.some((c) => /^__Host-oidc=;.*Max-Age=0/.test(c)),
      'the pre-auth cookie is deleted in the response',
    );

    const p = (
      await k.q(
        `SELECT id, person_id, realm, subject, email, status FROM identity.principal WHERE subject = $1`,
        [login.sub],
      )
    )[0];
    assert.ok(p);
    assert.equal(p['realm'], 'google');
    assert.equal(p['email'], 'dr.first@example.com');
    assert.equal(
      await count(`SELECT count(*) AS n FROM identity.role_assignment WHERE principal_id = $1`, [
        p['id'],
      ]),
      0,
    );
    assert.equal(
      (await k.q(`SELECT display_name FROM identity.person WHERE id = $1`, [p['person_id']]))[0]?.[
        'display_name'
      ],
      'Dr First',
    );

    const s = (
      await k.q(
        `SELECT token_hash, csrf_hash, audience, realm, idle_expires_at, absolute_expires_at, auth_time FROM identity.session WHERE principal_id = $1`,
        [p['id']],
      )
    )[0];
    assert.ok(s);
    assert.ok(
      (s['token_hash'] as Buffer).equals(sha(r.sid ?? '')),
      'token_hash is the SHA-256 of the cookie token',
    );
    assert.equal(s['audience'], 'staff');
    assert.equal(s['realm'], 'google');
    const idle = (s['idle_expires_at'] as Date).getTime() - Date.now();
    assert.ok(idle > 14 * 60_000 && idle <= 15 * 60_000 + 5000, `idle 15 min (staff), got ${idle}`);
    assert.ok(((s['absolute_expires_at'] as Date).getTime() - Date.now()) / 3_600_000 > 11.9);
    // The raw token is nowhere in the database.
    assert.equal(
      await count(
        `SELECT count(*) AS n FROM identity.session s WHERE s::text LIKE '%' || $1 || '%'`,
        [r.sid],
      ),
      0,
    );
  });

  test('the same subject again: no new person or principal; the old session cookie is revoked first (sign_out)', async () => {
    const login = fresh();
    const first = await browserSignIn(k, STAFF_HOST, login);
    const second = await browserSignIn(k, STAFF_HOST, login, { sid: first.sid });
    assert.equal(second.status, 302);
    assert.equal(
      await count(`SELECT count(*) AS n FROM identity.principal WHERE subject = $1`, [login.sub]),
      1,
    );
    const old = (
      await k.q(`SELECT revoked_at, revoke_reason FROM identity.session WHERE token_hash = $1`, [
        sha(first.sid ?? ''),
      ])
    )[0];
    assert.ok(old?.['revoked_at']);
    assert.equal(old?.['revoke_reason'], 'sign_out');
    const cur = (
      await k.q(`SELECT revoked_at FROM identity.session WHERE token_hash = $1`, [
        sha(second.sid ?? ''),
      ])
    )[0];
    assert.equal(cur?.['revoked_at'], null);
  });

  test('a suspended or disabled principal cannot sign in (generic refusal, no session)', async () => {
    for (const status of ['suspended', 'disabled']) {
      const login = fresh();
      const s = await seedPrincipal(k, 'google', {
        subject: login.sub,
        email: login.email ?? '',
        status,
      });
      const r = await browserSignIn(k, STAFF_HOST, login);
      assert.equal(r.status, 401);
      assert.equal(
        await count(`SELECT count(*) AS n FROM identity.session WHERE principal_id = $1`, [
          s.principalId,
        ]),
        0,
      );
    }
  });

  test('the sign-in is queued for audit in the same transaction; the worker job writes the event once', async () => {
    const login = fresh();
    const r = await browserSignIn(k, STAFF_HOST, login);
    const p = (await k.q(`SELECT id FROM identity.principal WHERE subject = $1`, [login.sub]))[0];
    const sess = (
      await k.q(`SELECT id FROM identity.session WHERE token_hash = $1`, [sha(r.sid ?? '')])
    )[0];
    const jobs = await queuedJobs(k, 'identity.record_sign_in', `j.payload->>'sessionId' = $2`, [
      sess?.['id'],
    ]);
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0] as { kind: string }).kind, 'created');
    const run = k.worker['runRecordSignIn'] as unknown as (
      d: unknown,
      p: unknown,
      j: string,
    ) => Promise<{ written: number }>;
    const deps = { db: k.wdb, orgId: ORG, workspaceDomain: 'example.com' };
    assert.equal((await run(deps, jobs[0], 'job-1')).written, 1);
    assert.equal((await run(deps, jobs[0], 'job-1')).written, 0, 'a retry writes nothing more');
    const ev = await k.q(
      `SELECT action, actor_principal_id, realm, audience, resource_type, change FROM audit.event WHERE resource_id = $1`,
      [sess?.['id']],
    );
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.['action'], 'sign_in');
    assert.equal(ev[0]?.['actor_principal_id'], p?.['id']);
    assert.equal(ev[0]?.['audience'], 'staff');
    assert.deepEqual(ev[0]?.['change'], { provisioned: true });
  });
});

describe('google realm: pre-registered email binding happens exactly once (26.1, SEC01-F-07/-08)', () => {
  test('binds sub by the verified email, audits the binding, and queues the event for the notice', async () => {
    const email = `pre${++n}@example.com`;
    const admin = await seedPrincipal(k, 'admin_pool', { subject: `admin-${n}` });
    const pre = await seedPrincipal(k, 'google', {
      subject: null,
      email,
      preregisteredAt: new Date(),
      createdBy: admin.principalId,
    });
    const login = fresh({ email: email.toUpperCase().replace('@EXAMPLE.COM', '@Example.com') });
    const r = await browserSignIn(k, STAFF_HOST, login);
    assert.equal(r.status, 302);
    const p = (
      await k.q(`SELECT subject, person_id FROM identity.principal WHERE id = $1`, [
        pre.principalId,
      ])
    )[0];
    assert.equal(p?.['subject'], login.sub);
    assert.equal(
      p?.['person_id'],
      pre.personId,
      'the pre-registered person is used, not a new one',
    );
    const sess = (
      await k.q(`SELECT id FROM identity.session WHERE principal_id = $1`, [pre.principalId])
    )[0];
    const jobs = await queuedJobs(k, 'identity.record_sign_in', `j.payload->>'sessionId' = $2`, [
      sess?.['id'],
    ]);
    assert.equal((jobs[0] as { kind: string }).kind, 'bound');
    const run = k.worker['runRecordSignIn'] as unknown as (
      d: unknown,
      p: unknown,
      j: string,
    ) => Promise<unknown>;
    await run({ db: k.wdb, orgId: ORG, workspaceDomain: 'example.com' }, jobs[0], 'job-2');
    const ev = await k.q(
      `SELECT action, resource_type, change FROM audit.event WHERE actor_principal_id = $1 ORDER BY action`,
      [pre.principalId],
    );
    assert.deepEqual(
      ev.map((e) => e['action']),
      ['sign_in', 'update'],
    );
    const upd = ev.find((e) => e['action'] === 'update');
    assert.equal(upd?.['resource_type'], 'identity.principal');
    assert.deepEqual(upd?.['change'], {
      bound: 'subject',
      sub: login.sub,
      email,
      hd: 'example.com',
    });
  });

  test('two concurrent first sign-ins of the same pre-registration: one binding, both sessions valid', async () => {
    const email = `race${++n}@example.com`;
    const pre = await seedPrincipal(k, 'google', {
      subject: null,
      email,
      preregisteredAt: new Date(),
    });
    const login = fresh({ email });
    const [a, b] = await Promise.all([
      browserSignIn(k, STAFF_HOST, login),
      browserSignIn(k, STAFF_HOST, login),
    ]);
    assert.equal(a.status, 302);
    assert.equal(b.status, 302);
    const sessions = await k.q(`SELECT id FROM identity.session WHERE principal_id = $1`, [
      pre.principalId,
    ]);
    assert.equal(sessions.length, 2);
    const ids = sessions.map((s) => s['id']);
    const jobs = await queuedJobs(
      k,
      'identity.record_sign_in',
      `j.payload->>'sessionId' = ANY($2)`,
      [ids],
    );
    assert.deepEqual(jobs.map((j) => (j as { kind: string }).kind).sort(), ['bound', 'sign_in']);
    assert.equal(
      await count(`SELECT count(*) AS n FROM identity.principal WHERE lower(email) = $1`, [email]),
      1,
    );
  });

  test('after binding, a different sub with the same email gets its OWN roleless principal: the address cannot take the principal over', async () => {
    const email = `reuse${++n}@example.com`;
    const pre = await seedPrincipal(k, 'google', {
      subject: null,
      email,
      preregisteredAt: new Date(),
    });
    const owner = fresh({ email });
    assert.equal((await browserSignIn(k, STAFF_HOST, owner)).status, 302);
    const successor = fresh({ email });
    assert.equal((await browserSignIn(k, STAFF_HOST, successor)).status, 302);
    const rows = await k.q(
      `SELECT id, subject FROM identity.principal WHERE lower(email) = $1 ORDER BY created_at`,
      [email],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.['id'], pre.principalId);
    assert.equal(rows[0]?.['subject'], owner.sub, 'the original binding is untouched');
    assert.equal(rows[1]?.['subject'], successor.sub);
  });

  test('a pre-registration older than preregistration_days (default 30, setting honoured) is not bound', async () => {
    const old = new Date(Date.now() - 31 * 86_400_000);
    const e1 = `old${++n}@example.com`;
    const p1 = await seedPrincipal(k, 'google', { subject: null, email: e1, preregisteredAt: old });
    assert.equal((await browserSignIn(k, STAFF_HOST, fresh({ email: e1 }))).status, 401);
    assert.equal(
      (await k.q(`SELECT subject FROM identity.principal WHERE id = $1`, [p1.principalId]))[0]?.[
        'subject'
      ],
      null,
    );
    assert.equal(
      await count(`SELECT count(*) AS n FROM identity.principal WHERE lower(email) = $1`, [e1]),
      1,
      'no second principal either',
    );

    const e2 = `recent${++n}@example.com`;
    const p2 = await seedPrincipal(k, 'google', {
      subject: null,
      email: e2,
      preregisteredAt: new Date(Date.now() - 2 * 86_400_000),
    });
    assert.equal(
      (await browserSignIn(k, STAFF_HOST, fresh({ email: e2 }))).status,
      302,
      '2 days old: inside the default 30',
    );
    assert.ok(
      (await k.q(`SELECT subject FROM identity.principal WHERE id = $1`, [p2.principalId]))[0]?.[
        'subject'
      ],
    );

    await k.sa.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, pre_auth) VALUES ($1, $2, 'preregistration_days', '1', 'int>=1', true)`,
      [id(7001), ORG],
    );
    const e3 = `custom${++n}@example.com`;
    await seedPrincipal(k, 'google', {
      subject: null,
      email: e3,
      preregisteredAt: new Date(Date.now() - 2 * 86_400_000),
    });
    assert.equal(
      (await browserSignIn(k, STAFF_HOST, fresh({ email: e3 }))).status,
      401,
      'setting = 1 day: 2 days old is refused',
    );
    await k.sa.query(`DELETE FROM kernel.setting WHERE key = 'preregistration_days'`);
  });

  test('a pre-registered principal can hold no role until it has signed in', async () => {
    const pre = await seedPrincipal(k, 'google', {
      subject: null,
      email: `norole${++n}@example.com`,
      preregisteredAt: new Date(),
    });
    await assert.rejects(
      k.sa.query(
        `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id)
         SELECT $1, $2, $3, r.id, $5, $4 FROM identity.role r WHERE r.key = 'front_desk' AND r.organisation_id = $2`,
        [id(7100), ORG, pre.principalId, id(7101), null],
      ),
      (e: { code?: string }) => e.code === 'PS001',
    );
  });
});

describe('callback refusals: one generic answer, nothing created, every failure counted', () => {
  const defects: Defect[] = [
    'wrong_nonce',
    'wrong_aud',
    'wrong_iss',
    'expired',
    'bad_signature',
    'alg_none',
    'alg_hs256',
    'unknown_kid',
    'token_error',
  ];
  for (const defect of defects)
    test(`ID token defect ${defect}`, async () => {
      const login = fresh({ defect });
      const r = await browserSignIn(k, STAFF_HOST, login);
      assert.equal(r.status, 401);
      assert.match(String(r.headers['content-type']), /text\/html/);
      assert.ok(
        !r.body.includes('SECRET-IDP-TEXT') && !/nonce|signature|issuer|audience/i.test(r.body),
        'no reason leaks',
      );
      assert.match(r.body, /<code>[0-9a-f-]{36}<\/code>/, 'the request id is shown');
      assert.equal(r.sid, undefined);
      assert.equal(
        await count(`SELECT count(*) AS n FROM identity.principal WHERE subject = $1`, [login.sub]),
        0,
      );
      assert.ok(
        r.setCookies.some((c) => /^__Host-oidc=;.*Max-Age=0/.test(c)),
        'the pre-auth cookie is deleted whatever the outcome',
      );
    });

  const realmCases: [string, Partial<Login>][] = [
    ['no hd claim', { hd: undefined }],
    ['hd of another domain', { hd: 'other.com' }],
    ['email not verified', { email_verified: false }],
    ['lookalike email domain', { email: 'a@evilexample.com' }],
    ['subdomain email', { email: 'a@mail.example.com' }],
  ];
  for (const [name, over] of realmCases)
    test(`realm check: ${name}`, async () => {
      const login = { ...fresh(), ...over } as Login;
      if (over.hd === undefined && 'hd' in over) delete (login as { hd?: string }).hd;
      const r = await browserSignIn(k, STAFF_HOST, login);
      assert.equal(r.status, 401);
      assert.equal(
        await count(`SELECT count(*) AS n FROM identity.principal WHERE subject = $1`, [login.sub]),
        0,
      );
    });

  test('state and pre-auth cookie: missing, tampered, mismatching state, other host realm, replayed code', async () => {
    const login = fresh();
    k.idp.nextLogin = login;
    const start = await call(k.base, 'GET', '/api/v1/auth/sign-in', { host: STAFF_HOST });
    const oidc = cookieValue(start.setCookies, '__Host-oidc') ?? '';
    const r = await fetch(String(start.headers['location']), { redirect: 'manual' });
    const back = new URL(r.headers.get('location') ?? '');
    const path = `${back.pathname}${back.search}`;
    const cb = (cookie: string | undefined, p = path, host = STAFF_HOST) =>
      call(k.base, 'GET', p, { host, ...(cookie === undefined ? {} : { cookie }), release: false });
    assert.equal((await cb(undefined)).status, 401, 'no pre-auth cookie');
    const tampered = Buffer.from(oidc, 'base64url');
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    assert.equal(
      (await cb(`__Host-oidc=${tampered.toString('base64url')}`)).status,
      401,
      'tampered pre-auth cookie',
    );
    assert.equal(
      (await cb(`__Host-oidc=${oidc}`, path.replace(/state=[^&]+/, 'state=other'))).status,
      401,
      'state mismatch',
    );
    assert.equal(
      (await cb(`__Host-oidc=${oidc}`, path, PATIENT_HOST)).status,
      401,
      'cookie sealed for the staff realm used at the patient host',
    );
    assert.equal(
      (await cb(`__Host-oidc=${oidc}`, path.replace(/code=[^&]+/, 'code='))).status,
      401,
      'empty code',
    );
    assert.equal(
      (await cb(`__Host-oidc=${oidc}`)).status,
      302,
      'the genuine callback still works after those refusals',
    );
    assert.equal((await cb(`__Host-oidc=${oidc}`)).status, 401, 'the same code cannot be replayed');
  });

  test('an unknown host has no sign-in: 404 problem body', async () => {
    const r = await call(k.base, 'GET', '/api/v1/auth/sign-in', { host: 'elsewhere.example.test' });
    assert.equal(r.status, 404);
  });

  test('returnTo that is not a same-host relative path becomes /', async () => {
    const r = await browserSignIn(k, STAFF_HOST, fresh(), { returnTo: 'https://evil.example/' });
    assert.equal(r.headers['location'], '/');
  });
});

describe('sign-in limits (31.3, TDR-13): failures only, before verification, counted outside the rolled-back transaction', () => {
  test('the 4th failure from one address (limit 3) gets 429 with Retry-After before any verification; a success never counts', async () => {
    await k.sa.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, pre_auth) VALUES ($1, $2, 'signin_ip_failures', '3', 'int>=1', true)`,
      [id(7201), ORG],
    );
    const ip = '198.51.100.7';
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await browserSignIn(k, STAFF_HOST, fresh(), { ip })).status,
        302,
        'successes are not counted',
      );
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await browserSignIn(k, STAFF_HOST, fresh({ defect: 'bad_signature' }), { ip })).status,
        401,
      );
    const tokenCallsBefore = k.idp.tokenCalls;
    const blocked = await browserSignIn(k, STAFF_HOST, fresh(), { ip });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    assert.equal(blocked.json()['code'], 'kernel.rate_limited');
    assert.equal(
      k.idp.tokenCalls,
      tokenCallsBefore,
      'no code exchange happened for the refused request',
    );
    assert.equal(
      (await browserSignIn(k, STAFF_HOST, fresh(), { ip: '198.51.100.8' })).status,
      302,
      'another address is unaffected',
    );
    await k.sa.query(`DELETE FROM kernel.setting WHERE key = 'signin_ip_failures'`);
  });

  test('a configured clinic range gets the higher limit; the keys are HMACs, not addresses', async () => {
    await k.sa.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, pre_auth) VALUES ($1, $2, 'signin_clinic_ip_failures', '5', 'int>=1', true), ($3, $2, 'clinic_egress_cidrs', '["203.0.113.0/24"]', 'cidr[]', true)`,
      [id(7202), ORG, id(7203)],
    );
    const ip = '203.0.113.9';
    for (let i = 0; i < 4; i++)
      assert.equal(
        (await browserSignIn(k, STAFF_HOST, fresh({ defect: 'bad_signature' }), { ip })).status,
        401,
        'over the plain limit of 3',
      );
    assert.equal((await browserSignIn(k, STAFF_HOST, fresh(), { ip })).status, 302);
    const keys = await k.q<{ key: string }>(`SELECT key FROM kernel.rate_counter`);
    assert.ok(keys.length > 0);
    assert.ok(keys.every((r) => !r.key.includes('198.51') && !r.key.includes('203.0.113')));
    await k.sa.query(
      `DELETE FROM kernel.setting WHERE key IN ('signin_clinic_ip_failures', 'clinic_egress_cidrs')`,
    );
  });

  test('a failure inside the rolled-back sign-in transaction is still counted', async () => {
    const ip = '192.0.2.44';
    const login = fresh();
    await seedPrincipal(k, 'google', {
      subject: login.sub,
      email: login.email ?? '',
      status: 'disabled',
    });
    const before = await count(`SELECT coalesce(sum(count), 0) AS n FROM kernel.rate_counter`);
    assert.equal((await browserSignIn(k, STAFF_HOST, login, { ip })).status, 401);
    const after = await count(`SELECT coalesce(sum(count), 0) AS n FROM kernel.rate_counter`);
    assert.ok(after >= before + 2, 'the per-address and the per-realm counters both moved');
  });
});

describe('patient realm: the patient identity service adapter', () => {
  test('first sign-in creates a patient_pool principal and a patient session; Lax cookie; no staff data', async () => {
    const login: Login = {
      sub: `pat-${++n}`,
      email: 'pat@example.org',
      email_verified: true,
      name: 'Pat Jones',
    };
    const r = await browserSignIn(k, PATIENT_HOST, login);
    assert.equal(r.status, 302);
    assert.match(r.setCookies.find((c) => c.startsWith('__Host-sid=')) ?? '', /SameSite=Lax/);
    const p = (
      await k.q(`SELECT id, realm, email FROM identity.principal WHERE subject = $1`, [login.sub])
    )[0];
    assert.equal(p?.['realm'], 'patient_pool');
    const s = (
      await k.q(
        `SELECT audience, realm, idle_expires_at FROM identity.session WHERE principal_id = $1`,
        [p?.['id']],
      )
    )[0];
    assert.equal(s?.['audience'], 'patient');
    assert.ok(((s?.['idle_expires_at'] as Date).getTime() - Date.now()) / 60_000 > 29);
    const me = await call(k.base, 'GET', '/api/v1/auth/session', {
      host: PATIENT_HOST,
      cookie: `__Host-sid=${r.sid}`,
    });
    assert.equal(me.status, 200);
    const body = me.json();
    assert.equal(body['realm'], 'patient_pool');
    assert.deepEqual(body['roles'], []);
    assert.deepEqual(body['permissions'], []);
    assert.deepEqual(body['patients'], []);
  });

  test('a patient token carrying staff claims does not make a staff principal: the realm comes from the host', async () => {
    const login: Login = {
      sub: `pat-${++n}`,
      email: 'x@example.com',
      email_verified: true,
      hd: 'example.com',
      extra: { realm: 'google' },
    };
    const r = await browserSignIn(k, PATIENT_HOST, login);
    assert.equal(r.status, 302);
    assert.equal(
      (await k.q(`SELECT realm FROM identity.principal WHERE subject = $1`, [login.sub]))[0]?.[
        'realm'
      ],
      'patient_pool',
    );
  });

  test('a Google identity is not a patient and a patient identity is not staff: same sub in both realms are two principals', async () => {
    const sub = `both-${++n}`;
    await browserSignIn(k, STAFF_HOST, {
      sub,
      email: `b${n}@example.com`,
      email_verified: true,
      hd: 'example.com',
    });
    await browserSignIn(k, PATIENT_HOST, { sub });
    const rows = await k.q(
      `SELECT realm FROM identity.principal WHERE subject = $1 ORDER BY realm`,
      [sub],
    );
    assert.deepEqual(
      rows.map((r) => r['realm']),
      ['google', 'patient_pool'],
    );
  });
});

describe('re-authentication (BQ-8) and realm switch', () => {
  test('POST /auth/reauth asks Google for prompt=login and max_age; completing it replaces the session (auth_time is fresh)', async () => {
    const login = fresh();
    const first = await browserSignIn(k, STAFF_HOST, login);
    const me = await call(k.base, 'GET', '/api/v1/auth/session', {
      cookie: `__Host-sid=${first.sid}`,
    });
    const csrf = String(me.json()['csrfToken']);
    const re = await call(k.base, 'POST', '/api/v1/auth/reauth?returnTo=/notes/1', {
      cookie: `__Host-sid=${first.sid}`,
      headers: { origin: `https://${STAFF_HOST}`, 'x-csrf-token': csrf },
    });
    assert.equal(re.status, 302);
    const idpUrl = new URL(String(re.headers['location']));
    assert.equal(idpUrl.searchParams.get('prompt'), 'login');
    assert.equal(idpUrl.searchParams.get('max_age'), '300');
    // Complete it: the IdP answers with a fresh login; the callback requires auth_time within max_age.
    k.idp.nextLogin = { ...login, auth_time: Math.floor(Date.now() / 1000) };
    const oidc = cookieValue(re.setCookies, '__Host-oidc');
    const toCb = await fetch(idpUrl, { redirect: 'manual' });
    const back = new URL(toCb.headers.get('location') ?? '');
    const done = await call(k.base, 'GET', `${back.pathname}${back.search}`, {
      cookie: `__Host-oidc=${oidc}; __Host-sid=${first.sid}`,
      release: false,
    });
    assert.equal(done.status, 302);
    assert.equal(done.headers['location'], '/notes/1');
    const newSid = cookieValue(done.setCookies, '__Host-sid');
    assert.ok(newSid && newSid !== first.sid);
    assert.ok(
      (await call(k.base, 'GET', '/api/v1/auth/session', { cookie: `__Host-sid=${first.sid}` }))
        .status === 401,
      'the old session is gone',
    );
    assert.equal(
      (await call(k.base, 'GET', '/api/v1/auth/session', { cookie: `__Host-sid=${newSid}` }))
        .status,
      200,
    );
  });

  test('a re-authentication whose auth_time is stale is refused', async () => {
    const login = fresh();
    const first = await browserSignIn(k, STAFF_HOST, login);
    const me = await call(k.base, 'GET', '/api/v1/auth/session', {
      cookie: `__Host-sid=${first.sid}`,
    });
    const re = await call(k.base, 'POST', '/api/v1/auth/reauth', {
      cookie: `__Host-sid=${first.sid}`,
      headers: { origin: `https://${STAFF_HOST}`, 'x-csrf-token': String(me.json()['csrfToken']) },
    });
    k.idp.nextLogin = { ...login, auth_time: Math.floor(Date.now() / 1000) - 7200 };
    const toCb = await fetch(String(re.headers['location']), { redirect: 'manual' });
    const back = new URL(toCb.headers.get('location') ?? '');
    const done = await call(k.base, 'GET', `${back.pathname}${back.search}`, {
      cookie: `__Host-oidc=${cookieValue(re.setCookies, '__Host-oidc')}; __Host-sid=${first.sid}`,
      release: false,
    });
    assert.equal(done.status, 401);
    assert.equal(
      (await call(k.base, 'GET', '/api/v1/auth/session', { cookie: `__Host-sid=${first.sid}` }))
        .status,
      200,
      'the existing session is untouched by a refused re-authentication',
    );
  });

  test('reauth is for staff sessions only, and needs the session and CSRF', async () => {
    const pat = await browserSignIn(k, PATIENT_HOST, { sub: `pat-${++n}` });
    const me = await call(k.base, 'GET', '/api/v1/auth/session', {
      host: PATIENT_HOST,
      cookie: `__Host-sid=${pat.sid}`,
    });
    const r = await call(k.base, 'POST', '/api/v1/auth/reauth', {
      host: PATIENT_HOST,
      cookie: `__Host-sid=${pat.sid}`,
      headers: {
        origin: `https://${PATIENT_HOST}`,
        'x-csrf-token': String(me.json()['csrfToken']),
      },
    });
    assert.equal(r.status, 403);
    assert.equal((await call(k.base, 'POST', '/api/v1/auth/reauth')).status, 401);
    const staff = await browserSignIn(k, STAFF_HOST, fresh());
    assert.equal(
      (
        await call(k.base, 'POST', '/api/v1/auth/reauth', {
          cookie: `__Host-sid=${staff.sid}`,
          headers: { origin: `https://${STAFF_HOST}` },
        })
      ).status,
      403,
      'no CSRF token',
    );
  });
});
