// End to end: an approved patient merge EXECUTES (INT03-F13, decision HEAAA-354 rev 2, D-F13-5, acceptance tests 8 and 9). The API as
// `buildComposition` + `createApp` build it, the worker as `composeWorker` builds it with the API ports (the production task table),
// one real PostgreSQL 17 database, the real queue. Needs the API built (apps/api/dist), as compose.dbtest.ts does.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/merge-e2e.dbtest.js
// Missing configuration FAILS; nothing skips. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createLogger, KernelDb, loadConfig, syncTaskTypes } from '@ehr/kernel';
import type { Logger, ParticipantRegistries } from '@ehr/kernel';
import { composeWorker } from './compose.js';
import { buildWorkerRegistry } from './job-registry.js';
import type { ApiPorts } from './compose.js';
import { closureOf } from './jobs/privacy/index.js';
import { createPool, startWorker } from './runner.js';
import type { PoolLike, TaskTable, WorkerHandle } from './runner.js';

// The API's built modules (the worker does not depend on the API package at build time).
const api = async <T>(file: string): Promise<T> =>
  (await import(
    pathToFileURL(new URL(`../../api/dist/src/${file}`, import.meta.url).pathname).href
  )) as T;
/* eslint-disable @typescript-eslint/no-explicit-any */
const tk: any = await api('modules/patient/testkit.js');
const comp: any = await api('composition.js');
const idenv: any = await api('identity-env.js');
const appmod: any = await api('platform/app.js');
const reg: any = await api('register-participants.js');
const mergeMod: any = await api('modules/patient/merge/index.js');
/* eslint-enable @typescript-eslint/no-explicit-any */

const K = 'k'.repeat(40);
const A1: string = tk.id(101);
const A2: string = tk.id(102);
const ENV = {
  EHR_ORGANISATION_ID: tk.ORG,
  EHR_STAFF_HOST: tk.STAFF_HOST,
  EHR_PATIENT_HOST: tk.PATIENT_HOST,
  EHR_ALLOWED_ORIGINS: `https://${tk.STAFF_HOST},https://${tk.PATIENT_HOST}`,
  EHR_OIDC_STATE_KEY: K,
  EHR_CSRF_KEY: tk.CSRF_KEY,
  EHR_RATE_KEY: K,
  EHR_MATCH_CHECK_KEY: tk.MATCH_KEY,
  EHR_CHECKIN_QR_KEY: K,
  EHR_STAFF_OIDC_CLIENT_ID: 'staff',
  EHR_STAFF_OIDC_CLIENT_SECRET: K,
  EHR_STAFF_OIDC_REDIRECT_URI: `https://${tk.STAFF_HOST}/api/v1/auth/callback`,
  EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
  EHR_PATIENT_OIDC_ISSUER: 'https://idp.example.test',
  EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.test/authorize',
  EHR_PATIENT_OIDC_TOKEN_ENDPOINT: 'https://idp.example.test/token',
  EHR_PATIENT_OIDC_JWKS_URI: 'https://idp.example.test/jwks',
  EHR_PATIENT_OIDC_CLIENT_ID: 'patient',
  EHR_PATIENT_OIDC_REDIRECT_URI: `https://${tk.PATIENT_HOST}/api/v1/auth/callback`,
};

type Kit = {
  q<T = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<T[]>;
  urlFor(user: string): string;
  close(): Promise<void>;
  base: string;
};
type Sess = { cookie: string; csrf: string; seeded: { principalId: string } };

let k: Kit;
let base: string;
let closeApp: () => Promise<void>;
let pool: PoolLike;
let ports: ApiPorts & { registries: ParticipantRegistries };
let cfg: ReturnType<typeof loadConfig>;
let log: Logger;
let desk: Sess;
let lead: Sess;
let approver: Sess;
let seq = 200;

const sleep = (ms: number): Promise<void> => new Promise((r) => globalThis.setTimeout(r, ms));
const send = (s: Sess, method: string, path: string, body?: unknown) =>
  tk.call(base, method, path, {
    cookie: s.cookie,
    headers: method === 'GET' ? {} : tk.writeHeaders(s, undefined, randomUUID()),
    ...(body === undefined ? {} : { body }),
  }) as Promise<{ status: number; body: string; json(): Record<string, unknown> }>;
