/* eslint-disable boundaries/module-boundaries -- test support: reaches the patient kit and the R1 template set the way the booking core's kit does (BE-11) */
// Harness of the scheduling-flow real-database tests (BE-13). Not a test file. Builds on the booking core's kit (BE-11) and the patient
// kit (BE-08): a throwaway database migrated by the real pipeline (including 1300-1302), the real Nest application with the identity
// guard, the booking and flow controllers, published notification templates, the real queue (task types synced), seeded sessions, and
// the worker's real job handlers wired to the flow service through `flowPort`. Synthetic data only.
import { FIXTURE_STATES, seedFixtureJurisdictions } from '../../../platform/fixture-states.js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  JobRegistry,
  KernelDb,
  ParticipantRegistries,
  Queue,
  createLogger,
  syncTaskTypes,
} from '@ehr/kernel';
import type { JobType, ScopeSettings, Tx } from '@ehr/kernel';
import { OrganisationService } from '../../organisation/index.js';
import { registerAllParticipants } from '../../../composition.js';
import { NOTIFICATIONS_JOBS, NotificationService } from '../../notifications/index.js';
import { r1TemplatesForLanguages } from '../../notifications/r1-templates.js';
import {
  createMergeControllers,
  executeMerge,
  MERGE_JOBS,
  MergeService,
  mergeResolvers,
} from '../../patient/merge/index.js';
import type { ExecuteDeps, ExecuteResult } from '../../patient/merge/index.js';
import {
  ORG,
  adminUrl,
  assignRole,
  call,
  id,
  pg,
  registerViaApi,
  saWrite,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
} from '../../patient/testkit.js';
import { repoRoot } from '../../patient/testkit.js';
import type { Client, Kit, SeededSession } from '../../patient/testkit.js';
import { createSchedulingControllers, schedulingResolvers } from '../core/controller.js';
import { SCHEDULING_CORE_JOBS } from '../core/jobs.js';
import { nearbyFreeStarts, SchedulingCoreService } from '../core/service.js';
import { stubOverbook } from '../core/testkit.js';
import type { AvailabilityPort } from '../core/types.js';
import { PgRateLimiter } from '../../../platform/rate-limit.js';
import { createFlowControllers, flowResolvers } from './controller.js';
import { registerSchedulingFlowHandlers, SCHEDULING_FLOW_JOBS } from './jobs.js';
import { flowPort } from './port.js';
import { SchedulingFlowService } from './service.js';
import { uuidv7 } from '../core/ids.js';
import type { PrevisitPort } from './types.js';
import { AvailabilitySearch } from '../availability/search.js';

export {
  ORG,
  adminUrl,
  call,
  id,
  pg,
  saWrite,
  seedPrincipal,
  seedSession,
  staffMember,
  writeHeaders,
};
export type { Client, Kit, SeededSession };

