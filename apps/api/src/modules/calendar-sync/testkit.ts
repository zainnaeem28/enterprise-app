/* eslint-disable boundaries/module-boundaries -- test support: reaches the patient kit, the integration-core and worker builds the way the scheduling kits do */
// Harness of the calendar-sync real-database tests (BE-14). Not a test file. A throwaway PostgreSQL 17 database migrated by the real
// pipeline (including 1400-1403), the real Nest application with the identity guard and this module's controllers, the real queue, the
// worker's real calendar-sync jobs and integration-core gateway (apps/worker/dist), and a LOCAL STUB of the Google endpoints (events,
// watch, token). The stub is a contract stub: it proves our requests and our handling of Google's documented answers, not Google itself
// (C-10: real Google evidence needs the test tenant and stays BLOCKED). Synthetic data only.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { KernelDb, Queue, createLogger, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings, Tx } from '@ehr/kernel';
import {
  ORG,
  STAFF_HOST,
  call,
  id,
  pg,
  repoRoot,
  saWrite,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
} from '../patient/testkit.js';
import type { Kit, SeededSession } from '../patient/testkit.js';
import { INTEGRATION_CORE_JOBS } from '../integration-core/index.js';
import type { OutboundSecretStore, PayloadSealer } from '../integration-core/index.js';
import { createCalendarControllers, calendarResolvers } from './controller.js';
import { CALENDAR_SYNC_JOBS, registerCalendarSyncHandlers } from './jobs.js';
import { GoogleCalendarOAuth } from './oauth.js';
import { GoogleCalendarPush } from './push.js';
import { CalendarLinkService } from './service.js';
import { uuidv7 } from './ids.js';

export {
  ORG,
  STAFF_HOST,
  call,
  id,
  pg,
  saWrite,
  seedPrincipal,
  seedSession,
  staffMember,
  writeHeaders,
};
export type { Kit, SeededSession };

export const A1 = id(101);
export const SVC = id(301);
export const SVC_SENS = id(311);
/** A condition-revealing internal service name: it must appear nowhere outside `organisation.service` (BR-23, TC-CAL-02). */
export const SENSITIVE_NAME = 'HIV-Clinic-Followup-CANARY';
export const REFRESH_TOKEN = 'RT-CANARY-refresh-token-4b1e9a77-DO-NOT-LOG';
export const AUTH_CODE = 'AC-CANARY-auth-code-77c1d2e0-DO-NOT-LOG';
export const CLIENT_SECRET = 'client-secret-for-tests-0123456789';
export const WEBHOOK_URL = 'https://integrations.example.test/webhooks/google/calendar';
export const RETURN_URL = 'https://staff.example.test/doctor/calendar';

const AES = randomBytes(32);
const gcmSeal = (plain: Buffer, ctx: string): Buffer => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', AES, iv);
  c.setAAD(Buffer.from(ctx));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
};
const gcmOpen = (sealed: Buffer, ctx: string): Buffer => {
  const d = createDecipheriv('aes-256-gcm', AES, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(ctx));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
};

/** The outbound secret store: write-only for the API, readable by the worker's reader. Never prints a value. */
export class FakeStore implements OutboundSecretStore {
  readonly values = new Map<string, string>();
  readonly puts: { connectionId: string; name: string; token: string }[] = [];
  private readonly byToken = new Map<string, string>();
  fail = false;
  put(ref: { connectionId: string; name: string }, value: string, token: string) {
    if (this.fail) return Promise.reject(new Error(`store down; value was ${value}`));
    this.puts.push({ ...ref, token });
    let v = this.byToken.get(token);
    if (v === undefined) {
      v = `v${this.byToken.size + 1}`;
      this.byToken.set(token, v);
    }
    const arn = `arn:test:secret:env/integration/outbound/${ref.connectionId}/${ref.name}`;
    this.values.set(`${arn}|${v}`, value);
    return Promise.resolve({ arn, versionId: v });
  }
  reader = {
    get: (arn: string, versionId: string): Promise<string> => {
      const v = this.values.get(`${arn}|${versionId}`);
      return v === undefined
        ? Promise.reject(new Error('no such secret version'))
        : Promise.resolve(v);
    },
  };
}

