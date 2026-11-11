/* eslint-disable boundaries/module-boundaries -- test support: drives the admin routes through the real identity guard, sessions and elevation kit (BE-04/BE-05), the way the composition root mounts them; production files of this module import only audit */
// Harness of the BE-23 real-database tests: the BE-05 admin kit (throwaway PostgreSQL database migrated by the real pipeline, real
// reference data, real WebAuthn-shaped admin sessions and elevation), plus the organisation admin controller mounted on the same
// application the way the composition root mounts it. Not a test file; imported by the *.dbtest.ts files.
import { FIXTURE_STATES } from '../../../platform/fixture-states.js';
import type { Type } from '@nestjs/common';
import { createLogger, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import { createApp } from '../../../platform/app.js';
import { AuditService } from '../../audit/index.js';
import { requireAuthContext } from '../../identity/guard-policy.js';
import { GoogleRealmAdapter, OidcPatientAdapter } from '../../identity/realms.js';
import { createIdentity } from '../../identity/runtime.js';
import {
  AAGUID_OK,
  DECOY_KEY,
  elevate,
  enrol,
  enrolSecond,
  nextIp,
  ORIGIN,
  seedAdmin,
  seedToken,
  signIn,
  SoftKey,
} from '../../identity/admin/testkit.js';
import type { AdminSession } from '../../identity/admin/testkit.js';
import { createIdentityAdmin } from '../../identity/admin/index.js';
import { IDENTITY_ADMIN_JOBS } from '../../identity/admin/jobs.js';
import { SimpleWebAuthnPort } from '../../identity/admin/webauthn.js';
import {
  call,
  clock,
  CSRF_KEY,
  now,
  OIDC_KEY,
  ORG,
  PATIENT_HOST,
  RATE_KEY,
  setup,
  STAFF_HOST,
  WORKSPACE,
} from '../../identity/testkit.js';
import type { Kit, Resp } from '../../identity/testkit.js';
import { OrganisationService } from '../service.js';
import { createOrganisationAdminController } from './controller.js';
import { OrganisationAdminService } from './service.js';

export { clock, now, ORG, call, nextIp, ORIGIN, AAGUID_OK, SoftKey };
export type { AdminSession, Resp };

export interface OrgKit extends Kit {
  adminBase: string;
  organisation: OrganisationService;
  service: OrganisationAdminService;
  close(): Promise<void>;
}

/** The worker scope that applies the settings catalogue (organisation job, audience `system`). */
export const WORKER_SCOPE: ScopeSettings = {
  audience: 'system',
  realm: 'worker',
  orgId: ORG,
  jobScope: 'org',
};

export async function orgAdminSetup(
  name: string,
  extraControllers: (kit: Kit, audit: AuditService) => Type<unknown>[] = () => [],
): Promise<OrgKit> {
  const kit = await setup({ name, withApp: false });
  for (const j of IDENTITY_ADMIN_JOBS) kit.registry.defineJob(j);
  const wc = new (await import('../../identity/testkit.js')).pg.Client({
    connectionString: kit.urlFor('app_worker'),
  });
  await wc.connect();
  await syncTaskTypes(wc, kit.registry);
  await wc.end();

  const logger = createLogger({ sink: () => undefined });
  const queue = new Queue(kit.registry, 'api');
  const audit: AuditService = kit.audit;
  const admin = createIdentityAdmin({
    db: kit.db,
    queue,
    audit,
    sessions: kit.identity.sessions,
    logger,
    port: new SimpleWebAuthnPort(
      { rpId: STAFF_HOST, rpName: 'EHR admin', expectedOrigins: [ORIGIN] },
      { mode: 'self_for_tests' },
    ),
    config: {
      orgId: ORG,
      ceremony: { rpId: STAFF_HOST, rpName: 'EHR admin', expectedOrigins: [ORIGIN] },
      attestation: {
        mode: 'chain',
        rootCertificatesPem: ['unused: the test port below replaces the library port'],
      },
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
    audit,
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
  const organisation = new OrganisationService();
  const service = new OrganisationAdminService({ db: kit.db, audit, organisation });
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
    controllers: [
      ...identity.controllers,
      ...admin.controllers,
      createOrganisationAdminController({
        service,
        scopeOf: (req) => requireAuthContext(req).scope,
      }),
      ...extraControllers(kit, audit),
    ],
  });
  await app.listen(0, '127.0.0.1');
  const adminBase = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const close = kit.close.bind(kit);
  return Object.assign(kit, {
    adminBase,
    organisation,
    service,
    async close() {
      await app.close();
      await close();
    },
  });
}

/** Seeds the reference data the worker would (the jurisdiction list) and the settings catalogue. */
export async function seedReference(
  k: OrgKit,
  states: readonly string[] = [
    FIXTURE_STATES.unlicensed,
    FIXTURE_STATES.licensed,
    FIXTURE_STATES.closed,
  ],
): Promise<void> {
  for (const s of states)
    await k.sa.query(
      `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [s, ORG, `State ${s}`],
    );
  await k.wdb.withScope(WORKER_SCOPE, (tx) =>
    k.organisation.applySettingDefaults(tx, '00000000-0000-7000-8000-0000000000e1'),
  );
}

export interface Admin {
  session: AdminSession;
  principalId: string;
}

let seq = 0;
/** An admin with the role, two keys, signed in; elevated unless `elevated: false`. */
export async function adminWith(
  k: OrgKit,
  roles: string[],
  o: { elevated?: boolean } = {},
): Promise<Admin> {
  const handle = `orgadm${++seq}${Date.now() % 100000}`;
  const s = await seedAdmin(k as never, handle, roles);
  const key = new SoftKey();
  const key2 = new SoftKey();
  const token = await seedToken(k as never, s.principalId);
  const enrolSession = await enrol(k as never, handle, s.principalId, token, key);
  await enrolSecond(k as never, enrolSession, key2);
  const signed = await signIn(k as never, handle, s.principalId, key);
  if (o.elevated === false) return { session: signed, principalId: s.principalId };
  const { resp, session } = await elevate(k as never, signed, key);
  if (resp.status !== 200) throw new Error(`elevate ${resp.status} ${resp.body}`);
  return { session, principalId: s.principalId };
}

/** One admin API call (state-changing methods carry the CSRF token and the Origin the guard checks). */
export function api(
  k: OrgKit,
  a: Admin | undefined,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Resp> {
  return call(k.adminBase, method, `/api/v1/admin${path}`, {
    ...(a === undefined ? {} : { cookie: a.session.cookie }),
    ...(body === undefined ? {} : { body }),
    headers: {
      'x-forwarded-for': nextIp(),
      ...(method === 'GET' || a === undefined
        ? {}
        : { origin: ORIGIN, 'x-csrf-token': a.session.csrf }),
      ...headers,
    },
  });
}
