// Harness of the booking-core real-database tests (BE-11). Not a test file. Builds on the patient testkit (BE-08) and the merge
// executor (BE-09): a throwaway database migrated by the real pipeline (including 0900-0903), the real Nest application with the
// identity guard, the patient, merge and booking controllers, seeded sessions, and a second pool with enough connections for real
// concurrency. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { JobRegistry, KernelDb, ParticipantRegistries, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings, Tx } from '@ehr/kernel';
import { OrganisationService } from '../../organisation/index.js';
import { registerIdentityParticipants } from '../../identity/index.js';
import { registerNotificationsParticipants } from '../../notifications/index.js';
import {
  createMergeControllers,
  executeMerge,
  loadPatientTestkit,
  MERGE_JOBS,
  MergeService,
  mergeResolvers,
} from '../../patient/index.js';
import type {
  Client,
  ExecuteDeps,
  ExecuteResult,
  Kit,
  SeededSession,
} from '../../patient/index.js';
import { createSchedulingControllers, schedulingResolvers } from './controller.js';
import { SCHEDULING_CORE_JOBS } from './jobs.js';
import { registerSchedulingParticipants } from './merge.js';
import { nearbyFreeStarts, SchedulingCoreService } from './service.js';
import type { AvailabilityPort } from './types.js';

const {
  ORG,
  adminUrl,
  assignRole,
  call,
  id,
  patientAccount,
  pg,
  registerViaApi,
  saWrite,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
} = await loadPatientTestkit();
export { ORG, adminUrl, call, id, patientAccount, pg, saWrite, writeHeaders };
export type { Client, Kit, SeededSession };

export const A1 = id(101);
export const A2 = id(102);
export const B1 = id(201);
export const SVC = id(301); // 30 minutes, either mode
export const SVC2 = id(302); // 30 minutes, either mode (second service)
export const ROOM1 = id(401);
export const ROOM2 = id(402);

/** A start time `days` from now at 09:00 UTC plus `slot` half-hours: always in the future, never on a DST boundary. */
export const slotStart = (days: number, slot = 0): Date => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(9, slot * 30, 0, 0);
  return d;
};

export interface Doctor {
  principalId: string;
  personId: string;
}

export interface SchedKit {
  k: Kit;
  svc: SchedulingCoreService;
  org: OrganisationService;
  regs: ParticipantRegistries;
  /** A second pool of app_api and one of app_worker with many connections, for real concurrency. */
  api: KernelDb;
  worker: KernelDb;
  /** Overbookable doctors and their session key; every other doctor is plain. */
  overbook: Map<string, string>;
  availability: AvailabilityPort;
  doctors: Doctor[];
  lead: SeededSession;
  mr: SeededSession;
  deskA1: SeededSession;
  deskB1: SeededSession;
  doctor(): Promise<Doctor>;
  /** Registers a patient through the front desk (care relationship at A1) and returns its ID. */
  mkPatient(n: number): Promise<string>;
  /** A bare patient row (no care relationship): fast, for volume tests. */
  bare(n: number): Promise<string>;
  /** A patient-realm principal for a patient, as a scope. */
  patientScope(patientId: string, o?: { proxy?: boolean }): Promise<ScopeSettings>;
  staffScope(locations?: string[], role?: string): Promise<ScopeSettings>;
  workerScope: ScopeSettings;
  /** Simulates time passing: the hold's expiry is moved into the past (the guard forbids it for every application role). */
  age(reservationId: string): Promise<void>;
  /** Runs `fn` in a scoped transaction on the big pool. */
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Executes the merge of `mergedId` into `survivorId` end to end (request, second-staff approval, execute job). */
  merge(
    survivorId: string,
    mergedId: string,
    over?: Partial<ExecuteDeps>,
  ): Promise<{ requestId: string; result: ExecuteResult }>;
  /** Request by the lead and approval by a second staff member: returns the approved request ID. */
  approved(survivorId: string, mergedId: string): Promise<string>;
  run(requestId: string, over?: Partial<ExecuteDeps>): Promise<ExecuteResult>;
  close(): Promise<void>;
}

