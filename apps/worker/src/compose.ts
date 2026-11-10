// Composition root of the worker's task table (HEAAA-231, R8-N2): every registered job type gets a handler, built from the nine
// `create*Tasks` factories. Ports backed by the database or by the API's services are real. Ports that need infrastructure which does
// not exist yet (object store, malware scanner, OCR, secret store, payload-opening key, export sink, calendar channel key, e-mail/SMS/
// push/video/Google providers: C-01, C-10, C-11, DEVOPS-PLAN) are REFUSING: the job is picked up and the handler runs, then the port
// fails with `PortNotConfiguredError` (class name only in the log) and the library retries. Nothing here pretends those services work.
import { pathToFileURL } from 'node:url';
import { JobRegistry, KernelDb, Queue } from '@ehr/kernel';
import type { KernelConfig, Logger, PoolLike as KernelPoolLike } from '@ehr/kernel';
import type { Task } from 'graphile-worker';
import { createClinicalTasks, createClinicalWorkflowTasks } from './jobs/clinical/index.js';
import type { ClinicalWorkerPort, TerminologySource } from './jobs/clinical/index.js';
import { createAlertTasks } from './jobs/notifications/alert-jobs.js';
import type { AlertWorkerPort } from './jobs/notifications/alert-jobs.js';
import { createMessagingTasks } from './jobs/messaging/index.js';
import type { MessagingWorkerPort } from './jobs/messaging/index.js';
import {
  CiPackageStore,
  closureOf,
  createPrivacyTasks,
  documentsLegalHolds,
} from './jobs/privacy/index.js';
import type { PackageWriter, WorkerPackageStore } from './jobs/privacy/index.js';
import { createReportingTasks } from './jobs/reporting/index.js';
import type { ReportingWorkerPort } from './jobs/reporting/index.js';
import { createAuditTasks, emfMetricSink } from './jobs/audit/index.js';
import type { MetricSink } from './jobs/audit/index.js';
import type { AnchorArchiveStore, ExportSink } from './jobs/audit/index.js';
import { createCalendarSyncTasks, registerGooglePushHandler } from './jobs/calendar-sync/index.js';
import type { CalendarJobDeps } from './jobs/calendar-sync/index.js';
import {
  createDocumentsTasks,
  metadataStrippingReencoder,
  type WorkerObjectStore,
} from './jobs/documents/index.js';
import { createIdentityTasks } from './jobs/identity/index.js';
import type { ComplianceAlertPort, SecurityNoticePort } from './jobs/identity/index.js';
import { createComplianceAlertTasks } from './jobs/notifications/compliance-alerts.js';
import {
  AdapterRegistry,
  createIntegrationCoreTasks,
  credentialReaderFor,
  InboundHandlerRegistry,
  SecretCache,
  VendorGateway,
} from './jobs/integration-core/index.js';
import type {
  InboundSecretWriter,
  PayloadOpener,
  SecretReader,
} from './jobs/integration-core/index.js';
import { createNotificationsTasks } from './jobs/notifications/index.js';
import {
  createPatientTasks,
  createSurvivorOf,
  patientRecipientContributor,
  scopeDriftAlerter,
} from './jobs/patient/index.js';
import { createSchedulingFlowTasks } from './jobs/scheduling/index.js';
import type { SchedulingFlowPort } from './jobs/scheduling/index.js';
import { createTelehealthTasks } from './jobs/telehealth/index.js';
import type { TelehealthWorkerPort } from './jobs/telehealth/index.js';
import { buildWorkerRegistry } from './job-registry.js';
import type { PoolLike } from './runner.js';
import type { TaskTable } from './runner.js';

export class PortNotConfiguredError extends Error {
  constructor(readonly port: string) {
    super(`port not configured: ${port}`);
    this.name = 'PortNotConfiguredError';
  }
}

const refuse = (port: string): never => {
  throw new PortNotConfiguredError(port);
};

