// TC-SEC-C7-01..07 (TEST-CASES 5.5): the seven authorization tests of condition C7 (extend RA-R1-17, negative authorization), P0.
// Path B (D-35 default). ENV-INT/ci: real API, real database roles, the run's software authenticator for the real WebAuthn ceremonies.
// The path A branches (Google OU, super-admin, directory) need the Workspace test tenant and are not built; the path B branch of each
// item is asserted. The path B reading of items 4 and 5 is QA's reading (SEC-confirm-1), recorded in the report, not a Cybersecurity statement.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, closeAdmin, ORG, until, Client, stateOf, login, elevate, attest, assertWith } from '../identity/lib/ctx.mjs';
import { newAdmin, newAdminPerson, enrol, enrolmentSecret, signIn, AD, origin } from './lib/admins.mjs';
import { asScope, attempt } from '../authorization/lib/db.mjs';

after(() => closeAdmin());
const stamp = () => new Date(Date.now() - 800).toISOString();
const rolesOf = async (principalId) => (await sql(`SELECT r.key FROM identity.role_assignment a JOIN identity.role r ON r.id=a.role_id WHERE a.principal_id=$1 AND a.revoked_at IS NULL ORDER BY 1`, [principalId])).rows.map((r) => r.key);
const ask = (c, subject, key = 'org_admin') => c.post(`${AD}/role-change-requests`, { subjectPrincipalId: subject, add: [{ roleKey: key }] });
const withoutTriggers = async (table, fn) => {
  await sql(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    return await fn();
  } finally {
    await sql(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
};
const deniedFor = (since, principals) => sql(`SELECT action, outcome, denial_reason, resource_type FROM audit.event WHERE occurred_at >= $1 AND outcome='denied' AND actor_principal_id = ANY($2)`, [since, principals]);

describe('TC-SEC-C7 negative authorization (condition C7)', () => {
  test('TC-SEC-C7-01 role elevation without an approver never takes effect: API, replay, direct SQL and a forged approval row all fail', async () => {
    const a = await newAdmin({ name: 'C701A', elevated: true });
    const b = await newAdmin({ name: 'C701B', elevated: true });
    const subject = await newAdminPerson({ roles: [], name: 'C701S' });
    const t0 = stamp();
    const req = await ask(a.client, subject.principalId, 'compliance_officer');
    assert.equal(req.status, 200, req.text);
    const url = `${AD}/role-change-requests/${req.json.id}`;
    // 2. activate without approval: requester approves (API), replay of the request id, cancel-then-approve
    const self = await a.client.post(`${url}/approve`, {});
    assert.equal(self.status, 403);
    assert.equal(self.json.code, 'identity.self_approval');
    const replayed = await a.client.post(`${url}/approve`, {});
    assert.equal(replayed.status, 403, 'replaying the request id does not help');
    const noSuch = await a.client.post(`${AD}/role-change-requests/${randomUUID()}/approve`, {});
    assert.equal(noSuch.status, 404);
    assert.deepEqual(await rolesOf(subject.principalId), [], 'the subject holds no role after the API attempts');
    // direct SQL as the API login role under the requester's own session settings
    const scopeA = { 'app.org_id': ORG, 'app.audience': 'staff', 'app.realm': 'admin_pool', 'app.principal_id': a.principalId, 'app.person_id': a.personId };
    await asScope('app_api', scopeA, async (c) => {
      const selfSql = await attempt(c, `UPDATE identity.role_change_request SET status='approved', approver_person_id=$2, decided_at=now() WHERE id=$1`, [req.json.id, a.personId]);
      assert.equal(selfSql.ok, false, 'the requester cannot approve their own request in SQL (CHECK approver_not_requester)');
      const forgedApprover = await attempt(c, `UPDATE identity.role_change_request SET status='approved', approver_person_id=$2, decided_at=now() WHERE id=$1`, [req.json.id, b.personId]);
      assert.equal(forgedApprover.ok, false, `an approval naming another person than the session's is refused (${forgedApprover.code})`);
      const assign = await attempt(c, `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id) SELECT gen_random_uuid(), $1, $2, r.id, NULL, $3 FROM identity.role r WHERE r.key='compliance_officer'`, [ORG, subject.principalId, req.json.id]);
      assert.equal(assign.ok, false, `a role cannot be assigned under an unapproved request (${assign.code})`);
      assert.equal(assign.code, '42501');
      // 3. a forged approval row: an already-approved request inserted directly
      const forged = await attempt(c, `INSERT INTO identity.role_change_request (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, approver_person_id, decided_at, expires_at) VALUES (gen_random_uuid(), $1, $2, $3, '{"add":[],"remove":[]}', '[]', decode(repeat('ab',32),'hex'), 'approved', $4, now(), now()+interval '1 day')`, [ORG, a.personId, subject.principalId, b.personId]);
      assert.equal(forged.ok, false, `an approval row cannot be inserted directly (${forged.code})`);
      const forgedAssignment = await attempt(c, `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id) SELECT gen_random_uuid(), $1, $2, r.id, NULL, gen_random_uuid() FROM identity.role r WHERE r.key='compliance_officer'`, [ORG, subject.principalId]);
      assert.equal(forgedAssignment.ok, false, 'an assignment naming a request that does not exist is refused');
    });
    assert.deepEqual(await rolesOf(subject.principalId), [], 'the subject holds no admin permission after any attempt');
    assert.equal((await sql(`SELECT status FROM identity.role_change_request WHERE id=$1`, [req.json.id])).rows[0].status, 'requested');
    const den = await until(async () => {
      const r = await deniedFor(t0, [a.principalId]);
      return r.rowCount ? r : null;
    });
    assert.ok(den, 'the attempts are audited (denied events)');
    // positive control: a different elevated person approves and the role takes effect
    assert.equal((await b.client.post(`${url}/approve`, {})).status, 200);
    assert.deepEqual(await rolesOf(subject.principalId), ['compliance_officer']);
    // Residual (QA03-O-05, reported to Cybersecurity): the approval itself is a plain UPDATE under the approver's session settings; a
    // compromised API process could set another admin's person id. The database cannot tell, by design of the current schema (O-2).
  });

  test('TC-SEC-C7-02 self-approval: requester, subject, a second principal of the same person and a self-request are all refused', async () => {
    const a = await newAdmin({ name: 'C702A', elevated: true });
    const b = await newAdmin({ name: 'C702B', elevated: true });
    const subject = await newAdmin({ name: 'C702S', roles: ['org_admin'], elevated: true });
    const t0 = stamp();
    const r1 = await ask(a.client, subject.principalId, 'compliance_officer'); // a -> subject
    const r2 = await ask(b.client, b.principalId, 'compliance_officer'); // b requests a role for b (self-request)
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r2.status, 200, `a self-request is accepted as a request, never as an approval (${r2.status} ${r2.text.slice(0, 100)})`);
    const approve = (c, id) => c.post(`${AD}/role-change-requests/${id}/approve`, {});
    const a1 = await approve(a.client, r1.json.id);
    assert.equal(a1.json?.code, 'identity.self_approval', '(a) requester');
    const a2 = await approve(subject.client, r1.json.id);
    assert.equal(a2.json?.code, 'identity.approver_is_subject', '(b) subject');
    const a3 = await approve(b.client, r2.json.id);
    assert.ok(a3.json?.code === 'identity.self_approval' || a3.json?.code === 'identity.approver_is_subject', `the self-requested request cannot be approved by its requester and subject (${a3.json?.code})`);
    // (c) the same person through a second principal: the database refuses a second admin_pool principal for one person
    const second = await newAdminPerson({ roles: [], name: 'C702A2' });
    const dup = await sql(`UPDATE identity.principal SET person_id = $1 WHERE id = $2`, [a.personId, second.principalId]).then(() => 'allowed', (e) => e.code);
    assert.ok(dup === '23505' || dup === 'PS001', `(c) a second admin principal of one person is refused (${dup})`);
    // (d) the subject approves a request created by someone else for themselves: covered by (b)
    assert.deepEqual(await rolesOf(subject.principalId), ['org_admin']);
    assert.deepEqual(await rolesOf(b.principalId), ['org_admin']);
    const den = await until(async () => {
      const r = await deniedFor(t0, [a.principalId, subject.principalId, b.principalId]);
      return r.rowCount >= 3 ? r : null;
    });
    assert.ok(den, 'every refusal is audited as denied');
    // positive control
    const c = await newAdmin({ name: 'C702C', elevated: true });
    assert.equal((await approve(c.client, r1.json.id)).status, 200);
  });

  test('TC-SEC-C7-03 a stale or expired elevation, a stale challenge and a missing re-authentication are refused and audited; no grant is created or extended', async () => {
    const adm = await newAdmin({ name: 'C703', elevated: true });
    const grantsOf = async () => (await sql(`SELECT count(*)::int n FROM identity.elevation_grant g JOIN identity.session s ON s.id=g.session_id WHERE s.principal_id=$1`, [adm.principalId])).rows[0].n;
    const g0 = await grantsOf();
    const g = (await sql(`SELECT g.id FROM identity.elevation_grant g JOIN identity.session s ON s.id=g.session_id WHERE s.principal_id=$1 AND g.revoked_at IS NULL`, [adm.principalId])).rows[0].id;
    await withoutTriggers('identity.elevation_grant', () => sql(`UPDATE identity.elevation_grant SET issued_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute' WHERE id=$1`, [g]));
    const t0 = stamp();
    const calls = [
      adm.client.put(`${AD}/feature-flags`, { key: 'qa03_c703', enabled: true }),
      adm.client.post(`${AD}/locations`, { name: 'C703', kind: 'clinic', timeZone: 'UTC', stateCode: 'NY' }),
    ];
    for (const r of await Promise.all(calls)) {
      assert.equal(r.status, 403);
      assert.equal(r.json.code, 'identity.elevation_required');
    }
    assert.equal(await grantsOf(), g0, 'no grant was created or extended by the refused calls');
    const exp = (await sql(`SELECT expires_at FROM identity.elevation_grant WHERE id=$1`, [g])).rows[0].expires_at;
    assert.ok(exp < new Date(), 'the expired grant was not extended');
    // a stale challenge (older than its life) cannot be used to get a new grant
    const o = await adm.client.post(`${AD}/auth/elevation/options`, {});
    await withoutTriggers('identity.webauthn_challenge', () => sql(`UPDATE identity.webauthn_challenge SET expires_at = now() - interval '1 second' WHERE id=$1`, [o.json.challengeId]));
    const a = await assertWith(o.json.publicKey ?? o.json);
    const stale = await adm.client.post(`${AD}/auth/elevation/verify`, { challengeId: o.json.challengeId, assertion: a.json });
    assert.ok(stale.status === 401 || stale.status === 403, `a stale challenge is refused (${stale.status})`);
    assert.equal(await grantsOf(), g0);
    // an assertion for another origin / rp id (the server's own relying-party check, F-1)
    const o2 = await adm.client.post(`${AD}/auth/elevation/options`, {});
    const bad = await assertWith(o2.json.publicKey ?? o2.json, { origin: 'https://evil.example', rpId: 'evil.example' });
    if (bad.status === 200) {
      const r = await adm.client.post(`${AD}/auth/elevation/verify`, { challengeId: o2.json.challengeId, assertion: bad.json });
      assert.ok(r.status === 401 || r.status === 403, `a foreign-origin assertion is refused (${r.status})`);
    }
    assert.equal(await grantsOf(), g0, 'still no new grant');
    const den = await until(async () => {
      const r = await deniedFor(t0, [adm.principalId]);
      return r.rowCount ? r : null;
    });
    assert.ok(den, 'every stale or expired attempt is audited as denied');
    // positive control: a fresh assertion gives a new grant
    assert.equal((await elevate(adm.client)).status, 200);
    assert.equal(await grantsOf(), g0 + 1);
  });

  test('TC-SEC-C7-04 (path B) a google principal cannot hold a privileged role; a disabled admin cannot be given one', async () => {
    const a = await newAdmin({ name: 'C704A', elevated: true });
    const google = (await sql(`SELECT id FROM identity.principal WHERE subject = 'sub-STF-FD-A'`)).rows[0].id;
    for (const role of ['org_admin', 'compliance_officer', 'compliance_on_call']) {
      const r = await ask(a.client, google, role);
      assert.equal(r.status, 422, `${role}: ${r.status} ${r.text.slice(0, 120)}`);
      assert.equal(r.json.code, 'identity.privileged_role_in_staff_realm');
    }
    assert.deepEqual(await rolesOf(google), ['front_desk'], 'the google principal holds only its own staff role');
    // an admin who was put out (kill switch -> disabled) cannot be given a role afterwards
    const out = await newAdmin({ name: 'C704OUT', roles: [] });
    const k = await a.client.post(`${AD}/principals/${out.principalId}/kill-switch`, { reason: 'qa03 c7-04 leaver' });
    assert.equal(k.status, 200, k.text);
    const r = await ask(a.client, out.principalId, 'compliance_officer');
    assert.equal(r.status, 422, `a disabled principal cannot receive a role (${r.status} ${r.text.slice(0, 100)})`);
    assert.equal((await sql(`SELECT count(*)::int n FROM identity.role_change_request WHERE subject_principal_id=$1`, [out.principalId])).rows[0].n, 0, 'no request was created');
    // Path A branch (OU membership, hourly directory re-check, directory API unreachable) is BLOCKED: no Workspace test tenant and the
    // directory reconciliation job is not built. The path B step "suspend the linked staff identity, run leaver detection" is the open
    // question SEC-confirm-1 (Cybersecurity decides whether a backstop exists); not asserted.
  });

  test('TC-SEC-C7-05 (path B) a staff identity cannot receive an admin or compliance role even with a valid approver', async () => {
    const a = await newAdmin({ name: 'C705A', elevated: true });
    const b = await newAdmin({ name: 'C705B', elevated: true });
    const staff = await newAdmin({ name: 'C705S', roles: [] });
    // QA's reading of "super-admin": any google principal (a Workspace super-admin signs in as google); the rule is on the realm, so no approval matters
    const google = (await sql(`SELECT id FROM identity.principal WHERE subject = 'sub-STF-DR-A1'`)).rows[0].id;
    const t0 = stamp();
    const requests = async () => (await sql(`SELECT count(*)::int n FROM identity.role_change_request WHERE subject_principal_id=$1`, [google])).rows[0].n;
    const had = await requests();
    for (const role of ['org_admin', 'compliance_officer']) {
      const r = await ask(a.client, google, role);
      assert.equal(r.status, 422);
      assert.equal(r.json.code, 'identity.privileged_role_in_staff_realm');
    }
    assert.equal(await requests(), had, 'no request was created, so there is nothing for an approver to approve');
    // direct SQL: an approved request cannot be forged to carry it either
    const asApi = { 'app.org_id': ORG, 'app.audience': 'staff', 'app.realm': 'admin_pool', 'app.principal_id': b.principalId, 'app.person_id': b.personId };
    await asScope('app_api', asApi, async (c) => {
      const x = await attempt(c, `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id) SELECT gen_random_uuid(), $1, $2, r.id, NULL, gen_random_uuid() FROM identity.role r WHERE r.key='org_admin'`, [ORG, google]);
      assert.equal(x.ok, false, `a privileged role cannot be written onto a google principal (${x.code})`);
    });
    assert.deepEqual(await rolesOf(google), ['doctor']);
    void staff;
    void t0;
    // Open question SEC-confirm-1: whether the same human may hold BOTH a google identity and an admin_pool identity on path B is
    // allowed by the schema (one principal per person per realm). QA records the answer given by Cybersecurity when it arrives.
  });

  test('TC-SEC-C7-06 a Workspace group claim never grants an app role: a token carrying an admin group still signs in as the same staff member with the same roles', async () => {
    const s = stateOf();
    const before = (await login('staff', 'STF-FD-A')).session;
    const c = new Client(`https://${s.staffHost}`, 'grp');
    await fetch(`http://127.0.0.1:${s.ports.staffIdp + 1}/next?sub=sub-STF-FD-A&email=stf-fd-a@example.com&groups=app-admins,admins,org_admin`);
    await c.send('GET', '/api/v1/auth/sign-in?returnTo=/', { follow: 10 });
    const sess = await c.get('/api/v1/auth/session');
    assert.equal(sess.status, 200, 'positive control: the sign-in itself works with the extra claim');
    assert.deepEqual(sess.json.roles, before.roles, 'the roles did not change');
    assert.deepEqual([...sess.json.permissions].sort(), [...before.permissions].sort(), 'the permissions did not change');
    assert.equal(sess.json.realm, 'google');
    for (const p of ['/principals', '/roles', '/btg-grants', '/feature-flags']) {
      const r = await c.get(`${AD}${p}`);
      assert.ok([401, 403, 404].includes(r.status), `admin ${p} stays refused (${r.status})`);
    }
    const w = await c.post(`${AD}/role-change-requests`, { subjectPrincipalId: randomUUID(), add: [{ roleKey: 'org_admin' }] });
    assert.ok([401, 403, 404].includes(w.status));
    assert.deepEqual(await sql(`SELECT 1 FROM identity.role_assignment a JOIN identity.role r ON r.id=a.role_id WHERE r.privileged AND a.principal_id=$1`, [sess.json.principalId]).then((r) => r.rows), []);
    // The Workspace group sync / "eligible" step is not built; only the claim half is asserted. The group-change-in-Workspace half needs the
    // test tenant (BLOCKED).
  });

  test('TC-SEC-C7-07 the kill switch ends an elevated session even while its privileged request is in flight: no partial change, old cookie and grant are useless, alert and audit exist', async () => {
    const killer = await newAdmin({ name: 'C707K', elevated: true });
    for (let round = 0; round < 4; round++) {
      const target = await newAdmin({ name: `C707T${round}`, elevated: true });
      const key = `qa03_c707_${round}_${randomUUID().slice(0, 6)}`;
      const sid = target.client.jar.get('__Host-sid');
      const gid = (await sql(`SELECT g.id FROM identity.elevation_grant g JOIN identity.session s ON s.id=g.session_id WHERE s.principal_id=$1 AND g.revoked_at IS NULL`, [target.principalId])).rows[0].id;
      const t0 = stamp();
      // fire the privileged request and the kill switch together, in both orders over the rounds
      const act = () => target.client.put(`${AD}/feature-flags`, { key, enabled: true });
      const kill = () => killer.client.post(`${AD}/principals/${target.principalId}/kill-switch`, { reason: `qa03 c7-07 round ${round}` });
      const [first, second] = round % 2 === 0 ? await Promise.all([act(), kill()]) : (await Promise.all([kill(), act()])).reverse();
      const killRes = round % 2 === 0 ? second : first;
      const actRes = round % 2 === 0 ? first : second;
      assert.equal(killRes.status, 200, killRes.text);
      assert.ok([200, 401, 403].includes(actRes.status), `the in-flight request completes or fails cleanly (${actRes.status})`);
      const row = await sql(`SELECT 1 FROM organisation.feature_flag WHERE key=$1`, [key]);
      assert.equal(row.rowCount, actRes.status === 200 ? 1 : 0, `no partial change: status ${actRes.status} and ${row.rowCount} row(s)`);
      // everything after is refused
      const after = await act();
      assert.equal(after.status, 401, 'the next privileged request is refused');
      assert.equal((await target.client.get('/api/v1/auth/session')).status, 401);
      const old = new Client(origin(), 'old');
      old.jar.set('__Host-sid', sid);
      assert.equal((await old.put(`${AD}/feature-flags`, { key: `${key}b`, enabled: true }, { headers: { 'x-elevation-grant': gid } })).status, 401, 'old cookie + old grant id are useless');
      assert.equal((await sql(`SELECT 1 FROM organisation.feature_flag WHERE key=$1`, [`${key}b`])).rowCount, 0);
      const grant = (await sql(`SELECT revoked_at, revoke_reason FROM identity.elevation_grant WHERE id=$1`, [gid])).rows[0];
      assert.ok(grant.revoked_at && grant.revoke_reason === 'kill_switch', 'the grant was revoked by the kill switch');
      const audited = await until(async () => {
        const r = await sql(`SELECT 1 FROM audit.event WHERE occurred_at >= $1 AND action='kill_switch' AND resource_id=$2`, [t0, target.principalId]);
        return r.rowCount ? r : null;
      });
      assert.ok(audited, 'audit event exists');
      const alert = await until(async () => {
        const r = await sql(`SELECT 1 FROM notifications.staff_alert WHERE type='kill_switch_used' AND created_at >= $1`, [t0]);
        return r.rowCount ? r : null;
      }, { timeoutMs: 30000 });
      assert.ok(alert, 'the compliance alert exists');
    }
  });
});
void signIn;
void enrol;
void enrolmentSecret;
void attest;
