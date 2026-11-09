// Composition root of the merge and export participants (ARCHITECTURE 22.16, 24). Every module that holds patient data registers
// its participant here, once, at start-up; the patient merge executor fails (patient.merge_participant_missing) when a table with a
// patient_id is covered by none. The patient module's own participant is not registered: the executor runs it first.
// Scheduling registers through the flow participant INSTEAD of the booking core's (it covers the core's tables too).
import { createHmac } from 'node:crypto';
import { JobRegistry, Queue } from '@ehr/kernel';
import type { JobType, KernelDb, Logger, ScopeSettings } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import { createPatientCliniciansControllers } from './clinicians.controller.js';
import type { IdentityEnv } from './identity-env.js';
import type { GuardPolicy } from './platform/guard.js';
import { MemoryRateLimiter, PgRateLimiter } from './platform/rate-limit.js';
import { AUDIT_JOBS, AuditService } from './modules/audit/index.js';
import { createClinicalChart, CLINICAL_CHART_JOBS } from './modules/clinical/chart/index.js';
import {
  createClinicalFrontdoor,
  createFrontdoorPorts,
  FRONTDOOR_JOBS,
  registerFrontdoorHandlers,
} from './modules/clinical/frontdoor/index.js';
import {
  createClinicalNotes,
  createNotesPorts,
  NOTES_JOBS,
} from './modules/clinical/notes/index.js';
import {
  createMessaging,
  MESSAGING_JOBS,
  registerMessagingHandlers,
} from './modules/messaging/index.js';
import { AlertService, ALERT_JOBS } from './modules/notifications/alerts/index.js';
import { createPrivacy, PRIVACY_JOBS } from './modules/privacy/index.js';
import type { PackageStorePort } from './modules/privacy/index.js';
import { createReporting, REPORTING_JOBS } from './modules/reporting/index.js';
import {
  createIdentity,
  GoogleRealmAdapter,
  IDENTITY_JOBS,
  OidcPatientAdapter,
  requireAuthContext,
} from './modules/identity/index.js';
import {
  createMergeControllers,
  createPatient,
  MERGE_JOBS,
  MergeService,
  mergeResolvers,
  patientInScope,
} from './modules/patient/index.js';
import { NOTIFICATIONS_JOBS, NotificationService } from './modules/notifications/index.js';
import {
  AvailabilitySearch,
  AvailabilityService,
  availabilityResolvers,
  createAvailabilityControllers,
} from './modules/scheduling/availability/index.js';
import {
  createSchedulingControllers,
  SCHEDULING_CORE_JOBS,
  SchedulingCoreService,
  schedulingResolvers,
} from './modules/scheduling/core/index.js';
import {
  createFlowControllers,
  flowResolvers,
  registerSchedulingFlowHandlers,
  SCHEDULING_FLOW_JOBS,
  SchedulingFlowService,
} from './modules/scheduling/flow/index.js';
import type { PrevisitPort } from './modules/scheduling/flow/types.js';
import type { ClinicalFrontdoor } from './modules/clinical/frontdoor/index.js';
import { createCatalogueControllers, OrganisationService } from './modules/organisation/index.js';
import { isConsentTemplatePublished } from './modules/organisation/consent-template-port.js';

export { registerAllParticipants } from './register-participants.js';

/** The package store's presigner is delivered with the bucket and the KMS key (C-01); until then a download link is refused, never faked. */
export const refusingPackageStore: PackageStorePort = {
  presignGet(): never {
    throw new Error('port not configured: package_store');
  },
};

/** The HMAC key of the list cursors, derived from the rate key with a fixed label (one secret, no new variable; decision HEAAA-286 needs one key for chart and notes). */
export const cursorKeyOf = (rateKey: string): string =>
  createHmac('sha256', rateKey).update('ehr:list-cursor-key:v1').digest('hex');