/** An object whose every method rejects with {@link PortNotConfiguredError}. */
function refusingPort<T extends object>(port: string): T {
  return new Proxy({} as T, {
    get: (_t, prop) =>
      typeof prop === 'symbol'
        ? undefined
        : (): Promise<never> => Promise.reject(new PortNotConfiguredError(`${port}.${prop}`)),
  });
}

/** The anchor archive until the log-archive bucket adapter exists: puts fail (the lag metric grows), verification reports the archive unavailable. */
const refusingAnchorArchive: AnchorArchiveStore = {
  putAnchor: () => Promise.reject(new PortNotConfiguredError('audit_anchor_archive.putAnchor')),
  listVersions: () => {
    throw new PortNotConfiguredError('audit_anchor_archive.listVersions');
  },
  getVersion: () => Promise.reject(new PortNotConfiguredError('audit_anchor_archive.getVersion')),
};

/** The service-backed ports, built by the API's composition (`apps/api/src/worker-ports.ts`). */
export interface ApiPorts {
  scheduling: SchedulingFlowPort;
  telehealth: TelehealthWorkerPort;
  clinical: ClinicalWorkerPort;
  messaging: MessagingWorkerPort;
  alerts: AlertWorkerPort;
  /** `AlertService.raise` under system scope with the admin-realm target resolver (SEC05-F03). */
  complianceAlerts: ComplianceAlertPort;
  reporting: ReportingWorkerPort;
  /** `patient.execute_merge`: the API's `executeMerge` with every participant registered (INT03-F13). */
  executeMerge(
    payload: Record<string, unknown>,
    ctx: { jobId: string; attempt: number; maxAttempts: number },
  ): Promise<unknown>;
  /** `privacy.assemble_export`: the API's `assembleExport` with the worker's package writer. */
  assembleExport(
    payload: Record<string, unknown>,
    ctx: { jobId: string; attempt: number; maxAttempts: number },
  ): Promise<unknown>;
}

export interface ComposeOptions {
  cfg: KernelConfig;
  pool: PoolLike;
  log: Logger;
  registry?: JobRegistry;
  /** Built API ports; without them the scheduling and telehealth ports refuse. */
  api?: ApiPorts;
  /** Public URL of the Google calendar webhook (configuration, never a setting); without it calendar jobs that need it refuse. */
  calendarWebhookUrl?: string;
  /** Infrastructure adapters; each defaults to a refusing port. */
  infra?: {
    exportSink?: ExportSink;
    /** Object Lock archive of audit anchors (log-archive bucket, SEC05-F02); refusing until the bucket adapter exists. */
    anchorArchive?: AnchorArchiveStore;
    objectStore?: WorkerObjectStore;
    secretReader?: SecretReader;
    secretWriter?: InboundSecretWriter;
    payloadOpener?: PayloadOpener;
    /** Terminology release source (NLM/UMLS licence, C-09). */
    terminologySource?: TerminologySource;
    /** Privacy package store with write access (bucket and KMS key, C-01). */
    packageWriter?: PackageWriter;
    packageStore?: WorkerPackageStore;
    /** The PHI-free notice to the security contact mailbox (B2-9); no mail channel is provisioned yet, so it defaults to refusing. */
    securityNotice?: SecurityNoticePort;
    /** Receives gauges such as `AuditAnchorLateSeconds`; defaults to a CloudWatch EMF line on stdout. */
    metrics?: MetricSink;
  };
}