export async function setupScheduling(name: string): Promise<SchedKit> {
  const holder: { k?: Kit; svc?: SchedulingCoreService } = {};
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const lazySvc = new Proxy({} as SchedulingCoreService, {
    get: (_t, prop) => {
      const v = (holder.svc as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(holder.svc) : v;
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
         VALUES ($1, $3, 'Consult', 'Appointment', 30, 0, 'either', true), ($2, $3, 'Consult 2', 'Appointment 2', 30, 0, 'either', true)`,
          [SVC, SVC2, ORG],
        );
        await f.sa.query(
          `INSERT INTO organisation.room (id, organisation_id, location_id, name, active) VALUES ($1, $3, $4, 'Room 1', true), ($2, $3, $4, 'Room 2', true)`,
          [ROOM1, ROOM2, ORG, A1],
        );
        await f.sa.query(
          `INSERT INTO organisation.operating_state (organisation_id, jurisdiction_code, telehealth_allowed, effective_from) VALUES ($1, 'NY', true, '2020-01-01'), ($1, 'NJ', false, '2020-01-01')`,
          [ORG],
        );
      },
      controllers: [
        ...createMergeControllers({ db: lazyDb, merges }),
        ...createSchedulingControllers({ db: lazyDb, scheduling: lazySvc }),
      ],
      beforeStart: ({ identity }) => {
        for (const [n, fn] of Object.entries({ ...mergeResolvers(), ...schedulingResolvers() }))
          identity.policy.registerResolver(n, fn);
      },
    }),
  );
  holder.k = k;
  // BE11-F02: the BE-08 kit's own pools have no error handler, so an idle client told to go while the test database is dropped is
  // an uncaught exception. Only idle-client errors are absorbed here; a failing query still rejects its own promise.
  for (const d of [k.db, k.wdb])
    (d as unknown as { pool: { on(e: 'error', f: () => void): void } }).pool.on(
      'error',
      () => undefined,
    );
  for (const j of [...MERGE_JOBS, ...SCHEDULING_CORE_JOBS])
    if (!safeHas(k, j.name)) k.registry.defineJob(j);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const availability: AvailabilityPort = {
    resolve: (_tx, q) =>
      Promise.resolve(
        overbook.has(q.clinicianId)
          ? { ok: true as const, overbook: { sessionKey: overbook.get(q.clinicianId) as string } }
          : { ok: true as const },
      ),
    alternatives: (tx, q) => nearbyFreeStarts(tx, q),
  };
  const svc = new SchedulingCoreService({
    audit: k.audit,
    organisation: org,
    availability,
    queue: new Queue(k.registry, 'api'),
  });
  holder.svc = svc;

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 40 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 8 });
  // An idle client may be told to go when the test database is dropped; that is the teardown, not a failure (BE11-F02).
  for (const pool of [apiPool, workerPool]) pool.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const worker = new KernelDb(workerPool as never);
  const workerScope: ScopeSettings = {
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'org',
  };
  // The settings the booking policy falls back on (hold, cut-off, BR-04, licensing mode) are the catalogue's, applied by the real job.
  await worker.withScope(workerScope, (tx) => org.applySettingDefaults(tx, undefined));

  const regs = new ParticipantRegistries();
  registerIdentityParticipants(regs);
  registerNotificationsParticipants(regs);
  registerSchedulingParticipants(regs);

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
  const kit: SchedKit = {
    k,
    svc,
    org,
    regs,
    api,
    worker,
    overbook,
    availability,
    doctors,
    lead,
    mr,
    deskA1,
    deskB1,
    workerScope,
    async doctor() {
      const p = await seedPrincipal(k, 'google', { name: `Doctor ${doctors.length + 1}` });
      doctors.push(p);
      return p;
    },
    mkPatient: (n) =>
      registerViaApi(k, deskA1, A1, {
        givenName: `Given${n}`,
        familyName: `Family${n}`,
        dateOfBirth: '1980-05-17',
        phone: `+1212555${String(1000 + n)}`,
        email: `person${n}@example.test`,
      }),
    async bare(n) {
      const pid = randomUUID();
      await saWrite(
        k,
        `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
         VALUES ($1, $2, $3, $4, $5, '1975-01-01', 'NY', 'front_desk')`,
        [pid, ORG, `MRN-${String(9_000_000 + n)}`, `Bare${n}`, `Patient${n}`],
      );
      return pid;
    },
    async patientScope(patientId, o = {}) {
      const p = await seedPrincipal(k, 'patient_pool', {
        name: `Patient account ${patientId.slice(-4)}`,
      });
      return {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: p.principalId,
        personId: p.personId,
        patientIds: [patientId],
        ...(o.proxy === true ? { proxyPatientIds: [patientId] } : {}),
      };
    },
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
    async age(reservationId) {
      await k.sa.query('BEGIN');
      try {
        await k.sa.query(`SET LOCAL session_replication_role = replica`);
        await k.sa.query(
          `UPDATE scheduling.slot_occupancy SET expires_at = now() - interval '1 minute' WHERE id = $1 AND status = 'held'`,
          [reservationId],
        );
        await k.sa.query('COMMIT');
      } catch (e) {
        await k.sa.query('ROLLBACK');
        throw e;
      }
    },
    as: (scope, fn) => api.withScope(scope, fn),
    async approved(survivorId, mergedId) {
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
    },
    run: (requestId, over = {}) =>
      executeMerge(
        { db: worker, orgId: ORG, registries: regs, ...over },
        { requestId, jobId: `test:${++seq}`, attempt: 1, maxAttempts: 1 },
      ),
    async merge(survivorId, mergedId, over = {}) {
      const requestId = await kit.approved(survivorId, mergedId);
      return { requestId, result: await kit.run(requestId, over) };
    },
    async close() {
      await apiPool.end();
      await workerPool.end();
      await k.close();
    },
  };
  return kit;
}

/**
 * BE11-F02: two test files starting at once both run the cluster-wide role bootstrap (db/tools/migrate.mjs) and can collide on the
 * shared roles; the loser's setup throws before anything of this file exists. A new database name per attempt makes a retry safe.
 */
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