export interface Composition {
  /** The identity guard policy: pass to `createApp` as `policy` (replaces the deny-everything default). */
  policy: GuardPolicy;
  controllers: Type<unknown>[];
  /** The API-path job registry: every job type an API request (or its handler registration) may publish. */
  registry: JobRegistry;
}

/** Every job type an API request may publish (the API-path queue). The worker's registry must hold each one (worker test). */
export const API_PATH_JOBS: readonly JobType[] = [
  ...IDENTITY_JOBS,
  ...AUDIT_JOBS,
  ...MERGE_JOBS,
  ...NOTIFICATIONS_JOBS,
  ...SCHEDULING_CORE_JOBS,
  ...SCHEDULING_FLOW_JOBS,
  ...ALERT_JOBS,
  ...CLINICAL_CHART_JOBS,
  ...FRONTDOOR_JOBS,
  ...NOTES_JOBS,
  ...MESSAGING_JOBS,
  ...PRIVACY_JOBS,
  ...REPORTING_JOBS,
];

/**
 * The HTTP surface of the API process and its guard. Mounted: identity (sign-in, callback, session), the patient catalogue reads
 * (`GET /api/v1/services|locations`), the patient clinician list (`GET /api/v1/clinicians`), scheduling availability (search and
 * the staff/admin management routes), the booking core (holds, confirm, appointments) and the flow (check-in, queue, waitlist,
 * pre-visit), the patient module (portal, staff and admin routes, merges), and milestone M4: the clinical chart, front door and notes, messaging, privacy and reporting. A route that is not listed
 * is not served. `main.ts` and the composition tests call this one function.
 */
