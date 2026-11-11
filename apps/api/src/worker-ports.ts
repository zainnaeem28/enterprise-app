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
import { createTargetResolver } from './alert-target-resolver.js';
import {
  AlertService,
  escalateAlert,
  registerComplianceAlertHandlers,
} from './modules/notifications/alerts/index.js';
import { registerMessagingHandlers, runOnCorrectionRequested } from './modules/messaging/index.js';
import { assembleExport, loadRetentionSettings, retentionPolicy } from './modules/privacy/index.js';
import type { RetentionSettings } from './modules/privacy/index.js';
import { executeMerge, patientExportContributor } from './modules/patient/index.js';
import { newRegisteredRegistries } from './register-participants.js';
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
  /** The retention settings (owner ruling C item 2); default: the defaults overridden by the process environment. */
  retention?: RetentionSettings;
  now?: () => Date;
}

export function buildWorkerPorts(deps: WorkerPortsDeps) {
  const retention = deps.retention ?? loadRetentionSettings(process.env);
  registerSchedulingFlowHandlers(deps.registry);
  registerTelehealthHandlers(deps.registry);
  registerFrontdoorHandlers(deps.registry);
  registerMessagingHandlers(deps.registry);
  registerComplianceAlertHandlers(deps.registry);
  // One explicit registry object for the jobs that run here (merge executor, export assembly): the same registration site as the
  // API process and the dbtests (INT03-F04), and no dependence on the process-wide default being filled (INT03-F13, D-F13-5).
  const registries = newRegisteredRegistries();
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
  const targetResolver = createTargetResolver();
  const alerts = new AlertService({ queue: deps.queue, audit, resolver: targetResolver });
  // A compliance alert for an admin's own change must not reach that admin: the worker has no acting principal in its scope, so the
  // exclusion travels with the call. An empty result fails the job visibly (the alert service refuses a target list of zero).
  const alertsWithout = (exclude: readonly string[] | undefined): AlertService =>
    exclude === undefined || exclude.length === 0
      ? alerts
      : new AlertService({
          queue: deps.queue,
          audit,
          resolver: {
            roleHolders: (tx, roleKey, locationIds) =>
              targetResolver.roleHolders(tx, roleKey, locationIds),
            permissionHolders: async (tx, permission) =>
              (await targetResolver.permissionHolders(tx, permission)).filter(
                (id) => !exclude.some((x) => x.toLowerCase() === id.toLowerCase()),
              ),
          },
        });
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
    retention: retentionPolicy(retention),
    /** The participant registries handed to `executeMerge` and `assembleExport` (exposed for the worker-registries test). */
    registries,
    scheduling: flowPort(flow),
    telehealth: telehealthPort(new TelehealthJobService({ audit })),
    clinical: {
      retargetUnacknowledged: (tx: Tx, alertId: string) =>
        triage.retargetUnacknowledged(tx, alertId),
      raiseQuestionnaireRedFlag: (tx: Tx, responseId: string) =>
        triage.raiseQuestionnaireRedFlag(tx, responseId),
      noteSignReminder: (tx: Tx, payload: { encounterId: string; patientId: string }) =>
        runNoteSignReminder(reminder, tx, payload),
    },
    alerts: {
      escalateAlert: (tx: Tx, payload: { alertId: string; level: number }, jobId: string) =>
        escalateAlert(tx, deps.queue, payload, { jobId, audit }),
    },
    complianceAlerts: {
      raise: (
        tx: Tx,
        input: {
          type:
            | 'btg_opened'
            | 'privileged_change'
            | 'kill_switch_used'
            | 'audit_anchor_mismatch'
            | 'scope_drift';
          severity: 'low' | 'medium' | 'high' | 'critical';
          resourceType: string;
          resourceId: string;
          permission: string;
          /** Principals who never receive this alert (the subject and the acting admin, C4; INT04F02-S3). */
          excludePrincipalIds?: readonly string[];
        },
        jobId: string,
      ) =>
        alertsWithout(input.excludePrincipalIds).raise(
          tx,
          {
            type: input.type,
            severity: input.severity,
            targets: { kind: 'compliance_permission', permission: input.permission },
            resourceType: input.resourceType,
            resourceId: input.resourceId,
          },
          { jobId },
        ),
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
    executeMerge: (
      payload: Record<string, unknown>,
      ctx: { jobId: string; attempt: number; maxAttempts: number },
    ) =>
      executeMerge(
        {
          db: deps.db,
          orgId: deps.orgId,
          registries,
          queue: deps.queue,
          // Request ID, code, error class and SQL state only: no patient data (the executor passes none).
          onFailure: (info) =>
            deps.logger.error('patient merge failed', {
              requestId: info.requestId,
              code: info.code,
              errorName: info.errorName,
              ...(info.sqlState === undefined ? {} : { sqlState: info.sqlState }),
            }),
        },
        {
          requestId: payload['mergeRequestId'] as string,
          jobId: ctx.jobId,
          attempt: ctx.attempt,
          maxAttempts: ctx.maxAttempts,
        },
      ),
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
          registries,
          // `patient` is below `privacy`: called downwards, not registered (SHARED-BOUNDARIES 3.2 rule 6; QA-EXEC-F04).
          downward: [patientExportContributor],
          closureOf: deps.closureOf,
          queue: deps.queue,
          expiryDays: retention.exportPackageDays,
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
