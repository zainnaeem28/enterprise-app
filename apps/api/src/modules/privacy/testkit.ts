/* eslint-disable boundaries/module-boundaries -- test support: reaches the patient kit, the merge executor and the other modules' participant registrations the way the documents', the chart's and the notes' kits do (BE-10, BE-16, BE-17) */
// Harness of the privacy real-database tests (BE-20). Not a test file. A throwaway database migrated by the real pipeline (including
// 1900-1902), the real Nest application with the identity guard, the merge and privacy controllers, the real audit service, the real
// queue, seeded sessions, the worker's real privacy jobs (loaded from the worker's build) over an in-memory package store, and the REAL
// export contributors of identity, notifications, documents, scheduling and clinical. Synthetic data only.
//
// Two contributors are FIXTURES and say so: `patient` (the patient module ships no `exportPart` yet; the owner calls it downwards) and,
// in the tests that need them, `messaging` and `telehealth` (those modules do not exist yet). They return canned parts; they prove the
// assembler iterates what is registered, not anything about those modules.
import { newRegisteredRegistries, type RegisteredModule } from '../../register-participants.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { JobRegistry, KernelDb, ParticipantRegistries, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ExportContributor, ScopeSettings, Tx } from '@ehr/kernel';
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
import { assembleExport } from './assemble.js';
import { RETENTION_DEFAULTS, retentionPolicy } from './retention.js';
import type { RetentionPolicy, RetentionSettings } from './retention.js';
import type { AssembleDeps, AssembleInput, AssembleResult } from './assemble.js';
import { PRIVACY_JOBS } from './jobs.js';
import { SignedPackageUrls } from './ports.js';
import type { PackageWriterPort } from './ports.js';
import { createPrivacy } from './runtime.js';
import type { Privacy } from './runtime.js';
import { privacyResolvers } from './controller.js';
import { uuidv7 } from './ids.js';

export { ORG, PATIENT_HOST, STAFF_HOST, call, id, pg, repoRoot, saWrite, writeHeaders, uuidv7 };
export type { Kit, Resp, SeededSession };

export const A1 = id(101);
export const A2 = id(102);

/** An in-memory package store. Proves OUR side of the interface, not encryption or any property of a real object store (C-01). */
export class MemoryPackageStore implements PackageWriterPort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  failPut = false;
  put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.failPut) return Promise.reject(new Error('store unavailable'));
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
  has(key: string): boolean {
    return this.objects.has(key);
  }
  /** The decoded package. */
  read(key: string): {
    manifest: Record<string, unknown>;
    parts: Record<string, unknown>;
    accountingOfDisclosures: { events: Record<string, unknown>[] };
  } {
    const o = this.objects.get(key);
    if (o === undefined) throw new Error('no such object');
    return JSON.parse(gunzipSync(o.body).toString('utf8'));
  }
}

/** Every REAL participant and contributor (the shared helper), optionally without some for a negative control (a registry of its own). */
export function buildRegistries(without: readonly RegisteredModule[] = []): ParticipantRegistries {
  return newRegisteredRegistries({ without });
}

export interface PatientKit {
  patientId: string;
  session: SeededSession;
}