const person = (n: number) => ({
  givenName: `Merge${n}`,
  familyName: `Famm${n}`,
  dateOfBirth: `19${60 + (n % 30)}-0${1 + (n % 9)}-1${n % 9}`,
  phone: `+1212666${String(1000 + n)}`,
  email: `merge${n}@example.test`,
});
const mkPatient = (): Promise<string> =>
  tk.registerViaApi({ ...k, base }, desk, A1, person(++seq)) as Promise<string>;
const requestRow = async (id: string) =>
  (
    await k.q<{ status: string; failure_code: string | null }>(
      `SELECT status, failure_code FROM patient.merge_request WHERE id = $1`,
      [id],
    )
  )[0] as { status: string; failure_code: string | null };

/** Two patients of one location, an appointment on the merged one (a row of the scheduling module), requested and approved over HTTP. */
async function approvedMerge(): Promise<{
  requestId: string;
  survivor: string;
  merged: string;
  appointment: string;
}> {
  const survivor = await mkPatient();
  const merged = await mkPatient();
  const appointment = (await tk.confirmedBooking({ ...k, base }, merged, A1)) as string;
  const r = await send(lead, 'POST', '/api/v1/patient-merges', {
    survivorId: survivor,
    mergedId: merged,
    reason: 'Same person registered twice',
  });
  assert.equal(r.status, 200, r.body);
  const requestId = r.json()['id'] as string;
  // Staff A approving their own request is refused.
  const self = await send(lead, 'POST', `/api/v1/patient-merges/${requestId}/approve`);
  assert.equal(self.status, 403, self.body);
  assert.equal(self.json()['code'], 'patient.merge_self_approval');
  const a = await send(approver, 'POST', `/api/v1/patient-merges/${requestId}/approve`);
  assert.equal(a.status, 200, a.body);
  const queued = await k.q<{ n: string }>(
    `SELECT count(*) AS n FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = 'patient.execute_merge' AND j.payload->>'mergeRequestId' = $1`,
    [requestId],
  );
  assert.equal(Number(queued[0]?.n), 1, 'the patient.execute_merge job is enqueued');
  return { requestId, survivor, merged, appointment };
}

/** A worker as main.ts builds it, on its own pool (`stop()` ends the pool), run until `done` holds or the time is up. */
async function runWorkerUntil(
  withoutTask: string | undefined,
  done: () => Promise<boolean>,
  ms = 60_000,
): Promise<boolean> {
  const p = await createPool(cfg);
  const composed = await composeWorker({
    cfg,
    pool: p,
    log,
    patientHost: tk.PATIENT_HOST,
    qrKey: K,
  });
  const table: TaskTable = { ...composed.tasks };
  if (withoutTask !== undefined) delete table[withoutTask];
  const w: WorkerHandle = await startWorker({
    cfg,
    pool: p,
    log,
    tasks: table,
    registry: composed.registry,
    concurrency: 2,
  });
  try {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await sleep(300);
    }
    return false;
  } finally {
    await w.stop();
  }
}

before(async () => {
  assert.ok(tk.adminUrl, 'EHR_TEST_ADMIN_URL must name a throwaway PostgreSQL 17 server');
  k = (await tk.setup({ name: 'f13m', fixtures: tk.standardFixtures })) as Kit;
  cfg = loadConfig({
    EHR_ENV: 'ci',
    EHR_DEPLOYABLE: 'worker',
    EHR_DATABASE_URL: k.urlFor('app_worker'),
    EHR_ORGANISATION_ID: tk.ORG,
  });
  log = createLogger({ sink: () => undefined });
  pool = await createPool(cfg);
  // The API-side sync the worker does at start (F01-R2): queue_api.enqueue accepts only the types the worker registry holds.
  await syncTaskTypes(pool as never, buildWorkerRegistry());
  ports = (await (async () => {
    const m = await api<{
      buildWorkerPorts(d: unknown): ApiPorts & { registries: ParticipantRegistries };
    }>('worker-ports.js');
    const wreg = buildWorkerRegistry();
    const { Queue } = await import('@ehr/kernel');
    return m.buildWorkerPorts({
      logger: log,
      queue: new Queue(wreg, 'worker'),
      registry: wreg,
      patientHost: tk.PATIENT_HOST,
      qrKey: Buffer.from(K, 'utf8'),
      orgId: tk.ORG,
      db: new KernelDb(pool as never),
      packageWriter: {},
      closureOf,
    });
  })()) as typeof ports;

  const c = comp.buildComposition({
    db: (k as unknown as { db: unknown }).db,
    logger: createLogger({ sink: () => undefined }),
    identity: idenv.loadIdentityEnv(ENV),
    now: tk.now,
  });
  const app = await appmod.createApp({
    config: {
      minClientRelease: tk.MIN_RELEASE,
      instanceCount: 1,
      integrationsHost: undefined,
      port: 0,
      requestTimeoutMs: 15_000,
    },
    logger: createLogger({ sink: () => undefined }),
    readiness: { missingRelations: () => Promise.resolve([]) },
    policy: c.policy,
    limiter: { hit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 1 }) },
    controllers: c.controllers,
  });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  closeApp = () => app.close();

  desk = await tk.staffMember(k, 'front_desk', A1, 'Desk A1');
  lead = await tk.staffMember(
    k,
    'medical_records',
    A1,
    'Records A1 (requester, holds request and approve)',
  );
  approver = await tk.staffMember(k, 'medical_records', A2, 'Records A2');
});
after(async () => {
  await closeApp?.();
  await (pool as unknown as { end?: () => Promise<void> })?.end?.();
  await k?.close();
});

