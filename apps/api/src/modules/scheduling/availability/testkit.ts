/* eslint-disable boundaries/module-boundaries -- a test harness: it reuses the patient module's kit (BE-08), which is not on the patient index (same exemption as the documents and booking-core kits; request to the Orchestrator: exempt testkit.ts and *.dbtest.ts from this rule). */
// Harness of the availability real-database tests (BE-12). Not a test file. A throwaway database migrated by the real pipeline
// (including 1100-1103), the real Nest application with the identity guard, the booking core (with this module's search as its
// availability port) and the availability controllers, seeded sessions, and a second pool with enough connections for real concurrency.
// Synthetic data only.
import { randomUUID } from 'node:crypto';
import { KernelDb, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings, Tx } from '@ehr/kernel';
import { OrganisationService } from '../../organisation/index.js';
import {
  ORG,
  PATIENT_HOST,
  adminUrl,
  assignRole,
  call,
  id,
  pg,
  saWrite,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
} from '../../patient/testkit.js';
import type { Client, Kit, SeededSession } from '../../patient/testkit.js';
import { createSchedulingControllers, schedulingResolvers } from '../core/controller.js';
import { SCHEDULING_CORE_JOBS } from '../core/jobs.js';
import { SchedulingCoreService } from '../core/service.js';
import { availabilityResolvers, createAvailabilityControllers } from './controller.js';
import { AvailabilitySearch } from './search.js';
import { AvailabilityService } from './service.js';

export {
  ORG,
  PATIENT_HOST,
  adminUrl,
  assignRole,
  call,
  id,
  pg,
  saWrite,
  seedPrincipal,
  seedSession,
  writeHeaders,
};
export type { Client, Kit, SeededSession };

export const A1 = id(101);
export const A2 = id(102);
export const B1 = id(201);
export const SVC = id(301); // 30 minutes, either mode
export const SVC_IN = id(302); // 60 minutes, in person only
export const ROOM1 = id(401);
export const TZ = 'America/New_York';

export interface Doctor {
  principalId: string;
  personId: string;
  session: SeededSession;
}

export interface AvailKit {
  k: Kit;
  org: OrganisationService;
  search: AvailabilitySearch;
  avail: AvailabilityService;
  core: SchedulingCoreService;
  /** Pools with many connections, for real concurrency. */
  api: KernelDb;
  worker: KernelDb;
  workerScope: ScopeSettings;
  lead: SeededSession;
  deskA1: SeededSession;
  deskB1: SeededSession;
  /** A doctor with the `doctor` role at A1, listed in the directory and eligible for SVC and SVC_IN. */
  doctor(opts?: { location?: string; listed?: boolean; eligible?: boolean }): Promise<Doctor>;
  /** A patient account (patient realm) for a bare patient row, signed in on the patient host. */
  patient(n: number): Promise<{ patientId: string; session: SeededSession; scope: ScopeSettings }>;
  staffScope(session: SeededSession, locations: string[]): ScopeSettings;
  adminScope(): Promise<ScopeSettings>;
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** A UTC instant for a local wall-clock time at the test location's zone, evaluated by PostgreSQL. */
  localInstant(date: string, time: string): Promise<Date>;
  /** A future local date `n` days from now (YYYY-MM-DD at the test location). */
  futureDate(n: number): Promise<string>;
  close(): Promise<void>;
}

