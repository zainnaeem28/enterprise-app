// Task handlers of integration-core (ARCHITECTURE 33.1). `createIntegrationCoreTasks` returns a task table for the
// worker's `startWorker({ tasks })`; `defineIntegrationCoreJobs` registers the types with the JobRegistry. The runner does
// not pass a crontab yet: INTEGRATION_CORE_CRONTAB is wired at integration.
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { runApplySecret, type ApplyDeps } from './apply-secret.js';
import { runDispatch, type DispatchDeps } from './dispatch.js';
import { runHealthCheck, type HealthDeps } from './health.js';
import { INTEGRATION_CORE_JOBS } from './jobs.js';

export {
  INTEGRATION_CORE_CRONTAB,
  INTEGRATION_CORE_EVENTS,
  INTEGRATION_CORE_JOBS,
} from './jobs.js';
export { ADAPTER_KINDS, ADAPTER_OPERATIONS, AdapterRegistry } from './adapters.js';
export type {
  AdapterKind,
  ConnectionView,
  CredentialReader,
  HealthResult,
  OperationOf,
  VendorAdapter,
  VendorCall,
  VendorResult,
} from './adapters.js';
export { CircuitBreakers } from './circuit.js';
export type { CircuitState } from './circuit.js';
export { VendorGateway } from './call-vendor.js';
export type { Correlation, GatewayDeps } from './call-vendor.js';
export {
  AdapterFailure,
  IntegrationError,
  IntegrationUsageError,
  VendorRejectedError,
  VendorUnavailableError,
} from './errors.js';
export { InboundHandlerRegistry, inboundContext, readInbound, runDispatch } from './dispatch.js';
export type { InboundHandlerFn, InboundMessage } from './dispatch.js';
export { nextHealth, runHealthCheck } from './health.js';
export { refusingVerifier, runApplySecret } from './apply-secret.js';
export type { ApprovalEvidenceVerifier, EvidenceInput, EvidenceVerdict } from './apply-secret.js';
export { SecretCache, credentialReaderFor, SECRET_CACHE_MS } from './secrets.js';
export type { InboundSecretWriter, PayloadOpener, SecretReader } from './secrets.js';
export { canonicalRequest, challengeOf, valueFingerprint } from './canonical.js';

export function defineIntegrationCoreJobs(registry: JobRegistry): void {
  for (const j of INTEGRATION_CORE_JOBS) registry.defineJob(j);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long an approved-but-not-yet-decided secret request waits between looks (the request lives 30 minutes). */
const RECHECK_SECONDS = 30;

export interface IntegrationCoreTaskDeps {
  dispatch: DispatchDeps;
  health: HealthDeps;
  apply: ApplyDeps;
}

export function createIntegrationCoreTasks(deps: IntegrationCoreTaskDeps): Record<string, Task> {
  return {
    'integration_core.dispatch_inbound': async (payload) => {
      const p = payload as { messageId?: unknown };
      if (typeof p.messageId !== 'string' || !UUID.test(p.messageId))
        throw new Error('integration_core.dispatch_inbound: bad payload');
      await runDispatch(deps.dispatch, p.messageId);
    },
    'integration_core.health_check': async () => {
      await runHealthCheck(deps.health);
    },
    'integration_core.apply_inbound_secret': async (payload, helpers) => {
      const p = payload as { requestId?: unknown; sealed?: unknown };
      if (
        typeof p.requestId !== 'string' ||
        !UUID.test(p.requestId) ||
        typeof p.sealed !== 'string'
      )
        throw new Error('integration_core.apply_inbound_secret: bad payload');
      const r = await runApplySecret(deps.apply, { requestId: p.requestId, sealed: p.sealed });
      if (r.status === 'waiting') {
        // Not approved yet: look again shortly. The sealed payload stays in this job only until the request is closed.
        await helpers.addJob('integration_core.apply_inbound_secret', payload, {
          runAt: new Date(Date.now() + RECHECK_SECONDS * 1000),
          jobKey: `integration_core.apply_inbound_secret:${p.requestId}`,
          maxAttempts: 3,
        });
      }
    },
  };
}