/** The worker's real scheduling job handlers (apps/worker/dist), loaded the way the patient kit loads the identity jobs. */
export interface WorkerJobs {
  SCHEDULING_FLOW_JOBS: readonly JobType[];
  SCHEDULING_FLOW_CRONTAB: string;
  runOfferWaitlist(
    deps: FlowKit['jobs'],
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<{ outcome: string; offerId?: string; tried?: number }>;
  runExpireOffer(
    deps: FlowKit['jobs'],
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<'expired' | 'not_due' | 'already_decided' | 'gone'>;
  runNoShowSweep(
    deps: FlowKit['jobs'],
    jobRef?: string,
  ): Promise<{ marked: number; flagged: number; skipped: number; failed: number }>;
  runOnSlotFreed(deps: FlowKit['jobs'], payload: Record<string, unknown>): Promise<void>;
  runOnReservationConfirmed(
    deps: FlowKit['jobs'],
    payload: Record<string, unknown>,
  ): Promise<'scheduled' | 'skipped' | 'gone'>;
  runOnReservationCancelled(
    deps: FlowKit['jobs'],
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<'sent' | 'duplicate' | 'skipped' | 'gone'>;
  runOnReservationRescheduled(
    deps: FlowKit['jobs'],
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<'sent' | 'duplicate' | 'skipped' | 'gone'>;
  runSendPrevisit(
    deps: FlowKit['jobs'],
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<'sent' | 'duplicate' | 'skipped' | 'gone'>;
  createSchedulingFlowTasks(deps: FlowKit['jobs']): Record<string, unknown>;
}
export async function workerJobs(): Promise<WorkerJobs> {
  return (await import(
    pathToFileURL(`${repoRoot}apps/worker/dist/jobs/scheduling/index.js`).href
  )) as WorkerJobs;
}

export const A1 = id(101);
export const A2 = id(102);
export const B1 = id(201);
export const SVC = id(301); // 30 minutes, either mode
export const SVC2 = id(302); // 30 minutes, either mode (second service)
export const SVC_IP = id(303); // 30 minutes, in person only
export const ROOM1 = id(401);
export const ROOM2 = id(402);
export const PATIENT_HOST = 'my.example.test';
export const QR_KEY = Buffer.from('qr-key-for-tests-0123456789abcdef0123');
export const PORTAL = 'https://portal.example.test/sign-in';

/** A start time `days` from now at 09:00 UTC plus `slot` half-hours. */
export const slotStart = (days: number, slot = 0): Date => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(9, slot * 30, 0, 0);
  return d;
};

export interface Doctor {
  principalId: string;
  personId: string;
}

export interface PatientKit {
  patientId: string;
  /** The patient's own portal account (linked), signed in on the patient host. */
  session: SeededSession;
  scope: ScopeSettings;
}

export interface FlowKit {
  k: Kit;
  /** The flow service as the API tier runs it (api queue path). */
  flow: SchedulingFlowService;
  /** The same service as the worker runs it (worker queue path), and the worker's job dependencies. */
  flowW: SchedulingFlowService;
  jobs: {
    db: KernelDb;
    orgId: string;
    queue: Queue;
    flow: ReturnType<typeof flowPort>;
    log: ReturnType<typeof createLogger>;
    survivorOf: (patientId: string) => Promise<string | undefined>;
    now?: () => Date;
  };
  core: SchedulingCoreService;
  org: OrganisationService;
  regs: ParticipantRegistries;
  api: KernelDb;
  worker: KernelDb;
  overbook: Map<string, string>;
  doctors: Doctor[];
  lead: SeededSession;
  mr: SeededSession;
  deskA1: SeededSession;
  deskB1: SeededSession;
  /** What the clinical module will supply: the consent templates a service requires and the questionnaire state. */
  previsit: {
    consents: Map<string, { key: string; version: number }[]>;
    questionnaire: Set<string>;
  };
  /** A test clock for the service's own decisions (grace, wait time). Real time unless set. */
  clock: { at: Date | undefined };
  doctor(): Promise<Doctor>;
  /** A registered patient (care relationship at A1) with a linked, signed-in portal account. */
  patient(n: number): Promise<PatientKit>;
  /** A bare patient row with a linked portal account (fast). */
  bare(n: number): Promise<PatientKit>;
  staffScope(locations?: string[], role?: string): Promise<ScopeSettings>;
  workerScope: ScopeSettings;
  /** `on` = the booking core's availability port is the real search (default: the stub). */
  realAvailability: { on: boolean };
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  asWorker<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Allows the waitlist for a service (booking policy row). */
  allowWaitlist(serviceId?: string, locationId?: string | null): Promise<void>;
  /** A confirmed appointment for the patient, booked through the real core and confirmed. */
  confirmed(
    p: PatientKit,
    doctorId: string,
    start: Date,
    opts?: { serviceId?: string; mode?: 'in_person' | 'video' },
  ): Promise<string>;
  /** An appointment in any state at any time, written directly (the way the booking service leaves the database): reservation and occupancy in one transaction. */
  seed(
    p: PatientKit,
    doctorId: string,
    start: Date,
    opts?: {
      status?: string;
      mode?: 'in_person' | 'video';
      serviceId?: string;
      locationId?: string;
      minutes?: number;
      roomId?: string;
    },
  ): Promise<string>;
  /** Moves a held reservation's expiry into the past. */
  age(reservationId: string): Promise<void>;
  /** Moves a queue entry's arrival back in time (the check-in stamps the database clock). */
  ageEntry(reservationId: string, minutes: number): Promise<void>;
  merge(
    survivorId: string,
    mergedId: string,
    over?: Partial<ExecuteDeps>,
  ): Promise<{ requestId: string; result: ExecuteResult }>;
  jobsInQueue(
    task: string,
  ): Promise<{ payload: Record<string, unknown>; run_at: Date; key: string | null }[]>;
  close(): Promise<void>;
}

/** `opts.noTemplates`: leave `notifications.template` empty, as a freshly migrated database is (INT02-R10-B1). */
export async function setupFlow(
  name: string,
  opts: { noTemplates?: boolean } = {},
): Promise<FlowKit> {
  const holder: { k?: Kit; core?: SchedulingCoreService; flow?: SchedulingFlowService } = {};
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const lazy = <T extends object>(get: () => T): T =>
    new Proxy({} as T, {
      get: (_t, prop) => {
        const target = get() as unknown as Record<string | symbol, unknown>;
        const v = target[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  const mreg = new JobRegistry();
  for (const j of MERGE_JOBS) mreg.defineJob(j);
  const merges = new MergeService({ queue: new Queue(mreg, 'api') });
  const org = new OrganisationService();
  const overbook = new Map<string, string>();

  const k = await retrySetup(() =>
    setup({
      name,
      fixtures: async (f) => {
        await standardFixtures(f);
        await f.sa.query(
          `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active)
           VALUES ($1, $4, 'Consult', 'Appointment', 30, 0, 'either', true), ($2, $4, 'Consult 2', 'Appointment 2', 30, 0, 'either', true),
                  ($3, $4, 'Consult IP', 'Appointment IP', 30, 0, 'in_person', true)`,
          [SVC, SVC2, SVC_IP, ORG],
        );
        await f.sa.query(
          `INSERT INTO organisation.room (id, organisation_id, location_id, name, active) VALUES ($1, $3, $4, 'Room 1', true), ($2, $3, $4, 'Room 2', true)`,
          [ROOM1, ROOM2, ORG, A1],
        );
        await seedFixtureJurisdictions(f.sa, ORG);
        await f.sa.query(
          `INSERT INTO organisation.operating_state (organisation_id, jurisdiction_code, telehealth_allowed, effective_from) VALUES ($1, '${FIXTURE_STATES.licensed}', true, '2020-01-01'), ($1, '${FIXTURE_STATES.closed}', false, '2020-01-01')`,
          [ORG],
        );
      },
      controllers: [
        ...createMergeControllers({ db: lazyDb, merges }),
        ...createSchedulingControllers({
          db: lazyDb,
          scheduling: lazy(() => holder.core as SchedulingCoreService),
        }),
        ...createFlowControllers({
          db: lazyDb,
          flow: lazy(() => holder.flow as SchedulingFlowService),
          limiter: new PgRateLimiter(lazyDb, ORG, 'test-rate-limit-key-secret-0123456789'),
        }),
      ],
      beforeStart: ({ identity }) => {
        for (const [n, fn] of Object.entries({
          ...mergeResolvers(),
          ...schedulingResolvers(),
          ...flowResolvers(),
        }))
          identity.policy.registerResolver(n, fn);
      },
    }),
  );
  holder.k = k;
  for (const d of [k.db, k.wdb])
    (d as unknown as { pool: { on(e: 'error', f: () => void): void } }).pool.on(
      'error',
      () => undefined,
    );
  for (const j of [
    ...MERGE_JOBS,
    ...SCHEDULING_CORE_JOBS,
    ...SCHEDULING_FLOW_JOBS,
    ...NOTIFICATIONS_JOBS,
  ])
    if (!safeHas(k, j.name)) k.registry.defineJob(j);
  registerSchedulingFlowHandlers(k.registry);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  // INT02-R9-B1: `real.on` routes `resolve` to the real availability search (the template/roster/principal reads), so a test can
  // run the offer job as app_worker in patients scope against the real rules; off, resolve stays the stub of the other flow tests.
  const real = { on: false };
  const realSearch = new AvailabilitySearch({ organisation: org });
  const availability: AvailabilityPort = {
    resolve: (tx, q) =>
      real.on ? realSearch.resolve(tx, q) : stubOverbook(tx, q, overbook.get(q.clinicianId)),
    alternatives: (tx, q) => nearbyFreeStarts(tx, q),
  };
  const apiQueue = new Queue(k.registry, 'api');
  const workerQueue = new Queue(k.registry, 'worker');
  const core = new SchedulingCoreService({
    audit: k.audit,
    organisation: org,
    availability,
    queue: apiQueue,
  });
  holder.core = core;

  const clock: { at: Date | undefined } = { at: undefined };
  const previsit = {
    consents: new Map<string, { key: string; version: number }[]>(),
    questionnaire: new Set<string>(),
  };
  const previsitPort: PrevisitPort = {
    requiredConsents: (_tx, serviceId) => Promise.resolve(previsit.consents.get(serviceId) ?? []),
    questionnaireComplete: (_tx, _p, reservationId) =>
      Promise.resolve(previsit.questionnaire.has(reservationId)),
  };
  const mkFlow = (queue: Queue): SchedulingFlowService =>
    new SchedulingFlowService({
      audit: k.audit,
      organisation: org,
      availability,
      notifications: new NotificationService({ queue, allowedLinkHosts: ['portal.example.test'] }),
      records: k.patient.records,
      queue,
      qrKey: { current: () => Promise.resolve(QR_KEY) },
      previsit: previsitPort,
      portalUrl: PORTAL,
      now: () => clock.at ?? new Date(),
    });
  const flow = mkFlow(apiQueue);
  const flowW = mkFlow(workerQueue);
  holder.flow = flow;

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 40 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 8 });
  for (const pool of [apiPool, workerPool]) pool.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const worker = new KernelDb(workerPool as never);
  const workerScope: ScopeSettings = {
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'org',
  };
  await worker.withScope(workerScope, (tx) => org.applySettingDefaults(tx, undefined));

  // The templates the flow sends (the whole R1 set, INT02-R11-N1): a published version of each (the render check is the notifications module's own test).
  for (const t of r1TemplatesForLanguages(['en']).filter(() => !opts.noTemplates)) {
    const tid = uuidv7();
    await k.sa.query(
      `INSERT INTO notifications.template (id, organisation_id, key, channel, language, version, subject, body, variables, status)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::jsonb, 'draft')`,
      [
        tid,
        ORG,
        t.key,
        t.channel,
        t.language,
        t.subject ?? null,
        t.body,
        JSON.stringify(t.variables),
      ],
    );
    await k.sa.query(
      `UPDATE notifications.template SET render_check_passed_at = now() WHERE id = $1`,
      [tid],
    );
    await k.sa.query(
      `UPDATE notifications.template SET status = 'published', published_at = now() WHERE id = $1`,
      [tid],
    );
  }

  const regs = new ParticipantRegistries();
  registerAllParticipants(regs);

  const lead = await (async () => {
    const p = await seedPrincipal(k, 'google', {
      name: 'Lead AB',
      email: `lead.ab.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'front_desk_lead', A1);
    await assignRole(k, p.principalId, 'front_desk_lead', B1);
    return seedSession(k, p, 'google');
  })();
  const mr = await staffMember(k, 'medical_records', A2, 'Records A2');
  const deskA1 = await staffMember(k, 'front_desk', A1, 'Desk A1');
  const deskB1 = await staffMember(k, 'front_desk', B1, 'Desk B1');

  const doctors: Doctor[] = [];
  let seq = 0;
  const link = async (patientId: string, n: number): Promise<PatientKit> => {
    const p = await seedPrincipal(k, 'patient_pool', { name: `Patient account ${n}` });
    await saWrite(
      k,
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [p.principalId, patientId, ORG],
    );
    return {
      patientId,
      session: await seedSession(k, p, 'patient_pool'),
      scope: {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: p.principalId,
        personId: p.personId,
        patientIds: [patientId],
      },
    };
  };
  const bare = async (n: number): Promise<PatientKit> => {
    const pid = randomUUID();
    await saWrite(
      k,
      `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
       VALUES ($1, $2, $3, $4, $5, '1975-01-01', '${FIXTURE_STATES.licensed}', 'front_desk')`,
      [pid, ORG, `MRN-${String(9_000_000 + n)}`, `Bare${n}`, `Patient${n}`],
    );
    return link(pid, n);
  };

  const kit: FlowKit = {
    k,
    flow,
    flowW,
    jobs: {
      db: worker,
      orgId: ORG,
      queue: workerQueue,
      flow: flowPort(flowW),
      log: createLogger({ sink: () => undefined }),
      survivorOf: async (patientId) =>
        (await worker.withScope(workerScope, async (tx) => {
          const r = await tx.query(
            `SELECT final_survivor_id FROM patient.patient_merge WHERE merged_id = $1::uuid LIMIT 1`,
            [patientId],
          );
          return r.rows[0]?.['final_survivor_id'] as string | undefined;
        })) ?? undefined,
    },
    core,
    org,
    regs,
    api,
    worker,
    overbook,
    doctors,
    lead,
    mr,
    deskA1,
    deskB1,
    previsit,
    clock,
    workerScope,
    realAvailability: real,
    async doctor() {
      const p = await seedPrincipal(k, 'google', { name: `Doctor ${doctors.length + 1}` });
      doctors.push(p);
      return p;
    },
    async patient(n) {
      const pid = await registerViaApi(k, deskA1, A1, {
        givenName: `Given${n}`,
        familyName: `Family${n}`,
        dateOfBirth: '1980-05-17',
        phone: `+1212555${String(1000 + n)}`,
        email: `person${n}@example.test`,
      });
      return link(pid, n);
    },
    bare,
    async staffScope(locations = [A1], role = 'front_desk') {
      const p = await seedPrincipal(k, 'google', { name: 'Staff scope' });
      await assignRole(k, p.principalId, role, locations[0]);
      return {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: p.principalId,
        personId: p.personId,
        locationIds: locations,
      };
    },
    as: (scope, fn) => api.withScope(scope, fn),
    asWorker: (scope, fn) => worker.withScope(scope, fn),
    async allowWaitlist(serviceId = SVC, locationId = null) {
      await k.sa.query(
        `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, lead_time_min, cutoff_hours, late_change, max_future_per_patient, waitlist_enabled)
         VALUES ($1, $2, $3, $4, 0, 24, 'block', 5, true)`,
        [uuidv7(), ORG, serviceId, locationId],
      );
    },
    async confirmed(p, doctorId, start, opts = {}) {
      const h = await api.withScope(p.scope, (tx) =>
        core.hold(
          tx,
          { requestId: randomUUID() },
          {
            patientId: p.patientId,
            serviceId: opts.serviceId ?? SVC,
            locationId: A1,
            clinicianId: doctorId,
            startsAt: start.toISOString(),
            mode: opts.mode ?? 'in_person',
            ...(opts.mode === 'video' ? { patientState: FIXTURE_STATES.licensed } : {}),
          },
        ),
      );
      await api.withScope(p.scope, (tx) =>
        core.confirm(tx, { requestId: randomUUID() }, h.reservationId),
      );
      return h.reservationId;
    },
    async seed(p, doctorId, start, opts = {}) {
      const rid = uuidv7();
      const end = new Date(start.getTime() + (opts.minutes ?? 30) * 60_000);
      const status = opts.status ?? 'confirmed';
      await k.sa.query('BEGIN');
      try {
        await k.sa.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
          [ORG],
        );
        await k.sa.query(
          `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, room_id, period, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, tstzrange($6::timestamptz, $7::timestamptz, '[)'), $8, CASE WHEN $8 = 'held' THEN now() + interval '10 minutes' END)`,
          [
            rid,
            ORG,
            opts.locationId ?? A1,
            doctorId,
            opts.roomId ?? null,
            start.toISOString(),
            end.toISOString(),
            status,
          ],
        );
        await k.sa.query(
          `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, booked_by_principal_id, booked_via)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $6, 'staff')`,
          [
            rid,
            ORG,
            p.patientId,
            opts.serviceId ?? SVC,
            opts.locationId ?? A1,
            doctorId,
            opts.mode ?? 'in_person',
          ],
        );
        await k.sa.query('COMMIT');
      } catch (e) {
        await k.sa.query('ROLLBACK');
        throw e;
      }
      return rid;
    },
    async age(reservationId) {
      await k.sa.query('BEGIN');
      try {
        await k.sa.query(`SET LOCAL session_replication_role = replica`);
        await k.sa.query(
          `UPDATE scheduling.slot_occupancy SET expires_at = now() - interval '1 minute' WHERE id = $1 AND status = 'held'`,
          [reservationId],
        );
        await k.sa.query(
          `UPDATE scheduling.waitlist_offer SET expires_at = now() - interval '1 minute' WHERE occupancy_id = $1 AND status = 'offered'`,
          [reservationId],
        );
        await k.sa.query('COMMIT');
      } catch (e) {
        await k.sa.query('ROLLBACK');
        throw e;
      }
    },
    async ageEntry(reservationId, minutes) {
      await k.sa.query('BEGIN');
      try {
        await k.sa.query(`SET LOCAL session_replication_role = replica`);
        await k.sa.query(
          `UPDATE scheduling.queue_entry SET entered_at = entered_at - make_interval(mins => $2::int) WHERE id = $1`,
          [reservationId, minutes],
        );
        await k.sa.query('COMMIT');
      } catch (e) {
        await k.sa.query('ROLLBACK');
        throw e;
      }
    },
    async merge(survivorId, mergedId, over = {}) {
      const requestId = await approved(survivorId, mergedId);
      return {
        requestId,
        result: await executeMerge(
          {
            db: worker,
            orgId: ORG,
            registries: regs,
            ...over,
          },
          { requestId, jobId: `test:${++seq}`, attempt: 1, maxAttempts: 1 },
        ),
      };
    },
    async jobsInQueue(task) {
      return (await k.q(
        `SELECT j.payload, j.run_at, j.key FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1 ORDER BY j.id`,
        [task],
      )) as never;
    },
    async close() {
      await apiPool.end();
      await workerPool.end();
      await k.close();
    },
  };

  async function approved(survivorId: string, mergedId: string): Promise<string> {
    const r = await call(k.base, 'POST', '/api/v1/patient-merges', {
      cookie: lead.cookie,
      headers: writeHeaders(lead, undefined, randomUUID()),
      body: { survivorId, mergedId, reason: 'Same person registered twice' },
    });
    if (r.status !== 200) throw new Error(`request failed ${r.status} ${r.body}`);
    const requestId = r.json()['id'] as string;
    const a = await call(k.base, 'POST', `/api/v1/patient-merges/${requestId}/approve`, {
      cookie: mr.cookie,
      headers: writeHeaders(mr, undefined, randomUUID()),
    });
    if (a.status !== 200) throw new Error(`approve failed ${a.status} ${a.body}`);
    return requestId;
  }
  return kit;
}

async function retrySetup<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt + Math.floor(Math.random() * 500)));
    }
  }
}

function safeHas(k: Kit, name: string): boolean {
  try {
    k.registry.get(name);
    return true;
  } catch {
    return false;
  }
}
