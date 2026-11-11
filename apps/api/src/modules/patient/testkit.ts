// Shared harness of the patient real-database tests (BE-08): a throwaway database migrated by the real pipeline, the queue library
// installed, the identity reference data applied by the real worker job, the real Nest application with the identity guard, the
// identity and patient controllers, and seeded sessions (the sign-in itself is BE-04's and is tested there). Not a test file; it
// is imported by the *.dbtest.ts files. Synthetic data only.
import { FIXTURE_STATES } from '../../platform/fixture-states.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Controller, Get } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { createLogger, JobRegistry, KernelDb, Queue, syncTaskTypes } from '@ehr/kernel';
import { createApp } from '../../platform/app.js';
import { MemoryRateLimiter } from '../../platform/rate-limit.js';
import { Route } from '../../platform/route.js';
import { AuditService } from '../audit/index.js';
import {
  IDENTITY_JOBS,
  GoogleRealmAdapter,
  OidcPatientAdapter,
  csrfTokenFor,
  createIdentity,
} from '../identity/index.js';
import type { Identity } from '../identity/index.js';
import { createPatient } from './runtime.js';
import type { Patient } from './runtime.js';
import { PATIENT_JOBS } from './jobs.js';
import { patientInScope } from './scope.js';
import { uuidv7 } from './ids.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pg: any = (await import(PG)).default;

export const adminUrl = process.env['EHR_TEST_ADMIN_URL'];
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
export const repoRoot = root;

export const ORG = '00000000-0000-7000-8000-0000000000a1';
export const ORG2 = '00000000-0000-7000-8000-0000000000a2';
export const STAFF_HOST = 'staff.example.test';
export const PATIENT_HOST = 'my.example.test';
export const MIN_RELEASE = 141;
export const RELEASE = `r${MIN_RELEASE}.3f9a1c2b7d10`;
export const CSRF_KEY = 'csrf-key-for-tests-0123456789abcdef';
export const MATCH_KEY = 'match-check-key-for-tests-0123456789';
export const SID_COOKIE = '__Host-sid';
export const id = (n: number): string =>
  `00000000-0000-7000-8000-00000000${String(n).padStart(4, '0')}`;

