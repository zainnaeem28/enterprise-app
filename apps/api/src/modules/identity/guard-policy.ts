// The authorization guard (ARCHITECTURE 27.1, BD-07): the GuardPolicy that fills the platform's deny-by-default hook.
// Order, exactly as 27.1 lists it: session valid -> CSRF and Origin on state-changing requests -> realm allowed for the
// route prefix -> permission held (location-bound roles only at their locations) -> elevation where the permission needs
// it -> resolver result (patient, location) in scope -> assignment rule where the permission is assignment-bound.
// Every refusal is one of: 401 (no session, expired, revoked, principal disabled), 403 auth.forbidden or a more specific
// 403 code, 404 kernel.not_found (a resource RLS hides). The 403s and 404s are audited as `forbidden` / `not_visible`.
import type { KernelDb, ScopeSettings, Tx } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { GuardPolicy } from '../../platform/guard.js';
import type { Req, Res } from '../../platform/http.js';
import { PATIENT_REALM, PUBLIC } from '../../platform/permissions.js';
import type { Realm, RouteDeclaration } from '../../platform/route.js';
import { ASSIGNMENT_BOUND_PERMISSIONS } from './assignment.js';
import type { AssignmentResolver } from './assignment.js';
import { ForbiddenError, UnauthenticatedError } from './errors.js';
import type { ScopeBuilder } from './scope.js';
import { isPassive } from './sessions.js';
import type { SessionService } from './sessions.js';
import {
  constantTimeEqual,
  hashPresentedToken,
  parseCookies,
  sha256,
  SID_COOKIE,
} from './tokens.js';
import type { AuthContext, PrincipalRealm, SessionRow } from './types.js';

export const IDLE_HEADER = 'X-Session-Idle-Expires-At';

/** What a route's resolver found about the resource the request names (27.1). */
export interface ResolvedResource {
  patientId?: string;
  locationId?: string;
}
/** Returns undefined when the resource does not exist or is not visible to the caller (-> 404). */
export type ResourceResolver = (
  req: Req,
  ctx: AuthContext,
  tx: Tx,
) => Promise<ResolvedResource | undefined>;

/** Is the staff scope allowed to touch this patient? Provided by the patient module (`patient.staff_sees`, 21.4). */
export type PatientInScope = (tx: Tx, ctx: AuthContext, patientId: string) => Promise<boolean>;

/** The admin elevation check (C1). BE-05 supplies the real one; until then a permission that needs elevation is refused. */
export interface ElevationChecker {
  isElevated(ctx: AuthContext): Promise<boolean>;
}
export const NO_ELEVATION: ElevationChecker = { isElevated: () => Promise.resolve(false) };

export interface DenialInfo {
  req: Req;
  ctx: AuthContext;
  decl: RouteDeclaration;
  reason: 'forbidden' | 'not_visible';
  patientId?: string;
  locationId?: string;
}

export interface GuardDeps {
  db: KernelDb;
  orgId: string;
  sessions: SessionService;
  scopes: ScopeBuilder;
  assignment: AssignmentResolver;
  /** Origins accepted on state-changing requests (the portal hosts). */
  allowedOrigins: readonly string[];
  elevation?: ElevationChecker;
  patientInScope?: PatientInScope;
  /** Writes the `denied` audit event (8.1 rule 2). Must not throw. */
  onDenied?: (d: DenialInfo) => Promise<void>;
}

/** 403 clinical.not_assigned with the `btgAvailable` extension member (30). */
export class NotAssignedError extends ApiError {
  readonly btgAvailable: boolean;
  /** `btgAvailable`: whether the caller holds `audit.btg.open` (QA-EXEC-F01 / TC-AZ-10: the member is serialised in the body). */
  constructor(btgAvailable = true) {
    super(403, 'clinical.not_assigned', false, { btgAvailable });
    this.btgAvailable = btgAvailable;
    this.name = 'NotAssignedError';
  }
}

