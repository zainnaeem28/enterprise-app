// Harness of the clinical chart real-database tests (BE-16). Not a test file. Builds on the patient testkit (BE-08) and the merge
// executor (BE-09): a throwaway database migrated by the real pipeline (including 1600-1603), the real Nest application with the
// identity guard, the chart controllers (registered BEFORE the patient module's, so the banner route that fills the allergy part wins),
// seeded sessions, the worker's real terminology job over an in-memory source, and a second pair of pools for real concurrency.
// Synthetic data only. Nothing here proves a licensed terminology (C-09) or the real elevation check (BE-05).
/* eslint-disable boundaries/module-boundaries -- a test harness: it reuses the patient module's kit and merge executor (BE-08, BE-09), which are not on the patient index. Request to the Orchestrator: exempt testkit.ts and *.dbtest.ts from this rule (BE-10 README O-6). */
import { newRegisteredRegistries } from '../../../register-participants.js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { KernelDb, ParticipantRegistries, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings, Tx } from '@ehr/kernel';
import {
  createMergeControllers,
  executeMerge,
  MERGE_JOBS,
  MergeService,
  mergeResolvers,
} from '../../patient/merge/index.js';
import type { ExecuteDeps, ExecuteResult } from '../../patient/merge/index.js';
import { JobRegistry, Queue } from '@ehr/kernel';
import {
  ORG,
  PATIENT_HOST,
  STAFF_HOST,
  adminUrl,
  assignRole,
  call,
  id,
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
} from '../../patient/testkit.js';
import type { Kit, Resp, SeededSession } from '../../patient/testkit.js';
import { createClinicalChart } from './index.js';
import type { ClinicalChart } from './index.js';

export { ORG, PATIENT_HOST, repoRoot, STAFF_HOST, adminUrl, call, id, pg, saWrite, writeHeaders };
export type { Kit, Resp, SeededSession };

export const A1 = id(101);
export const A2 = id(102);
export const B1 = id(201);

export const CURSOR_KEY = 'cursor-key-for-tests-0123456789abcdef';

/** A small synthetic terminology (no licensed content). Codes are made up for the test; the displays are plain words. */
export const SYNTH = {
  rxnorm: [
    { code: '70001', display: 'Synthetic penicillin' },
    { code: '70002', display: 'Synthetic penicillin V' },
    { code: '70003', display: 'Synthetic amoxicillin' },
    { code: '70004', display: 'Synthetic ibuprofen' },
    { code: '70005', display: '100% pure_test' },
  ],
  snomed: [
    { code: '80001', display: 'Synthetic hypertension' },
    { code: '80002', display: 'Synthetic asthma' },
  ],
  icd10cm: [{ code: 'T00.0', display: 'Synthetic disorder' }],
} as const;

export interface WorkerClinical {
  runTerminologyLoad(
    payload: unknown,
    o?: { chunkSize?: number; source?: unknown },
  ): Promise<{ loaded: number; chunks: number; deactivated: number; resumed: boolean }>;
  /** The in-memory source the load reads. */
  source: {
    calls: { system: string; release: string; cursor: string | null; limit: number }[];
    failOnCall: number | undefined;
    set(
      system: string,
      release: string,
      concepts: { code: string; display: string; active?: boolean }[],
    ): void;
  };
}