// ---- the Google stub ------------------------------------------------------------------------------------------------
export interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  authorization: string | undefined;
}
export interface StubEvent {
  id: string;
  status?: string;
  transparency?: string;
  summary?: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string; email?: string; displayName?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}

export class GoogleStub {
  server!: Server;
  url = '';
  requests: StubRequest[] = [];
  /** Events as Google would hold them, WITH titles and attendee names: the adapter must reduce them to an interval. */
  events = new Map<string, StubEvent>();
  /** The delta the next incremental listing returns. */
  delta: StubEvent[] = [];
  syncSeq = 1;
  /** `syncToken` values Google still accepts. Anything else answers 410 Gone. */
  validTokens = new Set<string>();
  pageSize = 250;
  /** Next N list calls answer 503. */
  failList = 0;
  /** Refresh-token grant answers 400 invalid_grant. */
  revoked = false;
  /** Event insert answers 403 (a refusal that is not a rate limit). */
  denyInsert = false;
  created = new Map<string, Record<string, unknown>>();
  deleted = new Set<string>();
  channels: {
    id: string;
    resourceId: string;
    token: string;
    address: string;
    expiration: string;
  }[] = [];
  stopped: { id: string; resourceId: string }[] = [];
  private resSeq = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const a = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${a.port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  reset(): void {
    this.requests = [];
  }
  of(re: RegExp, method?: string): StubRequest[] {
    return this.requests.filter(
      (r) => re.test(r.path) && (method === undefined || r.method === method),
    );
  }
  /** Issues a sync token Google will accept. */
  newToken(): string {
    const t = `SYNC-${this.syncSeq++}`;
    this.validTokens.add(t);
    return t;
  }

  private json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  private async handle(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url ?? '/', this.url);
    const body = Buffer.concat(chunks).toString('utf8');
    const r: StubRequest = {
      method: req.method ?? 'GET',
      path: u.pathname,
      query: u.searchParams,
      body,
      authorization: req.headers.authorization,
    };
    this.requests.push(r);

    if (u.pathname === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== AUTH_CODE || !form.get('code_verifier'))
          return this.json(res, 400, { error: 'invalid_grant' });
        return this.json(res, 200, {
          access_token: 'AT-initial',
          refresh_token: REFRESH_TOKEN,
          expires_in: 3599,
        });
      }
      if (this.revoked) return this.json(res, 400, { error: 'invalid_grant' });
      if (form.get('refresh_token') !== REFRESH_TOKEN)
        return this.json(res, 400, { error: 'invalid_grant' });
      return this.json(res, 200, { access_token: `AT-${randomUUID()}`, expires_in: 3599 });
    }
    if (u.pathname.startsWith('/discovery/')) return this.json(res, 200, { id: 'calendar:v3' });
    if (this.revoked || !r.authorization?.startsWith('Bearer AT-'))
      return this.json(res, 401, { error: { code: 401 } });

    const ev = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (ev !== null && r.method === 'GET' && ev[2] === undefined) return this.list(u, res);
    if (ev !== null && r.method === 'POST' && ev[2] === undefined) {
      if (this.denyInsert)
        return this.json(res, 403, { error: { errors: [{ reason: 'forbidden' }] } });
      const e = JSON.parse(body) as { id: string };
      if (this.created.has(e.id)) return this.json(res, 409, { error: { code: 409 } });
      this.created.set(e.id, JSON.parse(body) as Record<string, unknown>);
      this.deleted.delete(e.id);
      return this.json(res, 200, { id: e.id });
    }
    if (ev !== null && r.method === 'PUT' && ev[2] !== undefined) {
      this.created.set(ev[2], JSON.parse(body) as Record<string, unknown>);
      this.deleted.delete(ev[2]);
      return this.json(res, 200, { id: ev[2] });
    }
    if (ev !== null && r.method === 'DELETE' && ev[2] !== undefined) {
      if (!this.created.has(ev[2]) || this.deleted.has(ev[2]))
        return this.json(res, 404, { error: { code: 404 } });
      this.deleted.add(ev[2]);
      res.writeHead(204);
      return void res.end();
    }
    if (/\/events\/watch$/.test(u.pathname) && r.method === 'POST') {
      const b = JSON.parse(body) as {
        id: string;
        token: string;
        address: string;
        expiration: string;
      };
      const resourceId = `res${++this.resSeq}`;
      this.channels.push({ ...b, resourceId });
      return this.json(res, 200, { id: b.id, resourceId, expiration: b.expiration });
    }
    if (u.pathname === '/calendar/v3/channels/stop' && r.method === 'POST') {
      this.stopped.push(JSON.parse(body) as { id: string; resourceId: string });
      res.writeHead(204);
      return void res.end();
    }
    return this.json(res, 404, { error: { code: 404 } });
  }

  private list(u: URL, res: import('node:http').ServerResponse): void {
    if (this.failList > 0) {
      this.failList--;
      return this.json(res, 503, { error: { code: 503 } });
    }
    const syncToken = u.searchParams.get('syncToken');
    if (syncToken !== null && !this.validTokens.has(syncToken))
      return this.json(res, 410, { error: { code: 410 } });
    const all = syncToken === null ? [...this.events.values()] : this.delta;
    const page = Number(u.searchParams.get('pageToken') ?? '0');
    const slice = all.slice(page * this.pageSize, (page + 1) * this.pageSize);
    const more = (page + 1) * this.pageSize < all.length;
    this.json(res, 200, {
      timeZone: 'America/New_York',
      items: slice,
      ...(more ? { nextPageToken: String(page + 1) } : { nextSyncToken: this.newToken() }),
    });
  }
}

