// Harness of the BE-05 real-database tests: the BE-04 kit (throwaway database migrated by the real pipeline, real reference
// data, real queue), plus the admin realm wired the way the application entry point wires it, and a software authenticator.
// Not a test file; imported by the *.dbtest.ts files.
import { createHash, randomBytes } from 'node:crypto';
import { createLogger, Queue, syncTaskTypes } from '@ehr/kernel';
import { createApp } from '../../../platform/app.js';
import { csrfTokenFor } from '../auth.controller.js';
import { GoogleRealmAdapter, OidcPatientAdapter } from '../realms.js';
import { createIdentity } from '../runtime.js';
import {
  assignRole,
  call,
  clock,
  CSRF_KEY,
  now,
  OIDC_KEY,
  ORG,
  PATIENT_HOST,
  pg,
  queuedJobs,
  RATE_KEY,
  seedPrincipal,
  setup,
  STAFF_HOST,
  WORKSPACE,
} from '../testkit.js';
import type { Kit, Resp, Seeded } from '../testkit.js';
import { cookieValue } from '../testkit.js';
import { createIdentityAdmin } from './index.js';
import type { IdentityAdmin } from './index.js';
import { IDENTITY_ADMIN_JOBS } from './jobs.js';
import { SoftKey } from './softkey.js';
import { SID_COOKIE, sha256 } from '../tokens.js';

export {
  clock,
  now,
  ORG,
  STAFF_HOST,
  call,
  queuedJobs,
  cookieValue,
  SoftKey,
  csrfTokenFor,
  CSRF_KEY,
};

export const ORIGIN = `https://${STAFF_HOST}`;
export const AAGUID_OK = '2fc0579f-8113-47ea-b116-bb5a8db9202a';
export const DECOY_KEY = 'decoy-key-for-tests-0123456789abcdef';

export interface AdminKit extends Kit {
  admin: IdentityAdmin;
  adminBase: string;
  close(): Promise<void>;
}

