// Composition root of the merge and export participants (ARCHITECTURE 22.16, 24). Every module that holds patient data registers
// its participant here, once, at start-up; the patient merge executor fails (patient.merge_participant_missing) when a table with a
// patient_id is covered by none. The patient module's own participant is not registered: the executor runs it first.
// Scheduling registers through the flow participant INSTEAD of the booking core's (it covers the core's tables too).
import { createHmac } from 'node:crypto';
import { JobRegistry, Queue } from '@ehr/kernel';
import type { JobType, KernelDb, Logger, ScopeSettings } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import { createPatientCliniciansControllers } from './clinicians.controller.js';
import type { AdminEnv } from './admin-env.js';
import type { IdentityEnv } from './identity-env.js';
import type { GuardPolicy } from './platform/guard.js';
import { MemoryRateLimiter, PgRateLimiter } from './platform/rate-limit.js';
import { AUDIT_JOBS, AuditService } from './modules/audit/index.js';
import {
  createTelehealthControllers,
  registerTelehealthHandlers,
  TELEHEALTH_JOBS,
  TelehealthService,
} from './modules/telehealth/index.js';
import type { VideoVendorPort } from './modules/telehealth/index.js';
import {
  createBreakGlassControllers,
  createClinicalChart,
  type BannerService,
  CLINICAL_CHART_JOBS,
} from './modules/clinical/chart/index.js';
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
  toEncounterView,
} from './modules/clinical/notes/index.js';
import {
  createMessaging,
  MESSAGING_JOBS,
  registerMessagingHandlers,
} from './modules/messaging/index.js';
import {
  AlertService,
  ALERT_JOBS,
  createAlertsController,
  registerComplianceAlertHandlers,
} from './modules/notifications/alerts/index.js';
import { createTargetResolver } from './alert-target-resolver.js';
import { createAlertStreamController, StreamHub } from './modules/notifications/stream/index.js';
import type { ListenClient } from './modules/notifications/stream/index.js';
import {
  createDocumentsControllers,
  documentsResolvers,
  DocumentsService,
} from './modules/documents/index.js';
import type { ObjectStorePort } from './modules/documents/index.js';
import { createPrivacy, PRIVACY_JOBS } from './modules/privacy/index.js';
import type { PackageStorePort } from './modules/privacy/index.js';
import {
  createIntegrationsHostControllers,
  httpsConfirmSubscription,
  httpsFetchCertificate,
  SnsReceiptReceiver,
  PublicDirectoryService,
} from './modules/integrations-host/index.js';
import type { ReceiptChannel } from './modules/integrations-host/index.js';
import { createReporting, REPORTING_JOBS } from './modules/reporting/index.js';
import { createIdentityAdmin, IDENTITY_ADMIN_JOBS } from './modules/identity/admin/index.js';
import type { WebAuthnPort } from './modules/identity/admin/index.js';
import {
  createIdentity,
  GoogleRealmAdapter,
  IDENTITY_JOBS,
  OidcPatientAdapter,
  requireAuthContext,
  SessionService,
} from './modules/identity/index.js';
import {
  createMergeControllers,
  createPatient,
  MERGE_JOBS,
  MergeService,
  mergeResolvers,
  patientInScope,
} from './modules/patient/index.js';
import {
  NOTIFICATIONS_JOBS,
  NotificationService,
  TemplateService,
} from './modules/notifications/index.js';
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
import {
  AuditAdminService,
  createAdminRoutesControllers,
  IntegrationAdminService,
} from './modules/admin-routes/index.js';
import type { ConnectionTester, ExportUrlSigner } from './modules/admin-routes/index.js';
import {
  ConnectionService,
  INTEGRATION_CORE_JOBS,
  InboundReceiver,
  SecretService,
} from './modules/integration-core/index.js';
import type {
  InboundKeyProvider,
  OutboundSecretStore,
  PayloadSealer,
  SealedJobEnqueuer,
} from './modules/integration-core/index.js';
import { createTemplateAdminController } from './modules/notifications/admin-controller.js';
import {
  CALENDAR_SYNC_JOBS,
  CalendarLinkService,
  CalendarUnavailableError,
  calendarResolvers,
  createCalendarControllers,
  GoogleCalendarPush,
  registerCalendarSyncHandlers,
} from './modules/calendar-sync/index.js';
import type { OAuthPort } from './modules/calendar-sync/index.js';
import { createCatalogueControllers, OrganisationService } from './modules/organisation/index.js';
import {
  createOrganisationAdminController,
  OrganisationAdminService,
} from './modules/organisation/admin/index.js';
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

