// Public surface of the identity module (ARCHITECTURE 24). Other modules import only from here.
export { createIdentity } from './runtime.js';
export type { Identity, IdentityConfig, IdentityDeps } from './runtime.js';
export {
  IdentityGuardPolicy,
  NotAssignedError,
  NO_ELEVATION,
  authContextOf,
  requireAuthContext,
} from './guard-policy.js';
export type {
  DenialInfo,
  ElevationChecker,
  PatientInScope,
  ResolvedResource,
  ResourceResolver,
} from './guard-policy.js';
export {
  AssignmentResolver,
  ASSIGNMENT_BOUND_PERMISSIONS,
  DEFAULT_LOOKBACK_MONTHS,
} from './assignment.js';
export type { AssignmentRule, AssignmentSource } from './assignment.js';
export { ScopeBuilder } from './scope.js';
export type { BuiltScope, ScopeContribution, ScopeContributor } from './scope.js';
export { SessionService, PASSIVE_ROUTES, isPassive, TOUCH_INTERVAL_MS } from './sessions.js';
export type { Lookup, RevokeReason, SessionLifetimes } from './sessions.js';
export { SignInService, DEFAULT_PREREGISTRATION_DAYS } from './signin.js';
export type { SignInKind, SignInResult } from './signin.js';
export { SignInLimiter, parseClinicCidrs } from './signin-limiter.js';
export { createAuthController, csrfTokenFor, REAUTH_MAX_AGE_SECONDS } from './auth.controller.js';
export { OidcClient, OidcVerificationError, newPkce } from './oidc.js';
export type { IdTokenClaims, OidcClientConfig, OidcEndpoints } from './oidc.js';
export {
  GoogleRealmAdapter,
  GOOGLE_ENDPOINTS,
  OidcPatientAdapter,
  RealmCheckError,
} from './realms.js';
export type {
  GoogleRealmConfig,
  PatientIdentityAdapter,
  RealmAdapter,
  SignInRealm,
  VerifiedIdentity,
} from './realms.js';
export { ProxyService, patientAccessOf, PROXY_RELATIONSHIPS } from './proxy.js';
export type { ProxyGrantView, ProxyRelationship } from './proxy.js';
export {
  identityExportContributor,
  identityMergeParticipant,
  registerIdentityParticipants,
  IDENTITY_MERGE_TABLES,
} from './merge.js';
export { PermissionGrants } from './types.js';
export type {
  AuthContext,
  PatientAccess,
  PrincipalRealm,
  RoleGrant,
  SessionAudience,
  SessionRow,
} from './types.js';
export {
  IdentityError,
  IdentityScopeError,
  IdentityValidationError,
  ForbiddenError,
  RateLimitedError,
  SignInFailedError,
  UnauthenticatedError,
} from './errors.js';
export { IDENTITY_JOBS } from './jobs.js';