// ---- the kit --------------------------------------------------------------------------------------------------------
export interface WorkerCalendar {
  CALENDAR_SYNC_JOBS: readonly import('@ehr/kernel').JobType[];
  CALENDAR_SYNC_CRONTAB: string;
  GoogleCalendarAdapter: new (o?: Record<string, unknown>) => unknown;
  createCalendarSyncTasks(
    deps: unknown,
  ): Record<string, (payload: unknown, helpers: unknown) => Promise<void>>;
  registerGooglePushHandler(registry: unknown, deps: unknown): void;
  runIncrementalSync(deps: unknown, payload: Record<string, unknown>): Promise<string>;
  runFullResync(deps: unknown, payload: Record<string, unknown>): Promise<string>;
  runPushBusy(deps: unknown, payload: Record<string, unknown>): Promise<string>;
  runDeleteBusy(deps: unknown, payload: Record<string, unknown>): Promise<string>;
  runRenewWatch(deps: unknown, payload: Record<string, unknown>): Promise<string>;
  runUnlinkCleanup(deps: unknown, payload: Record<string, unknown>): Promise<string>;
  handlePush(deps: unknown, body: Buffer): Promise<string>;
  parsePush(body: Buffer): unknown;
  channelToken(
    key: { version: string; key: Buffer },
    channelId: string,
    expiryEpoch: number,
  ): string;
  eventIdFor(occupancyId: string): string;
  externalHash(eventId: string): Buffer;
  toBusyChange(e: unknown, zone?: string): unknown;
  startOfDayIn(date: string, zone: string | undefined): number | undefined;
}

interface WorkerCore {
  AdapterRegistry: new () => { register(a: unknown): void };
  VendorGateway: new (d: Record<string, unknown>) => unknown;
  SecretCache: new (reader: unknown) => unknown;
  credentialReaderFor(db: KernelDb, orgId: string, connectionId: string, cache: unknown): unknown;
  InboundHandlerRegistry: new () => unknown;
  runDispatch(deps: Record<string, unknown>, messageId: string): Promise<string>;
}