/** Loads the API's composition from its built output (the worker does not depend on the API package at build time). */
export async function loadApiPorts(opts: {
  log: Logger;
  registry: JobRegistry;
  queue: Queue;
  patientHost: string;
  qrKey: string;
  orgId: string;
  db: KernelDb;
  packageWriter: PackageWriter;
  closureOf: typeof closureOf;
}): Promise<ApiPorts> {
  const url = pathToFileURL(
    new URL('../../api/dist/src/worker-ports.js', import.meta.url).pathname,
  ).href;
  const mod = (await import(url)) as {
    buildWorkerPorts(d: {
      logger: Logger;
      queue: Queue;
      registry: JobRegistry;
      patientHost: string;
      qrKey: Buffer;
      orgId: string;
      db: KernelDb;
      packageWriter: PackageWriter;
      closureOf: typeof closureOf;
    }): ApiPorts;
  };
  return mod.buildWorkerPorts({
    logger: opts.log,
    queue: opts.queue,
    registry: opts.registry,
    patientHost: opts.patientHost,
    qrKey: Buffer.from(opts.qrKey, 'utf8'),
    orgId: opts.orgId,
    db: opts.db,
    packageWriter: opts.packageWriter,
    closureOf: opts.closureOf,
  });
}

export function composeTasks(opts: ComposeOptions & { queue: Queue }): TaskTable {
  const { cfg, log, queue } = opts;
  const orgId = cfg.organisationId;
  if (orgId === undefined) throw new Error('EHR_ORGANISATION_ID is required by the worker');
  const db = new KernelDb(opts.pool as unknown as KernelPoolLike);
  const infra = opts.infra ?? {};
  const survivorOf = createSurvivorOf(db, orgId);

  // Vendor access goes through the gateway; with no provider adapter registered a call fails as "no adapter" (not configured).
  const adapters = new AdapterRegistry();
  const secrets = new SecretCache(infra.secretReader ?? refusingPort<SecretReader>('secret_store'));
  const gateway = new VendorGateway({
    db,
    orgId,
    adapters,
    credentials: (connectionId) => credentialReaderFor(db, orgId, connectionId, secrets),
    logger: log,
  });
  const vendor = gateway;
  const opener = infra.payloadOpener ?? refusingPort<PayloadOpener>('payload_opener');
  const inbound = new InboundHandlerRegistry();

  const calendar: CalendarJobDeps = {
    db,
    orgId,
    queue,
    vendor,
    channelKeys: refusingPort('calendar_channel_key'),
    get webhookUrl(): string {
      return opts.calendarWebhookUrl ?? refuse('calendar_webhook_url');
    },
    log,
  };
  registerGooglePushHandler(inbound, calendar);

  const tasks: Record<string, Task> = {
    ...createIdentityTasks({
      db,
      orgId,
      queue,
      adminEvents: {
        alerts:
          opts.api?.complianceAlerts ?? refusingPort<ComplianceAlertPort>('compliance_alerts'),
        notice: infra.securityNotice ?? refusingPort<SecurityNoticePort>('security_notice'),
      },
    }),
    ...createPatientTasks({
      db,
      orgId,
      // QA-EXEC-F10 / TC-AZ-09: a drift found by the daily check is a compliance alert, not only a repaired table.
      onDrift: scopeDriftAlerter({
        db,
        orgId,
        alerts:
          opts.api?.complianceAlerts ?? refusingPort<ComplianceAlertPort>('compliance_alerts'),
        log,
      }),
      executeMerge:
        opts.api?.executeMerge ??
        (() => Promise.reject(new PortNotConfiguredError('patient_execute_merge'))),
    }),
    ...createAuditTasks({
      db,
      queue,
      orgId,
      log,
      sink: infra.exportSink ?? refusingPort<ExportSink>('audit_export_sink'),
      archive: infra.anchorArchive ?? refusingAnchorArchive,
      metrics: infra.metrics ?? emfMetricSink(),
    }),
    ...createSchedulingFlowTasks({
      db,
      orgId,
      queue,
      log,
      survivorOf,
      flow: opts.api?.scheduling ?? refusingPort<SchedulingFlowPort>('scheduling_flow'),
    }),
    ...createTelehealthTasks({
      db,
      orgId,
      queue,
      log,
      survivorOf,
      vendor,
      telehealth: opts.api?.telehealth ?? refusingPort<TelehealthWorkerPort>('telehealth'),
    }),
    ...createCalendarSyncTasks(calendar),
    ...createNotificationsTasks({
      db,
      orgId,
      queue,
      log,
      gateway,
      survivorOf,
      recipients: { patient: patientRecipientContributor },
    }),
    ...createDocumentsTasks({
      db,
      orgId,
      queue,
      log,
      survivorOf,
      gateway,
      store: infra.objectStore ?? refusingPort<WorkerObjectStore>('object_store'),
      scan: () => Promise.reject(new PortNotConfiguredError('malware_scanner')),
      reencode: metadataStrippingReencoder,
    }),
    ...createIntegrationCoreTasks({
      dispatch: { db, orgId, queue, log, registry: inbound, opener },
      health: {
        db,
        orgId,
        queue,
        adapters,
        log,
        credentials: (c) => credentialReaderFor(db, orgId, c, secrets),
      },
      apply: {
        db,
        orgId,
        queue,
        log,
        opener,
        writer: infra.secretWriter ?? refusingPort<InboundSecretWriter>('secret_writer'),
      },
    }),
    ...createClinicalTasks({
      db,
      orgId,
      source: infra.terminologySource ?? refusingPort<TerminologySource>('terminology_source'),
      log,
    }),
    ...createClinicalWorkflowTasks({
      db,
      orgId,
      clinical: opts.api?.clinical ?? refusingPort<ClinicalWorkerPort>('clinical'),
    }),
    ...createComplianceAlertTasks({
      db,
      orgId,
      alerts: opts.api?.complianceAlerts ?? refusingPort<ComplianceAlertPort>('compliance_alerts'),
    }),
    ...createAlertTasks({
      db,
      orgId,
      alerts: opts.api?.alerts ?? refusingPort<AlertWorkerPort>('alerts'),
    }),
    ...createMessagingTasks({
      messaging: opts.api?.messaging ?? refusingPort<MessagingWorkerPort>('messaging'),
    }),
    ...createReportingTasks({
      reporting: opts.api?.reporting ?? refusingPort<ReportingWorkerPort>('reporting'),
    }),
    ...createPrivacyTasks({
      db,
      orgId,
      log,
      store:
        infra.packageStore ??
        (opts.cfg.environment === 'ci'
          ? new CiPackageStore()
          : refusingPort<WorkerPackageStore>('package_store')),
      holds: documentsLegalHolds,
      closureOf,
      assemble:
        opts.api?.assembleExport ??
        (() => Promise.reject(new PortNotConfiguredError('privacy_assemble_export'))),
    }),
  };
  return tasks;
}

