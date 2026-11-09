// Shared harness of the identity real-database tests (BE-04): a throwaway database migrated by the real pipeline, the queue
// library installed, the reference data applied by the real worker job, the real Nest application with the identity guard
// and controllers, and the local OIDC IdP. Not a test file; it is imported by the *.dbtest.ts files.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Controller, Get, Post } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { createLogger, JobRegistry, KernelDb, Queue, syncTaskTypes } from '@ehr/kernel';
import type { Tx } from '@ehr/kernel';
import { createApp } from '../../platform/app.js';
import type { Req } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import { AuditService } from '../audit/index.js';
import { createIdentity } from './runtime.js';
import type { Identity } from './runtime.js';
import { LocalIdp } from './idp.fixture.js';
import type { Login } from './idp.fixture.js';
import { GoogleRealmAdapter, OidcPatientAdapter } from './realms.js';
import { IDENTITY_JOBS } from './jobs.js';
import { uuidv7 } from './ids.js';
import { issueToken, SID_COOKIE } from './tokens.js';
import { csrfTokenFor } from './auth.controller.js';
import type { ResolvedResource } from './guard-policy.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pg: any = (await import(PG)).default;

export const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
export const repoRoot = root;

export const ORG = '00000000-0000-7000-8000-0000000000a1';
export const STAFF_HOST = 'staff.example.test';
export const PATIENT_HOST = 'my.example.test';
export const MIN_RELEASE = 141;
export const RELEASE = `r${MIN_RELEASE}.3f9a1c2b7d10`;
export const CSRF_KEY = 'csrf-key-for-tests-0123456789abcdef';
export const OIDC_KEY = 'oidc-state-key-for-tests-0123456789ab';
export const RATE_KEY = 'rate-key-for-tests-0123456789abcdef';
export const WORKSPACE = 'example.com';
export const id = (n: number): string =>
  `00000000-0000-7000-8000-00000000${String(n).padStart(4, '0')}`;

