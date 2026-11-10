// TC-ID-01..12 (TEST-CASES 4): identity, sign-in and sessions on ENV-INT/ci against the REAL built API, the real database and
// the fixture IdPs (the identity slice's conformance IdP). The portal hosts' managed sign-in (patient pool, Cognito hosted page)
// and Google Workspace 2SV are not in ci: those parts stay BLOCKED / Pending-human and are never mocked as a pass (TEST-CASES 0.2).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { login, anonymous, newPatient, newStaff, sql, closeAdmin, stateOf, Client, clinical, newDoctor, A1, until, sleep } from './lib/ctx.mjs';

after(() => closeAdmin());

const st = () => stateOf();
const staffOrigin = () => `https://${st().staffHost}`;
const problem = (r) => r.json?.code;

/** One sign-in with chosen IdP claims. Returns the client and the status of GET /auth/session afterwards. */
async function signInWith(query, { client } = {}) {
  const s = st();
  const ctl = await fetch(`http://127.0.0.1:${s.ports.staffIdp + 1}/next?${query}`);
  assert.ok(ctl.ok, 'the QA-03 IdP control answers (tests/api/identity/lib/idp-control.mjs)');
  const c = client ?? new Client(staffOrigin(), 'probe');
  const start = await c.send('GET', '/api/v1/auth/sign-in?returnTo=/', { follow: 10 });
  const session = await c.send('GET', '/api/v1/auth/session');
  return { c, start, session };
}
/** Test clock control on the throwaway database: the trigger that freezes auth_time is switched off for one statement. */
async function ageSignIn(principalId, interval) {
  await sql(`ALTER TABLE identity.session DISABLE TRIGGER USER`);
  try {
    await sql(`UPDATE identity.session SET auth_time = now() - $2::interval WHERE principal_id = $1 AND revoked_at IS NULL`, [principalId, interval]);
  } finally {
    await sql(`ALTER TABLE identity.session ENABLE TRIGGER USER`);
  }
}
const countRows = async () => ({
  sessions: (await sql(`SELECT count(*)::int n FROM identity.session`)).rows[0].n,
  principals: (await sql(`SELECT count(*)::int n FROM identity.principal`)).rows[0].n,
  persons: (await sql(`SELECT count(*)::int n FROM identity.person`)).rows[0].n,
});

