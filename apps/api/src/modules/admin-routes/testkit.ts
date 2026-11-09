/* eslint-disable boundaries/module-boundaries -- test support: drives the admin routes through the real identity guard, sessions and elevation kit (BE-04/BE-05), the way the composition root mounts them; production files of this module import only audit */
// Harness of the BE-24 real-database tests: the BE-05 admin kit (throwaway PostgreSQL database migrated by the real pipeline, real
// reference data, real WebAuthn-shaped admin sessions and elevation), plus the audit and integration admin controllers mounted on the same
// application the way the composition root mounts it. Not a test file; imported by the *.dbtest.ts files.
import { createLogger, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import { createApp } from '../../platform/app.js';
import { AUDIT_JOBS, AuditService } from '../audit/index.js';
import { requireAuthContext } from '../identity/guard-policy.js';
import { GoogleRealmAdapter, OidcPatientAdapter } from '../identity/realms.js';
import { createIdentity } from '../identity/runtime.js';
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
} from '../identity/admin/testkit.js';
import type { AdminSession } from '../identity/admin/testkit.js';
import { createIdentityAdmin } from '../identity/admin/index.js';
import { IDENTITY_ADMIN_JOBS } from '../identity/admin/jobs.js';
import { SimpleWebAuthnPort } from '../identity/admin/webauthn.js';
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
} from '../identity/testkit.js';
import type { Kit, Resp } from '../identity/testkit.js';
import { ConnectionService, SecretService } from '../integration-core/index.js';
import type { OutboundSecretStore, PayloadSealer } from '../integration-core/index.js';
import { AuditAdminService } from './audit-routes.js';
import type { ExportUrlSigner } from './audit-routes.js';
import { createAdminRoutesControllers } from './controller.js';
import { IntegrationAdminService } from './integration-routes.js';
import type { ConnectionTester } from './integration-routes.js';

export { clock, now, ORG, call, nextIp, ORIGIN, AAGUID_OK, SoftKey };
export type { AdminSession, Resp };

/** Fakes of the infrastructure the services take as ports. Their calls are recorded so a test can look for a leaked value. */
export interface Fakes {
  storeCalls: { ref: { connectionId: string; name: string }; value: string; clientToken: string }[];
  storeFails: boolean;
  sealed: { plain: string; context: string }[];
  enqueued: { requestId: string; sealed: string }[];
  signed: { objectKey: string; ttl: number }[];
  /** What the probe reports; `null` makes it throw (the vendor is unreachable). */
  probe: 'ok' | 'down' | null;
}

export interface OrgKit extends Kit {
  adminBase: string;
  auditAdmin: AuditAdminService;
  integrations: IntegrationAdminService;
  fakes: Fakes;
  close(): Promise<void>;
}

/** The worker scope (audience `system`): the health job and the export job write under it. */
export const WORKER_SCOPE: ScopeSettings = {
  audience: 'system',
  realm: 'worker',
  orgId: ORG,
  jobScope: 'org',
};

export async function adminRoutesSetup(name: string): Promise<OrgKit> {
  const kit = await setup({ name, withApp: false });
  for (const j of IDENTITY_ADMIN_JOBS) kit.registry.defineJob(j);
  for (const j of AUDIT_JOBS) kit.registry.defineJob(j);
  const wc = new (await import('../identity/testkit.js')).pg.Client({
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
  const fakes: Fakes = {
    storeCalls: [],
    storeFails: false,
    sealed: [],
    enqueued: [],
    signed: [],
    probe: 'ok',
  };
  const store: OutboundSecretStore = {
    put: (ref, value, clientToken) => {
      fakes.storeCalls.push({ ref, value, clientToken });
      if (fakes.storeFails)
        return Promise.reject(new Error('store down: SECRET-TEST-1 vendor text'));
      // the same token gives the same version (25.9)
      const prior = fakes.storeCalls.findIndex((c) => c.clientToken === clientToken);
      const v = `v-${String(prior + 1)}`;
      return Promise.resolve({
        arn: `arn:test:/integration/outbound/${ref.connectionId}/${ref.name}`,
        versionId: v,
      });
    },
  };
  const sealer: PayloadSealer = {
    seal: (plain, context) => {
      fakes.sealed.push({ plain: plain.toString('utf8'), context });
      return Promise.resolve(Buffer.from(`sealed:${context}`));
    },
  };
  const connections = new ConnectionService(audit);
  const secrets = new SecretService({
    audit,
    store,
    sealer,
    enqueueApply: (_tx, job) => {
      fakes.enqueued.push(job);
      return Promise.resolve();
    },
    now,
  });
  const signer: ExportUrlSigner = {
    sign: (objectKey, ttl) => {
      fakes.signed.push({ objectKey, ttl });
      return Promise.resolve({
        url: `https://exports.example.invalid/${objectKey}?sig=synthetic`,
        expiresAt: new Date(now().getTime() + ttl * 1000),
      });
    },
  };
  // The probe stands for the worker's health check: it writes the health columns the way only the worker may.
  const tester: ConnectionTester = {
    async test(connectionId) {
      if (fakes.probe === null) throw new Error('vendor unreachable');
      const health = fakes.probe === 'ok' ? 'ok' : 'down';
      const checkedAt = now();
      await kit.wdb.withScope(WORKER_SCOPE, (tx) =>
        tx
          .query(
            `UPDATE integration_core.connection SET health = $2, last_test_at = $3::timestamptz, last_test_result = $4::jsonb WHERE id = $1::uuid`,
            [
              connectionId,
              health,
              checkedAt.toISOString(),
              JSON.stringify({ ok: health === 'ok' }),
            ],
          )
          .then(() => undefined),
      );
      return { health, checkedAt };
    },
  };
  const auditAdmin = new AuditAdminService({
    db: kit.db,
    audit,
    signer,
    now,
    elevationIdOf: async (tx, sessionId) =>
      (
        await tx.query(
          `SELECT id FROM identity.elevation_grant WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY issued_at DESC LIMIT 1`,
          [sessionId],
        )
      ).rows[0]?.id as string | undefined,
  });
  const integrations = new IntegrationAdminService({
    db: kit.db,
    audit,
    connections,
    secrets,
    tester,
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
    controllers: [
      ...identity.controllers,
      ...admin.controllers,
      ...createAdminRoutesControllers({
        audit: auditAdmin,
        integrations,
        scopeOf: (req) => requireAuthContext(req).scope,
        sessionIdOf: (req) => requireAuthContext(req).session.id,
      }),
    ],
  });
  await app.listen(0, '127.0.0.1');
  const adminBase = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const close = kit.close.bind(kit);
  return Object.assign(kit, {
    adminBase,
    auditAdmin,
    integrations,
    fakes,
    async close() {
      await app.close();
      await close();
    },
  });
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
  const handle = `a24adm${++seq}${Date.now() % 100000}`;
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