export interface CalendarKit {
  k: Kit;
  store: FakeStore;
  stub: GoogleStub;
  w: WorkerCalendar;
  links: CalendarLinkService;
  push: GoogleCalendarPush;
  /** Worker dependencies handed to every job. */
  jobs: Record<string, unknown> & { db: KernelDb; queue: Queue };
  connectionId: string;
  stateKeys: Buffer[];
  channelKey: { version: string; key: Buffer };
  oldChannelKey: { version: string; key: Buffer };
  verificationFailures: { source: string; reason: string }[];
  clock: { at: Date | undefined };
  /** Every log line the services wrote (a canary must not be in any of them). */
  logs: string[];
  api: KernelDb;
  worker: KernelDb;
  /** Publishes a domain event the way the booking service does (API queue, the caller's transaction). */
  publish(doctorId: string, event: string, payload: Record<string, unknown>): Promise<string[]>;
  /** A doctor (role `doctor`, google realm) with a signed-in session. */
  doctor(name?: string): Promise<SeededSession>;
  /** A patient row (a bare record) and an appointment for it, written the way the booking service leaves the database. */
  booking(
    doctorId: string,
    start: Date,
    o?: { status?: string; serviceId?: string; minutes?: number },
  ): Promise<{ occupancyId: string; patientId: string }>;
  /** Makes the doctor's link `active` with a stored refresh token reference, as a completed callback leaves it. */
  activeLink(
    doctorId: string,
    o?: { syncToken?: string | null; lastSyncedAt?: boolean },
  ): Promise<void>;
  /** The jobs waiting for a task, oldest first. */
  queued(
    task: string,
  ): Promise<{ id: string; payload: Record<string, unknown>; key: string | null }[]>;
  /** Runs (and removes) the waiting jobs of a task with the worker's real handler. Returns what ran. */
  runQueued(task: string): Promise<Record<string, unknown>[]>;
  scope(doctorId: string): ScopeSettings;
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  asWorker<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  dispatch(messageId: string): Promise<string>;
  close(): Promise<void>;
}

