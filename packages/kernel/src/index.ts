export const name = '@ehr/kernel';

export type { PoolClientLike, PoolLike, Queryable, QueryResult } from './db.js';
export { isRlsViolation, mapDatabaseError, toProblem } from './errors/map.js';
export type { ApiErrorBody, MapContext, MappedError } from './errors/map.js';
export { createLogger } from './logging/logger.js';
export type { Level, Logger, Sink } from './logging/logger.js';
export { REDACTED, redactValue, scrubString } from './logging/redact.js';
export { ConfigError, describeDatabase, loadConfig } from './config/config.js';
export type { KernelConfig } from './config/config.js';
export {
  KernelDb,
  LockOrderError,
  PATIENT_SCOPE_OWNER_FUNCTIONS,
  SignInTx,
  Tx,
} from './scope/with-scope.js';
export type { LockMode, ScopeOptions } from './scope/with-scope.js';
export { ScopeError, buildScopeStatement } from './scope/settings.js';
export type { AuthIdentity, ScopeSettings } from './scope/settings.js';
export { checkLockOrder, checkSignInCallSites } from './scope/lock-order-check.js';
export type { Violation } from './scope/lock-order-check.js';
export { canonicalJson, requestHash } from './idempotency/hash.js';
export {
  IdempotencyConflictError,
  IdempotencyKeyRequiredError,
  beginIdempotent,
  completeIdempotent,
  parseIdempotencyKey,
} from './idempotency/store.js';
export { JobRegistry, Queue, QueueError, assertPayloadIsIdsOnly } from './queue/enqueue.js';
export type { JobType } from './queue/enqueue.js';
export {
  ParticipantRegistries,
  RegistryError,
  defaultRegistries,
  registerExportContributor,
  registerMergeParticipant,
} from './registry/registry.js';
export type { ExportContributor, MergeParticipant } from './registry/registry.js';
