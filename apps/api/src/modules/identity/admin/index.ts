// Public surface of the identity admin realm (BE-05). `createIdentityAdmin` builds the B2 ceremonies, the privileged-action
// service, the controller and the elevation checker from explicit dependencies; the application entry point passes
// `elevation` to `createIdentity` and adds `controllers` to the application.
import type { KernelDb, Logger, Queue } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import type { AuditService } from '../../audit/index.js';
import type { SessionService } from '../sessions.js';
import { SignInLimiter } from '../signin-limiter.js';
import { AdminCeremonies } from './ceremony.js';
import { createAdminController } from './controller.js';
import { GrantElevationChecker } from './elevation.js';
import { OptionsLimiter } from './options-limiter.js';
import { AdminService } from './service.js';
import { SimpleWebAuthnPort } from './webauthn.js';
import type { AttestationPolicy, CeremonyParams, WebAuthnPort } from './webauthn.js';

export interface IdentityAdminConfig {
  orgId: string;
  ceremony: CeremonyParams;
  attestation: AttestationPolicy;
  /** Lower-case AAGUIDs Cybersecurity approved (B2-3, OPEN-3). */
  allowedAaguids: readonly string[];
  /** `<env>/app/admin-decoy-key`, `<env>/app/rate-key`, `<env>/app/csrf-key`: three separate secrets. */
  decoyKey: string;
  rateKey: string;
  csrfKey: string;
  /** Origins accepted on the anonymous admin writes. */
  allowedOrigins: readonly string[];
}

export interface IdentityAdminDeps {
  db: KernelDb;
  queue: Queue;
  audit: AuditService;
  sessions: SessionService;
  logger: Logger;
  config: IdentityAdminConfig;
  /** Tests may supply a port; production uses the pinned library. */
  port?: WebAuthnPort;
  onSignInAlert?: (info: { realm: string; failures: number }) => void;
  now?: () => Date;
}

export interface IdentityAdmin {
  controllers: Type<unknown>[];
  /** Pass to `createIdentity({ elevation })`: the guard's C1 check. */
  elevation: GrantElevationChecker;
  ceremonies: AdminCeremonies;
  service: AdminService;
}

export function createIdentityAdmin(deps: IdentityAdminDeps): IdentityAdmin {
  const c = deps.config;
  const now = deps.now ?? (() => new Date());
  const limiter = new SignInLimiter({
    db: deps.db,
    orgId: c.orgId,
    hmacKey: c.rateKey,
    now: () => now().getTime(),
    ...(deps.onSignInAlert === undefined ? {} : { onGlobalAlert: deps.onSignInAlert }),
  });
  const options = new OptionsLimiter({
    db: deps.db,
    orgId: c.orgId,
    hmacKey: c.rateKey,
    now: () => now().getTime(),
  });
  const ceremonies = new AdminCeremonies({
    db: deps.db,
    queue: deps.queue,
    audit: deps.audit,
    sessions: deps.sessions,
    limiter,
    options,
    port: deps.port ?? new SimpleWebAuthnPort(c.ceremony, c.attestation),
    orgId: c.orgId,
    csrfKey: c.csrfKey,
    rateKey: c.rateKey,
    decoyKey: c.decoyKey,
    allowedAaguids: new Set(c.allowedAaguids.map((a) => a.toLowerCase())),
    now,
  });
  const service = new AdminService({
    db: deps.db,
    queue: deps.queue,
    audit: deps.audit,
    orgId: c.orgId,
    now,
  });
  return {
    controllers: [
      createAdminController({
        ceremonies,
        service,
        sessions: deps.sessions,
        allowedOrigins: c.allowedOrigins,
        now: () => now().getTime(),
      }),
    ],
    elevation: new GrantElevationChecker(deps.db, now),
    ceremonies,
    service,
  };
}

export { GrantElevationChecker } from './elevation.js';
export { AdminCeremonies } from './ceremony.js';
export { AdminService, requestHashOf } from './service.js';
export { SimpleWebAuthnPort, parseAssertion, parseAttestation } from './webauthn.js';
export type { AttestationPolicy, CeremonyParams, WebAuthnPort } from './webauthn.js';
export { normaliseHandle } from './handle.js';
export { decoyAllowCredentials } from './decoy.js';
export { IDENTITY_ADMIN_JOBS, IDENTITY_ADMIN_EVENTS, ADMIN_EVENT_KINDS } from './jobs.js';
export * from './errors.js';