export type Client = {
  query(
    s: string,
    p?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect(): Promise<void>;
  end(): Promise<void>;
};

/** Patients the fake `patient.staff_sees` lets staff reach (the patient module's staff_scope does not exist yet, BE-08). */
export const staffVisible = new Set<string>();
export const clock = { t: Date.now() };
export const now = (): Date => new Date(clock.t);

export interface Kit {
  dbName: string;
  urlFor(user: string, database?: string): string;
  sa: Client;
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  db: KernelDb;
  wdb: KernelDb;
  idp: LocalIdp;
  identity: Identity;
  audit: AuditService;
  registry: JobRegistry;
  worker: Record<string, (...a: never[]) => unknown>;
  base: string;
  close(): Promise<void>;
}

export interface KitOptions {
  name: string;
  controllers?: readonly Type<unknown>[];
  /** Extra setup after migrations and the reference data, with the superuser client. */
  fixtures?: (k: { sa: Client; q: Kit['q'] }) => Promise<void>;
  withApp?: boolean;
}

export async function setup(opts: KitOptions): Promise<Kit> {
  const dbName = `ehr_be04_${opts.name}_${process.pid}_${Date.now()}`;
  const urlFor = (user: string, database = dbName): string => {
    const u = new URL(adminUrl as string);
    u.username = user;
    u.password = '';
    u.pathname = `/${database}`;
    return u.toString();
  };
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const env = {
    PATH: process.env['PATH'],
    EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl as string).username),
    EHR_DB_MIGRATE_URL: urlFor('app_owner'),
  };
  for (const cmd of ['bootstrap', 'migrate'])
    execFileSync(process.execPath, [`${repoRoot}db/tools/migrate.mjs`, cmd], {
      env,
      stdio: 'ignore',
    });
  const installPath = pathToFileURL(`${repoRoot}packages/kernel/dist/queue/install.js`).href;
  await ((await import(installPath)) as { installQueue(u: string): Promise<void> }).installQueue(
    urlFor('app_owner'),
  );

  const sa: Client = new pg.Client({
    connectionString: urlFor(new URL(adminUrl as string).username),
  });
  await sa.connect();
  const q: Kit['q'] = <T>(sql: string, params?: unknown[]) =>
    sa.query(sql, params).then((r) => r.rows as T[]);
  const apiPool = new pg.Pool({ connectionString: urlFor('app_api'), max: 8 });
  apiPool.on('error', () => undefined); // DROP DATABASE ... FORCE at teardown ends idle clients (57P01)
  const workerPool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 4 });
  workerPool.on('error', () => undefined); // DROP DATABASE ... FORCE at teardown ends idle clients (57P01)
  const db = new KernelDb(apiPool as never);
  const wdb = new KernelDb(workerPool as never);

  const registry = new JobRegistry();
  for (const j of IDENTITY_JOBS) registry.defineJob(j);
  const wc = new pg.Client({ connectionString: urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, registry);
  await wc.end();

  const workerDist = pathToFileURL(`${repoRoot}apps/worker/dist/jobs/identity/index.js`).href;
  const worker = (await import(workerDist)) as Kit['worker'];
  await (
    worker['runApplyReferenceData'] as unknown as (d: {
      db: KernelDb;
      orgId: string;
    }) => Promise<unknown>
  )({ db: wdb, orgId: ORG });

  const idp = new LocalIdp();
  await idp.start();
  const audit = new AuditService({ queue: new Queue(registry, 'api') });
  const redirectUri = `https://${STAFF_HOST}/api/v1/auth/callback`;
  const identity = createIdentity({
    db,
    queue: new Queue(registry, 'api'),
    audit,
    logger: createLogger({ sink: () => undefined }),
    config: {
      orgId: ORG,
      hosts: { [STAFF_HOST]: 'google', [PATIENT_HOST]: 'patient_pool' },
      allowedOrigins: [`https://${STAFF_HOST}`, `https://${PATIENT_HOST}`],
      oidcStateKeys: { current: OIDC_KEY },
      csrfKey: CSRF_KEY,
      rateKey: RATE_KEY,
    },
    realms: {
      google: new GoogleRealmAdapter({
        endpoints: idp.endpoints,
        clientId: idp.clientId,
        clientSecret: 'x'.repeat(24),
        redirectUri,
        workspaceDomain: WORKSPACE,
      }),
      patient_pool: new OidcPatientAdapter({
        endpoints: idp.endpoints,
        clientId: idp.clientId,
        redirectUri: `https://${PATIENT_HOST}/api/v1/auth/callback`,
      }),
    },
    patientInScope: (_tx, _ctx, patientId) => Promise.resolve(staffVisible.has(patientId)),
    now,
  });

  if (opts.fixtures) await opts.fixtures({ sa, q });

  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let base = '';
  if (opts.withApp !== false) {
    app = await createApp({
      config: {
        minClientRelease: MIN_RELEASE,
        instanceCount: 1,
        integrationsHost: undefined,
        port: 0,
        requestTimeoutMs: 15_000,
      },
      logger: createLogger({ sink: () => undefined }),
      readiness: { missingRelations: () => Promise.resolve([]) },
      policy: identity.policy,
      controllers: [...identity.controllers, ...(opts.controllers ?? [])],
    });
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  }
  return {
    dbName,
    urlFor,
    sa,
    q,
    db,
    wdb,
    idp,
    identity,
    audit,
    registry,
    worker,
    base,
    async close() {
      await app?.close();
      await idp.stop();
      await sa.end();
      await apiPool.end();
      await workerPool.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
    },
  };
}

// --- HTTP -------------------------------------------------------------------------------------------------------------
export interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): Record<string, unknown>;
  setCookies: string[];
}

export function call(
  base: string,
  method: string,
  path: string,
  o: {
    host?: string;
    cookie?: string;
    headers?: Record<string, string>;
    body?: unknown;
    release?: boolean;
  } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const headers: Record<string, string> = {
      host: o.host ?? STAFF_HOST,
      ...(o.release === false ? {} : { 'x-client-release': RELEASE }),
      ...(o.cookie === undefined ? {} : { cookie: o.cookie }),
      ...o.headers,
    };
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const r = request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: b,
          json: () => JSON.parse(b) as Record<string, unknown>,
          setCookies: ([] as string[]).concat(res.headers['set-cookie'] ?? []),
        }),
      );
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

/** Queued jobs of one task type (the library keeps payloads in `_private_jobs`). */
export async function queuedJobs(
  k: Kit,
  task: string,
  where = 'true',
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const rows = await k.q<{ payload: Record<string, unknown> }>(
    `SELECT j.payload FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1 AND (${where}) ORDER BY j.id`,
    [task, ...params],
  );
  return rows.map((r) => r.payload);
}

export const cookieValue = (setCookies: string[], name: string): string | undefined => {
  for (const c of setCookies)
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1).split(';')[0];
  return undefined;
};