export type Client = {
  query(
    s: string,
    p?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect(): Promise<void>;
  end(): Promise<void>;
  on(event: 'error', listener: (e: Error) => void): unknown;
};

export const clock = { t: Date.now() };
export const now = (): Date => new Date(clock.t);

/** Published consent template versions the test port reports (`organisation` owns the real ones). */
export const publishedTemplates = new Set<string>();
export const tpl = (key: string, version: number, language = 'en'): string =>
  `${key}:${version}:${language}`;

export interface Kit {
  dbName: string;
  urlFor(user: string, database?: string): string;
  sa: Client;
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  db: KernelDb;
  wdb: KernelDb;
  identity: Identity;
  patient: Patient;
  audit: AuditService;
  registry: JobRegistry;
  base: string;
  close(): Promise<void>;
}

export interface KitOptions {
  name: string;
  controllers?: readonly Type<unknown>[];
  fixtures?: (k: { sa: Client; q: Kit['q'] }) => Promise<void>;
  /** After the identity and patient modules exist, before the app starts (register extra resolvers). */
  beforeStart?: (k: { identity: Identity; patient: Patient }) => void;
}

export async function setup(opts: KitOptions): Promise<Kit> {
  const dbName = `ehr_be08_${opts.name}_${process.pid}_${Date.now()}`;
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
  const workerPool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 4 });
  // An idle client that the server ends (the DROP DATABASE ... WITH (FORCE) of close, a terminated backend) must not become an
  // uncaught exception of the test process.
  const ignoreIdle = (): void => undefined;
  apiPool.on('error', ignoreIdle);
  workerPool.on('error', ignoreIdle);
  sa.on('error', ignoreIdle);
  const db = new KernelDb(apiPool as never);
  const wdb = new KernelDb(workerPool as never);

  const registry = new JobRegistry();
  for (const j of IDENTITY_JOBS) registry.defineJob(j);
  for (const j of PATIENT_JOBS) registry.defineJob(j);
  const wc = new pg.Client({ connectionString: urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, registry);
  await wc.end();

  const workerDist = pathToFileURL(`${repoRoot}apps/worker/dist/jobs/identity/index.js`).href;
  const worker = (await import(workerDist)) as {
    runApplyReferenceData(d: { db: KernelDb; orgId: string; jobId?: string }): Promise<unknown>;
  };
  await worker.runApplyReferenceData({ db: wdb, orgId: ORG });

  const audit = new AuditService({ queue: new Queue(registry, 'api') });
  const dead = {
    issuer: 'https://idp.invalid',
    authorizationEndpoint: 'https://idp.invalid/a',
    tokenEndpoint: 'https://idp.invalid/t',
    jwksUri: 'https://idp.invalid/k',
  };
  const identity = createIdentity({
    db,
    queue: new Queue(registry, 'api'),
    audit,
    logger: createLogger({ sink: () => undefined }),
    config: {
      orgId: ORG,
      hosts: { [STAFF_HOST]: 'google', [PATIENT_HOST]: 'patient_pool' },
      allowedOrigins: [`https://${STAFF_HOST}`, `https://${PATIENT_HOST}`],
      oidcStateKeys: { current: 'oidc-state-key-for-tests-0123456789ab' },
      csrfKey: CSRF_KEY,
      rateKey: 'rate-key-for-tests-0123456789abcdef',
    },
    realms: {
      google: new GoogleRealmAdapter({
        endpoints: dead,
        clientId: 'x',
        clientSecret: 'x'.repeat(24),
        redirectUri: `https://${STAFF_HOST}/cb`,
        workspaceDomain: 'example.com',
      }),
      patient_pool: new OidcPatientAdapter({
        endpoints: dead,
        clientId: 'x',
        redirectUri: `https://${PATIENT_HOST}/cb`,
      }),
    },
    patientInScope,
    now,
  });

  const patient = createPatient({
    db,
    audit,
    identity,
    limiter: new MemoryRateLimiter(1),
    matchKey: MATCH_KEY,
    consentTemplates: {
      isPublished: (_tx, key, version, language) =>
        Promise.resolve(publishedTemplates.has(tpl(key, version, language))),
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
    queue: new Queue(registry, 'api'),
    labelLimitPerHour: 3,
    now,
  });
  // Probe routes: the resolver reads the patient from the last path segment; the guard's scope check is what is under test.
  identity.policy.registerResolver('probe-patient', (req) => {
    const m = /\/([0-9a-f-]{36})$/i.exec(req.path);
    return Promise.resolve(m?.[1] === undefined ? undefined : { patientId: m[1].toLowerCase() });
  });
  opts.beforeStart?.({ identity, patient });
  if (opts.fixtures) await opts.fixtures({ sa, q });

  const app = await createApp({
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
    // The platform's general per-principal limit (31.3) is not under test here; the label limit has its own limiter.
    limiter: { hit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 1 }) },
    controllers: [...identity.controllers, ...patient.controllers, ...(opts.controllers ?? [])],
  });
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return {
    dbName,
    urlFor,
    sa,
    q,
    db,
    wdb,
    identity,
    patient,
    audit,
    registry,
    base,
    async close() {
      await app.close();
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

// --- HTTP ------------------------------------------------------------------------------------------------------------
export interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): Record<string, unknown>;
}

export function call(
  base: string,
  method: string,
  path: string,
  o: { host?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const headers: Record<string, string> = {
      host: o.host ?? STAFF_HOST,
      'x-client-release': RELEASE,
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
          json: () => (b === '' ? {} : (JSON.parse(b) as Record<string, unknown>)),
        }),
      );
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

// --- principals, roles, sessions ------------------------------------------------------------------------------------
export interface Seeded {
  personId: string;
  principalId: string;
}