export function buildComposition(deps: {
  db: KernelDb;
  logger: Logger;
  identity: IdentityEnv;
  /** Presigner of the privacy package store; defaults to the refusing one. */
  packageStore?: PackageStorePort;
  now?: () => Date;
}): Composition {
  const env = deps.identity;
  // The API-path queue: every job type an API request may publish, defined once.
  const registry = new JobRegistry();
  for (const j of API_PATH_JOBS) registry.defineJob(j);
  registerSchedulingFlowHandlers(registry);
  registerFrontdoorHandlers(registry);
  registerMessagingHandlers(registry);
  const queue = new Queue(registry, 'api');
  const audit = new AuditService({ logger: deps.logger, queue });
  const organisation = new OrganisationService();

  const identity = createIdentity({
    db: deps.db,
    queue,
    audit,
    logger: deps.logger,
    config: {
      orgId: env.orgId,
      hosts: { [env.staffHost]: 'google', [env.patientHost]: 'patient_pool' },
      allowedOrigins: env.allowedOrigins,
      oidcStateKeys: { current: env.oidcStateKey },
      csrfKey: env.csrfKey,
      rateKey: env.rateKey,
    },
    realms: {
      google: new GoogleRealmAdapter({ ...env.staff }),
      patient_pool: new OidcPatientAdapter({
        endpoints: env.patient.endpoints,
        clientId: env.patient.clientId,
        redirectUri: env.patient.redirectUri,
        ...(env.patient.clientSecret === undefined
          ? {}
          : { clientSecret: env.patient.clientSecret }),
      }),
    },
    patientInScope,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  // The patient module registers its scope contributor and resolvers with identity; its records service is the flow's consent probe.
  // Its portal, staff and admin controllers and the merge controllers are mounted below (INT03-F13). The label and lookup limits are
  // compliance controls (6.7, 31.3), so the limiter is the shared one: a per-process counter would multiply them by the replica count.
  const patient = createPatient({
    db: deps.db,
    audit,
    identity,
    limiter: new PgRateLimiter(deps.db, env.orgId, env.rateKey),
    matchKey: env.matchKey,
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
    queue,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  // The merge routes are served only together with the worker's `patient.execute_merge` task (apps/worker, D-F13-5).
  const merges = new MergeService({ queue });
  for (const [name, fn] of Object.entries(mergeResolvers()))
    identity.policy.registerResolver(name, fn);

  const search = new AvailabilitySearch({ organisation });
  const availability = new AvailabilityService({ audit });
  const core = new SchedulingCoreService({ audit, organisation, availability: search, queue });
  // The front door supplies the flow's pre-visit port and itself needs the flow: bound after both exist.
  const previsit: PrevisitPort = {
    requiredConsents: (tx, serviceId) => frontdoor().previsitPort.requiredConsents(tx, serviceId),
    questionnaireComplete: (tx, patientId, reservationId) =>
      frontdoor().previsitPort.questionnaireComplete(tx, patientId, reservationId),
  };
  const late: { frontdoor?: ClinicalFrontdoor } = {};
  const frontdoor = (): ClinicalFrontdoor => {
    if (late.frontdoor === undefined) throw new Error('clinical front door is not composed yet');
    return late.frontdoor;
  };
  const flow = new SchedulingFlowService({
    previsit,
    audit,
    organisation,
    availability: search,
    notifications: new NotificationService({ queue, allowedLinkHosts: [env.patientHost] }),
    records: patient.records,
    queue,
    qrKey: { current: () => Promise.resolve(Buffer.from(env.qrKey, 'utf8')) },
    portalUrl: `https://${env.patientHost}/`,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  for (const [name, fn] of Object.entries({
    ...schedulingResolvers(),
    ...availabilityResolvers(),
    ...flowResolvers(),
  }))
    identity.policy.registerResolver(name, fn);

  // Milestone M4. Order matters: the chart first (the front door and the notes build on it), the scheduling resolvers are registered
  // above (`reservation`, `chart-patient` are looked up by the front door's and the notes' routes).
  const alerts = new AlertService({ queue, audit });
  const cursorKey = cursorKeyOf(env.rateKey);
  const chart = createClinicalChart({
    db: deps.db,
    audit,
    identity,
    patients: patient.patients,
    cursorKey,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const frontdoorPorts = createFrontdoorPorts({
    flow,
    alerts,
    organisation,
    records: patient.records,
    patients: patient.patients,
    queue,
  });
  const frontdoorBuilt = createClinicalFrontdoor({
    db: deps.db,
    chart,
    audit,
    identity,
    ports: frontdoorPorts,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  late.frontdoor = frontdoorBuilt;
  const notes = createClinicalNotes({
    db: deps.db,
    audit,
    chart,
    consentGate: frontdoorBuilt.consentGate,
    identity,
    ports: createNotesPorts({ alerts, queue }),
    cursorKey,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const messaging = createMessaging({ db: deps.db, audit, identity, queue });
  const privacy = createPrivacy({
    db: deps.db,
    audit,
    organisation,
    identity,
    queue,
    store: deps.packageStore ?? refusingPackageStore,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const reporting = createReporting({ db: deps.db });

  const scopeOf = (req: Parameters<typeof requireAuthContext>[0]): ScopeSettings =>
    requireAuthContext(req).scope;
  return {
    policy: identity.policy,
    registry,
    controllers: [
      ...identity.controllers,
      ...createCatalogueControllers({ db: deps.db, organisation, scopeOf }),
      ...createPatientCliniciansControllers({
        db: deps.db,
        organisation,
        scheduling: availability,
        scopeOf,
      }),
      ...patient.controllers,
      ...createMergeControllers({ db: deps.db, merges }),
      ...createAvailabilityControllers({ db: deps.db, audit, availability, search }),
      ...createSchedulingControllers({ db: deps.db, scheduling: core }),
      ...createFlowControllers({ db: deps.db, flow, limiter: new MemoryRateLimiter(1) }),
      ...chart.controllers,
      ...frontdoorBuilt.controllers,
      ...notes.controllers,
      ...messaging.controllers,
      ...privacy.controllers,
      ...reporting.controllers,
    ],
  };
}