let ipCounter = 0;
/** The browser's part of a sign-in: /auth/sign-in, the IdP, the callback. Returns the callback response. */
export async function browserSignIn(
  k: Kit,
  host: string,
  login: Login,
  o: { sid?: string; ip?: string; path?: string; returnTo?: string } = {},
): Promise<Resp & { sid: string | undefined }> {
  // Every sign-in comes from its own address unless a test says otherwise, so the per-address limit never couples tests.
  const ip = o.ip ?? `198.18.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  k.idp.nextLogin = login;
  const start = await call(
    k.base,
    'GET',
    `${o.path ?? '/api/v1/auth/sign-in'}?returnTo=${encodeURIComponent(o.returnTo ?? '/x')}`,
    { host },
  );
  if (start.status !== 302) throw new Error(`sign-in start answered ${start.status}`);
  const oidc = cookieValue(start.setCookies, '__Host-oidc');
  const r = await fetch(String(start.headers['location']), { redirect: 'manual' });
  const back = new URL(r.headers.get('location') ?? '');
  const cookie = [
    `__Host-oidc=${oidc}`,
    ...(o.sid === undefined ? [] : [`${SID_COOKIE}=${o.sid}`]),
  ].join('; ');
  const cb = await call(k.base, 'GET', `${back.pathname}${back.search}`, {
    host,
    cookie,
    headers: { 'x-forwarded-for': ip },
    release: false,
  });
  return Object.assign(cb, { sid: cookieValue(cb.setCookies, SID_COOKIE) });
}

// --- Fixtures ---------------------------------------------------------------------------------------------------------
export interface Seeded {
  personId: string;
  principalId: string;
}

export async function seedPrincipal(
  k: GrantKit,
  realm: 'google' | 'patient_pool' | 'admin_pool',
  o: {
    subject?: string | null;
    email?: string;
    status?: string;
    name?: string;
    preregisteredAt?: Date;
    createdBy?: string;
  } = {},
): Promise<Seeded> {
  const personId = uuidv7();
  const principalId = uuidv7();
  const subject = o.subject === undefined ? `sub-${principalId}` : o.subject;
  await k.sa.query('BEGIN');
  try {
    await k.sa.query(
      `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, $3)`,
      [personId, ORG, o.name ?? 'Test Person'],
    );
    await k.sa.query(
      `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status, preregistered_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        principalId,
        ORG,
        personId,
        realm,
        subject,
        o.email ?? null,
        o.status ?? 'active',
        o.preregisteredAt ?? null,
        o.createdBy ?? null,
      ],
    );
    await k.sa.query('COMMIT');
  } catch (e) {
    await k.sa.query('ROLLBACK');
    throw e;
  }
  return { personId, principalId };
}

/**
 * Two admin-realm principals that stand in for "the requester and the approver" of the role-change request every
 * assignment now cites (BE-05 added the foreign key `role_assignment.granted_via_request_id`, ARCHITECTURE 22.4).
 */
/** What the role helpers need of a kit: the database name and the superuser client (the patient kit has both). */
export interface GrantKit {
  dbName: string;
  sa: Kit['sa'];
}
const grantors = new Map<string, { requester: string; approver: string }>();
async function grantorsOf(k: GrantKit): Promise<{ requester: string; approver: string }> {
  const have = grantors.get(k.dbName);
  if (have !== undefined) return have;
  const requester = (await seedPrincipal(k, 'admin_pool', { subject: 'fixture-requester' }))
    .personId;
  const approver = (await seedPrincipal(k, 'admin_pool', { subject: 'fixture-approver' })).personId;
  const g = { requester, approver };
  grantors.set(k.dbName, g);
  return g;
}

export async function assignRole(
  k: GrantKit,
  principalId: string,
  roleKey: string,
  locationId?: string,
): Promise<void> {
  const g = await grantorsOf(k);
  const requestId = randomUUID();
  await k.sa.query('BEGIN');
  try {
    // The request goes through its real states; the triggers read the acting person from the session setting.
    await k.sa.query(`SELECT set_config('app.person_id', $1, true)`, [g.requester]);
    await k.sa.query(
      `INSERT INTO identity.role_change_request (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, '{"add":[],"remove":[]}'::jsonb, '[]'::jsonb, decode(repeat('ab', 32), 'hex'), 'requested', now() + interval '1 day')`,
      [requestId, ORG, g.requester, principalId],
    );
    await k.sa.query(`SELECT set_config('app.person_id', $1, true)`, [g.approver]);
    await k.sa.query(
      `UPDATE identity.role_change_request SET status = 'approved', approver_person_id = $2, decided_at = now() WHERE id = $1`,
      [requestId, g.approver],
    );
    await k.sa.query(
      `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id)
       SELECT $1, $2, $3, r.id, $4, $5 FROM identity.role r WHERE r.organisation_id = $2 AND r.key = $6`,
      [uuidv7(), ORG, principalId, locationId ?? null, requestId, roleKey],
    );
    await k.sa.query(`UPDATE identity.role_change_request SET status = 'applied' WHERE id = $1`, [
      requestId,
    ]);
    await k.sa.query('COMMIT');
  } catch (e) {
    await k.sa.query('ROLLBACK');
    throw e;
  }
}