export async function seedPrincipal(
  k: Kit,
  realm: 'google' | 'patient_pool' | 'admin_pool',
  o: { name?: string; email?: string } = {},
): Promise<Seeded> {
  const personId = uuidv7();
  const principalId = uuidv7();
  await k.sa.query('BEGIN');
  try {
    await k.sa.query(
      `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, $3)`,
      [personId, ORG, o.name ?? 'Test Person'],
    );
    await k.sa.query(
      `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status) VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [principalId, ORG, personId, realm, `sub-${principalId}`, o.email ?? null],
    );
    await k.sa.query('COMMIT');
  } catch (e) {
    await k.sa.query('ROLLBACK');
    throw e;
  }
  return { personId, principalId };
}

/** Two admin-realm people standing in for the requester and approver of the role-change request every assignment cites (BE-05). */
const grantors = new Map<string, { requester: string; approver: string }>();
async function grantorsOf(k: Kit): Promise<{ requester: string; approver: string }> {
  const have = grantors.get(k.dbName);
  if (have !== undefined) return have;
  const requester = (await seedPrincipal(k, 'admin_pool')).personId;
  const approver = (await seedPrincipal(k, 'admin_pool')).personId;
  const g = { requester, approver };
  grantors.set(k.dbName, g);
  return g;
}

export async function assignRole(
  k: Kit,
  principalId: string,
  roleKey: string,
  locationId?: string,
): Promise<void> {
  const g = await grantorsOf(k);
  const requestId = randomUUID();
  await k.sa.query('BEGIN');
  try {
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
  cookie: string;
  sessionId: string;
  csrf: string;
  seeded: Seeded;
}

export async function seedSession(
  k: Kit,
  s: Seeded,
  realm: 'google' | 'patient_pool' | 'admin_pool',
): Promise<SeededSession> {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest();
  const sessionId = uuidv7();
  const csrf = csrfTokenFor(CSRF_KEY, sessionId);
  const start = now();
  await k.sa.query(
    `INSERT INTO identity.session (id, organisation_id, token_hash, principal_id, person_id, realm, audience, auth_time, csrf_hash, idle_expires_at, absolute_expires_at, last_interaction_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$8)`,
    [
      sessionId,
      ORG,
      hash,
      s.principalId,
      s.personId,
      realm,
      realm === 'patient_pool' ? 'patient' : 'staff',
      start,
      createHash('sha256').update(csrf).digest(),
      new Date(start.getTime() + 15 * 60_000),
      new Date(start.getTime() + 12 * 3_600_000),
    ],
  );
  return { cookie: `${SID_COOKIE}=${token}`, sessionId, csrf, seeded: s };
}

export const writeHeaders = (
  s: SeededSession,
  host = STAFF_HOST,
  idempotencyKey?: string,
): Record<string, string> => ({
  origin: `https://${host}`,
  'x-csrf-token': s.csrf,
  ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
});

/** A staff member with one role at one location, already signed in. */
export async function staffMember(
  k: Kit,
  role: string,
  location: string | undefined,
  name = 'Staff Member',
): Promise<SeededSession> {
  const p = await seedPrincipal(k, 'google', {
    name,
    email: `${role}.${randomBytes(4).toString('hex')}@example.com`,
  });
  await assignRole(k, p.principalId, role, location);
  return seedSession(k, p, 'google');
}

/** A patient-realm principal, signed in; `patientId` links it as the patient's own account when given. */
export async function patientAccount(
  k: Kit,
  linkTo?: string,
  name = 'Patient Person',
): Promise<SeededSession> {
  const p = await seedPrincipal(k, 'patient_pool', { name });
  if (linkTo !== undefined)
    await saWrite(
      k,
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1,$2,$3,'self')`,
      [p.principalId, linkTo, ORG],
    );
  return seedSession(k, p, 'patient_pool');
}

/** Registers a patient through the real front-desk path (match, then register) and returns its ID. */
export async function registerViaApi(
  k: Kit,
  s: SeededSession,
  locationId: string,
  who: {
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    phone?: string;
    email?: string;
    stateCode?: string;
  },
  extra: Record<string, unknown> = {},
): Promise<string> {
  const m = await call(k.base, 'POST', '/api/v1/patients/match', {
    cookie: s.cookie,
    headers: writeHeaders(s),
    body: { ...who, locationId },
  });
  if (m.status !== 200) throw new Error(`match failed ${m.status} ${m.body}`);
  const checkId = m.json()['matchCheckId'] as string;
  const hasCandidates = (m.json()['candidates'] as unknown[]).length > 0;
  const r = await call(k.base, 'POST', '/api/v1/patients', {
    cookie: s.cookie,
    headers: writeHeaders(s, STAFF_HOST, randomUUID()),
    body: {
      stateCode: FIXTURE_STATES.licensed,
      ...who,
      locationId,
      matchCheckId: checkId,
      ...(hasCandidates
        ? { duplicateAcknowledged: true, acknowledgeReason: 'Checked, a different person' }
        : {}),
      ...extra,
    },
  });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${r.body}`);
  return r.json()['patientId'] as string;
}