export async function setupCalendar(name: string): Promise<CalendarKit> {
  let mrnSeq = Math.floor(Math.random() * 500_000);
  const holder: { k?: Kit; links?: CalendarLinkService; push?: GoogleCalendarPush } = {};
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
  const stub = new GoogleStub();
  await stub.start();
  const connectionId = randomUUID();
  const store = new FakeStore();
  const stateKeys = [
    Buffer.from('calendar-state-key-current-0123456789ab'),
    Buffer.from('calendar-state-key-previous-0123456789a'),
  ];
  const channelKey = { version: 'k2', key: randomBytes(32) };
  const oldChannelKey = { version: 'k1', key: randomBytes(32) };

  const k = await setup({
    name,
    fixtures: async (f) => {
      await standardFixtures(f);
      await f.sa.query(
        `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active)
         VALUES ($1, $3, 'Consult', 'Appointment', 30, 0, 'either', true), ($2, $3, $4, 'Appointment', 30, 0, 'either', true)`,
        [SVC, SVC_SENS, ORG, SENSITIVE_NAME],
      );
      await f.sa.query(
        `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, settings, enabled)
         VALUES ($1, $2, 'google_calendar', 'google', '{"clientId":"test-client-id"}'::jsonb, true)`,
        [connectionId, ORG],
      );
      // The OAuth client secret, as the admin path of BE-02 would have stored it.
      const arn = `arn:test:secret:env/integration/outbound/${connectionId}/oauth-client-secret`;
      store.values.set(`${arn}|v0`, CLIENT_SECRET);
      await f.sa.query(
        `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id)
         VALUES ($1, 'oauth-client-secret', $2, 'outbound', $3, 'v0')`,
        [connectionId, ORG, arn],
      );
    },
    controllers: [
      ...createCalendarControllers({
        db: lazyDb,
        links: lazy(() => holder.links as CalendarLinkService),
        push: lazy(() => holder.push as GoogleCalendarPush),
        returnUrl: RETURN_URL,
      }),
    ],
    beforeStart: ({ identity }) => {
      for (const [n, fn] of Object.entries(calendarResolvers()))
        identity.policy.registerResolver(n, fn);
    },
  });
  holder.k = k;
  for (const j of [...INTEGRATION_CORE_JOBS, ...CALENDAR_SYNC_JOBS])
    try {
      k.registry.get(j.name);
    } catch {
      k.registry.defineJob(j);
    }
  registerCalendarSyncHandlers(k.registry);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 12 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 6 });
  for (const p of [apiPool, workerPool]) p.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const worker = new KernelDb(workerPool as never);
  const apiQueue = new Queue(k.registry, 'api');
  const workerQueue = new Queue(k.registry, 'worker');
  const clock: { at: Date | undefined } = { at: undefined };
  const logs: string[] = [];
  const log = createLogger({ sink: (l) => logs.push(l), level: 'debug' });

  holder.links = new CalendarLinkService({
    db: api,
    audit: k.audit,
    queue: apiQueue,
    store,
    oauth: new GoogleCalendarOAuth({
      clientId: 'test-client-id',
      clientSecret: CLIENT_SECRET,
      redirectUri: `https://${STAFF_HOST}/api/v1/calendar-link/callback`,
      authUrl: `${stub.url}/auth`,
      tokenUrl: `${stub.url}/token`,
    }),
    stateKeys,
    logger: log,
    now: () => clock.at ?? new Date(),
  });
  const verificationFailures: { source: string; reason: string }[] = [];
  holder.push = new GoogleCalendarPush({
    db: api,
    queue: apiQueue,
    sealer: { seal: (p, ctx) => Promise.resolve(gcmSeal(p, ctx)) } satisfies PayloadSealer,
    keys: { keys: () => Promise.resolve([channelKey, oldChannelKey]) },
    orgId: ORG,
    logger: log,
    onVerificationFailure: (i) => verificationFailures.push(i),
    now: () => clock.at ?? new Date(),
  });

  const W = async <T>(path: string): Promise<T> =>
    (await import(pathToFileURL(`${repoRoot}apps/worker/dist/${path}`).href)) as T;
  const w = await W<WorkerCalendar>('jobs/calendar-sync/index.js');
  const core = await W<WorkerCore>('jobs/integration-core/index.js');
  const adapters = new core.AdapterRegistry();
  adapters.register(
    new w.GoogleCalendarAdapter({ apiBase: stub.url, tokenEndpoint: `${stub.url}/token`, fetch }),
  );
  const cache = new core.SecretCache(store.reader);
  const gateway = new core.VendorGateway({
    db: worker,
    orgId: ORG,
    adapters,
    credentials: (cid: string) => core.credentialReaderFor(worker, ORG, cid, cache),
    maxAttempts: 2,
    backoffBaseMs: 1,
    backoffCapMs: 2,
    sleep: () => Promise.resolve(),
  });
  const inbound = new core.InboundHandlerRegistry();
  const jobs = {
    db: worker,
    orgId: ORG,
    queue: workerQueue,
    vendor: gateway,
    channelKeys: { current: () => Promise.resolve(channelKey) },
    webhookUrl: WEBHOOK_URL,
    log,
    now: () => clock.at ?? new Date(),
  } as CalendarKit['jobs'];
  w.registerGooglePushHandler(inbound, jobs);
  const tasks = w.createCalendarSyncTasks(jobs);

  const workerScope: ScopeSettings = {
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'org',
  };

  const kit: CalendarKit = {
    k,
    store,
    stub,
    w,
    links: holder.links,
    push: holder.push,
    jobs,
    connectionId,
    stateKeys,
    channelKey,
    oldChannelKey,
    verificationFailures,
    clock,
    logs,
    api,
    worker,
    publish: (doctorId, event, payload) =>
      api.withScope(
        {
          audience: 'staff',
          realm: 'google',
          orgId: ORG,
          principalId: doctorId,
          personId: randomUUID(),
        },
        (tx) => apiQueue.publish(tx, event, payload),
      ),
    async doctor(n = 'Dr Calendar') {
      return staffMember(k, 'doctor', A1, n);
    },
    async booking(doctorId, start, o = {}) {
      const patientId = randomUUID();
      const occupancyId = uuidv7();
      await saWrite(
        k,
        `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
         VALUES ($1, $2, $3, 'Pat', 'Ient', '1975-01-01', 'NY', 'front_desk')`,
        [patientId, ORG, `MRN-${String(9_000_000 + (mrnSeq += 1))}`],
      );
      const end = new Date(start.getTime() + (o.minutes ?? 30) * 60_000);
      await k.sa.query('BEGIN');
      try {
        await k.sa.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
          [ORG],
        );
        await k.sa.query(
          `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, period, status, expires_at)
           VALUES ($1, $2, $3, $4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), $7, CASE WHEN $7 = 'held' THEN now() + interval '10 minutes' END)`,
          [
            occupancyId,
            ORG,
            A1,
            doctorId,
            start.toISOString(),
            end.toISOString(),
            o.status ?? 'confirmed',
          ],
        );
        await k.sa.query(
          `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, booked_by_principal_id, booked_via, reason)
           VALUES ($1, $2, $3, $4, $5, $6, 'in_person', $6, 'staff', 'private reason CANARY')`,
          [occupancyId, ORG, patientId, o.serviceId ?? SVC, A1, doctorId],
        );
        await k.sa.query('COMMIT');
      } catch (e) {
        await k.sa.query('ROLLBACK');
        throw e;
      }
      return { occupancyId, patientId };
    },
    async activeLink(doctorId, o = {}) {
      const name = `cal-${doctorId}`;
      const arn = `arn:test:secret:env/integration/outbound/${connectionId}/${name}`;
      store.values.set(`${arn}|vt`, REFRESH_TOKEN);
      await saWrite(
        k,
        `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id)
         VALUES ($1, $2, $3, 'outbound', $4, 'vt') ON CONFLICT (connection_id, name) DO NOTHING`,
        [connectionId, name, ORG, arn],
      );
      await saWrite(
        k,
        `INSERT INTO calendar_sync.calendar_link (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name)
         VALUES ($1, $2, 'primary', 'pending_consent', $3) ON CONFLICT DO NOTHING`,
        [doctorId, ORG, name],
      );
      await saWrite(
        k,
        `UPDATE calendar_sync.calendar_link SET status = 'active', sync_token = $2, last_synced_at = CASE WHEN $3 THEN now() END WHERE clinician_principal_id = $1`,
        [doctorId, o.syncToken === undefined ? null : o.syncToken, o.lastSyncedAt === true],
      );
    },
    async queued(task) {
      return (await k.q(
        `SELECT j.id::text AS id, j.payload, j.key FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1 ORDER BY j.id`,
        [task],
      )) as never;
    },
    async runQueued(task) {
      const fn = tasks[task];
      if (fn === undefined) throw new Error(`no task ${task}`);
      const ran: Record<string, unknown>[] = [];
      for (const j of await kit.queued(task)) {
        await k.sa.query(`DELETE FROM queue._private_jobs WHERE id = $1::bigint`, [j.id]);
        await fn(j.payload, {});
        ran.push(j.payload);
      }
      return ran;
    },
    scope(doctorId) {
      return {
        audience: 'staff',
        realm: 'google',
        orgId: ORG,
        principalId: doctorId,
        personId: randomUUID(),
      };
    },
    as: (scope, fn) => api.withScope(scope, fn),
    asWorker: (fn) => worker.withScope(workerScope, fn),
    async dispatch(messageId) {
      return core.runDispatch(
        {
          db: worker,
          orgId: ORG,
          queue: workerQueue,
          log,
          registry: inbound,
          opener: { open: (sealed: Buffer, ctx: string) => Promise.resolve(gcmOpen(sealed, ctx)) },
        },
        messageId,
      );
    },
    async close() {
      await apiPool.end();
      await workerPool.end();
      await k.close();
      await stub.stop();
    },
  };
  return kit;
}

export const sha = (s: string): Buffer => createHash('sha256').update(s).digest();