export interface SeededSession {
  token: string;
  cookie: string;
  sessionId: string;
  csrf: string;
}

/** A session row inserted directly (superuser), for the guard tests that do not go through the IdP. */
export async function seedSession(
  k: Kit,
  s: Seeded,
  realm: 'google' | 'patient_pool' | 'admin_pool',
  o: { idleMin?: number; absoluteHours?: number } = {},
): Promise<SeededSession> {
  const t = issueToken();
  const sessionId = uuidv7();
  const csrf = csrfTokenFor(CSRF_KEY, sessionId);
  const { createHash } = await import('node:crypto');
  const start = now();
  await k.sa.query(
    `INSERT INTO identity.session (id, organisation_id, token_hash, principal_id, person_id, realm, audience, auth_time, csrf_hash, idle_expires_at, absolute_expires_at, last_interaction_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$8)`,
    [
      sessionId,
      ORG,
      t.hash,
      s.principalId,
      s.personId,
      realm,
      realm === 'patient_pool' ? 'patient' : 'staff',
      start,
      createHash('sha256').update(csrf).digest(),
      new Date(
        Math.min(
          start.getTime() + (o.idleMin ?? 15) * 60_000,
          start.getTime() + (o.absoluteHours ?? 12) * 3_600_000,
        ),
      ),
      new Date(start.getTime() + (o.absoluteHours ?? 12) * 3_600_000),
    ],
  );
  return { token: t.token, cookie: `${SID_COOKIE}=${t.token}`, sessionId, csrf };
}

export const writeHeaders = (s: SeededSession, host = STAFF_HOST): Record<string, string> => ({
  origin: `https://${host}`,
  'x-csrf-token': s.csrf,
});

// --- A controller of declared routes for the guard tests -----------------------------------------------------------------
export const PATIENT_NOT_FOUND = id(9999);

@Controller()
export class ProbeController {
  @Get('api/v1/t/patients/:id')
  @Route({ permission: 'patient.read', resolver: 'probe' })
  patient(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/t/chart/:id')
  @Route({ permission: 'clinical.chart.read', resolver: 'probe' })
  chart(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/t/none')
  @Route({ permission: 'patient.read', resolver: 'none' })
  none(): { ok: true } {
    return { ok: true };
  }
  @Post('api/v1/t/write')
  @Route({ permission: 'patient.update', resolver: 'none' })
  write(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/t/unregistered')
  @Route({ permission: 'patient.read', resolver: 'nobody-registered-this' })
  unregistered(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/admin/t/thing')
  @Route({ permission: 'identity.principal.read', resolver: 'none' })
  adminThing(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/admin/t/elevated')
  @Route({ permission: 'identity.principal.kill', resolver: 'none' })
  elevated(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/t/staff-only-on-patient-host')
  @Route({ permission: 'patient', resolver: 'none' })
  mine(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/t/patient-record/:id')
  @Route({ permission: 'patient', resolver: 'probe' })
  patientRecord(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/t/appointments/:id')
  @Route({ permission: 'proxy', resolver: 'probe' })
  appointments(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/alerts/stream')
  @Route({ permission: 'notifications.alert.read', resolver: 'none', routeClass: 'stream' })
  stream(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/alerts/open-ids')
  @Route({ permission: 'notifications.alert.read', resolver: 'none' })
  openIds(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/alerts')
  @Route({ permission: 'notifications.alert.read', resolver: 'none' })
  alerts(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/appointments/:id/video-session')
  @Route({ permission: 'proxy', resolver: 'none' })
  video(): { ok: true } {
    return { ok: true };
  }
}

/** Registers the `probe` resolver: the id in the path is the patient; `?loc=` names the location; one id does not exist. */
export function registerProbeResolver(k: Kit): void {
  k.identity.policy.registerResolver('probe', (req: Req): Promise<ResolvedResource | undefined> => {
    const patientId = /\/([0-9a-f-]{36})$/.exec(req.path)?.[1];
    if (patientId === undefined || patientId === PATIENT_NOT_FOUND)
      return Promise.resolve(undefined);
    const loc = typeof req.query['loc'] === 'string' ? req.query['loc'] : undefined;
    return Promise.resolve({ patientId, ...(loc === undefined ? {} : { locationId: loc }) });
  });
}

export const asTx = async <T>(
  k: Kit,
  scope: Parameters<KernelDb['withScope']>[0],
  fn: (tx: Tx) => Promise<T>,
): Promise<T> => k.db.withScope(scope, fn);