type WorkerPrivacy = {
  runCheckLegalHolds(
    deps: unknown,
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<string>;
  runExpirePackages(
    deps: unknown,
    opts?: { batch?: number; jobRef?: string },
  ): Promise<{ expired: number; failed: number }>;
  runExecuteDeletion(
    deps: unknown,
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<'executed' | 'gone' | 'final'>;
  runSendDeletionStatement(
    deps: unknown,
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<'sent' | 'already_sent' | 'gone'>;
  runRetentionPurge(
    deps: unknown,
    opts?: { jobRef?: string; batch?: number },
  ): Promise<RetentionReport>;
  createPrivacyTasks(deps: unknown): Record<string, unknown>;
  documentsLegalHolds: unknown;
  closureOf: unknown;
  PRIVACY_JOBS: readonly { name: string }[];
  PRIVACY_CRONTAB: string;
};

/** The shape of the worker's retention report (apps/worker/src/jobs/privacy/retention-purge.ts), as the tests read it. */
export interface RetentionReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: 'completed' | 'partial';
  cutoffs: Record<string, string>;
  classes: {
    export_packages: { expired: number; failed: number };
    medical_record: {
      purged: number;
      objectsPending: number;
      deferredLegalHold: number;
      deferredDocumentRetention: number;
      extendedByNewerEncounter: number;
      failed: number;
      removed: Record<string, number>;
    };
    hipaa_documentation: { removed: Record<string, number>; failed: number };
    audit_trail: { removedByThisJob: number; reason: string; years: number };
    audit_anchors: { removedByThisJob: number; reason: string; years: number };
  };
}

/** Records the deletion statements the worker "sends"; nothing leaves the process. */
export class MemoryStatementSender {
  readonly sent: {
    recordId: string;
    requestId: string;
    patientId: string;
    subject: string;
    text: string;
  }[] = [];
  fail = false;
  send(input: {
    recordId: string;
    requestId: string;
    patientId: string;
    subject: string;
    text: string;
  }): Promise<void> {
    if (this.fail) return Promise.reject(new Error('mail provider not configured'));
    this.sent.push(input);
    return Promise.resolve();
  }
}

export interface PrivacyKit {
  k: Kit;
  privacy: Privacy;
  store: MemoryPackageStore;
  urls: SignedPackageUrls;
  /** The registries the assembler reads: the REAL contributors of five modules (no fixtures). */
  regs: ParticipantRegistries;
  /** A fixture standing in for `patient.exportPart` (not shipped yet), listed explicitly as the owner's downward call. */
  patientFixture: ExportContributor;
  api: KernelDb;
  worker: KernelDb;
  desk: SeededSession; // front_desk at A1: privacy.request.create_for_patient
  deskB: SeededSession; // front_desk at A2: another location
  records: SeededSession; // medical_records at A1 (merge approver)
  lead: SeededSession; // front_desk_lead (merge requester)
  compliance: SeededSession; // compliance_officer (admin_pool)
  orgAdmin: SeededSession; // org_admin (admin_pool): holds no privacy permission
  clock: { at: Date | undefined };
  /** The front desk member's staff scope at A1. */
  deskScope(): ScopeSettings;
  mkPatient(n: number): Promise<PatientKit>;
  pcall(
    p: SeededSession,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  scall(
    s: SeededSession,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** The assembler over the worker pool, the memory store and the registries (`over` replaces any dependency). */
  assemble(
    packageId: string,
    over?: Partial<AssembleDeps>,
    input?: Partial<AssembleInput>,
  ): Promise<AssembleResult>;
  /** The worker's real jobs. */
  w: {
    checkHolds(requestId: string, over?: Record<string, unknown>): Promise<string>;
    expire(over?: Record<string, unknown>): Promise<{ expired: number; failed: number }>;
    /** `privacy.execute_deletion` (owner ruling C item 1). */
    executeDeletion(
      requestId: string,
      over?: Record<string, unknown>,
    ): Promise<'executed' | 'gone' | 'final'>;
    sendStatement(
      requestId: string,
      over?: Record<string, unknown>,
    ): Promise<'sent' | 'already_sent' | 'gone'>;
    /** `privacy.retention_purge` (owner ruling C item 2); `over.now` is the controllable clock. */
    retentionPurge(over?: Record<string, unknown>): Promise<RetentionReport>;
    /** The job deps the worker builds (for a test that wants the real task table). */
    deps(over?: Record<string, unknown>): Record<string, unknown>;
  };
  /** The statements the worker's sender port was given. */
  statements: MemoryStatementSender;
  /** The retention policy the worker jobs use (the API's one config module); replaced by `setRetention`. */
  setRetention(s?: Partial<RetentionSettings>): RetentionPolicy;
  /** Runs SQL as the superuser with the user triggers off (`session_replication_role = replica`): seeds rows no route can create. */
  seed<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** A patient request through the API, verified and approved by compliance: returns the IDs. */
  approvedExport(
    p: PatientKit,
    kind?: 'export' | 'access',
  ): Promise<{ requestId: string; packageId: string }>;
  verify(requestId: string): Promise<Resp>;
  decide(requestId: string, decision: string, reason?: string): Promise<Resp>;
  merge(
    survivorId: string,
    mergedId: string,
    over?: Partial<ExecuteDeps>,
  ): Promise<{ requestId: string; result: ExecuteResult }>;
  close(): Promise<void>;
}

export async function setupPrivacy(name: string): Promise<PrivacyKit> {
  const holder: { k?: Kit; privacy?: Privacy } = {};
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const mreg = new JobRegistry();
  for (const j of MERGE_JOBS) mreg.defineJob(j);
  const merges = new MergeService({ queue: new Queue(mreg, 'api') });
  const org = new OrganisationService();
  const store = new MemoryPackageStore();
  const urls = new SignedPackageUrls(randomBytes(32));
  const clock: { at: Date | undefined } = { at: undefined };

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
        // The admin elevation check is BE-05's; the harness answers "elevated".
        (identity.policy as unknown as { deps: { elevation?: unknown } }).deps.elevation = {
          isElevated: () => Promise.resolve(true),
        };
        const privacy = createPrivacy({
          db: lazyDb,
          audit: lazyAudit(),
          organisation: org,
          identity,
          queue: new Queue(lazyRegistry(), 'api'),
          store: urls,
          now: () => clock.at ?? new Date(),
        });
        holder.privacy = privacy;
        // The privacy routes are registered before the patient module's: the same order every module's kit uses.
        patient.controllers.unshift(...privacy.controllers);
      },
    }),
  );
  holder.k = k;

  // beforeStart runs before `k` exists, so audit and the registry are resolved lazily (the module is wired once the kit is up).
  function lazyAudit(): never {
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          const target = (holder.k as Kit).audit as unknown as Record<string | symbol, unknown>;
          const v = target[prop];
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      },
    ) as never;
  }
  function lazyRegistry(): JobRegistry {
    return new Proxy({} as JobRegistry, {
      get: (_t, prop) => {
        const target = (holder.k as Kit).registry as unknown as Record<string | symbol, unknown>;
        const v = target[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  for (const d of [k.db, k.wdb])
    (d as unknown as { pool: { on(e: 'error', f: () => void): void } }).pool.on(
      'error',
      () => undefined,
    );
  for (const j of [...MERGE_JOBS, ...PRIVACY_JOBS])
    if (!safeHas(k, j.name)) k.registry.defineJob(j);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 20 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 8 });
  for (const pool of [apiPool, workerPool]) pool.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const worker = new KernelDb(workerPool as never);

  const wdist = (p: string): string => pathToFileURL(`${repoRoot}apps/worker/dist/jobs/${p}`).href;
  const wpriv = (await import(wdist('privacy/index.js'))) as WorkerPrivacy;

  // The REAL contributors of five modules, in a registry of their own (not the process-wide one).
  const regs = buildRegistries();

  const patientFixture: ExportContributor = {
    module: 'patient',
    async exportPart(tx, patientIds) {
      const r = await tx.query(
        `SELECT id, mrn, status FROM patient.patient WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[...patientIds]],
      );
      return { patients: r.rows, fixture: 'patient.exportPart is not shipped yet' };
    },
  };

  const lead = await (async () => {
    const p = await seedPrincipal(k, 'google', {
      name: 'Lead AB',
      email: `lead.ab.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'front_desk_lead', A1);
    return seedSession(k, p, 'google');
  })();
  const desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
  const deskB = await staffMember(k, 'front_desk', A2, 'Desk A2');
  const records = await staffMember(k, 'medical_records', A1, 'Records A1');
  const compliance = await (async () => {
    const p = await seedPrincipal(k, 'admin_pool', {
      name: 'Compliance Officer',
      email: `cmp.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'compliance_officer');
    return seedSession(k, p, 'admin_pool');
  })();
  const orgAdmin = await (async () => {
    const p = await seedPrincipal(k, 'admin_pool', {
      name: 'Org Admin',
      email: `adm.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'org_admin');
    return seedSession(k, p, 'admin_pool');
  })();

  const pcall: PrivacyKit['pcall'] = (s, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: PATIENT_HOST,
      cookie: s.cookie,
      headers:
        method === 'GET' ? extra : { ...writeHeaders(s, PATIENT_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });
  const scall: PrivacyKit['scall'] = (s, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: STAFF_HOST,
      cookie: s.cookie,
      headers:
        method === 'GET' ? extra : { ...writeHeaders(s, STAFF_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });

  let seq = 0;
  const downward = [patientFixture];
  const statements = new MemoryStatementSender();
  let policy: RetentionPolicy = retentionPolicy(RETENTION_DEFAULTS);
  const wq = new Queue(k.registry, 'worker');
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const jobDeps = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    db: worker,
    orgId: ORG,
    store,
    holds: wpriv.documentsLegalHolds,
    closureOf: wpriv.closureOf,
    log: silent,
    queue: wq,
    retention: policy,
    statements,
    ...(clock.at === undefined ? {} : { now: () => clock.at as Date }),
    ...over,
  });
  const kit: PrivacyKit = {
    k,
    privacy: holder.privacy as Privacy,
    store,
    urls,
    regs,
    patientFixture,
    api,
    worker,
    desk,
    deskB,
    records,
    lead,
    compliance,
    orgAdmin,
    clock,
    deskScope: () => ({
      audience: 'staff',
      realm: 'google',
      orgId: ORG,
      principalId: desk.seeded.principalId,
      personId: desk.seeded.personId,
      locationIds: [A1],
    }),
    async mkPatient(n) {
      const patientId = await registerViaApi(k, desk, A1, {
        givenName: `Given${n}`,
        familyName: `Family${n}`,
        dateOfBirth: '1980-05-17',
        phone: `+1212555${String(1000 + n)}`,
        email: `person${n}@example.test`,
      });
      return { patientId, session: await patientAccount(k, patientId, `Patient ${n}`) };
    },
    pcall,
    scall,
    as: (scope, fn) => api.withScope(scope, fn),
    assemble(packageId, over = {}, input = {}) {
      return assembleExport(
        {
          db: worker,
          orgId: ORG,
          audit: k.audit,
          writer: store,
          closureOf: (tx, pid) => k.patient.patients.closure(tx, pid),
          registries: regs,
          downward,
          ...(clock.at === undefined ? {} : { now: () => clock.at as Date }),
          ...over,
        },
        { packageId, jobId: `test:${++seq}`, attempt: 1, maxAttempts: 1, ...input },
      );
    },
    statements,
    setRetention(over = {}) {
      policy = retentionPolicy({ ...RETENTION_DEFAULTS, ...over });
      return policy;
    },
    async seed(sql, params = []) {
      await k.sa.query('BEGIN');
      try {
        await k.sa.query('SET LOCAL session_replication_role = replica');
        const r = await k.sa.query(sql, params);
        await k.sa.query('COMMIT');
        return r.rows as never;
      } catch (e) {
        await k.sa.query('ROLLBACK');
        throw e;
      }
    },
    w: {
      deps: jobDeps,
      executeDeletion: (requestId, over = {}) =>
        wpriv.runExecuteDeletion(jobDeps(over), { requestId }),
      sendStatement: (requestId, over = {}) =>
        wpriv.runSendDeletionStatement(jobDeps(over), { requestId }),
      retentionPurge: (over = {}) => wpriv.runRetentionPurge(jobDeps(over)),
      checkHolds: (requestId, over = {}) =>
        wpriv.runCheckLegalHolds(
          {
            db: worker,
            orgId: ORG,
            store,
            holds: wpriv.documentsLegalHolds,
            closureOf: wpriv.closureOf,
            log: { info: () => undefined, warn: () => undefined, error: () => undefined },
            ...over,
          },
          { requestId },
        ),
      expire: (over = {}) =>
        wpriv.runExpirePackages({
          db: worker,
          orgId: ORG,
          store,
          holds: wpriv.documentsLegalHolds,
          closureOf: wpriv.closureOf,
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
          ...over,
        }),
    },
    verify: (requestId) =>
      scall(compliance, 'POST', `/api/v1/admin/privacy-requests/${requestId}/verify-identity`, {
        method: 'in person with photo id',
      }),
    decide: (requestId, decision, reason) =>
      scall(compliance, 'POST', `/api/v1/admin/privacy-requests/${requestId}/decide`, {
        decision,
        ...(reason === undefined ? {} : { reason }),
      }),
    async approvedExport(p, kind = 'export') {
      const c = await pcall(p.session, 'POST', '/api/v1/privacy-requests', { kind });
      if (c.status !== 201) throw new Error(`create failed ${c.status} ${c.body}`);
      const requestId = String(c.json()['id']);
      const v = await kit.verify(requestId);
      if (v.status !== 200) throw new Error(`verify failed ${v.status} ${v.body}`);
      const d = await kit.decide(requestId, 'approve');
      if (d.status !== 200) throw new Error(`approve failed ${d.status} ${d.body}`);
      const pkg = (d.json()['package'] ?? {}) as Record<string, unknown>;
      return { requestId, packageId: String(pkg['id']) };
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
          // privacy.incident_patient records history (22.14): the merge executor's exempt list needs this line (README, request to the Orchestrator).
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

export { privacyResolvers };
