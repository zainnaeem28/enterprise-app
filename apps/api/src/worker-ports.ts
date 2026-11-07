// Composition of the service-backed ports the worker's task handlers need (HEAAA-231, R8-N2). The worker cannot import this package
// at build time; `apps/worker/src/compose.ts` loads the built file and calls `buildWorkerPorts` with the worker-path queue. Only the
// services the two ports reach are built here: nothing is mounted and no route is served.
import type { JobRegistry, Logger, Queue } from '@ehr/kernel';
import { AuditService } from './modules/audit/index.js';
import { NotificationService } from './modules/notifications/index.js';
import { OrganisationService } from './modules/organisation/index.js';
import { PatientRecordsService } from './modules/patient/index.js';
import { AvailabilitySearch } from './modules/scheduling/availability/index.js';
import {
  flowPort,
  registerSchedulingFlowHandlers,
  SchedulingFlowService,
} from './modules/scheduling/flow/index.js';
import {
  registerTelehealthHandlers,
  TelehealthJobService,
  telehealthPort,
} from './modules/telehealth/index.js';

export interface WorkerPortsDeps {
  logger: Logger;
  /** Worker-path queue (`new Queue(registry, 'worker')`). */
  queue: Queue;
  /** The registry behind `queue`: the event handlers this process publishes to are registered on it. */
  registry: JobRegistry;
  patientHost: string;
  qrKey: Buffer;
  now?: () => Date;
}

export function buildWorkerPorts(deps: WorkerPortsDeps): {
  scheduling: ReturnType<typeof flowPort>;
  telehealth: ReturnType<typeof telehealthPort>;
} {
  registerSchedulingFlowHandlers(deps.registry);
  registerTelehealthHandlers(deps.registry);
  const audit = new AuditService({ logger: deps.logger, queue: deps.queue });
  const organisation = new OrganisationService();
  const records = new PatientRecordsService({
    audit,
    consentTemplates: {
      isPublished: async (tx, key, version) =>
        (
          await tx.query(
            `SELECT 1 FROM organisation.consent_template WHERE key = $1 AND version = $2 AND status = 'published' LIMIT 1`,
            [key, version],
          )
        ).rows.length > 0,
    },
    staff: {
      isStaffPrincipal: async (tx, principalId) =>
        (
          await tx.query(
            `SELECT 1 FROM identity.principal WHERE id = $1::uuid AND realm = 'google' AND status = 'active'`,
            [principalId],
          )
        ).rows.length > 0,
    },
    queue: deps.queue,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const flow = new SchedulingFlowService({
    audit,
    organisation,
    availability: new AvailabilitySearch({ organisation }),
    notifications: new NotificationService({
      queue: deps.queue,
      allowedLinkHosts: [deps.patientHost],
    }),
    records,
    queue: deps.queue,
    qrKey: { current: () => Promise.resolve(deps.qrKey) },
    portalUrl: `https://${deps.patientHost}/`,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  return {
    scheduling: flowPort(flow),
    telehealth: telehealthPort(new TelehealthJobService({ audit })),
  };
}