describe('INT03-F13 / D-F13-5: the approved merge executes in the composed worker', () => {
  test('9: the registries the worker receives hold every merge participant and export contributor of the single registration site', () => {
    const names = (xs: readonly { module: string }[]): string[] => xs.map((x) => x.module).sort();
    assert.deepEqual(
      names(ports.registries.mergeParticipants()),
      [...reg.REGISTERED_MERGE_MODULES].sort(),
    );
    assert.deepEqual(
      names(ports.registries.exportContributors()),
      [...reg.REGISTERED_EXPORT_MODULES].sort(),
    );
    assert.equal(typeof ports.executeMerge, 'function');
  });

  test('8 negative control (a): a worker task table without patient.execute_merge leaves the request approved, never completed', async () => {
    const m = await approvedMerge();
    const completed = await runWorkerUntil(
      'patient.execute_merge',
      async () => (await requestRow(m.requestId)).status === 'completed',
      4_000,
    );
    assert.equal(completed, false);
    assert.equal((await requestRow(m.requestId)).status, 'approved');
  });

  test('8 negative control (b): registries without the documents participant end the request failed with patient.merge_participant_missing', async () => {
    const m = await approvedMerge();
    const res = await mergeMod.executeMerge(
      {
        db: new KernelDb(pool as never),
        orgId: tk.ORG,
        registries: reg.newRegisteredRegistries({ without: ['documents'] }),
      },
      { requestId: m.requestId, jobId: `nc:${m.requestId}`, attempt: 1, maxAttempts: 1 },
    );
    assert.equal(res.status, 'failed');
    const row = await requestRow(m.requestId);
    assert.equal(row.status, 'failed');
    assert.equal(row.failure_code, 'patient.merge_participant_missing');
  });

  test('8: request, second-approver approval and the production worker run the merge: completed, merged patient resolves to the survivor, appointment re-pointed', async () => {
    const m = await approvedMerge();
    const done = await runWorkerUntil(
      undefined,
      async () => (await requestRow(m.requestId)).status === 'completed',
    );
    assert.ok(done, `not completed: ${JSON.stringify(await requestRow(m.requestId))}`);
    const view = await send(approver, 'GET', `/api/v1/patient-merges/${m.requestId}`);
    assert.equal(view.status, 200, view.body);
    assert.equal(view.json()['status'], 'completed');
    const p = (
      await k.q<{ status: string; merged_into: string | null }>(
        `SELECT status, merged_into FROM patient.patient WHERE id = $1`,
        [m.merged],
      )
    )[0];
    assert.equal(p?.status, 'merged');
    assert.equal(p?.merged_into, m.survivor);
    const appt = (
      await k.q<{ patient_id: string }>(
        `SELECT patient_id FROM scheduling.slot_reservation WHERE id = $1`,
        [m.appointment],
      )
    )[0];
    assert.equal(appt?.patient_id, m.survivor, 'the other module rows are on the survivor');
    const merged = await k.q<{ n: string }>(
      `SELECT count(*) AS n FROM audit.event WHERE action = 'merge' AND change->>'mergedId' = $1`,
      [m.merged],
    );
    assert.ok(
      Number(merged[0]?.n) >= 1,
      'the merge is audited (patient.merged is published in the same transaction)',
    );
  });
});
