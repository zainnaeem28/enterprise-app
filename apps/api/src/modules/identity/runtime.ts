// Wiring of the identity module: one call builds the services, the guard policy and the controller from explicit
// dependencies. Nothing here reads the environment; the application entry point (integration) supplies the pieces.
import type { KernelDb, Logger, Queue } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import { AuditService } from '../audit/index.js';
import { AssignmentResolver } from './assignment.js';
import { createAuthController } from './auth.controller.js';
import { IdentityGuardPolicy } from './guard-policy.js';
import type { ElevationChecker, PatientInScope } from './guard-policy.js';
import type { OidcStateKeys } from './oidc-state.js';
import { ProxyService } from './proxy.js';
import type { RealmAdapter, SignInRealm } from './realms.js';
import { ScopeBuilder } from './scope.js';
import { SessionService } from './sessions.js';
import { SignInService } from './signin.js';
import { SignInLimiter } from './signin-limiter.js';

export interface IdentityConfig {
  orgId: string;
  hosts: Readonly<Record<string, SignInRealm>>;
  allowedOrigins: readonly string[];
  oidcStateKeys: OidcStateKeys;
  csrfKey: string;
  rateKey: string;
}

export interface IdentityDeps {
  db: KernelDb;
  /** API-path queue (`new Queue(registry, 'api')`) with the identity job types defined. */
  queue: Queue;
  audit: AuditService;
  logger: Logger;
  config: IdentityConfig;
  realms: Readonly<Record<SignInRealm, RealmAdapter>>;
  elevation?: ElevationChecker;
  patientInScope?: PatientInScope;
  onSignInAlert?: (info: { realm: string; failures: number }) => void;
  now?: () => Date;
}

export interface Identity {
  /** Pass as `policy` to the application shell (replaces the deny-everything default). */
  policy: IdentityGuardPolicy;
  controllers: Type<unknown>[];
  sessions: SessionService;
  scopes: ScopeBuilder;
  assignment: AssignmentResolver;
  proxies: ProxyService;
}

export function createIdentity(deps: IdentityDeps): Identity {
  const c = deps.config;
  const now = deps.now ?? (() => new Date());
  const sessions = new SessionService({ db: deps.db, orgId: c.orgId, now });
  const scopes = new ScopeBuilder({
    orgId: c.orgId,
    activeBtgPatientIds: async (tx, principalId) =>
      (await deps.audit.activeBtgGrants(tx, principalId)).map((g) => g.patientId),
  });
  const assignment = new AssignmentResolver();
  const limiter = new SignInLimiter({
    db: deps.db,
    orgId: c.orgId,
    hmacKey: c.rateKey,
    now: () => now().getTime(),
    ...(deps.onSignInAlert === undefined ? {} : { onGlobalAlert: deps.onSignInAlert }),
  });
  const signIn = new SignInService({
    db: deps.db,
    orgId: c.orgId,
    sessions,
    queue: deps.queue,
    now,
  });
  const policy = new IdentityGuardPolicy({
    db: deps.db,
    orgId: c.orgId,
    sessions,
    scopes,
    assignment,
    allowedOrigins: c.allowedOrigins,
    ...(deps.elevation === undefined ? {} : { elevation: deps.elevation }),
    ...(deps.patientInScope === undefined ? {} : { patientInScope: deps.patientInScope }),
    onDenied: async (d) => {
      const module = d.decl.permission.split('.')[0] ?? 'identity';
      await deps.audit.recordDenied(deps.db, d.ctx.scope, {
        requestId: d.req.requestId ?? null,
        resourceType: `${/^[a-z][a-z0-9_]*$/.test(module) ? module : 'identity'}.route`,
        denialReason: d.reason,
        ...(d.patientId === undefined ? {} : { patientId: d.patientId }),
        ...(d.locationId === undefined ? {} : { locationId: d.locationId }),
        ip: d.req.ip ?? null,
        userAgent: d.req.header('user-agent') ?? null,
      });
    },
  });
  const controller = createAuthController({
    db: deps.db,
    orgId: c.orgId,
    hosts: c.hosts,
    realms: deps.realms,
    oidcKeys: c.oidcStateKeys,
    csrfKey: c.csrfKey,
    sessions,
    signIn,
    limiter,
    audit: deps.audit,
    now: () => now().getTime(),
  });
  return {
    policy,
    controllers: [controller],
    sessions,
    scopes,
    assignment,
    proxies: new ProxyService(),
  };
}
