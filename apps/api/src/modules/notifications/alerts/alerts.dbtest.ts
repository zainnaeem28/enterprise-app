// Real-database tests for BE-07 (staff alerts and the alert stream) on PostgreSQL 17 with the real roles, migrations, RLS,
// queue, identity guard and sessions, and a real HTTP server:
//   TC-PC-16 mechanics (ARCHITECTURE 38.2 item 19): escalatesAt on GET /alerts, GET /alerts/open-ids, the SSE `alert` event and
//     the acknowledge response; two simultaneous acknowledgements; 409 notifications.alert_closed; the job after acknowledge.
//   38.2 item 6: outdated clientRelease refused, reconnect replay, slow consumer dropped, kill switch closes within the bound.
//   ADR-022: targets resolved to principals at creation and escalation; admin-realm alerts never carry a patient ID.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/notifications/alerts/alerts.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import { FIXTURE_STATES } from '../../../platform/fixture-states.js';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Module } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import { createTargetResolver } from '../../../alert-target-resolver.js';
import { clientReleaseMiddleware } from '../../../platform/client-release.js';
import { errorMiddleware, LOGGER, ProblemFilter } from '../../../platform/filter.js';
import { GUARD_POLICY, RouteGuard } from '../../../platform/guard.js';
import { baselineHeaders } from '../../../platform/headers.js';
import { requireAuthContext } from '../../identity/index.js';
// The identity harness (BE-04 testkit) is the only real-stack kit: migrations, queue, reference data, sessions, guard. It is
// test-only code; lint exemption requested (README, ALR-N8).
/* eslint-disable boundaries/module-boundaries */
import {
  assignRole,
  call,
  id,
  MIN_RELEASE,
  ORG,
  pg,
  RELEASE,
  seedPrincipal,
  seedSession,
  setup,
  STAFF_HOST,
  writeHeaders,
} from '../../identity/testkit.js';
import type { Kit, SeededSession } from '../../identity/testkit.js';
/* eslint-enable boundaries/module-boundaries */
import { NotificationsValidationError } from '../errors.js';
import { createAlertStreamController } from '../stream/controller.js';
import { StreamHub, REVALIDATE_MS } from '../stream/hub.js';
import { createAlertsController } from './controller.js';
import { escalateAlert } from './escalate.js';
import { ALERT_JOBS, ALERT_UNACKNOWLEDGED } from './jobs.js';
import { ALERT_MERGE_TABLES, alertExportContributor, repointAlertRows } from './merge.js';
import { AlertService } from './service.js';
import { AlertSettingService } from './settings.js';
import type { TargetResolver } from './types.js';

const L1 = id(7001);
const P1 = id(7101); // a patient the T-STAFF stand-in lets staff reach
const P2 = id(7102);
const RES = id(7201);
const M1 = id(7111); // merged patient of the merge test
const M2 = id(7112); // survivor
const CANARY = 'ZZ-PHI-CANARY-7731';