/**
 * A write by the superuser session with the transaction settings of a system job (what a data-repair or fixture write carries).
 * The merge guard reads the patient root under those settings, so fixtures that name a patient need them (and a write without
 * them is refused: the guard fails closed).
 */
export async function saWrite(k: Kit, sql: string, params: unknown[] = []): Promise<void> {
  await k.sa.query(
    `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
    [ORG],
  );
  try {
    await k.sa.query(sql, params);
  } finally {
    await k.sa.query(
      `SELECT set_config('app.org_id', '', false), set_config('app.audience', '', false)`,
    );
  }
}

/** Runs `fn` in a transaction as the application role with the given settings (SET LOCAL), then rolls back. */
export async function asRole<T>(
  k: Kit,
  role: string,
  settings: Record<string, string>,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const c: Client = new pg.Client({ connectionString: k.urlFor(role) });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [name, value] of Object.entries(settings))
      await c.query(`SELECT set_config($1, $2, true)`, [name, value]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

@Controller('api/v1/t')
export class ProbeController {
  /** A `proxy` route: the realm capability a proxy holds (D-7 default: appointments). */
  @Get('appointments/:patientId')
  @Route({ permission: 'proxy', resolver: 'probe-patient' })
  appointments(): { ok: true } {
    return { ok: true };
  }
  /** A `patient` route: the patient's own records only. */
  @Get('chart/:patientId')
  @Route({ permission: 'patient', resolver: 'probe-patient' })
  chart(): { ok: true } {
    return { ok: true };
  }
}

export const standardFixtures = async ({ sa }: { sa: Client }): Promise<void> => {
  await sa.query(
    `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('${FIXTURE_STATES.licensed}', $1, 'Fixture state A'), ('${FIXTURE_STATES.unlicensed}', $1, 'Fixture state B')`,
    [ORG],
  );
  for (const [lid, name] of [
    [id(101), 'Clinic A1'],
    [id(102), 'Clinic A2'],
    [id(201), 'Clinic B1'],
  ] as const)
    await sa.query(
      `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active) VALUES ($1, $2, $3, 'clinic', 'America/New_York', '${FIXTURE_STATES.licensed}', true)`,
      [lid, ORG, name],
    );
};

/**
 * SEC-03 F04: `ensure_care_relationship(..., 'booking')` needs a confirmed appointment of the patient at the location. This seeds
 * one directly (reservation and its occupancy twin in one transaction, a doctor of its own so that no slot ever collides), the way
 * the booking service leaves the database after a confirm. Returns the reservation ID.
 */
export async function confirmedBooking(
  k: Kit,
  patientId: string,
  locationId: string,
): Promise<string> {
  const doctor = await seedPrincipal(k, 'google', { name: 'Seeded doctor' });
  const rid = uuidv7();
  const svc = id(399);
  const start = new Date(Date.now() + 30 * 86_400_000);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  await k.sa.query('BEGIN');
  try {
    await k.sa.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
      [ORG],
    );
    await k.sa.query(
      `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active)
       VALUES ($1, $2, 'Seeded consult', 'Appointment', 30, 0, 'either', true) ON CONFLICT DO NOTHING`,
      [svc, ORG],
    );
    await k.sa.query(
      `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode,
                                                 booked_by_principal_id, booked_via)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_person', $6, 'staff')`,
      [rid, ORG, patientId, svc, locationId, doctor.principalId],
    );
    await k.sa.query(
      `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, period, status)
       VALUES ($1, $2, $3, $4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), 'confirmed')`,
      [rid, ORG, locationId, doctor.principalId, start.toISOString(), end.toISOString()],
    );
    await k.sa.query('COMMIT');
  } catch (e) {
    await k.sa.query('ROLLBACK');
    throw e;
  }
  return rid;
}
