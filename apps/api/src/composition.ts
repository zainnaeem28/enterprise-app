// Composition root of the merge and export participants (ARCHITECTURE 22.16, 24). Every module that holds patient data registers
// its participant here, once, at start-up; the patient merge executor fails (patient.merge_participant_missing) when a table with a
// patient_id is covered by none. The patient module's own participant is not registered: the executor runs it first.
// Scheduling registers through the flow participant INSTEAD of the booking core's (it covers the core's tables too).
import { defaultRegistries, JobRegistry, Queue } from '@ehr/kernel';
import type { KernelDb, Logger, ParticipantRegistries, ScopeSettings } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import { createPatientCliniciansControllers } from './clinicians.controller.js';
import type { IdentityEnv } from './identity-env.js';
import type { GuardPolicy } from './platform/guard.js';
import { MemoryRateLimiter } from './platform/rate-limit.js';
import { AUDIT_JOBS, AuditService } from './modules/audit/index.js';
import { registerDocumentsParticipants } from './modules/documents/index.js';
import {
  createIdentity,
  GoogleRealmAdapter,
  IDENTITY_JOBS,
  OidcPatientAdapter,
  registerIdentityParticipants,
  requireAuthContext,
} from './modules/identity/index.js';
import { createPatient, MERGE_JOBS, patientInScope } from './modules/patient/index.js';
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
import { createCatalogueControllers, OrganisationService } from './modules/organisation/index.js';
import { registerNotificationsParticipants } from './modules/notifications/index.js';
import { registerSchedulingFlowParticipants } from './modules/scheduling/flow/index.js';
import { registerTelehealthParticipants } from './modules/telehealth/index.js';

/** Called once per registry; a second call is a RegistryError. */
export function registerAllParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registerIdentityParticipants(registries);
  registerNotificationsParticipants(registries);
  registerSchedulingFlowParticipants(registries);
  registerTelehealthParticipants(registries);
  registerDocumentsParticipants(registries);
}

export interface Composition {
  /** The identity guard policy: pass to `createApp` as `policy` (replaces the deny-everything default). */
  policy: GuardPolicy;
  controllers: Type<unknown>[];
}

/**
 * The HTTP surface of the API process and its guard. Mounted: identity (sign-in, callback, session), the patient catalogue reads
 * (`GET /api/v1/services|locations`), the patient clinician list (`GET /api/v1/clinicians`), scheduling availability (search and
 * the staff/admin management routes), the booking core (holds, confirm, appointments) and the flow (check-in, queue, waitlist,
 * pre-visit). A route that is not listed is not served. `main.ts` and the composition tests call this one function.
 */
export function buildComposition(deps: {
  db: KernelDb;
  logger: Logger;
  identity: IdentityEnv;
  now?: () => Date;
}): Composition {
  const env = deps.identity;
  // The API-path queue: every job type an API request may publish, defined once.
  const registry = new JobRegistry();
  for (const j of [
    ...IDENTITY_JOBS,
    ...AUDIT_JOBS,
    ...MERGE_JOBS,
    ...NOTIFICATIONS_JOBS,
    ...SCHEDULING_CORE_JOBS,
    ...SCHEDULING_FLOW_JOBS,
  ])
    registry.defineJob(j);
  registerSchedulingFlowHandlers(registry);
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
  // Its own controllers are not part of this cycle's surface and are not mounted.
  const patient = createPatient({
    db: deps.db,
    audit,
    identity,
    limiter: new MemoryRateLimiter(1),
    matchKey: env.matchKey,
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
    queue,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  const search = new AvailabilitySearch({ organisation });
  const availability = new AvailabilityService({ audit });
  const core = new SchedulingCoreService({ audit, organisation, availability: search, queue });
  const flow = new SchedulingFlowService({
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

  const scopeOf = (req: Parameters<typeof requireAuthContext>[0]): ScopeSettings =>
    requireAuthContext(req).scope;
  return {
    policy: identity.policy,
    controllers: [
      ...identity.controllers,
      ...createCatalogueControllers({ db: deps.db, organisation, scopeOf }),
      ...createPatientCliniciansControllers({
        db: deps.db,
        organisation,
        scheduling: availability,
        scopeOf,
      }),
      ...createAvailabilityControllers({ db: deps.db, audit, availability, search }),
      ...createSchedulingControllers({ db: deps.db, scheduling: core }),
      ...createFlowControllers({ db: deps.db, flow }),
    ],
  };
}