const system: ScopeSettings = { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' };
const patientsJob = (ids: string[]): ScopeSettings => ({
  audience: 'system',
  realm: 'worker',
  orgId: ORG,
  jobScope: 'patients',
  jobPatientIds: ids,
});
const staffScope = (
  principalId: string,
  realm: 'google' | 'admin_pool' = 'google',
): ScopeSettings => ({
  audience: 'staff',
  realm,
  orgId: ORG,
  principalId,
});

// --- a minimal SSE client ----------------------------------------------------------------------------------------
interface Frame {
  id?: string;
  event?: string;
  data?: string;
}
interface Sse {
  status: number;
  contentType: string;
  body(): string;
  frames(): Frame[];
  events(name: string): Frame[];
  waitFor(pred: (f: Frame[]) => boolean, ms?: number): Promise<void>;
  ended(): Promise<void>;
  isEnded(): boolean;
  destroy(): void;
}

function openStream(
  base: string,
  o: { cookie: string; lastEventId?: string; release?: string | null; paused?: boolean },
): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const headers: Record<string, string> = {
      host: STAFF_HOST,
      cookie: o.cookie,
      accept: 'text/event-stream',
      ...(o.lastEventId === undefined ? {} : { 'last-event-id': o.lastEventId }),
    };
    const release = o.release === undefined ? RELEASE : o.release;
    const path = `/api/v1/alerts/stream${release === null ? '' : `?clientRelease=${encodeURIComponent(release)}`}`;
    const req = request({ host: u.hostname, port: u.port, method: 'GET', path, headers }, (res) => {
      let raw = '';
      let done = false;
      let endResolve!: () => void;
      const ended = new Promise<void>((r) => (endResolve = r));
      const finish = (): void => {
        done = true;
        endResolve();
      };
      res.setEncoding('utf8');
      res.on('data', (c: string) => (raw += c));
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
      const frames = (): Frame[] =>
        raw
          .split('\n\n')
          .filter((b) => b.trim().length > 0 && !b.startsWith('retry:'))
          .map((b) => {
            const f: Frame = {};
            for (const line of b.split('\n')) {
              const m = /^(id|event|data):? ?(.*)$/.exec(line);
              if (m !== null) f[m[1] as 'id' | 'event' | 'data'] = m[2] as string;
            }
            return f;
          });
      resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
        body: () => raw,
        frames,
        events: (n) => frames().filter((f) => f.event === n),
        async waitFor(pred, ms = 8000) {
          const t0 = Date.now();
          while (!pred(frames())) {
            if (Date.now() - t0 > ms)
              throw new Error(`timeout waiting for frames; got ${JSON.stringify(frames())}`);
            await new Promise((r) => setTimeout(r, 25));
          }
        },
        ended: () => ended,
        isEnded: () => done,
        destroy: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('staff alerts and the alert stream on PostgreSQL 17 (BE-07)', () => {
  let k: Kit;
  let app: NestExpressApplication;
  let base = '';
  let hub: StreamHub;
  let svcA: AlertService; // API tier (api queue)
  let svcW: AlertService; // worker tier (worker queue)
  let workerQueue: Queue;
  const roleHolders = new Map<string, string[]>();
  let permissionHolders: string[] = [];
  const resolver: TargetResolver = {
    roleHolders: (_tx, roleKey) => Promise.resolve(roleHolders.get(roleKey) ?? []),
    permissionHolders: () => Promise.resolve(permissionHolders),
  };
  const settings = new AlertSettingService();

  let nurse: Awaited<ReturnType<typeof seedPrincipal>>;
  let dr1: Awaited<ReturnType<typeof seedPrincipal>>;
  let dr2: Awaited<ReturnType<typeof seedPrincipal>>;
  let oncall: Awaited<ReturnType<typeof seedPrincipal>>;
  let desk: Awaited<ReturnType<typeof seedPrincipal>>;
  let compliance: Awaited<ReturnType<typeof seedPrincipal>>;
  let sDr1: SeededSession;
  let sDr2: SeededSession;
  let sOncall: SeededSession;
  let sDesk: SeededSession;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    k.q<T>(sql, p);
  const raiseSys = (input: Parameters<AlertService['raise']>[1]) =>
    k.wdb.withScope(system, (tx) => svcW.raise(tx, input));
  const getH = (s: SeededSession, path: string) => call(base, 'GET', path, { cookie: s.cookie });
  const ack = (s: SeededSession, alertId: string, key = crypto.randomUUID()) =>
    call(base, 'POST', `/api/v1/alerts/${alertId}/acknowledge`, {
      cookie: s.cookie,
      headers: { ...writeHeaders(s), 'idempotency-key': key },
    });
  const events = (alertId: string) =>
    q<{ kind: string }>(
      `SELECT kind FROM notifications.staff_alert_event WHERE alert_id = $1 ORDER BY at, id`,
      [alertId],
    );
  const jobsFor = async (alertId: string) =>
    q<{ run_at: Date }>(
      `SELECT j.run_at FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'notifications.escalate_alert' AND j.payload->>'alertId' = $1`,
      [alertId],
    );

  before(async () => {
    k = await setup({
      name: 'be07',
      withApp: false,
      fixtures: async ({ sa }) => {
        await sa.query(
          `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('${FIXTURE_STATES.licensed}', $1, 'Fixture state ${FIXTURE_STATES.licensed}')`,
          [ORG],
        );
        await sa.query(
          `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active)
           VALUES ($1, $2, 'Main', 'clinic', 'America/New_York', '${FIXTURE_STATES.licensed}', true)`,
          [L1, ORG],
        );
      },
    });
    // The M-5 patient guard refuses an alert for a patient who is not registered in the organisation (PM008): register the
    // synthetic patients the tests raise alerts for, as the patient testkit does (system settings for the merge write guard).
    await k.sa.query(
      `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
      [ORG],
    );
    for (const [n, pid] of [P1, P2, M1, M2].entries())
      await k.sa.query(
        `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via)
         VALUES ($1, $2, $3, 'Pat', 'Ient', '1975-01-01', '${FIXTURE_STATES.licensed}', 'front_desk')`,
        [pid, ORG, `MRN-${String(9_100_000 + n)}`],
      );
    await k.sa.query(
      `SELECT set_config('app.org_id', '', false), set_config('app.audience', '', false)`,
    );
    // Job types: ours, plus the handler of `alert_unacknowledged` that the owning module (clinical) will register.
    for (const j of ALERT_JOBS) k.registry.defineJob(j);
    k.registry.defineJob({
      name: 'clinical.on_alert_unacknowledged',
      maxAttempts: 3,
      onMerged: 'resolve',
      carriesPatientIds: true,
      jobScope: 'patients',
      jobClass: 'handler',
    });
    k.registry.registerHandler(ALERT_UNACKNOWLEDGED, 'clinical');
    const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
    await wc.connect();
    await syncTaskTypes(wc, k.registry);
    await wc.end();
    svcA = new AlertService({ queue: new Queue(k.registry, 'api'), resolver });
    workerQueue = new Queue(k.registry, 'worker');
    svcW = new AlertService({ queue: workerQueue, resolver });

    nurse = await seedPrincipal(k, 'google', { email: 'nurse@example.com' });
    dr1 = await seedPrincipal(k, 'google', { email: 'dr1@example.com' });
    dr2 = await seedPrincipal(k, 'google', { email: 'dr2@example.com' });
    oncall = await seedPrincipal(k, 'google', { email: 'oncall@example.com' });
    desk = await seedPrincipal(k, 'google', { email: 'desk@example.com' });
    compliance = await seedPrincipal(k, 'admin_pool', { email: 'compliance@example.com' });
    // `front_desk` and `triage_nurse` hold notifications.alert.read and .acknowledge in the reference data. The `doctor` role
    // does not (27.3 proposal): ALR-N5 in the README. The alert receivers in these tests therefore hold `front_desk`.
    for (const p of [dr1, dr2, oncall, desk]) await assignRole(k, p.principalId, 'front_desk', L1);
    await assignRole(k, nurse.principalId, 'triage_nurse', L1);
    await assignRole(k, compliance.principalId, 'compliance_on_call');
    sDr1 = await seedSession(k, dr1, 'google');
    sDr2 = await seedSession(k, dr2, 'google');
    sOncall = await seedSession(k, oncall, 'google');
    sDesk = await seedSession(k, desk, 'google');

    // The real Nest stack of the platform layer (release check, guard, filter) with OUR controllers. The platform's own
    // transport-only stream controller owns the same route, so `createApp` cannot mount ours: integration swaps them (README).
    const hubLogger = createLogger({ sink: () => undefined });
    hub = new StreamHub({
      db: k.db,
      alerts: svcA,
      listen: () => new pg.Client({ connectionString: k.urlFor('app_api') }),
      logger: hubLogger,
      pingMs: 15_000,
      revalidateMs: 400,
    });
    const controllers: Type<unknown>[] = [
      createAlertsController({
        db: k.db,
        alerts: svcA,
        scopeOf: (req) => requireAuthContext(req).scope,
      }),
      createAlertStreamController(hub, (req) => {
        const c = requireAuthContext(req);
        return { sessionId: c.session.id, principalId: c.session.principalId, scope: c.scope };
      }),
    ];
    @Module({
      controllers,
      providers: [
        { provide: GUARD_POLICY, useValue: k.identity.policy },
        { provide: LOGGER, useValue: hubLogger },
        { provide: APP_GUARD, useClass: RouteGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    })
    class TestModule {}
    app = await NestFactory.create<NestExpressApplication>(TestModule, {
      bodyParser: false,
      logger: false,
    });
    app.use(baselineHeaders);
    app.use(
      clientReleaseMiddleware(
        {
          minClientRelease: MIN_RELEASE,
          instanceCount: 1,
          integrationsHost: undefined,
          port: 0,
          requestTimeoutMs: 15_000,
        },
        { refused: () => undefined },
      ),
    );
    app.useBodyParser('json', { limit: '64kb', type: 'application/json' });
    app.use(errorMiddleware(hubLogger));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    await hub.start();
  });

  after(async () => {
    await hub?.stop();
    await app?.close();
    await k?.close();
  });

  // --------------------------------------------------------------------------------------------------------------
  describe('migration rules (22.13, ADR-022)', () => {
    test('T-STAFF fails closed until BE-08: a patient-bound alert is invisible to staff, an alert without a patient is not', async () => {
      const withPatient = await raiseSys({
        type: 'red_flag',
        severity: 'critical',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: P1,
      });
      const without = await raiseSys({
        type: 'integration_down',
        severity: 'medium',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      const seen = await k.db.withScope(staffScope(dr1.principalId), (tx) => svcA.openIds(tx));
      assert.deepEqual(
        seen.items.map((i) => i.alertId),
        [without.alertId],
      );
      assert.ok(withPatient.alertId);
      // Close both so they do not leak into the later tests.
      await k.wdb.withScope(system, async (tx) => {
        await svcW.close(tx, withPatient.alertId);
        await svcW.close(tx, without.alertId);
      });
    });

    test('install the T-STAFF stand-in (patient.staff_scope arrives with BE-08): the test replaces ONE function', async () => {
      await q(
        `CREATE OR REPLACE FUNCTION notifications.staff_scope_allows_patient(patient uuid) RETURNS boolean
           LANGUAGE sql STABLE SET search_path = pg_catalog AS $$ SELECT patient = '${P1}'::uuid $$`,
      );
      const r = await q<{ ok: boolean }>(
        `SELECT notifications.staff_scope_allows_patient($1) AS ok`,
        [P1],
      );
      assert.equal(r[0]?.ok, true);
    });

    test('M-5 patient guard: an alert for an unregistered patient is still refused (PM008) and leaves no row', async () => {
      const ghost = id(7999);
      await assert.rejects(
        raiseSys({
          type: 'red_flag',
          severity: 'critical',
          targets: { kind: 'principal', principalIds: [dr1.principalId] },
          resourceType: 'triage_assessment',
          resourceId: RES,
          patientId: ghost,
        }),
        (e: { code?: string }) => e.code === 'PM008',
      );
      assert.equal(
        (await q(`SELECT 1 FROM notifications.staff_alert WHERE patient_id = $1`, [ghost])).length,
        0,
      );
    });

    test('ADR-022: admin-realm alert types never carry a patient ID, in the service and in the table', async () => {
      for (const type of [
        'btg_opened',
        'privileged_change',
        'kill_switch_used',
        'audit_anchor_mismatch',
        'scope_drift',
        'integration_down',
      ] as const) {
        await assert.rejects(
          raiseSys({
            type,
            severity: 'high',
            targets: { kind: 'principal', principalIds: [dr1.principalId] },
            resourceType: 'grant',
            resourceId: RES,
            patientId: P1,
          }),
          (e: unknown) =>
            e instanceof NotificationsValidationError && e.fields.includes('patientId'),
          type,
        );
        // The table refuses the same row from the worker role even without the service.
        await assert.rejects(
          k.wdb.withScope(system, (tx) =>
            tx.query(
              `INSERT INTO notifications.staff_alert (id, organisation_id, type, severity, patient_id, resource_type, resource_id,
                 target_kind, target_principal_ids, status, escalation_level)
               VALUES (gen_random_uuid(), $1, $2, 'high', $3, 'grant', $4, 'principal', ARRAY[$5]::uuid[], 'open', 0)`,
              [ORG, type, P1, RES, dr1.principalId],
            ),
          ),
          (e: { code?: string }) => e.code === '23514',
          type,
        );
      }
      // A red flag without a patient is refused too.
      await assert.rejects(
        raiseSys({
          type: 'red_flag',
          severity: 'critical',
          targets: { kind: 'principal', principalIds: [dr1.principalId] },
          resourceType: 'triage_assessment',
          resourceId: RES,
        }),
        (e: unknown) => e instanceof NotificationsValidationError,
      );
    });

    test('state rules: closed is final, status moves forward only, targets are only added, one event of each kind', async () => {
      const a = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: [dr1.principalId, dr2.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      const worker = (sql: string, p: unknown[]) =>
        k.wdb.withScope(system, (tx) => tx.query(sql, p));
      // Targets cannot be removed.
      await assert.rejects(
        worker(
          `UPDATE notifications.staff_alert SET target_principal_ids = ARRAY[$2]::uuid[] WHERE id = $1`,
          [a.alertId, dr1.principalId],
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      // The worker cannot rewrite content.
      await assert.rejects(
        worker(`UPDATE notifications.staff_alert SET severity = 'critical' WHERE id = $1`, [
          a.alertId,
        ]),
        (e: { code?: string }) => e.code === '42501', // no column grant
      );
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
      await assert.rejects(
        worker(
          `UPDATE notifications.staff_alert SET status = 'escalated', escalation_level = 1 WHERE id = $1`,
          [a.alertId],
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      assert.equal(await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId)), false); // idempotent
      assert.deepEqual(
        (await events(a.alertId)).map((e) => e.kind),
        ['created', 'closed'],
      );
      // Events are append-only and `closed` exists once.
      await assert.rejects(
        q(`UPDATE notifications.staff_alert_event SET kind = 'delivered' WHERE alert_id = $1`, [
          a.alertId,
        ]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await assert.rejects(
        q(
          `INSERT INTO notifications.staff_alert_event (id, organisation_id, alert_id, kind) VALUES (gen_random_uuid(), $1, $2, 'closed')`,
          [ORG, a.alertId],
        ),
        (e: { code?: string }) => e.code === '23505',
      );
    });

    test('every new table has FORCE ROW LEVEL SECURITY and no policy matches anonymous or public', async () => {
      const t = await q<{ relname: string; f: boolean }>(
        `SELECT c.relname, c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'notifications' AND c.relname LIKE 'staff_alert%' AND c.relkind = 'r'`,
      );
      assert.equal(t.length, 3);
      assert.ok(t.every((x) => x.f));
      const pol = await q<{
        policyname: string;
        roles: string[];
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT policyname, roles::text[] AS roles, qual, with_check FROM pg_policies
          WHERE schemaname = 'notifications' AND tablename LIKE 'staff_alert%'`,
      );
      assert.ok(pol.length >= 12);
      for (const p of pol) {
        assert.ok(!p.roles.includes('public'), p.policyname);
        assert.ok(!`${p.qual}${p.with_check}`.includes('anonymous'), p.policyname);
      }
    });
  });

  // --------------------------------------------------------------------------------------------------------------
  describe('escalatesAt and escalationLevel (TC-PC-16 steps 1-2, AL-02)', () => {
    test('null rule: no configured time -> null in list, open-ids, stream and no job; configured -> equal in all three places', async () => {
      // 1. red_flag with NO escalation configured anywhere (D-12a: no default).
      const none = await raiseSys({
        type: 'red_flag',
        severity: 'critical',
        targets: { kind: 'principal', principalIds: [dr1.principalId, dr2.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: P1,
      });
      assert.equal(none.escalatesAt, null);
      assert.equal((await jobsFor(none.alertId)).length, 0);

      // 2. A configured time (staff_alert_setting) for the same type at the location: set on the new alert.
      await k.db.withScope(
        staffScope((await seedPrincipal(k, 'admin_pool')).principalId, 'admin_pool'),
        (tx) =>
          settings.put(tx, {
            alertType: 'red_flag',
            locationId: L1,
            escalateAfterMin: 10,
            escalateToDuty: 'on_call_doctor',
          }),
      );
      const withTime = await raiseSys({
        type: 'red_flag',
        severity: 'critical',
        targets: { kind: 'principal', principalIds: [dr1.principalId, dr2.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: P1,
        locationId: L1,
      });
      assert.ok(withTime.escalatesAt instanceof Date);
      const mins = (withTime.escalatesAt.getTime() - Date.now()) / 60_000;
      assert.ok(mins > 9.5 && mins <= 10.01, `escalates in ${mins} min`);
      const jobs = await jobsFor(withTime.alertId);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.run_at.getTime(), withTime.escalatesAt.getTime());

      // The stream (opened after the alert: replay) and the two reads carry the same two fields.
      const sse = await openStream(base, { cookie: sDr1.cookie });
      assert.equal(sse.status, 200);
      await sse.waitFor((f) =>
        f.some(
          (x) => x.event === 'alert' && JSON.parse(x.data ?? '{}').alertId === withTime.alertId,
        ),
      );
      const fromStream = sse
        .events('alert')
        .map((f) => JSON.parse(f.data as string))
        .find((d) => d.alertId === withTime.alertId);
      const list = await getH(sDr1, '/api/v1/alerts?status=open');
      assert.equal(list.status, 200);
      const items = list.json()['items'] as Record<string, unknown>[];
      const fromList = items.find((i) => i['alertId'] === withTime.alertId) as Record<
        string,
        unknown
      >;
      const open = await getH(sDr1, '/api/v1/alerts/open-ids');
      const fromOpen = (open.json()['items'] as Record<string, unknown>[]).find(
        (i) => i['alertId'] === withTime.alertId,
      ) as Record<string, unknown>;
      const iso = withTime.escalatesAt.toISOString();
      assert.equal(fromStream.escalatesAt, iso);
      assert.equal(fromList['escalatesAt'], iso);
      assert.equal(fromOpen['escalatesAt'], iso);
      for (const v of [
        fromStream.escalationLevel,
        fromList['escalationLevel'],
        fromOpen['escalationLevel'],
      ])
        assert.equal(v, 0);
      // The alert with no time: null, in every place.
      const noneList = items.find((i) => i['alertId'] === none.alertId) as Record<string, unknown>;
      assert.equal(noneList['escalatesAt'], null);
      assert.equal(noneList['escalationLevel'], 0);
      const noneStream = sse
        .events('alert')
        .map((f) => JSON.parse(f.data as string))
        .find((d) => d.alertId === none.alertId);
      assert.equal(noneStream.escalatesAt, null);
      sse.destroy();
      // Listing carries the closed shape of 29.3.
      assert.deepEqual(
        Object.keys(fromList).sort(),
        [
          'acknowledgedAt',
          'acknowledgedBy',
          'acknowledgedByDisplayName',
          'alertId',
          'createdAt',
          'escalatesAt',
          'escalationLevel',
          'link',
          'patientId',
          'resourceId',
          'resourceType',
          'seq',
          'severity',
          'status',
          'type',
        ].sort(),
      );
      // The alert is for the target only: the desk worker (not a target) sees neither alert.
      const deskList = await getH(sDesk, '/api/v1/alerts?status=open');
      assert.deepEqual(deskList.json()['items'], []);
      // Clean up for later tests.
      await k.wdb.withScope(system, async (tx) => {
        await svcW.close(tx, none.alertId);
        await svcW.close(tx, withTime.alertId);
      });
    });

    test('the clinical setting red_flag_escalation_minutes is the fallback for red_flag; the alert-setting row wins; other types have none', async () => {
      await q(`DELETE FROM notifications.staff_alert_setting`);
      await q(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'red_flag_escalation_minutes', '7'::jsonb, 'int>=1')
         ON CONFLICT ON CONSTRAINT setting_org_key_location_uq DO UPDATE SET value = '7'::jsonb`,
        [ORG],
      );
      const a = await raiseSys({
        type: 'red_flag',
        severity: 'critical',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: P1,
      });
      assert.ok(a.escalatesAt);
      assert.ok(Math.abs((a.escalatesAt.getTime() - Date.now()) / 60_000 - 7) < 0.5);
      const other = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      assert.equal(other.escalatesAt, null);
      await q(`DELETE FROM kernel.setting WHERE key = 'red_flag_escalation_minutes'`);
      await k.wdb.withScope(system, async (tx) => {
        await svcW.close(tx, a.alertId);
        await svcW.close(tx, other.alertId);
      });
    });

    test('settings are validated and admin-realm only', async () => {
      await assert.rejects(
        k.db.withScope(staffScope(compliance.principalId, 'admin_pool'), (tx) =>
          settings.put(tx, {
            alertType: 'red_flag',
            locationId: null,
            escalateAfterMin: 0,
            escalateToDuty: 'on_call_doctor',
          }),
        ),
        (e: unknown) => e instanceof NotificationsValidationError,
      );
      await assert.rejects(
        k.db.withScope(staffScope(dr1.principalId), (tx) =>
          settings.put(tx, {
            alertType: 'red_flag',
            locationId: null,
            escalateAfterMin: 5,
            escalateToDuty: 'on_call_doctor',
          }),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await k.db.withScope(staffScope(compliance.principalId, 'admin_pool'), async (tx) => {
        await settings.put(tx, {
          alertType: 'btg_opened',
          locationId: null,
          escalateAfterMin: 5,
          escalateToDuty: 'compliance_on_call',
        });
        await settings.put(tx, {
          alertType: 'btg_opened',
          locationId: null,
          escalateAfterMin: 9,
          escalateToDuty: 'compliance_on_call',
        });
      });
      const rows = await k.db.withScope(staffScope(dr1.principalId), (tx) => settings.list(tx));
      assert.deepEqual(rows, [
        {
          alertType: 'btg_opened',
          locationId: null,
          escalateAfterMin: 9,
          escalateToDuty: 'compliance_on_call',
        },
      ]);
      await q(`DELETE FROM notifications.staff_alert_setting`);
    });
  });

  // --------------------------------------------------------------------------------------------------------------
  describe('acknowledge (TC-PC-16 steps 3-4)', () => {
    test('two simultaneous acknowledgements both get 200 with exactly one acknowledged event; escalatesAt null after', async () => {
      await q(
        `INSERT INTO notifications.staff_alert_setting (id, organisation_id, alert_type, location_id, escalate_after_min, escalate_to_duty)
         VALUES (gen_random_uuid(), $1, 'integration_down', NULL, 5, 'on_call_doctor')`,
        [ORG],
      );
      const a = await raiseSys({
        type: 'integration_down',
        severity: 'high',
        targets: { kind: 'principal', principalIds: [dr1.principalId, dr2.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      assert.ok(a.escalatesAt);
      const [r1, r2] = await Promise.all([ack(sDr1, a.alertId), ack(sDr2, a.alertId)]);
      assert.equal(r1.status, 200, r1.body);
      assert.equal(r2.status, 200, r2.body);
      const b1 = r1.json();
      const b2 = r2.json();
      assert.deepEqual([b1['alreadyAcknowledged'], b2['alreadyAcknowledged']].sort(), [
        false,
        true,
      ]);
      for (const b of [b1, b2]) {
        assert.equal(b['status'], 'acknowledged');
        assert.equal(b['escalatesAt'], null);
        assert.equal(b['escalationLevel'], 0);
        assert.equal(b['alertId'], a.alertId);
      }
      // Both responses name the SAME acknowledger and time: the stored values.
      assert.equal(b1['acknowledgedBy'], b2['acknowledgedBy']);
      assert.equal(b1['acknowledgedAt'], b2['acknowledgedAt']);
      assert.deepEqual(
        (await events(a.alertId)).map((e) => e.kind).filter((x) => x === 'acknowledged'),
        ['acknowledged'],
      );
      const row = (
        await q<{ status: string; escalate_at: Date | null; acknowledged_by: string }>(
          `SELECT status, escalate_at, acknowledged_by FROM notifications.staff_alert WHERE id = $1`,
          [a.alertId],
        )
      )[0];
      assert.equal(row?.status, 'acknowledged');
      assert.equal(row?.escalate_at, null);
      assert.equal(row?.acknowledged_by, b1['acknowledgedBy']);
      // The list shows the display-name source the contract names (null here: no staff profile) and a null countdown.
      const list = await getH(sDr1, '/api/v1/alerts?status=acknowledged');
      const item = (list.json()['items'] as Record<string, unknown>[]).find(
        (i) => i['alertId'] === a.alertId,
      );
      assert.equal(item?.['escalatesAt'], null);
      assert.equal(item?.['status'], 'acknowledged');
      // A repeat acknowledge (a second click, another key) is 200 alreadyAcknowledged, no new event.
      const again = await ack(sDr1, a.alertId);
      assert.equal(again.status, 200);
      assert.equal(again.json()['alreadyAcknowledged'], true);
      assert.equal((await events(a.alertId)).filter((e) => e.kind === 'acknowledged').length, 1);
      // 4. After the alert is closed: 409 notifications.alert_closed.
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
      const closed = await ack(sDr2, a.alertId);
      assert.equal(closed.status, 409);
      assert.equal(closed.json()['code'], 'notifications.alert_closed');
    });

    test('the same Idempotency-Key replays the first answer; a reused key for another alert conflicts; the key is required', async () => {
      const a = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      const b = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      const key = crypto.randomUUID();
      const first = await ack(sDr1, a.alertId, key);
      const replay = await ack(sDr1, a.alertId, key);
      assert.equal(first.status, 200);
      assert.deepEqual(replay.json(), first.json());
      const clash = await ack(sDr1, b.alertId, key);
      assert.equal(clash.status, 409);
      assert.equal(clash.json()['code'], 'kernel.idempotency_conflict');
      const nokey = await call(base, 'POST', `/api/v1/alerts/${b.alertId}/acknowledge`, {
        cookie: sDr1.cookie,
        headers: writeHeaders(sDr1),
      });
      assert.equal(nokey.status, 400);
      await k.wdb.withScope(system, async (tx) => {
        await svcW.close(tx, a.alertId);
        await svcW.close(tx, b.alertId);
      });
    });

    test('a principal who is not a target gets 404 kernel.not_found, with no side effect', async () => {
      const a = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      const r = await ack(sDesk, a.alertId);
      assert.equal(r.status, 404);
      assert.equal(r.json()['code'], 'kernel.not_found');
      const bad = await ack(sDesk, 'not-a-uuid');
      assert.equal(bad.status, 404);
      assert.deepEqual(
        (await events(a.alertId)).map((e) => e.kind),
        ['created'],
      );
      assert.equal(
        (await q(`SELECT status FROM notifications.staff_alert WHERE id = $1`, [a.alertId]))[0]?.[
          'status'
        ],
        'open',
      );
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test('HEAAA-286 (draft 8.3): a red flag targeted at a principal holding the seeded doctor role is listed, streamed and acknowledged; a doctor who is not targeted gets 404 and sees nothing (38.2 item 22)', async () => {
      const targeted = await seedPrincipal(k, 'google', { email: 'doctor.target@example.com' });
      const other = await seedPrincipal(k, 'google', { email: 'doctor.other@example.com' });
      for (const p of [targeted, other]) await assignRole(k, p.principalId, 'doctor', L1);
      const sTarget = await seedSession(k, targeted, 'google');
      const sOther = await seedSession(k, other, 'google');
      const a = await raiseSys({
        type: 'red_flag',
        severity: 'high',
        targets: { kind: 'principal', principalIds: [targeted.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: P1,
      });
      const stream = await openStream(base, { cookie: sTarget.cookie });
      assert.equal(stream.status, 200, 'the guard lets the doctor in: notifications.alert.read');
      await stream.waitFor((f) =>
        f.some((x) => x.event === 'alert' && JSON.parse(x.data ?? '{}').alertId === a.alertId),
      );
      stream.destroy();
      const list = await getH(sTarget, '/api/v1/alerts?status=open');
      assert.equal(list.status, 200, list.body);
      assert.ok(
        (list.json()['items'] as { alertId: string }[]).some((x) => x.alertId === a.alertId),
        'the targeted doctor lists the alert',
      );
      const none = await getH(sOther, '/api/v1/alerts?status=open');
      assert.equal(none.status, 200, none.body);
      assert.ok(
        !(none.json()['items'] as { alertId: string }[]).some((x) => x.alertId === a.alertId),
        'a doctor who is not targeted does not see it',
      );
      const refused = await ack(sOther, a.alertId);
      assert.equal(refused.status, 404);
      assert.equal(refused.json()['code'], 'kernel.not_found');
      const ok = await ack(sTarget, a.alertId);
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json()['status'], 'acknowledged');
      assert.equal(ok.json()['acknowledgedBy'], targeted.principalId);
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test('an admin-realm principal (compliance) reads and acknowledges an alert of a compliance type in its own scope; no patient anywhere', async () => {
      const a = await raiseSys({
        type: 'btg_opened',
        severity: 'high',
        targets: { kind: 'compliance_permission', permission: 'audit.btg.review' },
        resourceType: 'btg_grant',
        resourceId: RES,
      }).catch((e: unknown) => e);
      assert.ok(
        a instanceof NotificationsValidationError,
        'no holders resolved -> refused, never an alert without a target',
      );
      permissionHolders = [compliance.principalId];
      const ok = await raiseSys({
        type: 'btg_opened',
        severity: 'high',
        targets: { kind: 'compliance_permission', permission: 'audit.btg.review' },
        resourceType: 'btg_grant',
        resourceId: RES,
      });
      const scope = staffScope(compliance.principalId, 'admin_pool');
      const seen = await k.db.withScope(scope, (tx) => svcA.list(tx, { status: 'open' }));
      const item = seen.items.find((i) => i.alertId === ok.alertId);
      assert.ok(item);
      assert.equal(item.patientId, null);
      const res = await k.db.withScope(scope, (tx) => svcA.acknowledge(tx, ok.alertId));
      assert.equal(res.alreadyAcknowledged, false);
      assert.equal(res.acknowledgedBy, compliance.principalId);
      await k.wdb.withScope(system, (tx) => svcW.close(tx, ok.alertId));
    });

    test('INT04-F10-D: the real resolver and the realm rule: admin_pool holders only, actor excluded, admin_pool and google sessions on the routes, other realms refused', async () => {
      const real = new AlertService({
        queue: new Queue(k.registry, 'api'),
        resolver: createTargetResolver(),
      });
      const other = await seedPrincipal(k, 'admin_pool', { email: 'compliance2@example.com' });
      await assignRole(k, other.principalId, 'compliance_officer');
      const disabled = await seedPrincipal(k, 'admin_pool', {
        email: 'compliance3@example.com',
        status: 'disabled',
      });
      await assignRole(k, disabled.principalId, 'compliance_on_call');
      const targets = { kind: 'compliance_permission', permission: 'audit.btg.review' } as const;
      const raise = (scope: ScopeSettings) =>
        k.wdb.withScope(scope, (tx) =>
          real.raise(tx, {
            type: 'btg_opened',
            severity: 'high',
            targets,
            resourceType: 'btg_grant',
            resourceId: RES,
          }),
        );
      // Under the worker (no actor): every active admin_pool holder of the permission, and no google principal.
      const a = await raise(system);
      assert.deepEqual(
        a.targetPrincipalIds,
        [compliance.principalId, other.principalId].sort(),
        'active admin_pool holders only (not the disabled one, not a google staff member)',
      );
      const row = await q<{ patient_id: string | null }>(
        `SELECT patient_id FROM notifications.staff_alert WHERE id = $1`,
        [a.alertId],
      );
      assert.equal(row[0]?.patient_id, null, 'an admin alert never carries a patient');
      // The actor is excluded.
      const b = await raise({ ...system, principalId: other.principalId });
      assert.deepEqual(b.targetPrincipalIds, [compliance.principalId]);
      // A role target resolves google holders at the location only.
      const c = await k.wdb.withScope(system, (tx) =>
        createTargetResolver().roleHolders(tx, 'front_desk', [L1]),
      );
      assert.deepEqual(c.sort(), [dr1, dr2, oncall, desk].map((p) => p.principalId).sort());

      // The routes accept admin_pool and google; patient sessions and the other realms are refused.
      const sAdmin = await seedSession(k, compliance, 'admin_pool');
      const list = await getH(sAdmin, '/api/v1/alerts?status=open');
      assert.equal(list.status, 200, list.body);
      const items = list.json()['items'] as { alertId: string; patientId: string | null }[];
      const mine = items.find((i) => i.alertId === a.alertId);
      assert.ok(mine);
      assert.equal(mine.patientId, null);
      assert.equal((await getH(sAdmin, '/api/v1/alerts/open-ids')).status, 200);
      const ok = await ack(sAdmin, a.alertId);
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json()['acknowledgedBy'], compliance.principalId);
      const stream = await openStream(base, { cookie: sAdmin.cookie });
      assert.equal(stream.status, 200);
      stream.destroy();
      assert.equal((await getH(sDr1, '/api/v1/alerts')).status, 200, 'google still accepted');

      const patient = await seedPrincipal(k, 'patient_pool', { email: 'pp@example.com' });
      const sPatient = await seedSession(k, patient, 'patient_pool');
      for (const path of ['/api/v1/alerts', '/api/v1/alerts/open-ids']) {
        const r = await getH(sPatient, path);
        assert.equal(r.status, 403, `patient session ${path}`);
      }
      assert.equal((await ack(sPatient, a.alertId)).status, 403);
      assert.equal((await openStream(base, { cookie: sPatient.cookie })).status, 403);
      await k.wdb.withScope(system, async (tx) => {
        await real.close(tx, a.alertId);
        await real.close(tx, b.alertId);
      });
    });
  });

  // --------------------------------------------------------------------------------------------------------------
  describe('escalation job (32.4, TC-PC-16 step 5)', () => {
    // The patient guard also runs on UPDATE of a patient-bound alert, so the fixture write carries the settings of a system job.
    const due = async (alertId: string) => {
      await k.sa.query('BEGIN');
      try {
        await k.sa.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
          [ORG],
        );
        await k.sa.query(
          `UPDATE notifications.staff_alert SET escalate_at = now() - interval '1 second' WHERE id = $1 AND status = 'open'`,
          [alertId],
        );
        await k.sa.query('COMMIT');
      } catch (e) {
        await k.sa.query('ROLLBACK');
        throw e;
      }
    };
    const run = (alertId: string) =>
      k.wdb.withScope(patientsJob([P1]), (tx) =>
        escalateAlert(tx, workerQueue, { alertId, level: 1 }),
      );
    const timed = async (patient = true) => {
      await q(`DELETE FROM notifications.staff_alert_setting`);
      await q(
        `INSERT INTO notifications.staff_alert_setting (id, organisation_id, alert_type, location_id, escalate_after_min, escalate_to_duty)
         VALUES (gen_random_uuid(), $1, 'red_flag', NULL, 5, 'on_call_doctor'), (gen_random_uuid(), $1, 'integration_down', NULL, 5, 'on_call_doctor')`,
        [ORG],
      );
      return raiseSys({
        type: patient ? 'red_flag' : 'integration_down',
        severity: 'critical',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        ...(patient ? { patientId: P1 } : {}),
      });
    };

    test('the job does nothing after an acknowledge (no escalated event, no status change, nothing published)', async () => {
      const a = await timed();
      await k.db.withScope(staffScope(dr1.principalId), (tx) => svcA.acknowledge(tx, a.alertId));
      await due(a.alertId); // matches no row: acknowledge cleared the timer (the update filters on status = open)
      assert.equal(await run(a.alertId), 'acknowledged');
      assert.equal((await events(a.alertId)).filter((e) => e.kind === 'escalated').length, 0);
      assert.equal(
        (
          await q(`SELECT status, escalation_level FROM notifications.staff_alert WHERE id = $1`, [
            a.alertId,
          ])
        )[0]?.['status'],
        'acknowledged',
      );
      assert.equal(
        (
          await q(
            `SELECT 1 FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'clinical.on_alert_unacknowledged' AND j.payload->>'alertId' = $1`,
            [a.alertId],
          )
        ).length,
        0,
      );
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test('an unacknowledged alert escalates once: level 1, status escalated, escalate_at cleared, one event, event published; a repeat does nothing', async () => {
      const a = await timed();
      assert.equal(
        await run(a.alertId),
        'rescheduled',
        'ran before its time: put back, not escalated early',
      );
      assert.equal(
        (await q(`SELECT status FROM notifications.staff_alert WHERE id = $1`, [a.alertId]))[0]?.[
          'status'
        ],
        'open',
      );
      await due(a.alertId);
      assert.equal(await run(a.alertId), 'escalated');
      const row = (
        await q<Record<string, unknown>>(
          `SELECT status, escalation_level, escalate_at FROM notifications.staff_alert WHERE id = $1`,
          [a.alertId],
        )
      )[0];
      assert.equal(row?.['status'], 'escalated');
      assert.equal(row?.['escalation_level'], 1);
      assert.equal(row?.['escalate_at'], null);
      assert.deepEqual(
        (await events(a.alertId)).map((e) => e.kind),
        ['created', 'escalated'],
      );
      const pub = await q<{ payload: Record<string, unknown> }>(
        `SELECT j.payload FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'clinical.on_alert_unacknowledged' AND j.payload->>'alertId' = $1`,
        [a.alertId],
      );
      assert.equal(pub.length, 1);
      assert.deepEqual(pub[0]?.payload, { alertId: a.alertId, patientId: P1, level: 1 });
      // Idempotent by (alert, level): a second run, or a concurrent pair, changes nothing.
      assert.equal(await run(a.alertId), 'already_escalated');
      const both = await Promise.all([run(a.alertId), run(a.alertId)]);
      assert.deepEqual(both, ['already_escalated', 'already_escalated']);
      assert.equal((await events(a.alertId)).filter((e) => e.kind === 'escalated').length, 1);
      // The reads: escalated stays in the list and the tray with a null countdown and level 1 (N-6).
      const open = await getH(sDr1, '/api/v1/alerts/open-ids');
      const it = (open.json()['items'] as Record<string, unknown>[]).find(
        (i) => i['alertId'] === a.alertId,
      );
      assert.deepEqual(
        { s: it?.['status'], l: it?.['escalationLevel'], e: it?.['escalatesAt'] },
        { s: 'escalated', l: 1, e: null },
      );
      const listed = await getH(sDr1, '/api/v1/alerts?status=open');
      assert.ok(
        (listed.json()['items'] as Record<string, unknown>[]).some(
          (i) => i['alertId'] === a.alertId,
        ),
      );
      // 22.13 / ADR-022: the owning module adds the on-call doctor now (resolved to a principal at this escalation).
      roleHolders.set('on_call_doctor', [oncall.principalId, oncall.principalId]);
      assert.equal(
        (await getH(sOncall, '/api/v1/alerts/open-ids')).json()['items'] instanceof Array,
        true,
      );
      assert.ok(
        !(
          (await getH(sOncall, '/api/v1/alerts/open-ids')).json()['items'] as Record<
            string,
            unknown
          >[]
        ).some((i) => i['alertId'] === a.alertId),
      );
      const added = await k.wdb.withScope(patientsJob([P1]), (tx) =>
        svcW.addEscalationTargets(tx, a.alertId, {
          kind: 'role_location',
          roleKey: 'on_call_doctor',
          locationIds: [L1],
        }),
      );
      assert.deepEqual(added, [oncall.principalId]);
      const seen = (await getH(sOncall, '/api/v1/alerts/open-ids')).json()['items'] as Record<
        string,
        unknown
      >[];
      assert.ok(seen.some((i) => i['alertId'] === a.alertId));
      assert.ok(
        (
          (await getH(sDr1, '/api/v1/alerts/open-ids')).json()['items'] as Record<string, unknown>[]
        ).some((i) => i['alertId'] === a.alertId),
        'the first target keeps it',
      );
      // The staff tier may not add targets (only T-SYS), and a target acknowledges an escalated alert.
      await assert.rejects(
        k.db.withScope(staffScope(dr1.principalId), (tx) =>
          svcA.addEscalationTargets(tx, a.alertId, {
            kind: 'principal',
            principalIds: [desk.principalId],
          }),
        ),
      );
      const r = await ack(sOncall, a.alertId);
      assert.equal(r.status, 200);
      assert.equal(r.json()['escalationLevel'], 1);
      assert.equal(r.json()['escalatesAt'], null);
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test('acknowledge racing the escalation job: one consistent outcome, one event of each kind', async () => {
      for (let i = 0; i < 5; i++) {
        const a = await timed(false);
        await due(a.alertId);
        const runOrg = () =>
          k.wdb.withScope(system, (tx) =>
            escalateAlert(tx, workerQueue, { alertId: a.alertId, level: 1 }),
          );
        const [r, c] = await Promise.all([runOrg(), ack(sDr1, a.alertId)]);
        assert.equal(c.status, 200);
        const ev = (await events(a.alertId)).map((e) => e.kind);
        assert.equal(ev.filter((x) => x === 'acknowledged').length, 1, ev.join());
        assert.ok(['escalated', 'acknowledged'].includes(r), r);
        assert.equal(
          ev.filter((x) => x === 'escalated').length,
          r === 'escalated' ? 1 : 0,
          `${r} ${ev.join()}`,
        );
        const st = (
          await q<{ status: string; escalate_at: Date | null }>(
            `SELECT status, escalate_at FROM notifications.staff_alert WHERE id = $1`,
            [a.alertId],
          )
        )[0];
        assert.equal(st?.status, 'acknowledged');
        assert.equal(st?.escalate_at, null);
        await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
      }
    });

    test('an alert without a patient escalates in an org scope; the job refuses a staff scope and a bad level', async () => {
      const a = await timed(false);
      await due(a.alertId);
      await assert.rejects(
        k.db.withScope(staffScope(dr1.principalId), (tx) =>
          escalateAlert(tx, new Queue(k.registry, 'api'), { alertId: a.alertId, level: 1 }),
        ),
        (e: unknown) => e instanceof NotificationsValidationError,
      );
      await assert.rejects(
        k.wdb.withScope(system, (tx) =>
          escalateAlert(tx, workerQueue, { alertId: a.alertId, level: 2 }),
        ),
        (e: unknown) => e instanceof NotificationsValidationError,
      );
      assert.equal(
        await k.wdb.withScope(system, (tx) =>
          escalateAlert(tx, workerQueue, { alertId: a.alertId, level: 1 }),
        ),
        'escalated',
      );
      // A patients-scope job that does not name the patient cannot see a patient alert (RLS), so nothing happens.
      const p = await timed(true);
      await due(p.alertId);
      assert.equal(
        await k.wdb.withScope(patientsJob([P2]), (tx) =>
          escalateAlert(tx, workerQueue, { alertId: p.alertId, level: 1 }),
        ),
        'not_found',
      );
      await k.wdb.withScope(system, async (tx) => {
        await svcW.close(tx, a.alertId);
        await svcW.close(tx, p.alertId);
      });
      await q(`DELETE FROM notifications.staff_alert_setting`);
    });
  });

  // --------------------------------------------------------------------------------------------------------------
  describe('targets (ADR-022) and row-level security', () => {
    test('role and permission targets are resolved to principals at creation, de-duplicated; unresolvable targets are refused', async () => {
      roleHolders.set('duty_doctor', [
        dr2.principalId,
        dr1.principalId,
        dr2.principalId.toUpperCase(),
      ]);
      const a = await raiseSys({
        type: 'red_flag',
        severity: 'critical',
        targets: { kind: 'role_location', roleKey: 'duty_doctor', locationIds: [L1] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: P1,
      });
      assert.deepEqual(a.targetPrincipalIds, [dr1.principalId, dr2.principalId].sort());
      const row = (
        await q<Record<string, unknown>>(
          `SELECT target_kind, target_role_key, target_location_ids, target_principal_ids FROM notifications.staff_alert WHERE id = $1`,
          [a.alertId],
        )
      )[0];
      assert.equal(row?.['target_kind'], 'role_location');
      assert.equal(row?.['target_role_key'], 'duty_doctor');
      assert.deepEqual(row?.['target_location_ids'], [L1]);
      roleHolders.set('nobody', []);
      await assert.rejects(
        raiseSys({
          type: 'red_flag',
          severity: 'critical',
          targets: { kind: 'role_location', roleKey: 'nobody', locationIds: [L1] },
          resourceType: 'triage_assessment',
          resourceId: RES,
          patientId: P1,
        }),
        (e: unknown) => e instanceof NotificationsValidationError,
      );
      await assert.rejects(
        raiseSys({
          type: 'red_flag',
          severity: 'critical',
          targets: { kind: 'principal', principalIds: ['x'] },
          resourceType: 'triage_assessment',
          resourceId: RES,
          patientId: P1,
        }),
        (e: unknown) => e instanceof NotificationsValidationError,
      );
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test('a rolled-back alert leaves no row, no event, no job and sends no notification', async () => {
      const before = (
        await q<{ n: string }>(`SELECT count(*) AS n FROM notifications.staff_alert`)
      )[0]?.n;
      const listener = new pg.Client({ connectionString: k.urlFor('app_api') });
      await listener.connect();
      const got: string[] = [];
      listener.on('notification', (m: { payload?: string }) => got.push(m.payload ?? ''));
      await listener.query('LISTEN staff_alert');
      await assert.rejects(
        k.wdb.withScope(system, async (tx) => {
          await svcW.raise(tx, {
            type: 'integration_down',
            severity: 'low',
            targets: { kind: 'principal', principalIds: [dr1.principalId] },
            resourceType: 'connection',
            resourceId: RES,
          });
          throw new Error('abort');
        }),
        /abort/,
      );
      await sleep(300);
      assert.equal(
        (await q<{ n: string }>(`SELECT count(*) AS n FROM notifications.staff_alert`))[0]?.n,
        before,
      );
      assert.deepEqual(got, []);
      await listener.end();
    });

    test('the NOTIFY payload is IDs only, below 8,000 bytes, and broadcast beyond 100 targets', async () => {
      const listener = new pg.Client({ connectionString: k.urlFor('app_api') });
      await listener.connect();
      const got: Record<string, unknown>[] = [];
      listener.on('notification', (m: { payload?: string }) =>
        got.push(JSON.parse(m.payload ?? '{}') as Record<string, unknown>),
      );
      await listener.query('LISTEN staff_alert');
      const small = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: [dr1.principalId, dr2.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      const many = Array.from({ length: 150 }, (_, i) => id(8000 + i));
      const big = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: many },
        resourceType: 'connection',
        resourceId: RES,
      });
      for (let i = 0; i < 40 && got.length < 2; i++) await sleep(50);
      const s = got.find((g) => g['alertId'] === small.alertId) as Record<string, unknown>;
      const b = got.find((g) => g['alertId'] === big.alertId) as Record<string, unknown>;
      assert.deepEqual(Object.keys(s).sort(), ['alertId', 'kind', 'seq', 'targets']);
      assert.deepEqual(s['targets'], [dr1.principalId, dr2.principalId].sort());
      assert.deepEqual(Object.keys(b).sort(), ['alertId', 'broadcast', 'kind', 'seq']);
      assert.equal(b['broadcast'], true);
      await listener.end();
      await k.wdb.withScope(system, async (tx) => {
        await svcW.close(tx, small.alertId);
        await svcW.close(tx, big.alertId);
      });
    });

    test('RLS: the creator of a red flag reads it back in her own transaction but never in a tray; a non-target reads nothing; staff cannot forge other types', async () => {
      const a = await k.db.withScope(staffScope(nurse.principalId), (tx) =>
        svcA.raise(tx, {
          type: 'red_flag',
          severity: 'critical',
          targets: { kind: 'principal', principalIds: [dr1.principalId] },
          resourceType: 'triage_assessment',
          resourceId: RES,
          patientId: P1,
        }),
      );
      // Creator: row visible by the creator policy, not in her tray (own targets).
      const raw = await k.db.withScope(staffScope(nurse.principalId), (tx) =>
        tx.query(`SELECT id FROM notifications.staff_alert WHERE id = $1`, [a.alertId]),
      );
      assert.equal(raw.rows.length, 1);
      const tray = await k.db.withScope(staffScope(nurse.principalId), (tx) => svcA.openIds(tx));
      assert.ok(!tray.items.some((i) => i.alertId === a.alertId));
      // A non-target staff member cannot read it.
      const other = await k.db.withScope(staffScope(desk.principalId), (tx) =>
        tx.query(`SELECT id FROM notifications.staff_alert WHERE id = $1`, [a.alertId]),
      );
      assert.equal(other.rows.length, 0);
      // The target sees it.
      const mine = await k.db.withScope(staffScope(dr1.principalId), (tx) => svcA.openIds(tx));
      assert.ok(mine.items.some((i) => i.alertId === a.alertId));
      // Forgery: any other type, the admin realm, a patient out of scope, someone else's creator ID.
      const forge = (
        scope: ScopeSettings,
        type: string,
        patient: string | null,
        by: string | null,
      ) =>
        k.db.withScope(scope, (tx) =>
          tx.query(
            `INSERT INTO notifications.staff_alert (id, organisation_id, type, severity, patient_id, resource_type, resource_id, target_kind, target_principal_ids, status, escalation_level, created_by)
             VALUES (gen_random_uuid(), $1, $2, 'high', $3, 'x', $4, 'principal', ARRAY[$5]::uuid[], 'open', 0, $6)`,
            [ORG, type, patient, RES, dr1.principalId, by],
          ),
        );
      for (const type of ['btg_opened', 'kill_switch_used', 'integration_down', 'note_unsigned'])
        await assert.rejects(
          forge(
            staffScope(nurse.principalId),
            type,
            type === 'note_unsigned' ? P1 : null,
            nurse.principalId,
          ),
          (e: { code?: string }) => e.code === '42501',
          type,
        );
      await assert.rejects(
        forge(
          staffScope(compliance.principalId, 'admin_pool'),
          'red_flag',
          P1,
          compliance.principalId,
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        forge(staffScope(nurse.principalId), 'red_flag', P2, nurse.principalId),
        (e: { code?: string }) => e.code === '42501',
        'patient out of scope',
      );
      await assert.rejects(
        forge(staffScope(nurse.principalId), 'red_flag', P1, dr1.principalId),
        (e: { code?: string }) => e.code === '42501',
        'created_by must be the caller',
      );
      // A target may only acknowledge: no status other than acknowledged, no other column, no delete.
      const upd = (sql: string) =>
        k.db.withScope(staffScope(dr1.principalId), (tx) => tx.query(sql, [a.alertId]));
      await assert.rejects(
        upd(`UPDATE notifications.staff_alert SET status = 'closed' WHERE id = $1`),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        upd(
          `UPDATE notifications.staff_alert SET target_principal_ids = ARRAY[]::uuid[] WHERE id = $1`,
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        upd(`DELETE FROM notifications.staff_alert WHERE id = $1`),
        (e: { code?: string }) => e.code === '42501',
      );
      // A non-target's acknowledge changes nothing.
      const none = await k.db.withScope(staffScope(desk.principalId), (tx) =>
        tx.query(
          `UPDATE notifications.staff_alert SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1`,
          [a.alertId, desk.principalId],
        ),
      );
      assert.equal(none.rowCount, 0);
      // Event forgery: another principal's ID, an `escalated` event, a `created` event by a non-creator.
      const ev = (scope: ScopeSettings, kind: string, who: string) =>
        k.db.withScope(scope, (tx) =>
          tx.query(
            `INSERT INTO notifications.staff_alert_event (id, organisation_id, alert_id, patient_id, kind, principal_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
            [ORG, a.alertId, P1, kind, who],
          ),
        );
      await assert.rejects(
        ev(staffScope(dr1.principalId), 'acknowledged', dr2.principalId),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        ev(staffScope(dr1.principalId), 'escalated', dr1.principalId),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        ev(staffScope(dr1.principalId), 'created', dr1.principalId),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        ev(staffScope(desk.principalId), 'acknowledged', desk.principalId),
        (e: { code?: string }) => e.code === '42501',
      );
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test('the anonymous and patient audiences read and write nothing', async () => {
      const anon: ScopeSettings = { audience: 'anonymous', orgId: ORG };
      const pat: ScopeSettings = {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: dr1.principalId,
        patientIds: [P1],
        proxyPatientIds: [],
      };
      for (const s of [anon, pat]) {
        for (const t of ['staff_alert', 'staff_alert_event', 'staff_alert_setting'])
          assert.equal(
            (await k.db.withScope(s, (tx) => tx.query(`SELECT 1 FROM notifications.${t}`))).rows
              .length,
            0,
            `${s.audience} ${t}`,
          );
      }
    });
  });

  // --------------------------------------------------------------------------------------------------------------
  describe('the alert stream (38.2 item 6, ARCHITECTURE 32)', () => {
    test('an outdated, malformed or missing clientRelease is refused with a plain 400 before any event; a current one connects', async () => {
      for (const release of [
        'r1.3f9a1c2b7d10',
        `r${MIN_RELEASE - 1}.3f9a1c2b7d10`,
        'garbage',
        null,
      ]) {
        const s = await openStream(base, { cookie: sDr1.cookie, release });
        assert.equal(s.status, 400, String(release));
        assert.ok(s.contentType.startsWith('application/problem+json'), s.contentType);
        assert.ok(!s.body().includes('event:'), 'no text/event-stream output');
        assert.equal(JSON.parse(s.body()).code, 'kernel.client_release_unsupported');
        await s.ended();
      }
      // The previous and a newer release are accepted (28.6).
      for (const n of [MIN_RELEASE, MIN_RELEASE + 5]) {
        const s = await openStream(base, { cookie: sDr1.cookie, release: `r${n}.3f9a1c2b7d10` });
        assert.equal(s.status, 200);
        assert.ok(s.contentType.startsWith('text/event-stream'));
        s.destroy();
      }
      // No cookie: 401, never a stream.
      const anon = await openStream(base, { cookie: '' });
      assert.equal(anon.status, 401);
    });

    test('replay on reconnect in seq order after Last-Event-ID; live alerts through the real LISTEN/NOTIFY; alert_closed to the other target', async () => {
      const mk = (patient: boolean) =>
        raiseSys({
          type: patient ? 'red_flag' : 'integration_down',
          severity: 'high',
          targets: { kind: 'principal', principalIds: [dr1.principalId, dr2.principalId] },
          resourceType: patient ? 'triage_assessment' : 'connection',
          resourceId: RES,
          ...(patient ? { patientId: P1 } : {}),
        });
      const a1 = await mk(true);
      const a2 = await mk(false);
      const a3 = await mk(true);
      // First connection: all three, in seq order.
      const s1 = await openStream(base, { cookie: sDr1.cookie });
      await s1.waitFor((f) => f.filter((x) => x.event === 'alert').length >= 3);
      const seqs = s1.events('alert').map((f) => Number(f.id));
      assert.deepEqual(
        seqs,
        [...seqs].sort((x, y) => x - y),
      );
      assert.deepEqual(
        s1.events('alert').map((f) => JSON.parse(f.data as string).alertId),
        [a1.alertId, a2.alertId, a3.alertId],
      );
      assert.equal(s1.events('alert')[0]?.id, String(a1.seq));
      s1.destroy();
      // The tab was away while a4 was raised: the reconnect with Last-Event-ID replays only what it missed.
      const a4 = await mk(false);
      const s2 = await openStream(base, { cookie: sDr1.cookie, lastEventId: String(a3.seq) });
      await s2.waitFor((f) => f.some((x) => x.event === 'alert'));
      assert.deepEqual(
        s2.events('alert').map((f) => JSON.parse(f.data as string).alertId),
        [a4.alertId],
      );
      // Live: raised now, delivered through NOTIFY to the open stream (no polling).
      const sOther = await openStream(base, { cookie: sDr2.cookie, lastEventId: String(a4.seq) });
      const a5 = await mk(true);
      await s2.waitFor((f) =>
        f.some((x) => x.event === 'alert' && JSON.parse(x.data ?? '{}').alertId === a5.alertId),
      );
      await sOther.waitFor((f) =>
        f.some((x) => x.event === 'alert' && JSON.parse(x.data ?? '{}').alertId === a5.alertId),
      );
      // dr1 acknowledges: dr2's stream gets alert_closed {alertId, seq}, and nothing else leaks.
      const r = await ack(sDr1, a5.alertId);
      assert.equal(r.status, 200);
      await sOther.waitFor((f) => f.some((x) => x.event === 'alert_closed'));
      const closed = JSON.parse(sOther.events('alert_closed')[0]?.data as string);
      assert.deepEqual(closed, { alertId: a5.alertId, seq: a5.seq });
      // A non-target's stream receives none of it.
      const sDeskStream = await openStream(base, { cookie: sDesk.cookie });
      const a6 = await mk(false);
      await sleep(400);
      assert.equal(sDeskStream.events('alert').length, 0);
      assert.equal(sDeskStream.events('alert_closed').length, 0);
      // The recorded trail: one `delivered` event per target and alert.
      await sleep(200);
      const delivered = await q<{ principal_id: string }>(
        `SELECT principal_id FROM notifications.staff_alert_event WHERE alert_id = $1 AND kind = 'delivered' ORDER BY principal_id`,
        [a5.alertId],
      );
      assert.deepEqual(
        delivered.map((d) => d.principal_id),
        [dr1.principalId, dr2.principalId].sort(),
      );
      for (const s of [s2, sOther, sDeskStream]) s.destroy();
      await k.wdb.withScope(system, async (tx) => {
        for (const x of [a1, a2, a3, a4, a5, a6]) await svcW.close(tx, x.alertId);
      });
    });

    test('event data is the closed field list: no PHI, no free text (SEC-01 ST-2); the patient ID never appears', async () => {
      const a = await raiseSys({
        type: 'red_flag',
        severity: 'critical',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: P1,
      });
      const s = await openStream(base, { cookie: sDr1.cookie, lastEventId: String(a.seq - 1) });
      await s.waitFor((f) => f.some((x) => x.event === 'alert'));
      const f = s.events('alert')[0] as Frame;
      assert.deepEqual(
        Object.keys(JSON.parse(f.data as string)).sort(),
        [
          'alertId',
          'createdAt',
          'escalatesAt',
          'escalationLevel',
          'link',
          'seq',
          'severity',
          'type',
        ].sort(),
      );
      assert.ok(!s.body().includes(P1));
      assert.ok(!s.body().includes(CANARY));
      assert.match(JSON.parse(f.data as string).link as string, /^\/alerts\/[0-9a-f-]{36}$/);
      s.destroy();
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test('resync instead of a replay when more than 200 alerts were missed', async () => {
      const ids: string[] = [];
      await k.wdb.withScope(system, async (tx) => {
        for (let i = 0; i < 201; i++)
          ids.push(
            (
              await svcW.raise(tx, {
                type: 'integration_down',
                severity: 'low',
                targets: { kind: 'principal', principalIds: [desk.principalId] },
                resourceType: 'connection',
                resourceId: RES,
              })
            ).alertId,
          );
      });
      const s = await openStream(base, { cookie: sDesk.cookie });
      await s.waitFor((f) => f.some((x) => x.event === 'resync'));
      assert.equal(s.events('alert').length, 0);
      assert.equal(s.events('resync')[0]?.data, '{}');
      // The passive open-ids route returns them (the client's next call).
      const open = await getH(sDesk, '/api/v1/alerts/open-ids');
      assert.equal((open.json()['items'] as unknown[]).length, 201);
      s.destroy();
      await k.wdb.withScope(system, async (tx) => {
        for (const x of ids) await svcW.close(tx, x);
      });
    });

    test('more than 3 streams per session: the oldest is closed with event: closed; the 10 per principal limit holds', async () => {
      const streams: Sse[] = [];
      for (let i = 0; i < 3; i++) streams.push(await openStream(base, { cookie: sDr2.cookie }));
      const fourth = await openStream(base, { cookie: sDr2.cookie });
      await streams[0]?.ended();
      assert.match(streams[0]?.body() ?? '', /event: closed/);
      assert.equal(streams[1]?.isEnded(), false);
      assert.equal(fourth.isEnded(), false);
      for (const s of [...streams, fourth]) s.destroy();
      // Ten per principal across sessions: eleven sessions of one principal -> the first closes.
      const sessions = [] as SeededSession[];
      for (let i = 0; i < 11; i++) sessions.push(await seedSession(k, desk, 'google'));
      const opened: Sse[] = [];
      for (const s of sessions) opened.push(await openStream(base, { cookie: s.cookie }));
      await opened[0]?.ended();
      assert.match(opened[0]?.body() ?? '', /event: closed/);
      assert.equal(
        opened.slice(1).every((s) => !s.isEnded()),
        true,
      );
      for (const s of opened) s.destroy();
    });

    test("kill switch: session_revoked closes the principal's streams at once with a final event: closed", async () => {
      const p = await seedPrincipal(k, 'google', { email: 'ks@example.com' });
      await assignRole(k, p.principalId, 'front_desk', L1);
      const s = await seedSession(k, p, 'google');
      const sse = await openStream(base, { cookie: s.cookie });
      const t0 = Date.now();
      await q(
        `UPDATE identity.session SET revoked_at = now(), revoke_reason = 'kill_switch' WHERE id = $1`,
        [s.sessionId],
      );
      await q(`SELECT pg_notify('session_revoked', $1)`, [p.principalId]);
      await sse.ended();
      assert.match(sse.body(), /event: closed/);
      assert.ok(Date.now() - t0 < 2000, 'closed at once');
      // The next request of the revoked session is refused as well.
      assert.equal((await getH(s, '/api/v1/alerts/open-ids')).status, 401);
    });

    test("ST-3: with the LISTEN connection dropped (fault injection) a revoked session's stream still closes within the bound; the stream then catches up", async () => {
      assert.ok(
        REVALIDATE_MS <= 60_000,
        'the default session re-read period is at most 60 s (32.2)',
      );
      const p = await seedPrincipal(k, 'google', { email: 'ks2@example.com' });
      await assignRole(k, p.principalId, 'front_desk', L1);
      const s = await seedSession(k, p, 'google');
      const sse = await openStream(base, { cookie: s.cookie });
      // Kill the hub's LISTEN backend: every notification from now on is lost.
      const killed = await q<{ pg_terminate_backend: boolean }>(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN session_revoked' AND state = 'idle' AND datname = current_database() AND usename = 'app_api'`,
      );
      assert.ok(killed.length >= 1 && killed.every((x) => x.pg_terminate_backend));
      const t0 = Date.now();
      await q(
        `UPDATE identity.session SET revoked_at = now(), revoke_reason = 'kill_switch' WHERE id = $1`,
        [s.sessionId],
      ); // NO notification
      await sse.ended();
      const took = Date.now() - t0;
      assert.match(sse.body(), /event: closed/);
      assert.ok(
        took <= 1500,
        `closed in ${took} ms with the test's 400 ms period (production: at most ${REVALIDATE_MS} ms)`,
      );
      // The hub reconnects with back-off and repairs what it missed from the table.
      for (let i = 0; i < 100 && !hub.isListening(); i++) await sleep(100);
      assert.equal(hub.isListening(), true);
      const live = await openStream(base, { cookie: sDesk.cookie });
      const a = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: [desk.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      await live.waitFor((f) =>
        f.some((x) => x.event === 'alert' && JSON.parse(x.data ?? '{}').alertId === a.alertId),
      );
      live.destroy();
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test('an alert raised while the LISTEN connection is down reaches an open stream after the hub reconnects (a lost NOTIFY delays an alert, never loses it)', async () => {
      const live = await openStream(base, { cookie: sDesk.cookie });
      await q(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN session_revoked' AND state = 'idle' AND datname = current_database() AND usename = 'app_api'`,
      );
      const a = await raiseSys({
        type: 'integration_down',
        severity: 'low',
        targets: { kind: 'principal', principalIds: [desk.principalId] },
        resourceType: 'connection',
        resourceId: RES,
      });
      await live.waitFor(
        (f) =>
          f.some((x) => x.event === 'alert' && JSON.parse(x.data ?? '{}').alertId === a.alertId),
        15_000,
      );
      live.destroy();
      await k.wdb.withScope(system, (tx) => svcW.close(tx, a.alertId));
    });

    test("an idle-expired session's stream closes at the next session check", async () => {
      const p = await seedPrincipal(k, 'google', { email: 'idle@example.com' });
      await assignRole(k, p.principalId, 'front_desk', L1);
      const s = await seedSession(k, p, 'google');
      const sse = await openStream(base, { cookie: s.cookie });
      await q(
        `UPDATE identity.session SET idle_expires_at = now() - interval '1 second' WHERE id = $1`,
        [s.sessionId],
      );
      await sse.ended();
      assert.match(sse.body(), /event: closed/);
    });

    test('a draining instance closes every stream with event: closed', async () => {
      const a = await openStream(base, { cookie: sDr1.cookie });
      const b = await openStream(base, { cookie: sDr2.cookie });
      assert.ok(hub.count() >= 2);
      hub.drain();
      await Promise.all([a.ended(), b.ended()]);
      assert.match(a.body(), /event: closed/);
      assert.match(b.body(), /event: closed/);
      assert.equal(hub.count(), 0);
    });
  });

  // --------------------------------------------------------------------------------------------------------------
  describe('merge and export contribution (22.16)', () => {
    test('R states re-point, closed is kept, counts add up, events are kept; only a patients-scope job naming the IDs may run it', async () => {
      const open = await raiseSys({
        type: 'red_flag',
        severity: 'critical',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: M1,
      });
      const done = await raiseSys({
        type: 'red_flag',
        severity: 'critical',
        targets: { kind: 'principal', principalIds: [dr1.principalId] },
        resourceType: 'triage_assessment',
        resourceId: RES,
        patientId: M1,
      });
      await k.wdb.withScope(system, (tx) => svcW.close(tx, done.alertId));
      await assert.rejects(k.wdb.withScope(system, (tx) => repointAlertRows(tx, M1, M2)));
      await assert.rejects(
        k.wdb.withScope(patientsJob([M1]), (tx) => repointAlertRows(tx, M1, M2)),
      );
      const counts = await k.wdb.withScope(patientsJob([M1, M2]), (tx) =>
        repointAlertRows(tx, M1, M2),
      );
      const byTable = Object.fromEntries(counts.map((c) => [c.table, c]));
      assert.equal(byTable['notifications.staff_alert']?.repointed, 1);
      assert.equal(byTable['notifications.staff_alert']?.kept, 1);
      assert.ok((byTable['notifications.staff_alert_event']?.kept ?? 0) >= 3);
      assert.deepEqual(
        [...ALERT_MERGE_TABLES],
        counts.map((c) => c.table),
      );
      const rows = await q<{ id: string; patient_id: string }>(
        `SELECT id, patient_id FROM notifications.staff_alert WHERE id = ANY($1::uuid[])`,
        [[open.alertId, done.alertId]],
      );
      assert.equal(rows.find((r) => r.id === open.alertId)?.patient_id, M2);
      assert.equal(rows.find((r) => r.id === done.alertId)?.patient_id, M1);
      const part = (await k.wdb.withScope(patientsJob([M1, M2]), (tx) =>
        alertExportContributor.exportPart(tx, [M1, M2], crypto.randomUUID()),
      )) as { staffAlerts: unknown[] };
      assert.ok(part.staffAlerts.length >= 2);
      await k.wdb.withScope(system, (tx) => svcW.close(tx, open.alertId));
    });
  });
});
