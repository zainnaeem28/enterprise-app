// Harness of the documents real-database tests (BE-10). Not a test file. Builds on the patient testkit (BE-08) and the merge
// executor (BE-09): a throwaway database migrated by the real pipeline (including 1000-1003), the real Nest application with the
// identity guard, the merge and documents controllers, seeded sessions, the worker's real jobs (loaded from the worker's build) over an
// in-memory object store and a stub scanner, and a second pair of pools for real concurrency. Synthetic data only. Nothing here proves
// a real object store, scanner or OCR vendor (C-01, C-10).
/* eslint-disable boundaries/module-boundaries -- a test harness: it reuses the patient module's kit and merge executor (BE-08, BE-09), which are not on the patient index. Request to the Orchestrator: exempt testkit.ts and *.dbtest.ts from this rule (README O-6). */
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  JobRegistry,
  KernelDb,
  ParticipantRegistries,
  Queue,
  createLogger,
  syncTaskTypes,
} from '@ehr/kernel';
import type { Logger, MergeParticipant, ScopeSettings, Tx } from '@ehr/kernel';
import { registerIdentityParticipants } from '../identity/index.js';
import { registerNotificationsParticipants } from '../notifications/index.js';
import { OrganisationService } from '../organisation/index.js';
import {
  createMergeControllers,
  executeMerge,
  MERGE_JOBS,
  MergeService,
  NOT_PARTICIPANT_TABLES,
  mergeResolvers,
} from '../patient/merge/index.js';
import type { ExecuteDeps, ExecuteResult } from '../patient/merge/index.js';
import {
  ORG,
  PATIENT_HOST,
  STAFF_HOST,
  adminUrl,
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
import type { Client, Kit, Resp, SeededSession } from '../patient/testkit.js';
import { createDocumentsControllers, documentsResolvers } from './controller.js';
import { DOCUMENTS_JOBS } from './jobs.js';
import { registerDocumentsParticipants } from './merge.js';
import { SignedUrlPresigner } from './ports.js';
import { DocumentsService } from './service.js';

export { ORG, PATIENT_HOST, repoRoot, STAFF_HOST, adminUrl, call, id, pg, saWrite, writeHeaders };
export type { Client, Kit, Resp, SeededSession };

export const A1 = id(101);
export const A2 = id(102);
export const B1 = id(201);

/** A tiny but structurally valid PDF, PNG and JPEG (synthetic; no real content). */
export const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);
export const PNG_WITH_TEXT = (() => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // crc not checked by the rewrite
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Comment\0CANARY-EXIF-LOCATION-40.7128N', 'latin1')),
    chunk('IDAT', Buffer.from([1, 2, 3, 4])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();
export const JPEG_WITH_EXIF = Buffer.from([
  0xff,
  0xd8, // SOI
  0xff,
  0xe1,
  0x00,
  0x08,
  0x45,
  0x78,
  0x69,
  0x66,
  0x00,
  0x00, // APP1 "Exif"
  0xff,
  0xdb,
  0x00,
  0x04,
  0x00,
  0x01, // DQT
  0xff,
  0xda,
  0x00,
  0x04,
  0x00,
  0x00,
  0x11,
  0x22, // SOS + data
  0xff,
  0xd9, // EOI
]);

export interface Alerts {
  list: { kind: string; documentId: string }[];
}

/** The worker's stubs, by shape only (the API package does not import the worker's sources). */
export interface StoreStub {
  objects: Map<string, { body: Buffer; contentType: string }>;
  failRemove: boolean;
  upload(key: string, body: Buffer, contentType: string): void;
  has(bucket: 'quarantine' | 'clean', key: string): boolean;
}
export interface ScannerStub {
  outage: boolean;
  release(key: string): void;
  releaseAll(): void;
}
export interface OcrStub {
  calls: number;
  plan: (n: number) => unknown;
}

export interface WorkerApi {
  runAwaitScan(
    payload: Record<string, unknown>,
    o?: { scan?: (bucket: string, key: string) => Promise<string>; log?: boolean },
  ): Promise<string>;
  runOcrSuggest(
    payload: Record<string, unknown>,
    attempt?: { number: number; max: number },
  ): Promise<string>;
  runRetentionSweep(opts?: {
    quarantineKeepDays?: number;
  }): Promise<{ removed: number; failed: number }>;
}

export interface DocKit {
  k: Kit;
  svc: DocumentsService;
  org: OrganisationService;
  presigner: SignedUrlPresigner;
  /** The worker side: in-memory store and controllable scanner (the job code is the real one). */
  store: StoreStub;
  scanner: ScannerStub;
  ocr: OcrStub;
  /** Builds the error an OCR provider throws (the worker's own class). */
  ocrError(retryable: boolean, httpStatus?: number, errorClass?: string): unknown;
  /** The worker's scan-tag adapter over a controllable tag client, for the adapter tests. */
  tagScanner: {
    adapter: { call(req: Record<string, unknown>): Promise<{ data: unknown }> };
    client: { tags: Map<string, string>; outage: boolean };
    caller: (bucket: string, key: string) => Promise<string>;
  };
  setNow(f: (() => Date) | undefined): void;
  alerts: Alerts;
  logs: string[];
  worker: WorkerApi;
  api: KernelDb;
  wdb: KernelDb;
  regs: ParticipantRegistries;
  desk: SeededSession; // front_desk at A1
  records: SeededSession; // medical_records at A1 (documents.read/classify/legal_hold/deletion.decide)
  lead: SeededSession;
  mr2: SeededSession; // medical_records at A2, a second approver for merges
  /** A real patient (registered through the API at A1) and its own patient-realm session. */
  mkPatient(n: number): Promise<{ patientId: string; session: SeededSession }>;
  /** Patient-realm HTTP call. */
  pcall(
    s: SeededSession,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  /** Staff-realm HTTP call. */
  scall(
    s: SeededSession,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  /** Requests an upload as the patient, "uploads" the bytes to the store, completes it; returns the document ID and key. */
  uploadAs(
    s: SeededSession,
    patientId: string,
    bytes: Buffer,
    o?: { contentType?: string; classification?: string; complete?: boolean; put?: boolean },
  ): Promise<{ documentId: string; key: string; ticket: Record<string, unknown> }>;
  /** Drives a document from upload to clean (as the real jobs do) and returns its ID. */
  cleanDocument(s: SeededSession, patientId: string, bytes?: Buffer): Promise<string>;
  /** Cleans, classifies and confirms through the staff routes. */
  confirmedDocument(s: SeededSession, patientId: string): Promise<string>;
  staffScope(role?: string, location?: string): Promise<ScopeSettings>;
  setSetting(key: string, value: unknown): Promise<void>;
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  merge(
    survivorId: string,
    mergedId: string,
    over?: Partial<ExecuteDeps>,
  ): Promise<{ requestId: string; result: ExecuteResult }>;
  close(): Promise<void>;
}

const keyOfUrl = (url: string): { bucket: string; key: string } => {
  const u = new URL(url);
  const [, bucket, ...rest] = u.pathname.split('/');
  return { bucket: bucket as string, key: rest.join('/') };
};
export { keyOfUrl };

export async function setupDocuments(name: string): Promise<DocKit> {
  const holder: { k?: Kit; svc?: DocumentsService } = {};
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const lazySvc = new Proxy({} as DocumentsService, {
    get: (_t, prop) => {
      const v = (holder.svc as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(holder.svc) : v;
    },
  });
  const mreg = new JobRegistry();
  for (const j of MERGE_JOBS) mreg.defineJob(j);
  const merges = new MergeService({ queue: new Queue(mreg, 'api') });
  const org = new OrganisationService();

  const k = await retrySetup(() =>
    setup({
      name,
      fixtures: async (f) => {
        await standardFixtures(f);
      },
      controllers: [
        ...createMergeControllers({ db: lazyDb, merges }),
        ...createDocumentsControllers({ db: lazyDb, documents: lazySvc }),
      ],
      beforeStart: ({ identity }) => {
        for (const [n, fn] of Object.entries({ ...mergeResolvers(), ...documentsResolvers() }))
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
  for (const j of [...MERGE_JOBS, ...DOCUMENTS_JOBS])
    if (!safeHas(k, j.name)) k.registry.defineJob(j);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const presigner = new SignedUrlPresigner(randomBytes(32));
  const svc = new DocumentsService({
    audit: k.audit,
    organisation: org,
    store: presigner,
    queue: new Queue(k.registry, 'api'),
  });
  holder.svc = svc;

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 30 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 8 });
  for (const pool of [apiPool, workerPool]) pool.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const wdb = new KernelDb(workerPool as never);

  // The worker's real jobs, from its build.
  const wdist = (p: string): string => pathToFileURL(`${repoRoot}apps/worker/dist/jobs/${p}`).href;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = any;
  const wdocs: Loose = await import(wdist('documents/index.js'));
  const wstubs: Loose = await import(wdist('documents/stubs.js'));
  const wpatient: Loose = await import(wdist('patient/index.js'));
  const wic: Loose = await import(wdist('integration-core/index.js'));

  const store = new wstubs.InMemoryObjectStore();
  const scanner = new wstubs.StubScanner(store);
  const ocr = new wstubs.StubOcrProvider();
  const alerts: Alerts = { list: [] };
  const logs: string[] = [];
  const log: Logger = createLogger({
    sink: (line: unknown) => void logs.push(typeof line === 'string' ? line : JSON.stringify(line)),
  } as never);
  const wreg = new JobRegistry();
  for (const j of DOCUMENTS_JOBS) wreg.defineJob(j);
  // Stand-ins for the consumers of the events (notifications tells the uploader, operations watch the quarantine): job types of
  // their own, so the publish in the scanning transaction has somewhere to go.
  for (const n of ['sink.on_scan_completed', 'sink.on_quarantined'])
    wreg.defineJob({
      name: n,
      maxAttempts: 3,
      onMerged: 'resolve',
      carriesPatientIds: true,
      jobScope: 'patients',
      jobClass: 'handler',
    });
  wreg.registerHandler('documents.scan_completed', 'sink');
  wreg.registerHandler('documents.quarantined', 'sink');
  const wqueue = new Queue(wreg, 'worker');

  await k.sa.query(
    `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, enabled) VALUES (gen_random_uuid(), $1, 'ocr', 'stub', true)`,
    [ORG],
  );
  const adapters = new wic.AdapterRegistry();
  adapters.register(new wdocs.OcrAdapter(ocr));
  const gateway = new wic.VendorGateway({
    db: wdb,
    orgId: ORG,
    adapters,
    credentials: () => ({ get: () => Promise.resolve('x') }),
    maxAttempts: 1,
    sleep: () => Promise.resolve(),
  });

  let nowFn: (() => Date) | undefined;
  const deps = (): Record<string, unknown> => ({
    db: wdb,
    orgId: ORG,
    queue: wqueue,
    store,
    scan: scanner.scan,
    reencode: wdocs.metadataStrippingReencoder,
    log,
    survivorOf: wpatient.createSurvivorOf(wdb, ORG),
    alert: (a: { kind: string; documentId: string }) =>
      void alerts.list.push({ kind: a.kind, documentId: a.documentId }),
    ...(nowFn === undefined ? {} : { now: nowFn }),
    gateway,
  });
  const worker: WorkerApi = {
    runAwaitScan: (p, o) =>
      wdocs.runAwaitScan(
        { ...deps(), ...(o?.scan === undefined ? {} : { scan: o.scan }) },
        p,
      ) as Promise<string>,
    runOcrSuggest: (p, a = { number: 1, max: 8 }) =>
      wdocs.runOcrSuggest(deps(), p, a) as Promise<string>,
    runRetentionSweep: (o) =>
      wdocs.runRetentionSweep(deps(), o) as Promise<{ removed: number; failed: number }>,
  };

  const regs = new ParticipantRegistries();
  registerIdentityParticipants(regs);
  registerNotificationsParticipants(regs);
  // The merge executor refuses to run unless a participant lists every table with a patient_id. The booking and telehealth tables exist
  // in this database (migrations 0900-1500) but hold no rows here, so their participants are stand-ins that report nothing found: the
  // real ones are scheduling's and telehealth's, and documents may not import them (BD-02: they are above documents). The list is the
  // tables of the combined revision (INT02-F03): the flow tables of BE-13 and the telehealth tables of BE-15 joined the database after
  // this suite was first written, and the executor refuses the merge before anything is written while one has no participant.
  const standIn = (module: string, tables: readonly string[]): MergeParticipant => ({
    module,
    tables,
    conflictRules: [],
    repointPatient: () =>
      Promise.resolve(
        tables.map((table) => ({
          table,
          found: 0,
          repointed: 0,
          resolved: 0,
          kept: 0,
          deleted: [],
        })),
      ),
  });
  regs.registerMergeParticipant(
    standIn('scheduling', [
      'scheduling.slot_reservation',
      'scheduling.check_in',
      'scheduling.queue_entry',
      'scheduling.waitlist_entry',
      'scheduling.waitlist_offer',
    ]),
  );
  regs.registerMergeParticipant(
    standIn('telehealth', [
      'telehealth.video_session',
      'telehealth.participant',
      'telehealth.join_token',
      'telehealth.location_confirmation',
    ]),
  );
  registerDocumentsParticipants(regs);

  const lead = await (async () => {
    const p = await seedPrincipal(k, 'google', {
      name: 'Lead AB',
      email: `lead.ab.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'front_desk_lead', A1);
    return seedSession(k, p, 'google');
  })();
  const desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
  const records = await staffMember(k, 'medical_records', A1, 'Records A1');
  const mr2 = await staffMember(k, 'medical_records', A2, 'Records A2');

  let seq = 0;
  const pcall: DocKit['pcall'] = (s, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: PATIENT_HOST,
      cookie: s.cookie,
      headers:
        method === 'GET' ? extra : { ...writeHeaders(s, PATIENT_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });
  const scall: DocKit['scall'] = (s, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: STAFF_HOST,
      cookie: s.cookie,
      headers:
        method === 'GET' ? extra : { ...writeHeaders(s, STAFF_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });

  const kit: DocKit = {
    k,
    svc,
    org,
    presigner,
    store,
    scanner,
    ocr,
    ocrError: (retryable, httpStatus, errorClass) =>
      new wdocs.OcrProviderError(retryable, httpStatus, errorClass),
    tagScanner: (() => {
      const client = new wstubs.StubTagClient();
      const adapter = new wdocs.TagScannerAdapter(client);
      const caller = wdocs.scannerCaller(
        adapter,
        { id: randomUUID(), kind: 'malware_scan', vendor: 'stub', settings: {} },
        { get: () => Promise.resolve('x') },
        () => randomUUID(),
      );
      return { adapter, client, caller };
    })(),
    setNow: (f) => {
      nowFn = f;
    },
    alerts,
    logs,
    worker,
    api,
    wdb,
    regs,
    desk,
    records,
    lead,
    mr2,
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
    async uploadAs(s, patientId, bytes, o = {}) {
      const contentType = o.contentType ?? 'application/pdf';
      const r = await pcall(s, 'POST', `/api/v1/patients/${patientId}/document-uploads`, {
        contentType,
        sizeBytes: bytes.length,
        ...(o.classification === undefined ? {} : { classification: o.classification }),
      });
      if (r.status !== 201) throw new Error(`upload failed ${r.status} ${r.body}`);
      const ticket = r.json();
      const { key } = keyOfUrl(String(ticket['uploadUrl']));
      if (o.put !== false) store.upload(key, bytes, contentType);
      if (o.complete !== false) {
        const c = await pcall(
          s,
          'POST',
          `/api/v1/document-uploads/${ticket['documentId']}/complete`,
          {},
        );
        if (c.status !== 202) throw new Error(`complete failed ${c.status} ${c.body}`);
      }
      return { documentId: String(ticket['documentId']), key, ticket };
    },
    async cleanDocument(s, patientId, bytes = PDF) {
      const u = await kit.uploadAs(s, patientId, bytes);
      scanner.release(u.key);
      const out = await worker.runAwaitScan({ documentId: u.documentId, version: 1, patientId });
      if (out !== 'clean') throw new Error(`scan ended ${out}`);
      return u.documentId;
    },
    async confirmedDocument(s, patientId) {
      const documentId = await kit.cleanDocument(s, patientId);
      const version = Number(
        (
          await k.q<{ row_version: string }>(
            `SELECT row_version FROM documents.document WHERE id = $1`,
            [documentId],
          )
        )[0]?.row_version,
      );
      const c = await scall(
        records,
        'POST',
        `/api/v1/documents/${documentId}/confirm`,
        {},
        { 'if-match': `W/"${version}"` },
      );
      if (c.status !== 200) throw new Error(`confirm failed ${c.status} ${c.body}`);
      return documentId;
    },
    async staffScope(role = 'front_desk', location = A1) {
      const p = await seedPrincipal(k, 'google', { name: 'Staff scope' });
      await assignRole(k, p.principalId, role, location);
      return {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: p.principalId,
        personId: p.personId,
        locationIds: [location],
      };
    },
    async setSetting(key, value) {
      await k.sa.query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, $2, $3::jsonb, 'int>=1')
         ON CONFLICT ON CONSTRAINT setting_org_key_location_uq DO UPDATE SET value = EXCLUDED.value`,
        [ORG, key, JSON.stringify(value)],
      );
    },
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
        {
          db: wdb,
          orgId: ORG,
          registries: regs,
          // The staff-alert tables (BE-07) carry a patient_id and their participant is to be added to the notifications participant at
          // integration (notifications/alerts/merge.ts, "must call these functions"); it is not yet on the combined revision. Listed
          // here, as the scheduling flow suite does, so this suite's merges are about documents. Not a claim about alerts.
          notParticipants: {
            ...NOT_PARTICIPANT_TABLES,
            'notifications.staff_alert': 'BE-07 participant is wired at integration',
            'notifications.staff_alert_event': 'BE-07 participant is wired at integration',
          },
          ...over,
        },
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