/** Task table + the queue/registry it was built on, for `startWorker`. */
export async function composeWorker(
  opts: ComposeOptions & { patientHost?: string; qrKey?: string },
): Promise<{ tasks: TaskTable; registry: JobRegistry }> {
  const registry = opts.registry ?? buildWorkerRegistry();
  const queue = new Queue(registry, 'worker');
  let api = opts.api;
  if (api === undefined && opts.patientHost !== undefined && opts.qrKey !== undefined)
    api = await loadApiPorts({
      log: opts.log,
      registry,
      queue,
      patientHost: opts.patientHost,
      qrKey: opts.qrKey,
      orgId: opts.cfg.organisationId ?? refuse('EHR_ORGANISATION_ID'),
      db: new KernelDb(opts.pool as unknown as KernelPoolLike),
      packageWriter:
        opts.infra?.packageWriter ??
        (opts.cfg.environment === 'ci'
          ? new CiPackageStore()
          : refusingPort<PackageWriter>('package_writer')),
      closureOf,
    });
  else if (api === undefined)
    opts.log.warn('scheduling and telehealth ports not configured', {
      missing: 'EHR_PATIENT_HOST, EHR_CHECKIN_QR_KEY',
    });
  return {
    tasks: composeTasks({ ...opts, ...(api === undefined ? {} : { api }), queue }),
    registry,
  };
}