export async function setupAvailability(name: string): Promise<AvailKit> {
  const holder: {
    k?: Kit;
    avail?: AvailabilityService;
    search?: AvailabilitySearch;
    core?: SchedulingCoreService;
  } = {};
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const lazyAudit = new Proxy({} as Kit['audit'], {
    get: (_t, prop) => {
      const v = (holder.k as Kit).audit as unknown as Record<string | symbol, unknown>;
      return typeof v[prop] === 'function'
        ? (v[prop] as (...a: unknown[]) => unknown).bind(v)
        : v[prop];
    },
  });
  const lazy = <T extends object>(get: () => T | undefined): T =>
    new Proxy({} as T, {
      get: (_t, prop) => {
        const target = get() as unknown as Record<string | symbol, unknown>;
        const v = target[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  const lazyAvail = lazy(() => holder.avail);
  const lazySearch = lazy(() => holder.search);
  const lazyCore = lazy(() => holder.core);
  const org = new OrganisationService();

  const k = await retrySetup(() =>
    setup({
      name,
      fixtures: async (f) => {
        await standardFixtures(f);
        await f.sa.query(
          `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active)
           VALUES ($1, $3, 'Consult', 'Appointment', 30, 0, 'either', true), ($2, $3, 'Long consult', 'Appointment (long)', 60, 0, 'in_person', true)`,
          [SVC, SVC_IN, ORG],
        );
        for (const s of [SVC, SVC_IN])
          for (const l of [A1, B1])
            await f.sa.query(
              `INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1, $2, $3)`,
              [ORG, s, l],
            );
        await f.sa.query(
          `INSERT INTO organisation.room (id, organisation_id, location_id, name, active) VALUES ($1, $2, $3, 'Room 1', true)`,
          [ROOM1, ORG, A1],
        );
        await f.sa.query(
          `INSERT INTO organisation.operating_state (organisation_id, jurisdiction_code, telehealth_allowed, effective_from) VALUES ($1, 'NY', true, '2020-01-01')`,
          [ORG],
        );
      },
      controllers: [
        ...createSchedulingControllers({ db: lazyDb, scheduling: lazyCore }),
        ...createAvailabilityControllers({
          db: lazyDb,
          audit: lazyAudit,
          availability: lazyAvail,
          search: lazySearch,
        }),
      ],
      beforeStart: ({ identity }) => {
        for (const [n, fn] of Object.entries({
          ...schedulingResolvers(),
          ...availabilityResolvers(),
        }))
          identity.policy.registerResolver(n, fn);
      },
    }),
  );
  holder.k = k;
  // Idle-client errors are the teardown (the test database is dropped), not a failure (BE11-F02).
  for (const d of [k.db, k.wdb])
    (d as unknown as { pool: { on(e: 'error', f: () => void): void } }).pool.on(
      'error',
      () => undefined,
    );
  for (const j of SCHEDULING_CORE_JOBS) k.registry.defineJob(j);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const search = new AvailabilitySearch({ organisation: org });
  const avail = new AvailabilityService({ audit: k.audit });
  const core = new SchedulingCoreService({
    audit: k.audit,
    organisation: org,
    availability: search,
    queue: new Queue(k.registry, 'api'),
  });
  holder.search = search;
  holder.avail = avail;
  holder.core = core;

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 30 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 4 });
  for (const pool of [apiPool, workerPool]) pool.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const worker = new KernelDb(workerPool as never);
  const workerScope: ScopeSettings = {
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'org',
  };
  // calendar_stale_minutes, hold_minutes, ... are the catalogue's, applied by the real job.
  await worker.withScope(workerScope, (tx) => org.applySettingDefaults(tx, undefined));

  const lead = await (async () => {
    const p = await seedPrincipal(k, 'google', {
      name: 'Lead A',
      email: `lead.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'front_desk_lead', A1);
    return seedSession(k, p, 'google');
  })();
  const deskA1 = await staffMember(k, 'front_desk', A1, 'Desk A1');
  const deskB1 = await staffMember(k, 'front_desk', B1, 'Desk B1');

  let seq = 0;
  const kit: AvailKit = {
    k,
    org,
    search,
    avail,
    core,
    api,
    worker,
    workerScope,
    lead,
    deskA1,
    deskB1,
    async doctor(o = {}) {
      const p = await seedPrincipal(k, 'google', {
        name: `Doctor ${++seq}`,
        email: `doctor.${randomUUID().slice(0, 8)}@example.com`,
      });
      await assignRole(k, p.principalId, 'doctor', o.location ?? A1);
      await saWrite(
        k,
        `INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, directory_listed) VALUES ($1, $2, $3, $4)`,
        [p.principalId, ORG, `Dr. Test ${seq}`, o.listed ?? true],
      );
      if (o.eligible !== false)
        for (const s of [SVC, SVC_IN])
          await saWrite(
            k,
            `INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1, $2, $3)`,
            [ORG, s, p.principalId],
          );
      return { ...p, session: await seedSession(k, p, 'google') };
    },
    async patient(n) {
      const patientId = randomUUID();
      await saWrite(
        k,
        `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
         VALUES ($1, $2, $3, $4, $5, '1975-01-01', 'NY', 'front_desk')`,
        [patientId, ORG, `MRN-${String(8_000_000 + n)}`, `Avail${n}`, `Patient${n}`],
      );
      const p = await seedPrincipal(k, 'patient_pool', { name: `Patient account ${n}` });
      await saWrite(
        k,
        `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1,$2,$3,'self')`,
        [p.principalId, patientId, ORG],
      );
      const session = await seedSession(k, p, 'patient_pool');
      return {
        patientId,
        session,
        scope: {
          audience: 'patient',
          realm: 'patient_pool',
          orgId: ORG,
          principalId: p.principalId,
          personId: p.personId,
          patientIds: [patientId],
        } as ScopeSettings,
      };
    },
    staffScope(session, locations) {
      return {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: session.seeded.principalId,
        personId: session.seeded.personId,
        locationIds: locations,
      };
    },
    async adminScope() {
      const p = await seedPrincipal(k, 'admin_pool', { name: 'Admin' });
      return {
        audience: 'staff',
        realm: 'admin_pool',
        orgId: ORG,
        principalId: p.principalId,
        personId: p.personId,
      };
    },
    as: (scope, fn) => api.withScope(scope, fn),
    async localInstant(date, time) {
      const r = await k.q<{ t: Date }>(`SELECT (($1::date + $2::time) AT TIME ZONE $3) AS t`, [
        date,
        time,
        TZ,
      ]);
      return (r[0] as { t: Date }).t;
    },
    async futureDate(n) {
      const r = await k.q<{ d: string }>(
        `SELECT to_char((now() AT TIME ZONE $2)::date + $1::int, 'YYYY-MM-DD') AS d`,
        [n, TZ],
      );
      return (r[0] as { d: string }).d;
    },
    async close() {
      await apiPool.end();
      await workerPool.end();
      await k.close();
    },
  };
  return kit;
}

/** Two test files starting at once both run the cluster-wide role bootstrap and can collide; a new database name per attempt makes a retry safe. */
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

export const nextDow = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();