/** The documents object store's presigner is delivered with the bucket (C-01); until then an upload or download URL is refused, never faked. */
export const refusingObjectStore: ObjectStorePort = {
  presignPut(): never {
    throw new Error('port not configured: object_store');
  },
  presignGet(): never {
    throw new Error('port not configured: object_store');
  },
};

/** The secret store and the payload sealer are delivered with the secrets service and its KMS key (C-01); until then a secret write is refused, never faked. */
export const refusingSecretStore: OutboundSecretStore = {
  put(): never {
    throw new Error('port not configured: secret_store');
  },
};
export const refusingPayloadSealer: PayloadSealer = {
  seal(): never {
    throw new Error('port not configured: payload_sealer');
  },
};

/**
 * The infrastructure ports of the admin routes (BE-24). Every one is optional and absent means "refused": no signer makes an export
 * download 503, no tester makes "test connection" 503 (only the worker may write the health columns), no sealed-payload enqueuer makes
 * an inbound-secret request 503. None is replaced by a test value in production.
 */
export interface AdminPorts {
  signer?: ExportUrlSigner;
  tester?: ConnectionTester;
  secretStore?: OutboundSecretStore;
  sealer?: PayloadSealer;
  enqueueApply?: SealedJobEnqueuer;
}

/**
 * The infrastructure ports of the calendar-sync routes (BE-14). Every one is optional and absent means "refused": no OAuth client makes
 * `POST /calendar-link/start` 503, no secret store makes the callback 503, and no channel key makes every Google push 401 (nothing is
 * accepted without a verifiable token). None is replaced by a test value in production.
 */
export interface CalendarPorts {
  oauth?: OAuthPort;
  store?: OutboundSecretStore;
  sealer?: PayloadSealer;
  channelKeys?: InboundKeyProvider;
  /** Where the browser lands after the OAuth callback; defaults to the doctor portal's calendar page. */
  returnUrl?: string;
}

/**
 * The SNS delivery-receipt route (INT-N2): `POST /webhooks/sns/receipts`. Absent means the route answers 404. With no `sealer` the
 * route verifies, then answers 503 at the store (a payload is never stored unsealed); `main.ts` supplies the sealer once one exists.
 */
export interface ReceiptPorts {
  region: string;
  /** TopicArn -> channel. Also the allowlist of topics the route accepts. */
  topics: ReadonlyMap<string, ReceiptChannel>;
  sealer?: PayloadSealer;
  trustAnchorsPem?: readonly string[];
  maxAgeSeconds?: number;
  /** Test seams: default to HTTPS GETs on the pinned SNS host. */
  fetchCertificate?: (url: string) => Promise<string>;
  confirmSubscription?: (url: string) => Promise<number>;
}

export const refusingOAuth: OAuthPort = {
  authorizationUrl(): never {
    throw new CalendarUnavailableError();
  },
  exchangeCode(): never {
    throw new CalendarUnavailableError();
  },
};

/** The HMAC key of the OAuth state, derived from the rate key with a fixed label (one secret, no new variable). */
export const calendarStateKeyOf = (rateKey: string): Buffer =>
  createHmac('sha256', rateKey).update('ehr:calendar-oauth-state:v1').digest();