export interface ChartKit {
  k: Kit;
  chart: ClinicalChart;
  api: KernelDb;
  wdb: KernelDb;
  regs: ParticipantRegistries;
  desk: SeededSession; // front_desk at A1: registers patients; holds read_previsit
  nurse: SeededSession; // triage_nurse at A1: read_previsit, vitals.record
  doctor: SeededSession; // doctor at A1
  doctor2: SeededSession; // another doctor at A1
  records: SeededSession; // medical_records at A1: patient.read only
  admin: SeededSession; // org_admin (admin realm), holds clinical.vital_range.manage
  lead: SeededSession;
  mr2: SeededSession;
  worker: WorkerClinical;
  /** A patient registered at A1 through the front desk. */
  mkPatient(n: number, o?: { dateOfBirth?: string; sexAtBirth?: string | null }): Promise<string>;
  /** Puts the principal on the patient's care team (the assignment rule's first source). */
  assign(s: SeededSession, patientId: string): Promise<void>;
  /** Staff-realm HTTP call (a state change gets the CSRF headers and a fresh idempotency key). */
  scall(
    s: SeededSession,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  /** Loads the synthetic terminology through the real job. */
  loadTerminology(release?: string): Promise<void>;
  staffScope(s: SeededSession, locations?: string[]): ScopeSettings;
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  merge(
    survivorId: string,
    mergedId: string,
    over?: Partial<ExecuteDeps>,
  ): Promise<{ requestId: string; result: ExecuteResult }>;
  close(): Promise<void>;
}

export async function setupChart(name: string): Promise<ChartKit> {
  const holder: { k?: Kit; chart?: ClinicalChart } = {};
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  // The kit creates the audit service before `beforeStart` but does not hand it over; the chart reads it through this proxy.
  const lazyAudit = new Proxy({} as Kit['audit'], {
    get: (_t, prop) => {
      const a = (holder.k as Kit).audit as unknown as Record<string | symbol, unknown>;
      const v = a[prop];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(a) : v;
    },
  });
  const mreg = new JobRegistry();
  for (const j of MERGE_JOBS) mreg.defineJob(j);
  const merges = new MergeService({ queue: new Queue(mreg, 'api') });

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
        // The admin elevation check is BE-05's; the harness answers "elevated" so the elevated admin routes can be exercised.
        (identity.policy as unknown as { deps: { elevation?: unknown } }).deps.elevation = {
          isElevated: () => Promise.resolve(true),
        };
        const chart = createClinicalChart({
          db: lazyDb,
          audit: lazyAudit,
          identity,
          patients: patient.patients,
          cursorKey: CURSOR_KEY,
          photo: (_tx, docId) =>
            Promise.resolve(`https://files.example.test/photo/${docId}?sig=test&exp=60`),
        });
        holder.chart = chart;
        // Registered first: both this module and the patient module declare GET /patients/{id}/banner.
        patient.controllers.unshift(...chart.controllers);
      },
    }),
  );
  holder.k = k;
  const chart = holder.chart as ClinicalChart;
  for (const d of [k.db, k.wdb])
    (d as unknown as { pool: { on(e: 'error', f: () => void): void } }).pool.on(
      'error',
      () => undefined,
    );

  // The merge executor's jobs, and a stand-in for the handler of `audit.btg_opened` (the compliance alert, a later ticket): the event
  // is published in the BTG transaction, and the test looks for the job it creates.
  for (const j of MERGE_JOBS) if (!safeHas(k, j.name)) k.registry.defineJob(j);
  k.registry.defineJob({
    name: 'sink.on_btg_opened',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  });
  k.registry.registerHandler('audit.btg_opened', 'sink');
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 30 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 8 });
  for (const pool of [apiPool, workerPool]) pool.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const wdb = new KernelDb(workerPool as never);

  // The worker's real job, from its build.
  const wdist = (p: string): string => pathToFileURL(`${repoRoot}apps/worker/dist/jobs/${p}`).href;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = any;
  const wclin: Loose = await import(wdist('clinical/index.js'));
  const source = new wclin.InMemoryTerminologySource();
  const worker: WorkerClinical = {
    source,
    runTerminologyLoad: (payload, o = {}) =>
      wclin.runTerminologyLoad(
        {
          db: wdb,
          orgId: ORG,
          source: o.source ?? source,
          ...(o.chunkSize === undefined ? {} : { chunkSize: o.chunkSize }),
        },
        payload,
      ),
  };

  const regs = newRegisteredRegistries();

  const lead = await (async () => {
    const p = await seedPrincipal(k, 'google', {
      name: 'Lead AB',
      email: `lead.ab.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'front_desk_lead', A1);
    return seedSession(k, p, 'google');
  })();
  const desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
  const nurse = await staffMember(k, 'triage_nurse', A1, 'Nurse A1');
  const doctor = await staffMember(k, 'doctor', A1, 'Doctor A1');
  const doctor2 = await staffMember(k, 'doctor', A1, 'Doctor A1 second');
  const records = await staffMember(k, 'medical_records', A1, 'Records A1');
  const mr2 = await staffMember(k, 'medical_records', A2, 'Records A2');
  const admin = await (async () => {
    const p = await seedPrincipal(k, 'admin_pool', {
      name: 'Admin',
      email: `admin.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'org_admin');
    return seedSession(k, p, 'admin_pool');
  })();

  const scall: ChartKit['scall'] = (s, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: STAFF_HOST,
      cookie: s.cookie,
      headers:
        method === 'GET' ? extra : { ...writeHeaders(s, STAFF_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });

  let seq = 0;
  const kit: ChartKit = {
    k,
    chart,
    api,
    wdb,
    regs,
    desk,
    nurse,
    doctor,
    doctor2,
    records,
    admin,
    lead,
    mr2,
    worker,
    async mkPatient(n, o = {}) {
      const pid = await registerViaApi(k, desk, A1, {
        givenName: `Given${n}`,
        familyName: `Family${n}`,
        dateOfBirth: o.dateOfBirth ?? '1980-05-17',
        phone: `+1212555${String(1000 + n)}`,
        email: `person${n}@example.test`,
      });
      if (o.sexAtBirth !== undefined)
        await saWrite(k, `UPDATE patient.patient SET sex_at_birth = $2 WHERE id = $1`, [
          pid,
          o.sexAtBirth,
        ]);
      return pid;
    },
    async assign(s, patientId) {
      await saWrite(
        k,
        `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) VALUES ($1, $2, $3, $4, 'clinician')`,
        [randomUUID(), ORG, patientId, s.seeded.principalId],
      );
    },
    scall,
    async loadTerminology(release = 'T1') {
      for (const [system, concepts] of Object.entries(SYNTH)) {
        source.set(
          system,
          release,
          concepts.map((c) => ({ ...c })),
        );
        await worker.runTerminologyLoad({ dataset: system, version: release });
      }
    },
    staffScope: (s, locations = [A1]) => ({
      audience: 'staff',
      realm: 'google',
      orgId: ORG,
      principalId: s.seeded.principalId,
      personId: s.seeded.personId,
      locationIds: locations,
    }),
    as: (scope, fn) => api.withScope(scope, fn),
    async merge(survivorId, mergedId, over = {}) {
      const r = await call(k.base, 'POST', '/api/v1/patient-merges', {
        cookie: lead.cookie,
        headers: writeHeaders(lead, undefined, randomUUID()),
        body: { survivorId, mergedId, reason: 'Same person registered twice' },
      });
      if (r.status !== 200) throw new Error(`request failed ${r.status} ${r.body}`);
      const requestId = r.json()['id'] as string;
      const a = await call(k.base, 'POST', `/api/v1/patient-merges/${requestId}/approve`, {
        cookie: mr2.cookie,
        headers: writeHeaders(mr2, undefined, randomUUID()),
      });
      if (a.status !== 200) throw new Error(`approve failed ${a.status} ${a.body}`);
      const result = await executeMerge(
        { db: wdb, orgId: ORG, registries: regs, ...over },
        { requestId, jobId: `test:${++seq}`, attempt: 1, maxAttempts: 1 },
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