const contexts = new WeakMap<object, AuthContext>();
/** The caller of an authenticated request, as resolved by the guard. Undefined on routes the guard let through unauthenticated. */
export const authContextOf = (req: Req): AuthContext | undefined => contexts.get(req);
export const requireAuthContext = (req: Req): AuthContext => {
  const c = contexts.get(req);
  if (c === undefined) throw new UnauthenticatedError();
  return c;
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const REALM_OF: Record<Exclude<Realm, 'none'>, PrincipalRealm> = {
  google: 'google',
  admin_pool: 'admin_pool',
  patient: 'patient_pool',
  partner: 'partner_pool',
};

/** The realms a route accepts; undefined means any. An empty list fails closed (no realm matches). */
function expectedRealms(
  decl: RouteDeclaration,
  path: string,
): readonly PrincipalRealm[] | undefined {
  const d = decl.realm;
  if (Array.isArray(d))
    return (d as readonly Realm[]).flatMap((r) => (r === 'none' ? [] : [REALM_OF[r]]));
  if (d === 'none') return undefined;
  if (d !== undefined) return [REALM_OF[d as Exclude<Realm, 'none'>]];
  if ((PATIENT_REALM as readonly string[]).includes(decl.permission)) return ['patient_pool'];
  return [/^\/api\/v1\/admin(\/|$)/.test(path) ? 'admin_pool' : 'google'];
}

export class IdentityGuardPolicy implements GuardPolicy {
  private readonly resolvers = new Map<string, ResourceResolver>();

  constructor(private readonly deps: GuardDeps) {}

  /** A module names its resolver (the `resolver` field of the route declaration). A route naming an unregistered one is refused. */
  registerResolver(name: string, fn: ResourceResolver): void {
    if (name === 'none' || name === 'session' || this.resolvers.has(name))
      throw new Error(`resolver ${name} cannot be registered`);
    this.resolvers.set(name, fn);
  }

  async authorize(req: Req, decl: RouteDeclaration): Promise<void> {
    // Routes that need no session (sign-in, callback, health): the guard does not read or touch a session for them.
    if (decl.permission === PUBLIC && decl.resolver !== 'session') return;

    const ctx = await this.authenticate(req);
    contexts.set(req, ctx);
    (req as Req & { res?: Res }).res?.setHeader(IDLE_HEADER, ctx.idleExpiresAt.toISOString());

    const realms = expectedRealms(decl, req.path);
    if (realms !== undefined && !realms.includes(ctx.session.realm))
      return this.deny(req, ctx, decl, 'forbidden');
    if (decl.permission === PUBLIC) return; // any session ('session' resolver)

    // `patient` and `proxy` are realm capabilities (27.2): the realm check above is their permission check. Which
    // patients a caller reaches is decided below and by the RLS templates T-PAT-OWN / T-PAT-APPT.
    if (!(PATIENT_REALM as readonly string[]).includes(decl.permission)) {
      if (!ctx.grants.has(decl.permission)) return this.deny(req, ctx, decl, 'forbidden');
      if (decl.elevation === true || ctx.grants.needsElevation(decl.permission)) {
        if (!(await (this.deps.elevation ?? NO_ELEVATION).isElevated(ctx))) {
          // A refusal is a `denied` audit event like every other (8.1 rule 2, QA-EXEC-F02); the audit write must not throw.
          await this.audit(req, ctx, decl, 'forbidden');
          throw new ForbiddenError('identity.elevation_required');
        }
      }
    }

    if (decl.resolver === 'none') return;
    const resolve = this.resolvers.get(decl.resolver);
    if (resolve === undefined) return this.deny(req, ctx, decl, 'forbidden'); // an unknown resolver fails closed
    await this.deps.db.withScope(ctx.scope, async (tx) => {
      const res = await resolve(req, ctx, tx);
      if (res === undefined) return this.deny(req, ctx, decl, 'not_visible');
      await this.checkResource(req, ctx, decl, tx, res);
    });
  }

  private async checkResource(
    req: Req,
    ctx: AuthContext,
    decl: RouteDeclaration,
    tx: Tx,
    res: ResolvedResource,
  ): Promise<void> {
    const staff = ctx.session.audience === 'staff';
    if (staff && !(PATIENT_REALM as readonly string[]).includes(decl.permission)) {
      // Location-bound roles count only for resources at their locations.
      if (res.locationId !== undefined && !ctx.grants.has(decl.permission, res.locationId))
        return this.deny(req, ctx, decl, 'forbidden', res);
      if (res.patientId !== undefined) {
        const btg = ctx.scope.btgPatientIds?.includes(res.patientId) === true;
        const inScope =
          btg ||
          (this.deps.patientInScope !== undefined &&
            (await this.deps.patientInScope(tx, ctx, res.patientId)));
        if (!inScope) return this.deny(req, ctx, decl, 'not_visible', res);
        if (ASSIGNMENT_BOUND_PERMISSIONS.has(decl.permission) && !btg) {
          if (
            !(await this.deps.assignment.isAssigned(tx, ctx.session.principalId, res.patientId))
          ) {
            await this.audit(req, ctx, decl, 'forbidden', res);
            throw new NotAssignedError(ctx.grants.has('audit.btg.open'));
          }
        }
      }
    } else if (!staff && res.patientId !== undefined) {
      // Patient realm: only the patients of the scope. A `patient` route is for the patient's own records; only a `proxy`
      // route (the appointment routes) is open to a proxy, whose scope is appointments only (D-7 default, RA-R1-20a).
      const access = ctx.patients.find((p) => p.patientId === res.patientId);
      if (access === undefined) return this.deny(req, ctx, decl, 'not_visible', res);
      if (access.scope === 'appointments' && decl.permission !== 'proxy')
        return this.deny(req, ctx, decl, 'not_visible', res);
    }
  }

  private async audit(
    req: Req,
    ctx: AuthContext,
    decl: RouteDeclaration,
    reason: 'forbidden' | 'not_visible',
    res?: ResolvedResource,
  ): Promise<void> {
    await this.deps.onDenied?.({
      req,
      ctx,
      decl,
      reason,
      ...(res?.patientId === undefined ? {} : { patientId: res.patientId }),
      ...(res?.locationId === undefined ? {} : { locationId: res.locationId }),
    });
  }

  private async deny(
    req: Req,
    ctx: AuthContext,
    decl: RouteDeclaration,
    reason: 'forbidden' | 'not_visible',
    res?: ResolvedResource,
  ): Promise<never> {
    await this.audit(req, ctx, decl, reason, res);
    if (reason === 'not_visible') throw new ApiError(404, 'kernel.not_found');
    throw new ForbiddenError();
  }

  /** Session valid, CSRF and Origin, then the one authenticated transaction: principal state, touch, scope. */
  private async authenticate(req: Req): Promise<AuthContext> {
    const presented = parseCookies(req.headers['cookie']).get(SID_COOKIE);
    const hashHex = hashPresentedToken(presented);
    if (hashHex === undefined) throw new UnauthenticatedError();
    const found = await this.deps.sessions.lookup(hashHex);
    if (found.state === 'none' || found.state === 'revoked') throw new UnauthenticatedError();
    if (found.state === 'expired') {
      await this.deps.sessions.revokeExpired(found.session, found.reason);
      throw new UnauthenticatedError('auth.session_expired');
    }
    const session = found.session;
    // CSRF and Origin run before anything is written, so a forged request cannot extend the session (26.2).
    if (!SAFE_METHODS.has(req.method.toUpperCase())) this.checkCsrf(req, session);

    const interactive = !isPassive(req.method, req.path);
    return this.deps.db.withScope(this.deps.sessions.scopeOf(session), async (tx) => {
      const built = await this.deps.scopes.build(tx, session);
      if (!built.principalActive) throw new UnauthenticatedError();
      const idleExpiresAt = interactive
        ? await this.deps.sessions.touch(tx, session)
        : session.idleExpiresAt; // passive: the stored expiry, unchanged (TDR-06)
      return {
        session,
        scope: built.scope as ScopeSettings,
        displayName: built.displayName,
        roles: built.roles,
        grants: built.grants,
        patients: built.patients,
        idleExpiresAt,
      };
    });
  }

  private checkCsrf(req: Req, session: SessionRow): void {
    const origin = req.header('origin');
    if (origin === undefined || !this.deps.allowedOrigins.includes(origin))
      throw new ForbiddenError('auth.csrf_failed');
    const token = req.header('x-csrf-token');
    if (token === undefined || token.length === 0 || token.length > 256)
      throw new ForbiddenError('auth.csrf_failed');
    if (!constantTimeEqual(sha256(token), session.csrfHash))
      throw new ForbiddenError('auth.csrf_failed');
  }
}