describe('TC-ID identity, sign-in and sessions', () => {
  test('TC-ID-01 patient sign-up with an e-mail OTP', { skip: 'BLOCKED: sign-up and the OTP are the managed patient pool (hosted page); no pool and no e-mail/SMS sandbox in ENV-INT/ci (TEST-CASES 0.3, DEVOPS-PLAN 3.5). Needs ENV-INT/staging after the staging apply. Not mocked.' }, () => {});

  test('TC-ID-02 wrong OTP five times, then right, then a used OTP', { skip: 'BLOCKED: the OTP is checked by the managed pool, not by this API. The API-side limit on failed callbacks is asserted in TC-ID-11 step 1. OTP wording and rate limit need ENV-INT/staging.' }, () => {});

  test('TC-ID-03 second factor demanded for a patient', { skip: 'Pending-human (AUTO+H): the second factor is a passkey ceremony on a real device in the managed pool. The script half (the API accepts only a session minted from a completed pool sign-in) is TC-ID-10/11.' }, () => {});

  test('TC-ID-03b hosted-page OTP paste/autofill, MFA at sign-up, passkey first', { skip: 'PENDING-HUMAN: stays pending until a real person runs it after the staging apply (TEST-CASES TC-ID-03b); a written case is not evidence.' }, () => {});

  test('TC-ID-04 staff sign-in is Google only: session realm google / audience staff, no local-password route', async () => {
    const fd = await login('staff', 'STF-FD-A');
    assert.equal(fd.sessionStatus, 200, 'the staff persona signs in through the real OIDC callback');
    assert.equal(fd.session.realm, 'google');
    assert.equal(fd.session.audience, 'staff');
    const anon = anonymous('staff');
    for (const p of ['password', 'password-reset', 'forgot-password', 'login', 'reset', 'register', 'sign-up', 'set-password', 'change-password']) {
      for (const method of ['GET', 'POST']) {
        const r = method === 'GET' ? await anon.get(`/api/v1/auth/${p}`) : await anon.post(`/api/v1/auth/${p}`, { email: 'x@example.com', password: 'x' }, { bearerless: true });
        assert.ok([404, 405].includes(r.status), `${method} /auth/${p} must not exist (got ${r.status})`);
      }
    }
    // the sign-in start only redirects to the IdP: there is no form to post a credential to
    const start = await anon.send('GET', '/api/v1/auth/sign-in?returnTo=/');
    assert.equal(start.status, 302);
    assert.match(String(start.headers.location), /authorize\?/);
    // Not shown here (needs a real Workspace test device): that 2SV was completed (HUMAN half of AUTO+H).
  });

  test('TC-ID-05 a staff account without 2SV cannot sign in', { skip: 'BLOCKED (AUTO+H): refusal comes from the Workspace 2SV enforcement policy only; `hd` / `email_verified` cannot detect it, so a local claim check would be false evidence. Needs the Workspace test tenant (not provisioned).' }, () => {});

  test('TC-ID-06 an ID token from outside the allowed domain, or with email_verified=false, is refused and creates nothing', async () => {
    const before = await countRows();
    const base = 'sub=sub-STF-FD-A&email=stf-fd-a@example.com';
    const positive = await signInWith(base);
    assert.equal(positive.session.status, 200, 'positive control: the same persona with a valid token signs in');
    const cases = [
      ['hd outside the allowed domain', `${base}&hd=evil.example.org`],
      ['no hd claim', `${base}&hd=none`],
      ['email_verified=false', `${base}&ev=false`],
    ];
    for (const [name, q] of cases) {
      const { c, session } = await signInWith(q);
      assert.equal(session.status, 401, `${name}: no session`);
      assert.equal([...c.jar.keys()].filter((k) => k.includes('sid')).length, 0, `${name}: no session cookie is issued`);
    }
    const after2 = await countRows();
    assert.equal(after2.sessions, before.sessions + 1, 'only the positive control created a session');
    assert.equal(after2.principals, before.principals, 'no principal was provisioned for a refused token');
    assert.equal(after2.persons, before.persons, 'no person was created for a refused token');
    // Observation (not asserted): the case text expects a `denied` audit event for the refusal. Unauthenticated sign-in failures
    // cannot write audit.event by design (the `anonymous` audience, AUD-N1), so none exists. Reported as QA03-O-01.
  });


  test('TC-ID-06b every kind of invalid ID token is refused by the callback: wrong nonce, audience, issuer or authorised party, expired, future, bad signature, alg none/HS256, unknown key, no nonce', async () => {
    const before = await countRows();
    const base = 'sub=sub-STF-FD-A&email=stf-fd-a@example.com';
    for (const defect of ['wrong_nonce', 'wrong_aud', 'wrong_iss', 'wrong_azp', 'expired', 'future_iat', 'bad_signature', 'alg_none', 'alg_hs256', 'unknown_kid', 'no_nonce', 'token_error']) {
      const { c, session } = await signInWith(`${base}&defect=${defect}`);
      assert.equal(session.status, 401, `${defect}: no session`);
      assert.equal([...c.jar.keys()].filter((k) => k.includes('sid')).length, 0, `${defect}: no session cookie`);
    }
    assert.equal((await countRows()).sessions, before.sessions, 'no session row was created by any of them');
    assert.equal((await signInWith(base)).session.status, 200, 'positive control: the same persona with a valid token signs in');
  });

  test('TC-ID-08b a re-authentication (prompt=login, max_age) refuses a stale auth_time and accepts a fresh one', async () => {
    const staff = await login('staff', 'STF-DR-A1');
    const base = 'sub=sub-STF-DR-A1&email=stf-dr-a1@example.com';
    const reauth = async (query) => {
      await fetch(`http://127.0.0.1:${st().ports.staffIdp + 1}/next?${query}`);
      const r = await staff.post('/api/v1/auth/reauth', {});
      assert.equal(r.status, 302, r.text);
      assert.match(String(r.headers.location), /prompt=login/);
      assert.match(String(r.headers.location), /max_age=300/);
      let res = await staff.send('GET', r.headers.location);
      res = await staff.send('GET', res.headers.location);
      return { callback: res, session: await staff.get('/api/v1/auth/session') };
    };
    const stale = await reauth(`${base}&auth_time=${Math.floor(Date.now() / 1000) - 3600}`);
    assert.equal(stale.callback.status, 401, 'a token whose auth_time is older than max_age is refused');
    const fresh = await reauth(`${base}&auth_time=${Math.floor(Date.now() / 1000)}`);
    assert.equal(fresh.callback.status, 302, 'a fresh auth_time is accepted');
    assert.equal(fresh.session.status, 200);
    // Observation (designed, BQ-8): a token WITHOUT auth_time is accepted on re-authentication because the request carried prompt=login.
  });

  test('TC-ID-07 Workspace policy export', { skip: 'OPS + HUMAN: evidence is the owner/DevOps policy export dated within 30 days; QA reads it. Not a script. Pending-human.' }, () => {});

  test('TC-ID-08 signing a note needs a fresh sign-in; a stale one is refused and leaves the draft intact', async () => {
    const v = await clinical.visit();
    await clinical.checkIn(v);
    const c = await clinical.docClient(v.doc);
    const enc = await c.post('/api/v1/encounters', { reservationId: v.reservationId });
    assert.equal(enc.status, 201, `encounter ${enc.status} ${enc.text.slice(0, 200)}`);
    const note = await c.post(`/api/v1/encounters/${enc.json.id}/notes`, {});
    assert.equal(note.status, 201);
    const saved = await c.patch(`/api/v1/notes/${note.json.id}`, { sections: { subjective: 'draft text (synthetic)' } }, { headers: { 'if-match': clinical.W(note.json.version) } });
    assert.equal(saved.status, 200, saved.text);
    // The sign-in becomes older than the allowed age: the session's auth_time is moved back (test clock control).
    await ageSignIn(v.doc.id, '3 days');
    const stale = await c.post(`/api/v1/notes/${note.json.id}/sign`, {}, { headers: { 'if-match': clinical.W(saved.json.version) } });
    assert.equal(stale.status, 401, stale.text);
    assert.equal(problem(stale), 'auth.reauth_required');
    const row = await sql(`SELECT status FROM clinical.note WHERE id = $1`, [note.json.id]);
    assert.equal(row.rows[0].status, 'draft', 'cancelling or failing re-auth leaves the note unsigned');
    const kept = await c.get(`/api/v1/notes/${note.json.id}`);
    assert.equal(kept.json?.body?.sections?.subjective, 'draft text (synthetic)', 'the draft is intact');
    // A fresh sign-in (the real callback) then signs.
    const fresh = await login('staff', v.doc.key);
    const ok = await fresh.post(`/api/v1/notes/${note.json.id}/sign`, {}, { headers: { 'if-match': clinical.W(saved.json.version) } });
    assert.equal(ok.status, 200, `${ok.status} ${ok.text.slice(0, 200)}`);
    assert.equal(ok.json.status, 'signed');
    // Not shown: the browser prompt and the Google forced re-authentication (prompt=login) need a real Workspace tenant (HUMAN half).
  });

  test('TC-ID-09 idle timeout: before it the action works and the timer resets; after it the action is refused and the server session is gone', async () => {
    const v = await clinical.visit();
    await clinical.checkIn(v);
    const c = await clinical.docClient(v.doc);
    const enc = await c.post('/api/v1/encounters', { reservationId: v.reservationId });
    const note = await c.post(`/api/v1/encounters/${enc.json.id}/notes`, {});
    const saved = await c.patch(`/api/v1/notes/${note.json.id}`, { sections: { subjective: 'unsaved text kept' } }, { headers: { 'if-match': clinical.W(note.json.version) } });
    assert.equal(saved.status, 200);
    const sid = c.jar.get('__Host-sid');
    const idle = (await sql(`SELECT idle_expires_at - now() AS left, extract(epoch from idle_expires_at - created_at) / 60 AS minutes FROM identity.session WHERE principal_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [v.doc.id])).rows[0];
    assert.ok(Math.abs(Number(idle.minutes) - 15) < 1.5, `staff idle timeout is the 15 minute default (got ${idle.minutes})`);
    // Just before the timeout: 30 seconds left and the last touch more than a minute ago.
    await sql(`UPDATE identity.session SET idle_expires_at = now() + interval '30 seconds', last_interaction_at = now() - interval '2 minutes' WHERE principal_id=$1 AND revoked_at IS NULL`, [v.doc.id]);
    const act = await c.get(`/api/v1/notes/${note.json.id}`);
    assert.equal(act.status, 200, 'before the timeout the action works');
    const reset = (await sql(`SELECT extract(epoch from idle_expires_at - now()) / 60 AS minutes FROM identity.session WHERE principal_id=$1 AND revoked_at IS NULL`, [v.doc.id])).rows[0];
    assert.ok(Number(reset.minutes) > 13, `the timer reset after the action (about 15 minutes left, got ${reset.minutes})`);
    // Past the timeout.
    await sql(`UPDATE identity.session SET idle_expires_at = now() - interval '1 second' WHERE principal_id=$1 AND revoked_at IS NULL`, [v.doc.id]);
    const gone = await c.get(`/api/v1/notes/${note.json.id}`);
    assert.equal(gone.status, 401, gone.text);
    const replay = new Client(staffOrigin(), 'replay');
    replay.jar.set('__Host-sid', sid);
    assert.equal((await replay.get('/api/v1/auth/session')).status, 401, 'a replayed cookie gets 401: the server-side session is gone');
    const dbState = (await sql(`SELECT revoked_at, revoke_reason FROM identity.session WHERE principal_id=$1 ORDER BY created_at DESC LIMIT 1`, [v.doc.id])).rows[0];
    assert.ok(dbState, 'session row still present for audit');
    const again = await login('staff', v.doc.key);
    const draft = await again.get(`/api/v1/notes/${note.json.id}`);
    assert.equal(draft.json?.body?.sections?.subjective, 'unsaved text kept', 'the draft text is preserved after re-authentication');
  });

  test('TC-ID-10 a session is bound to one audience; cookies are __Host-, Secure, HttpOnly and SameSite', async () => {
    const staff = await login('staff', 'STF-FD-A');
    const pat = await newPatient();
    const staffCookieOnPatientHost = new Client(pat.client.origin, 'x');
    staffCookieOnPatientHost.jar.set('__Host-sid', staff.jar.get('__Host-sid'));
    const patientCookieOnStaffHost = new Client(staff.origin, 'y');
    patientCookieOnStaffHost.jar.set('__Host-sid', pat.client.jar.get('__Host-sid'));
    const patientOnly = ['/api/v1/me'];
    const staffOnly = ['/api/v1/patients/search', '/api/v1/alerts'];
    for (const p of patientOnly) {
      const r = await staffCookieOnPatientHost.get(p);
      assert.ok([401, 403].includes(r.status), `staff session on ${p}: ${r.status}`);
      assert.equal((await pat.client.get(p)).status, 200, `positive control: the patient session opens ${p}`);
    }
    for (const p of staffOnly) {
      const r = await patientCookieOnStaffHost.get(p);
      assert.ok([401, 403].includes(r.status), `patient session on ${p}: ${r.status}`);
      assert.notEqual((await staff.get(p)).status, 403, `positive control: the staff session is not refused on ${p}`);
    }
    const r = await staffCookieOnPatientHost.get('/api/v1/me');
    assert.equal(r.json?.code, 'auth.forbidden');
    // cookie attributes straight from the sign-in response
    const probe = await signInWith('sub=sub-STF-FD-A&email=stf-fd-a@example.com');
    assert.equal(probe.session.status, 200);
    const raw = await (async () => {
      const s = st();
      const c = new Client(staffOrigin(), 'attrs');
      await fetch(`http://127.0.0.1:${s.ports.staffIdp + 1}/next?sub=sub-STF-FD-A&email=stf-fd-a@example.com`);
      const out = [];
      let res = await c.send('GET', '/api/v1/auth/sign-in?returnTo=/');
      res = await c.send('GET', res.headers.location);
      const cb = await c.send('GET', res.headers.location);
      out.push(...[].concat(cb.headers['set-cookie'] ?? []));
      return out;
    })();
    const sid = raw.find((x) => x.startsWith('__Host-sid='));
    assert.ok(sid, `the session cookie is __Host- prefixed (got ${raw.map((x) => x.split('=')[0]).join(',')})`);
    assert.match(sid, /;\s*Secure/i);
    assert.match(sid, /;\s*HttpOnly/i);
    assert.match(sid, /;\s*SameSite=(Strict|Lax)/i);
    assert.match(sid, /;\s*Path=\//i);
    assert.doesNotMatch(sid, /;\s*Domain=/i, '__Host- cookies carry no Domain');
  });

  test('TC-ID-11 brute force is rate limited, answers are identical for any failure, the session id changes at login, CSRF is refused', async () => {
    // 1. brute force on the callback from one address: 429 + Retry-After at the limit, generic body before it
    const ip = `10.77.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`; // a fresh synthetic source address per run
    const attacker = anonymous('staff', { ip });
    const bodies = new Set();
    let limited;
    for (let i = 0; i < 70 && !limited; i++) {
      const r = await attacker.get(`/api/v1/auth/callback?code=wrong${i}&state=bogus${i}`);
      if (r.status === 429) limited = r;
      else {
        assert.equal(r.status, 401, `failure ${i}`);
        bodies.add(r.text.replace(/[0-9a-f-]{36}/g, ''));
      }
    }
    assert.ok(limited, 'the callback is rate limited after repeated failures');
    assert.ok(limited.headers['retry-after'], '429 carries Retry-After (CN-11)');
    assert.equal(bodies.size, 1, 'the failure page is identical every time');
    // 2. user enumeration: a known and an unknown account fail identically (token refused vs unknown subject)
    const known = await signInWith('sub=sub-STF-FD-A&email=stf-fd-a@example.com&ev=false');
    const unknown = await signInWith('sub=sub-NOBODY-AT-ALL&email=nobody@evil.example&ev=false', { client: new Client(staffOrigin(), 'enum2') });
    assert.equal(known.session.status, 401);
    assert.equal(unknown.session.status, 401);
    const norm = (r) => r.start.text.replace(/[0-9a-f-]{36}/g, '');
    assert.equal(norm(known), norm(unknown), 'the response is identical for a known and an unknown account');
    // 3. session fixation: a pre-login session cookie is not adopted
    const fx = new Client(staffOrigin(), 'fixation');
    fx.jar.set('__Host-sid', 'pre-login-attacker-chosen-value');
    const login1 = await signInWith('sub=sub-STF-FD-A&email=stf-fd-a@example.com', { client: fx });
    assert.equal(login1.session.status, 200);
    assert.notEqual(fx.jar.get('__Host-sid'), 'pre-login-attacker-chosen-value', 'the session id changes at login');
    const attackerReplay = new Client(staffOrigin(), 'fixation2');
    attackerReplay.jar.set('__Host-sid', 'pre-login-attacker-chosen-value');
    assert.equal((await attackerReplay.get('/api/v1/auth/session')).status, 401, 'the pre-login value never becomes a session');
    // 4. CSRF: a state-changing POST without the token is refused, with it works
    const pat = await newPatient();
    const noToken = await pat.client.send('POST', '/api/v1/auth/session/extend', { body: {}, headers: { origin: pat.client.origin, 'idempotency-key': 'qa03-csrf-1' } });
    assert.equal(noToken.status, 403);
    assert.equal(problem(noToken), 'auth.csrf_failed');
    const wrongToken = await pat.client.send('POST', '/api/v1/auth/session/extend', { body: {}, headers: { origin: pat.client.origin, 'idempotency-key': 'qa03-csrf-2', 'x-csrf-token': 'not-the-token' } });
    assert.equal(wrongToken.status, 403);
    const crossOrigin = await pat.client.send('POST', '/api/v1/auth/session/extend', { body: {}, headers: { origin: 'https://evil.example', 'idempotency-key': 'qa03-csrf-3', 'x-csrf-token': pat.client.session.csrfToken } });
    assert.ok([403, 401].includes(crossOrigin.status), `a foreign Origin is refused (${crossOrigin.status})`);
    const good = await pat.client.post('/api/v1/auth/session/extend', {});
    assert.equal(good.status, 200, 'positive control: with the token the same call works');
  });

  test('TC-ID-12 sign-out is server-side; the other session is not extended; one session per browser', async () => {
    const a = await login('staff', 'STF-FD-A');
    const b = await login('staff', 'STF-FD-A');
    const sidA = a.jar.get('__Host-sid');
    const sidB = b.jar.get('__Host-sid');
    assert.notEqual(sidA, sidB);
    const idleBefore = (await sql(`SELECT idle_expires_at FROM identity.session WHERE token_hash = sha256(convert_to($1,'UTF8')) OR revoked_at IS NULL ORDER BY created_at DESC LIMIT 2`, [sidB])).rows;
    void idleBefore;
    const rowsB0 = (await b.get('/api/v1/auth/session')).json.idleExpiresAt;
    const out = await a.post('/api/v1/auth/sign-out', {});
    assert.equal(out.status, 204);
    const replay = new Client(staffOrigin(), 'r');
    replay.jar.set('__Host-sid', sidA);
    assert.equal((await replay.get('/api/v1/auth/session')).status, 401, 'a replayed cookie of the signed-out session is refused');
    const stillB = await b.get('/api/v1/auth/session');
    assert.equal(stillB.status, 200, 'the other session is not signed out');
    assert.equal(stillB.json.idleExpiresAt, rowsB0, 'the other session is not silently extended by the sign-out of the first');
    // one session per browser: signing in again in the same browser (same cookie jar) revokes the old session
    const same = await login('staff', 'STF-FD-A');
    const oldSid = same.jar.get('__Host-sid');
    await fetch(`http://127.0.0.1:${st().ports.staffIdp + 1}/next?sub=sub-STF-FD-A&email=stf-fd-a@example.com`);
    await same.send('GET', '/api/v1/auth/sign-in?returnTo=/', { follow: 10 });
    const newSid = same.jar.get('__Host-sid');
    assert.notEqual(newSid, oldSid, 'a new session id');
    const oldReplay = new Client(staffOrigin(), 'old');
    oldReplay.jar.set('__Host-sid', oldSid);
    assert.equal((await oldReplay.get('/api/v1/auth/session')).status, 401, 'the browser keeps one live session: the previous one was revoked');
    void until;
    void sleep;
    void newStaff;
    void newDoctor;
    void A1;
  });
});