export async function adminSetup(name: string): Promise<AdminKit> {
  const kit = await setup({ name, withApp: false });
  for (const j of IDENTITY_ADMIN_JOBS) kit.registry.defineJob(j);
  const wc = new pg.Client({ connectionString: kit.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, kit.registry);
  await wc.end();

  const logger = createLogger({ sink: () => undefined });
  const queue = new Queue(kit.registry, 'api');
  const admin = createIdentityAdmin({
    db: kit.db,
    queue,
    audit: kit.audit,
    sessions: kit.identity.sessions,
    logger,
    config: {
      orgId: ORG,
      ceremony: { rpId: STAFF_HOST, rpName: 'EHR admin', expectedOrigins: [ORIGIN] },
      attestation: { mode: 'self_for_tests' },
      allowedAaguids: [AAGUID_OK],
      decoyKey: DECOY_KEY,
      rateKey: RATE_KEY,
      csrfKey: CSRF_KEY,
      allowedOrigins: [ORIGIN],
    },
    now,
  });
  const redirectUri = `https://${STAFF_HOST}/api/v1/auth/callback`;
  const identity = createIdentity({
    db: kit.db,
    queue,
    audit: kit.audit,
    logger,
    config: {
      orgId: ORG,
      hosts: { [STAFF_HOST]: 'google', [PATIENT_HOST]: 'patient_pool' },
      allowedOrigins: [ORIGIN, `https://${PATIENT_HOST}`],
      oidcStateKeys: { current: OIDC_KEY },
      csrfKey: CSRF_KEY,
      rateKey: RATE_KEY,
    },
    realms: {
      google: new GoogleRealmAdapter({
        endpoints: kit.idp.endpoints,
        clientId: kit.idp.clientId,
        clientSecret: 'x'.repeat(24),
        redirectUri,
        workspaceDomain: WORKSPACE,
      }),
      patient_pool: new OidcPatientAdapter({
        endpoints: kit.idp.endpoints,
        clientId: kit.idp.clientId,
        redirectUri: `https://${PATIENT_HOST}/api/v1/auth/callback`,
      }),
    },
    elevation: admin.elevation,
    now,
  });
  const app = await createApp({
    config: {
      minClientRelease: 141,
      instanceCount: 1,
      integrationsHost: undefined,
      port: 0,
      requestTimeoutMs: 15_000,
    },
    logger,
    readiness: { missingRelations: () => Promise.resolve([]) },
    policy: identity.policy,
    controllers: [...identity.controllers, ...admin.controllers],
  });
  await app.listen(0, '127.0.0.1');
  const adminBase = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const close = kit.close.bind(kit);
  return Object.assign(kit, {
    admin,
    adminBase,
    async close() {
      await app.close();
      await close();
    },
  });
}

let ip = 0;
/** A distinct client address per call, so the per-address limits never couple tests. */
export const nextIp = (): string => `203.0.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

export async function post(
  k: AdminKit,
  path: string,
  body: unknown,
  o: { cookie?: string; csrf?: string; ip?: string; origin?: string | null } = {},
): Promise<Resp> {
  return call(k.adminBase, 'POST', `/api/v1/admin${path}`, {
    body,
    ...(o.cookie === undefined ? {} : { cookie: o.cookie }),
    headers: {
      'x-forwarded-for': o.ip ?? nextIp(),
      ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }),
      ...(o.csrf === undefined ? {} : { 'x-csrf-token': o.csrf }),
    },
  });
}

export const getAdmin = (k: AdminKit, path: string, cookie: string): Promise<Resp> =>
  call(k.adminBase, 'GET', `/api/v1/admin${path}`, {
    cookie,
    headers: { 'x-forwarded-for': nextIp() },
  });

/** An admin principal with a handle and (optionally) a role, inserted as the migration owner would not: by the superuser. */
export async function seedAdmin(
  k: AdminKit,
  handle: string,
  roles: string[] = [],
): Promise<Seeded> {
  const s = await seedPrincipal(k, 'admin_pool', { subject: handle, name: `Admin ${handle}` });
  for (const r of roles) await assignRole(k, s.principalId, r);
  return s;
}

/** An approved enrolment token for a principal, as two admins would have produced it (the API flow has its own test). */
export async function seedToken(
  k: AdminKit,
  principalId: string,
  o: { minutes?: number; status?: string } = {},
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const requester = (
    await seedPrincipal(k, 'admin_pool', { subject: `req-${randomBytes(4).toString('hex')}` })
  ).personId;
  const approver = (
    await seedPrincipal(k, 'admin_pool', { subject: `apr-${randomBytes(4).toString('hex')}` })
  ).personId;
  const id = (await k.q<{ id: string }>(`SELECT gen_random_uuid() AS id`))[0]!.id;
  const expiresAt = new Date(now().getTime() + (o.minutes ?? 30) * 60_000);
  await k.sa.query('BEGIN');
  try {
    // Through the real states: the triggers read the acting person from the session setting (26.3).
    await k.sa.query(`SELECT set_config('app.person_id', $1, true)`, [requester]);
    await k.sa.query(
      `INSERT INTO identity.enrolment_token (id, organisation_id, principal_id, requested_by_person_id, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, 'requested')`,
      [id, ORG, principalId, requester, expiresAt],
    );
    await k.sa.query(`SELECT set_config('app.person_id', $1, true)`, [approver]);
    await k.sa.query(
      `UPDATE identity.enrolment_token SET token_hash = $2, approved_by_person_id = $3, status = 'approved' WHERE id = $1`,
      [id, createHash('sha256').update(token).digest(), approver],
    );
    if (o.status === 'used')
      await k.sa.query(
        `UPDATE identity.enrolment_token SET status = 'used', used_at = now() WHERE id = $1`,
        [id],
      );
    await k.sa.query('COMMIT');
  } catch (e) {
    await k.sa.query('ROLLBACK');
    throw e;
  }
  return token;
}

export interface AdminSession {
  cookie: string;
  csrf: string;
  principalId: string;
  setCookies: string[];
}

const sessionOf = (r: Resp, principalId: string): AdminSession => {
  const sid = cookieValue(r.setCookies, SID_COOKIE);
  if (r.status !== 200 || sid === undefined) throw new Error(`no session: ${r.status} ${r.body}`);
  return {
    cookie: `${SID_COOKIE}=${sid}`,
    csrf: String(r.json()['csrfToken']),
    principalId,
    setCookies: r.setCookies,
  };
};

/** Enrols `key` for `handle` through the HTTP routes with an approved token. Returns the enrolment session. */
export async function enrol(
  k: AdminKit,
  handle: string,
  principalId: string,
  token: string,
  key: SoftKey,
  o: { aaguid?: string; be?: boolean; bs?: boolean; uv?: boolean } = {},
): Promise<AdminSession> {
  const opt = await post(k, '/auth/enrolment/options', { handle, token });
  if (opt.status !== 200) throw new Error(`enrolment options ${opt.status} ${opt.body}`);
  const j = opt.json() as { challengeId: string; publicKey: { challenge: string } };
  const attestation = key.create(j.publicKey, {
    origin: ORIGIN,
    rpId: STAFF_HOST,
    aaguid: o.aaguid ?? AAGUID_OK,
    ...(o.be === undefined ? {} : { be: o.be }),
    ...(o.bs === undefined ? {} : { bs: o.bs }),
    ...(o.uv === undefined ? {} : { uv: o.uv }),
  });
  const ver = await post(k, '/auth/enrolment/verify', {
    challengeId: j.challengeId,
    handle,
    token,
    attestation,
  });
  return sessionOf(ver, principalId);
}

export async function signInOptions(k: AdminKit, handle: string, ip?: string): Promise<Resp> {
  return post(k, '/auth/sign-in/options', { handle }, ip === undefined ? {} : { ip });
}

export async function signIn(
  k: AdminKit,
  handle: string,
  principalId: string,
  key: SoftKey,
): Promise<AdminSession> {
  const opt = await signInOptions(k, handle);
  const j = opt.json() as { challengeId: string; publicKey: { challenge: string } };
  const assertion = key.assert(j.publicKey, { origin: ORIGIN, rpId: STAFF_HOST });
  return sessionOf(
    await post(k, '/auth/sign-in/verify', { challengeId: j.challengeId, handle, assertion }),
    principalId,
  );
}

/** Runs the elevation ceremony for a session; returns the response and the (rotated) session. */
export async function elevate(
  k: AdminKit,
  s: AdminSession,
  key: SoftKey,
): Promise<{ resp: Resp; session: AdminSession }> {
  const opt = await post(k, '/auth/elevation/options', {}, { cookie: s.cookie, csrf: s.csrf });
  if (opt.status !== 200) return { resp: opt, session: s };
  const j = opt.json() as { challengeId: string; publicKey: { challenge: string } };
  const assertion = key.assert(j.publicKey, { origin: ORIGIN, rpId: STAFF_HOST });
  const resp = await post(
    k,
    '/auth/elevation/verify',
    { challengeId: j.challengeId, assertion },
    { cookie: s.cookie, csrf: s.csrf },
  );
  const sid = cookieValue(resp.setCookies, SID_COOKIE);
  return { resp, session: sid === undefined ? s : { ...s, cookie: `${SID_COOKIE}=${sid}` } };
}

/** An admin with two keys, signed in and elevated: the state every privileged-action test starts from. */
export async function elevatedAdmin(
  k: AdminKit,
  handle: string,
  roles: string[],
): Promise<{ s: Seeded; session: AdminSession; key: SoftKey; key2: SoftKey }> {
  const s = await seedAdmin(k, handle, roles);
  const key = new SoftKey();
  const key2 = new SoftKey();
  const token = await seedToken(k, s.principalId);
  await enrol(k, handle, s.principalId, token, key);
  await enrol(k, handle, s.principalId, token, key2);
  const signed = await signIn(k, handle, s.principalId, key);
  const { resp, session } = await elevate(k, signed, key);
  if (resp.status !== 200) throw new Error(`elevate ${resp.status} ${resp.body}`);
  return { s, session, key, key2 };
}

export const sidHash = (cookie: string): Buffer => sha256(cookie.split('=')[1] ?? '');
