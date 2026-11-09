/* eslint-disable boundaries/module-boundaries -- test support: reaches the patient kit, the merge executor, the privacy module and the other modules' participant registrations the way the privacy, documents and notes kits do (BE-20, BE-10, BE-17) */
// Harness of the messaging real-database tests (BE-19). Not a test file. A throwaway database migrated by the real pipeline (including
// 2000-2002), the real Nest application with the identity guard, the messaging, merge and privacy controllers, the real audit service,
// the real queue, seeded sessions and the REAL participants of identity, notifications, documents, scheduling, clinical, privacy and
// messaging for the merge. Synthetic data only.
import { newRegisteredRegistries } from '../../register-participants.js';
import { randomUUID } from 'node:crypto';
import { JobRegistry, KernelDb, ParticipantRegistries, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings, Tx } from '@ehr/kernel';
import { OrganisationService } from '../organisation/index.js';
import {
  createMergeControllers,
  executeMerge,
  MERGE_JOBS,
  MergeService,
  mergeResolvers,
  NOT_PARTICIPANT_TABLES,
} from '../patient/merge/index.js';
import type { ExecuteDeps, ExecuteResult } from '../patient/merge/index.js';
import {
  ORG,
  PATIENT_HOST,
  STAFF_HOST,
  assignRole,
  call,
  id,
  patientAccount,
  pg,
  registerViaApi,
  repoRoot,
  saWrite,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
} from '../patient/testkit.js';
import type { Kit, Resp, SeededSession } from '../patient/testkit.js';
import { PRIVACY_JOBS } from '../privacy/jobs.js';
import { createPrivacy } from '../privacy/runtime.js';
import { SignedPackageUrls } from '../privacy/ports.js';
import { MESSAGING_JOBS, registerMessagingHandlers } from './jobs.js';
import { createMessaging } from './runtime.js';
import type { Messaging } from './runtime.js';
import { uuidv7 } from './ids.js';
import { randomBytes } from 'node:crypto';

export { ORG, PATIENT_HOST, STAFF_HOST, call, id, pg, repoRoot, saWrite, writeHeaders, uuidv7 };
export type { Kit, Resp, SeededSession };

export const A1 = id(101);
export const A2 = id(102);
export const ORG2 = '00000000-0000-7000-8000-0000000000a2';

export interface PatientKit {
  patientId: string;
  session: SeededSession;
}

