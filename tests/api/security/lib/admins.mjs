// Fresh admin-realm people for the QA-03 suites (ENV-INT/ci): a person, an admin_pool principal, roles through the real
// requested -> approved -> applied request states, an approved single-use enrolment token with a secret the test chooses, and the
// REAL enrolment, sign-in and elevation ceremonies against the API with the run's software authenticator. Nothing is bypassed:
// the fixtures use the same database writes as the stack's own seeding (tests/api/platform/lib/seed.mjs).
import { randomUUID, randomBytes } from 'node:crypto';
import { admin, sqlTx, ORG, stateOf, Client, GRANTOR, newEnrolmentToken, attest, assertWith, elevate } from '../../identity/lib/ctx.mjs';
import { grantRole } from '../../platform/lib/seed.mjs';

const AD = '/api/v1/admin';
const origin = () => `https://${stateOf().staffHost}`;

/** A custom admin_pool role (non-privileged unless asked) holding exactly the named permissions. */
export async function newRole(permissions, { privileged = false } = {}) {
  const key = `qa03_${randomBytes(4).toString('hex')}`;
  const id = randomUUID();
  await sqlTx(async (c) => {
    await c.query(`INSERT INTO identity.role (id, organisation_id, key, realm, privileged, location_bound, description) VALUES ($1,$2,$3,'admin_pool',$4,false,'QA-03 synthetic role')`, [id, ORG, key, privileged]);
    for (const p of permissions) await c.query(`INSERT INTO identity.role_permission (organisation_id, role_id, permission_key) VALUES ($1,$2,$3)`, [ORG, id, p]);
  });
  return key;
}

/** Creates the person, principal and role; returns ids and the handle (the principal's subject). Not enrolled yet. */
export async function newAdminPerson({ roles = ['org_admin'], name = 'ADM' } = {}) {
  const personId = randomUUID();
  const principalId = randomUUID();
  const handle = `${name.toLowerCase()}-${randomBytes(4).toString('hex')}`;
  await sqlTx(async (c) => {
    await c.query(`INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,$3)`, [personId, ORG, `Synthetic ${name} ${handle}`]);
    await c.query(`INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, status) VALUES ($1,$2,$3,'admin_pool',$4,'active')`, [principalId, ORG, personId, handle]);
    for (const r of roles) await grantRole(c, principalId, r, null);
  });
  return { personId, principalId, handle, name };
}

/** Approved single-use enrolment token (30 minutes) with a secret we choose; the two people are the fixed grantors. */
export async function enrolmentSecret(p) {
  const secret = randomBytes(32).toString('base64url');
  const sa = await admin();
  await newEnrolmentToken(sa, { principalId: p.principalId }, { personId: GRANTOR.requester.person }, { personId: GRANTOR.approver.person }, secret);
  return secret;
}

const adopt = (c, r) => {
  if (r.status === 200 && r.json?.csrfToken) c.session = { ...(c.session ?? {}), ...r.json };
  return r;
};

/** The real enrolment ceremony (token, first key, second key). Returns the signed-in client. */
export async function enrol(p, secret) {
  const c = new Client(origin(), p.handle);
  const o1 = await c.post(`${AD}/auth/enrolment/options`, { handle: p.handle, token: secret }, { bearerless: true });
  if (o1.status !== 200) throw new Error(`enrolment options ${o1.status} ${o1.text}`);
  const a1 = await attest(o1.json.publicKey);
  const v1 = await c.post(`${AD}/auth/enrolment/verify`, { challengeId: o1.json.challengeId, handle: p.handle, token: secret, attestation: a1.json }, { bearerless: true });
  if (v1.status !== 200) throw new Error(`enrolment verify ${v1.status} ${v1.text}`);
  adopt(c, v1);
  const o2 = await c.post(`${AD}/auth/enrolment/second-key/options`, {});
  if (o2.status !== 200) throw new Error(`second key options ${o2.status} ${o2.text}`);
  const a2 = await attest(o2.json.publicKey);
  const v2 = await c.post(`${AD}/auth/enrolment/second-key/verify`, { challengeId: o2.json.challengeId, attestation: a2.json });
  if (v2.status !== 200) throw new Error(`second key verify ${v2.status} ${v2.text}`);
  return c;
}

/** Signs in a fresh browser (client) for an enrolled admin with the real key. */
export async function signIn(p, client = new Client(origin(), p.handle)) {
  const opt = await client.post(`${AD}/auth/sign-in/options`, { handle: p.handle }, { bearerless: true });
  if (opt.status !== 200) return { client, response: opt };
  const a = await assertWith(opt.json.publicKey ?? opt.json);
  if (a.status !== 200) return { client, response: { status: 401, json: a.json, text: 'no key' } };
  const ver = await client.post(`${AD}/auth/sign-in/verify`, { challengeId: opt.json.challengeId, handle: p.handle, assertion: a.json }, { bearerless: true });
  adopt(client, ver);
  return { client, response: ver };
}

/** New admin person, enrolled and signed in; `elevated: true` also takes the elevation grant. */
export async function newAdmin({ roles = ['org_admin'], name = 'ADM', elevated = false } = {}) {
  const p = await newAdminPerson({ roles, name });
  const secret = await enrolmentSecret(p);
  const client = await enrol(p, secret);
  p.client = client;
  p.secret = secret;
  if (elevated) {
    const e = await elevate(client);
    if (e.status !== 200) throw new Error(`elevation ${e.status} ${e.text}`);
  }
  return p;
}
export { AD, origin };