export interface Composition {
  /** Present when a LISTEN connection factory was supplied: it replaces the platform's transport-only `GET /alerts/stream` (ALR-N3); the caller runs `start()`/`stop()` with the app. */
  alertStreamHub?: StreamHub;
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
  ...TELEHEALTH_JOBS,
  ...REPORTING_JOBS,
  ...IDENTITY_ADMIN_JOBS,
  ...INTEGRATION_CORE_JOBS,
  ...CALENDAR_SYNC_JOBS,
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
  /** Presigner of the documents store; defaults to the refusing one. */
  objectStore?: ObjectStorePort;
  /**
   * The admin realm (BE-05, BE-23, BE-24): `/api/v1/admin/*` and the admin ceremonies. Absent means the realm is NOT mounted and no elevation
   * checker is installed (every elevated route is then refused by the guard); `main.ts` always supplies it (fail-closed, SEC02-F01).
   */
  admin?: AdminEnv;
  adminPorts?: AdminPorts;
  calendarPorts?: CalendarPorts;
  receiptPorts?: ReceiptPorts;
  /** Test seam only (`main.ts` never passes it): replaces the pinned WebAuthn library port so a test can enrol a software key. */
  webauthnPort?: WebAuthnPort;
  /** A NEW client on its own (non-pooled) connection per call; when given, the alert stream hub is composed. */
  listen?: () => ListenClient;
  now?: () => Date;
}): Composition {
  const env = deps.identity;
  // The API-path queue: every job type an API request may publish, defined once.
  const registry = new JobRegistry();
  for (const j of API_PATH_JOBS) registry.defineJob(j);
  registerSchedulingFlowHandlers(registry);
  registerFrontdoorHandlers(registry);
  registerMessagingHandlers(registry);
  registerComplianceAlertHandlers(registry);
  registerTelehealthHandlers(registry);
  registerCalendarSyncHandlers(registry);
  const queue = new Queue(registry, 'api');
  const audit = new AuditService({ logger: deps.logger, queue });
  const organisation = new OrganisationService();

  // The admin realm is built first: its elevation checker is the guard's C1 check, installed in the identity policy below. It has its
  // own session service over the same tables (the sessions are rows, not process state).
  const admin =
    deps.admin === undefined
      ? undefined
      : createIdentityAdmin({
          db: deps.db,
          queue,
          audit,
          logger: deps.logger,
          ...(deps.webauthnPort === undefined ? {} : { port: deps.webauthnPort }),
          sessions: new SessionService({
            db: deps.db,
            orgId: env.orgId,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          }),
          config: {
            orgId: env.orgId,
            ceremony: {
              rpId: env.staffHost,
              rpName: deps.admin.rpName,
              expectedOrigins: [`https://${env.staffHost}`],
            },
            attestation: { mode: 'chain', rootCertificatesPem: deps.admin.attestationRootsPem },
            allowedAaguids: deps.admin.allowedAaguids,
            decoyKey: deps.admin.decoyKey,
            rateKey: env.rateKey,
            csrfKey: env.csrfKey,
            allowedOrigins: [`https://${env.staffHost}`],
          },
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });

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
    ...(admin === undefined ? {} : { elevation: admin.elevation }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  // The patient module registers its scope contributor and resolvers with identity; its records service is the flow's consent probe.
  // Its portal, staff and admin controllers and the merge controllers are mounted below (INT03-F13). The label and lookup limits are
  // compliance controls (6.7, 31.3), so the limiter is the shared one: a per-process counter would multiply them by the replica count.
  // `GET /patients/{id}` returns the clinical banner (ARCH 28.2); the chart is built after the patient module, so bind it late.
  const late: { banner?: BannerService } = {};
  const patient = createPatient({
    banner: (tx, req, patientId) => {
      if (late.banner === undefined) throw new Error('clinical chart is not composed yet');
      return late.banner.bannerFor(
        tx,
        requireAuthContext(req),
        {
          requestId: req.requestId ?? null,
          ip: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
        },
        patientId,
      );
    },
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
  const alerts = new AlertService({ queue, audit, resolver: createTargetResolver() });
  const cursorKey = cursorKeyOf(env.rateKey);
  const chart = createClinicalChart({
    db: deps.db,
    audit,
    identity,
    patients: patient.patients,
    cursorKey,
    // The chart summary's history and documents parts (TC-CL-08b, RA-R1-24): rows are as the caller's RLS shows them; `documents` is
    // composed further down, read only when a request arrives.
    encounters: async (tx, patientId) =>
      (
        await tx.query(
          `SELECT * FROM clinical.encounter WHERE patient_id = $1::uuid ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 200`,
          [patientId],
        )
      ).rows.map((r) => toEncounterView(r as Parameters<typeof toEncounterView>[0])),
    documents: (tx, patientId) => documents.list(tx, patientId),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  late.banner = chart.banner;
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
  // Telehealth (BE-15): the video vendor is not selected yet (C-11), so the port refuses every call; a join then answers 503
  // `telehealth.vendor_unavailable`. The session, waiting room, device check and location routes need no vendor.
  const refusingVideoVendor: VideoVendorPort = {
    issueJoinToken: () => Promise.reject(new Error('video vendor not configured')),
  };
  const telehealth = new TelehealthService({
    db: deps.db,
    audit,
    organisation,
    vendor: refusingVideoVendor,
    queue,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  // The integrations host (BE-22, INT03-F18): GET /public/v1/services|locations|clinicians. No webhook vendor is configured yet (no
  // verifier, no key store), so the receiver answers 404 for every source until C-01 delivers them.
  const integrationsHost = createIntegrationsHostControllers({
    directory: new PublicDirectoryService({
      db: deps.db,
      orgId: env.orgId,
      organisation,
      scheduling: availability,
    }),
    receiver: { receive: () => Promise.resolve({ status: 404 }) },
    ...(deps.receiptPorts === undefined
      ? {}
      : {
          snsReceipts: new SnsReceiptReceiver({
            region: deps.receiptPorts.region,
            topics: deps.receiptPorts.topics,
            store: new InboundReceiver({
              db: deps.db,
              queue,
              sealer: deps.receiptPorts.sealer ?? refusingPayloadSealer,
              keys: { keys: () => Promise.resolve([]) },
              orgId: env.orgId,
              verifiers: new Map(),
              logger: deps.logger,
            }),
            fetchCertificate:
              deps.receiptPorts.fetchCertificate ?? httpsFetchCertificate(deps.receiptPorts.region),
            confirmSubscription:
              deps.receiptPorts.confirmSubscription ??
              httpsConfirmSubscription(deps.receiptPorts.region),
            ...(deps.receiptPorts.trustAnchorsPem === undefined
              ? {}
              : { trustAnchorsPem: deps.receiptPorts.trustAnchorsPem }),
            ...(deps.receiptPorts.maxAgeSeconds === undefined
              ? {}
              : { maxAgeSeconds: deps.receiptPorts.maxAgeSeconds }),
            logger: deps.logger,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          }),
        }),
  });

  // Calendar sync (BE-14): the doctor's calendar link and the Google push webhook. The ports default to refusing ones (see CalendarPorts).
  const calendarPorts = deps.calendarPorts ?? {};
  const calendarControllers = createCalendarControllers({
    db: deps.db,
    links: new CalendarLinkService({
      db: deps.db,
      audit,
      queue,
      store: calendarPorts.store ?? refusingSecretStore,
      oauth: calendarPorts.oauth ?? refusingOAuth,
      stateKeys: [calendarStateKeyOf(env.rateKey)],
      logger: deps.logger,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
    push: new GoogleCalendarPush({
      db: deps.db,
      queue,
      sealer: calendarPorts.sealer ?? refusingPayloadSealer,
      keys: calendarPorts.channelKeys ?? { keys: () => Promise.resolve([]) },
      orgId: env.orgId,
      logger: deps.logger,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
    returnUrl: calendarPorts.returnUrl ?? `https://${env.staffHost}/doctor/calendar`,
  });
  for (const [name, fn] of Object.entries(calendarResolvers()))
    identity.policy.registerResolver(name, fn);

  // Documents (BE-10): the patient-portal routes (patient host) and the staff routes (staff host), including the staff variants of the
  // four shared paths (INT03-F21-O1).
  const documents = new DocumentsService({
    audit,
    organisation,
    store: deps.objectStore ?? refusingObjectStore,
    queue,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  for (const [name, fn] of Object.entries(documentsResolvers()))
    identity.policy.registerResolver(name, fn);

  const scopeOf = (req: Parameters<typeof requireAuthContext>[0]): ScopeSettings =>
    requireAuthContext(req).scope;
  const alertControllers: Type<unknown>[] = [
    createAlertsController({ db: deps.db, alerts, scopeOf }),
  ];
  let alertStreamHub: StreamHub | undefined;
  if (deps.listen !== undefined) {
    alertStreamHub = new StreamHub({
      db: deps.db,
      alerts,
      listen: deps.listen,
      logger: deps.logger,
    });
    alertControllers.push(
      createAlertStreamController(alertStreamHub, (req) => {
        const c = requireAuthContext(req);
        return { sessionId: c.session.id, principalId: c.session.principalId, scope: c.scope };
      }),
    );
  }
  const adminControllers: Type<unknown>[] = [];
  if (admin !== undefined) {
    const ports = deps.adminPorts ?? {};
    const secrets = new SecretService({
      audit,
      store: ports.secretStore ?? refusingSecretStore,
      sealer: ports.sealer ?? refusingPayloadSealer,
      ...(ports.enqueueApply === undefined ? {} : { enqueueApply: ports.enqueueApply }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    adminControllers.push(
      ...admin.controllers,
      createOrganisationAdminController({
        service: new OrganisationAdminService({ db: deps.db, audit, organisation }),
        scopeOf,
      }),
      // Message templates (TC-AD-04, RA-R1-15). The configured languages are the boot provisioning's (EHR_TEMPLATE_LANGUAGES).
      createTemplateAdminController({
        db: deps.db,
        scopeOf,
        templates: new TemplateService({
          audit,
          configuredLanguages: () =>
            Promise.resolve(
              (process.env['EHR_TEMPLATE_LANGUAGES'] ?? 'en')
                .split(',')
                .map((l) => l.trim())
                .filter(Boolean),
            ),
        }),
      }),
      ...createAdminRoutesControllers({
        audit: new AuditAdminService({
          db: deps.db,
          audit,
          // The caller's live grant (revoked_at IS NULL, not expired): the export records the grant it was made under.
          elevationIdOf: async (tx, sessionId) =>
            (
              await tx.query(
                `SELECT id FROM identity.elevation_grant WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY issued_at DESC LIMIT 1`,
                [sessionId],
              )
            ).rows[0]?.['id'] as string | undefined,
          ...(ports.signer === undefined ? {} : { signer: ports.signer }),
          ...(deps.now === undefined ? {} : { now: deps.now }),
        }),
        integrations: new IntegrationAdminService({
          db: deps.db,
          audit,
          connections: new ConnectionService(audit),
          secrets,
          ...(ports.tester === undefined ? {} : { tester: ports.tester }),
        }),
        scopeOf,
        sessionIdOf: (req) => requireAuthContext(req).session.id,
      }),
    );
  }
  return {
    ...(alertStreamHub === undefined ? {} : { alertStreamHub }),
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
      ...createSchedulingControllers({
        db: deps.db,
        scheduling: core,
        hosts: { staff: env.staffHost, patient: env.patientHost },
      }),
      ...createFlowControllers({ db: deps.db, flow, limiter: new MemoryRateLimiter(1) }),
      ...chart.controllers,
      ...frontdoorBuilt.controllers,
      ...notes.controllers,
      ...messaging.controllers,
      ...privacy.controllers,
      ...reporting.controllers,
      ...createBreakGlassControllers({ db: deps.db, audit }),
      ...createTelehealthControllers({ db: deps.db, telehealth }),
      ...alertControllers,
      ...createDocumentsControllers({
        db: deps.db,
        documents,
        hosts: { staff: env.staffHost, patient: env.patientHost },
        banner: chart.banner,
      }),
      ...integrationsHost,
      ...calendarControllers,
      ...adminControllers,
    ],
  };
}