export interface MessagingKit {
  k: Kit;
  messaging: Messaging;
  api: KernelDb;
  worker: KernelDb;
  regs: ParticipantRegistries;
  /** Staff: a doctor and two front-desk members at A1, a front-desk member at A2 only, a care coordinator at A1. */
  doctor: SeededSession;
  desk: SeededSession;
  desk2: SeededSession;
  deskB: SeededSession;
  coordinator: SeededSession;
  /** A staff member holding no messaging permission (medical records). */
  records: SeededSession;
  lead: SeededSession;
  compliance: SeededSession;
  /** An active staff principal of ANOTHER organisation (ORG-2). */
  foreign: { principalId: string; personId: string };
  scall(
    s: SeededSession,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  pcall(
    s: SeededSession,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  /** A fresh scope for a staff session (what the guard builds), for tests that talk SQL as the application role. */
  scopeOf(s: SeededSession, locations: string[], extra?: Partial<ScopeSettings>): ScopeSettings;
  patientScope(p: PatientKit): ScopeSettings;
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  asWorker<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  mkPatient(n: number, at?: string): Promise<PatientKit>;
  /** Turns the organisation flag `patient_messaging` on or off (a superuser write standing in for the admin screen). */
  setFlag(on: boolean): Promise<void>;
  merge(
    survivorId: string,
    mergedId: string,
    over?: Partial<ExecuteDeps>,
  ): Promise<{ requestId: string; result: ExecuteResult }>;
  close(): Promise<void>;
}

export function buildRegistries(): ParticipantRegistries {
  return newRegisteredRegistries();
}

export async function setupMessaging(name: string): Promise<MessagingKit> {
  const holder: { k?: Kit; messaging?: Messaging } = {};
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const mreg = new JobRegistry();
  for (const j of MERGE_JOBS) mreg.defineJob(j);
  const merges = new MergeService({ queue: new Queue(mreg, 'api') });
  const org = new OrganisationService();
  const urls = new SignedPackageUrls(randomBytes(32));

  const lazy = <T extends object>(pick: (k: Kit) => unknown): T =>
    new Proxy({} as T, {
      get: (_t, prop) => {
        const target = pick(holder.k as Kit) as Record<string | symbol, unknown>;
        const v = target[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

  const k = await retrySetup(() =>
    setup({
      name,
      fixtures: async (f) => {
        await standardFixtures(f);
      },
      controllers: [...createMergeControllers({ db: lazyDb, merges })],
      beforeStart: ({ identity, patient }) => {
        for (const [n, fn] of Object.entries(mergeResolvers()))
          identity.policy.registerResolver(n, fn);
        (identity.policy as unknown as { deps: { elevation?: unknown } }).deps.elevation = {
          isElevated: () => Promise.resolve(true),
        };
        const queue = new Queue(
          lazy<JobRegistry>((kk) => kk.registry),
          'api',
        );
        const audit = lazy<Kit['audit']>((kk) => kk.audit);
        const privacy = createPrivacy({
          db: lazyDb,
          audit,
          organisation: org,
          identity,
          queue,
          store: urls,
        });
        const messaging = createMessaging({ db: lazyDb, audit, identity, queue });
        holder.messaging = messaging;
        patient.controllers.unshift(...privacy.controllers, ...messaging.controllers);
      },
    }),
  );
  holder.k = k;

  for (const d of [k.db, k.wdb])
    (d as unknown as { pool: { on(e: 'error', f: () => void): void } }).pool.on(
      'error',
      () => undefined,
    );
  for (const j of [...MERGE_JOBS, ...PRIVACY_JOBS, ...MESSAGING_JOBS])
    if (!safeHas(k, j.name)) k.registry.defineJob(j);
  registerMessagingHandlers(k.registry);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 20 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 8 });
  for (const pool of [apiPool, workerPool]) pool.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const worker = new KernelDb(workerPool as never);
  const regs = buildRegistries();

  const desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
  const desk2 = await staffMember(k, 'front_desk', A1, 'Desk A1 second');
  const deskB = await staffMember(k, 'front_desk', A2, 'Desk A2');
  const doctor = await staffMember(k, 'doctor', A1, 'Doctor A1');
  const coordinator = await staffMember(k, 'care_coordinator', A1, 'Coordinator A1');
  const records = await staffMember(k, 'medical_records', A1, 'Records A1');
  const lead = await (async () => {
    const p = await seedPrincipal(k, 'google', {
      name: 'Lead AB',
      email: `lead.ab.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'front_desk_lead', A1);
    return seedSession(k, p, 'google');
  })();
  const compliance = await (async () => {
    const p = await seedPrincipal(k, 'admin_pool', {
      name: 'Compliance Officer',
      email: `cmp.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'compliance_officer');
    return seedSession(k, p, 'admin_pool');
  })();

  // A patient names only the directory's listed clinicians (22.5.1): list the doctor and the desk.
  for (const s of [doctor, desk]) {
    await k.sa.query(
      `INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, directory_listed) VALUES ($1, $2, 'Listed Staff', true)`,
      [s.seeded.principalId, ORG],
    );
  }

  // An active staff principal of a SECOND organisation (TC-MSG-02).
  const foreign = { principalId: uuidv7(), personId: uuidv7() };
  await k.sa.query(
    `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
    [ORG2],
  );
  await k.sa.query('BEGIN');
  try {
    await k.sa.query(
      `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, 'Other Org Staff')`,
      [foreign.personId, ORG2],
    );
    await k.sa.query(
      `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status) VALUES ($1,$2,$3,'google',$4,$5,'active')`,
      [
        foreign.principalId,
        ORG2,
        foreign.personId,
        `sub-${foreign.principalId}`,
        'other.org@example.com',
      ],
    );
    await k.sa.query('COMMIT');
  } catch (e) {
    await k.sa.query('ROLLBACK');
    throw e;
  } finally {
    await k.sa.query(
      `SELECT set_config('app.org_id', '', false), set_config('app.audience', '', false)`,
    );
  }

  const scall: MessagingKit['scall'] = (s, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: STAFF_HOST,
      cookie: s.cookie,
      headers:
        method === 'GET' ? extra : { ...writeHeaders(s, STAFF_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });
  const pcall: MessagingKit['pcall'] = (s, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: PATIENT_HOST,
      cookie: s.cookie,
      headers:
        method === 'GET' ? extra : { ...writeHeaders(s, PATIENT_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });

  let seq = 0;
  const kit: MessagingKit = {
    k,
    messaging: holder.messaging as Messaging,
    api,
    worker,
    regs,
    doctor,
    desk,
    desk2,
    deskB,
    coordinator,
    records,
    lead,
    compliance,
    foreign,
    scall,
    pcall,
    scopeOf: (s, locations, extra = {}) => ({
      audience: 'staff',
      realm: 'google',
      orgId: ORG,
      principalId: s.seeded.principalId,
      personId: s.seeded.personId,
      locationIds: locations,
      ...extra,
    }),
    patientScope: (p) => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: p.session.seeded.principalId,
      personId: p.session.seeded.personId,
      patientIds: [p.patientId],
    }),
    as: (scope, fn) => api.withScope(scope, fn),
    asWorker: (scope, fn) => worker.withScope(scope, fn),
    async mkPatient(n, at = A1) {
      const patientId = await registerViaApi(k, at === A2 ? deskB : desk, at, {
        givenName: `Given${n}`,
        familyName: `Family${n}`,
        dateOfBirth: '1980-05-17',
        phone: `+1212555${String(1000 + n)}`,
        email: `person${n}@example.test`,
      });
      return { patientId, session: await patientAccount(k, patientId, `Patient ${n}`) };
    },
    async setFlag(on) {
      await saWrite(
        k,
        `INSERT INTO organisation.feature_flag (id, organisation_id, key, location_id, enabled) VALUES ($1, $2, 'patient_messaging', NULL, $3)
         ON CONFLICT (key, location_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [uuidv7(), ORG, on],
      );
    },
    async merge(survivorId, mergedId, over = {}) {
      const r = await call(k.base, 'POST', '/api/v1/patient-merges', {
        cookie: lead.cookie,
        headers: writeHeaders(lead, undefined, randomUUID()),
        body: { survivorId, mergedId, reason: 'Same person registered twice' },
      });
      if (r.status !== 200) throw new Error(`request failed ${r.status} ${r.body}`);
      const requestId = r.json()['id'] as string;
      const a = await call(k.base, 'POST', `/api/v1/patient-merges/${requestId}/approve`, {
        cookie: records.cookie,
        headers: writeHeaders(records, undefined, randomUUID()),
      });
      if (a.status !== 200) throw new Error(`approve failed ${a.status} ${a.body}`);
      const result = await executeMerge(
        {
          db: worker,
          orgId: ORG,
          registries: regs,
          notParticipants: {
            ...NOT_PARTICIPANT_TABLES,
            'privacy.incident_patient': 'records history; exempt from the guard (22.14, 22.16)',
            'notifications.staff_alert': 'BE-07 participant is wired at integration',
            'notifications.staff_alert_event': 'BE-07 participant is wired at integration',
          },
          ...over,
        },
        { requestId, jobId: `test-merge:${++seq}`, attempt: 1, maxAttempts: 1 },
      );
      return { requestId, result };
    },
    async close() {
      await apiPool.end();
      await workerPool.end();
      await k.close();
    },
  };
  return kit;
}

function safeHas(k: Kit, name: string): boolean {
  try {
    k.registry.get(name);
    return true;
  } catch {
    return false;
  }
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
