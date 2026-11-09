// Composition of the service-backed ports the worker's task handlers need (HEAAA-231, R8-N2). The worker cannot import this package
// at build time; `apps/worker/src/compose.ts` loads the built file and calls `buildWorkerPorts` with the worker-path queue. Only the
// services the two ports reach are built here: nothing is mounted and no route is served.
import type { JobRegistry, KernelDb, Logger, Queue, Tx } from '@ehr/kernel';
import { AuditService } from './modules/audit/index.js';
import {
  createFrontdoorPorts,
  registerFrontdoorHandlers,
  TriageService,
} from './modules/clinical/frontdoor/index.js';
import { NoteReminderService, runNoteSignReminder } from './modules/clinical/notes/index.js';
import { AlertService, escalateAlert } from './modules/notifications/alerts/index.js';
import { registerMessagingHandlers, runOnCorrectionRequested } from './modules/messaging/index.js';
import { assembleExport } from './modules/privacy/index.js';
import type { PackageWriterPort } from './modules/privacy/index.js';
import { runRefreshOps } from './modules/reporting/index.js';
import { NotificationService } from './modules/notifications/index.js';
import { OrganisationService } from './modules/organisation/index.js';
import { isConsentTemplatePublished } from './modules/organisation/consent-template-port.js';
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
  /** Pool of the worker role; the M4 handlers open their own scopes on it. */
  db: KernelDb;
  orgId: string;
  /** The privacy package store with write access (bucket and KMS key: C-01); the worker supplies a refusing one until then. */
  packageWriter: PackageWriterPort;
  /** `patient.closure(id)` in the transaction handed in. */
  closureOf: (tx: Tx, patientId: string) => Promise<string[]>;
  now?: () => Date;
}

export function buildWorkerPorts(deps: WorkerPortsDeps) {
  registerSchedulingFlowHandlers(deps.registry);
  registerTelehealthHandlers(deps.registry);
  registerFrontdoorHandlers(deps.registry);
  registerMessagingHandlers(deps.registry);
  const audit = new AuditService({ logger: deps.logger, queue: deps.queue });
  const organisation = new OrganisationService();
  const records = new PatientRecordsService({
    audit,
    consentTemplates: { isPublished: isConsentTemplatePublished },
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
  // Milestone M4 handlers. The re-target needs only the roster and the alert service; the ports it never calls refuse.
  const alerts = new AlertService({ queue: deps.queue, audit });
  const unused = (port: string): never =>
    new Proxy({} as never, {
      get: (_t, prop) => (): Promise<never> =>
        Promise.reject(new Error(`worker port not available: ${port}.${String(prop)}`)),
    });
  const frontdoorPorts = createFrontdoorPorts({
    flow,
    alerts,
    organisation,
    records,
    patients: unused('patients'),
    queue: deps.queue,
  });
  const triage = new TriageService({
    audit,
    checkIns: frontdoorPorts.checkIns,
    duty: frontdoorPorts.duty,
    alerts: frontdoorPorts.alerts,
    catalog: frontdoorPorts.catalog,
    events: frontdoorPorts.events,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const reminder = new NoteReminderService({
    alerts: {
      raise: (tx, input) => alerts.raise(tx, input),
    },
  });
  return {
    scheduling: flowPort(flow),
    telehealth: telehealthPort(new TelehealthJobService({ audit })),
    clinical: {
      retargetUnacknowledged: (tx: Tx, alertId: string) =>
        triage.retargetUnacknowledged(tx, alertId),
      noteSignReminder: (tx: Tx, payload: { encounterId: string; patientId: string }) =>
        runNoteSignReminder(reminder, tx, payload),
    },
    alerts: {
      escalateAlert: (tx: Tx, payload: { alertId: string; level: number }, jobId: string) =>
        escalateAlert(tx, deps.queue, payload, { jobId, audit }),
    },
    messaging: {
      onCorrectionRequested: (payload: Record<string, unknown>, jobId: string) =>
        runOnCorrectionRequested(
          {
            db: deps.db,
            orgId: deps.orgId,
            audit,
            queue: deps.queue,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
          payload,
          jobId,
        ),
    },
    reporting: {
      refreshOps: () =>
        runRefreshOps(
          {
            db: deps.db,
            staleMinutes: (tx) => organisation.setting<number>(tx, 'calendar_stale_minutes'),
          },
          deps.orgId,
        ),
    },
    assembleExport: (
      payload: Record<string, unknown>,
      ctx: { jobId: string; attempt: number; maxAttempts: number },
    ) =>
      assembleExport(
        {
          db: deps.db,
          orgId: deps.orgId,
          audit,
          writer: deps.packageWriter,
          closureOf: deps.closureOf,
          queue: deps.queue,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        },
        {
          packageId: payload['packageId'] as string,
          jobId: ctx.jobId,
          attempt: ctx.attempt,
          maxAttempts: ctx.maxAttempts,
        },
      ),
  };
}
