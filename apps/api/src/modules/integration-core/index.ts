// Public surface of integration-core (ARCHITECTURE 24). Other modules import only from here. The vendor-call side
// (`callVendor`, adapters, circuit state, inbound handler registry, `readInbound`, health) lives with the worker, in
// apps/worker/src/jobs/integration-core, because only the worker writes the outbound call log and runs handlers.
export { ConnectionService, isAdminScope } from './connections.js';
export type { ConnectionInput, ConnectionRecord } from './connections.js';
export { CONNECTION_KINDS, hasSecretLikeKey } from './kinds.js';
export type { ConnectionKind } from './kinds.js';
export {
  DISPATCH_JOB,
  INBOUND_RECEIVED_EVENT,
  InboundReceiver,
  MAX_WEBHOOK_BODY_BYTES,
} from './inbound.js';
export type { ReceiveResult, ReceiverDeps } from './inbound.js';
export { SecretService } from './secret-service.js';
export type {
  Assertion,
  InboundRequestReceipt,
  SealedJobEnqueuer,
  SecretServiceDeps,
} from './secret-service.js';
export type { InboundKeyProvider, OutboundSecretStore, PayloadSealer } from './secret-store.js';
export {
  googleCalendarVerifier,
  googleChannelToken,
  hmacTimestampVerifier,
  safeEqual,
} from './verifiers.js';
export type {
  KeyVersion,
  Verdict,
  WebhookHeaders,
  WebhookRequest,
  WebhookVerifier,
} from './verifiers.js';
export { INTEGRATION_CORE_JOBS } from './jobs.js';
export {
  IntegrationError,
  IntegrationNotFoundError,
  IntegrationScopeError,
  IntegrationValidationError,
  RequestExpiredError,
  RequestStateError,
  SecretStoreUnavailableError,
  SelfApprovalError,
} from './errors.js';
