/* eslint-disable boundaries/module-boundaries -- test support: reaches the patient kit, the merge executor and the scheduling kit's pieces the way the chart's and the flow's kits do (BE-16, BE-13) */
// Harness of the clinical notes real-database tests (BE-17). Not a test file. A throwaway database migrated by the real pipeline
// (including 1800-1802), the real Nest application with the identity guard, the chart's, the front door's, the booking core's, the
// flow's and this module's controllers, the real alert service, the real queue (task types synced), seeded sessions and a real
// PostgreSQL 17. Synthetic data only. The ports are `createNotesPorts` over the real services: no fake stands in for another module.
// Derived from the front door's harness (BE-18): the same pieces plus the notes.
import { randomUUID } from 'node:crypto';
import { JobRegistry, KernelDb, ParticipantRegistries, Queue, syncTaskTypes } from '@ehr/kernel';
import type { ScopeSettings, Tx } from '@ehr/kernel';
import { registerDocumentsParticipants } from '../../documents/index.js';
import { registerIdentityParticipants } from '../../identity/index.js';
import {
  NOTIFICATIONS_JOBS,
  NotificationService,
  registerNotificationsParticipants,
} from '../../notifications/index.js';
import { ALERT_JOBS } from '../../notifications/alerts/jobs.js';
import { AlertService } from '../../notifications/alerts/service.js';
import { createAlertsController } from '../../notifications/alerts/controller.js';
import { OrganisationService } from '../../organisation/index.js';
import {
  createMergeControllers,
  executeMerge,
  MERGE_JOBS,
  MergeService,
  mergeResolvers,
  NOT_PARTICIPANT_TABLES,
} from '../../patient/merge/index.js';
import type { ExecuteDeps, ExecuteResult } from '../../patient/merge/index.js';
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
import { requireAuthContext } from '../../identity/index.js';
import {
  createSchedulingControllers,
  schedulingResolvers,
} from '../../scheduling/core/controller.js';
import { SCHEDULING_CORE_JOBS } from '../../scheduling/core/jobs.js';
import { uuidv7 } from '../../scheduling/core/ids.js';
import { nearbyFreeStarts, SchedulingCoreService } from '../../scheduling/core/service.js';
import type { AvailabilityPort } from '../../scheduling/core/types.js';
import { createFlowControllers, flowResolvers } from '../../scheduling/flow/controller.js';
import {
  SCHEDULING_FLOW_JOBS,
  registerSchedulingFlowHandlers,
} from '../../scheduling/flow/jobs.js';
import { SchedulingFlowService } from '../../scheduling/flow/service.js';
import { createClinicalChart } from '../chart/runtime.js';
import type { ClinicalChart } from '../chart/runtime.js';
import { BtgAwareAudit } from '../chart/audit-port.js';
import type { ChartAuditPort } from '../chart/audit-port.js';
import { createFrontdoorPorts } from '../frontdoor/adapters.js';
import type { FrontdoorPorts } from '../frontdoor/ports.js';
import { FRONTDOOR_JOBS, registerFrontdoorHandlers } from '../frontdoor/jobs.js';
import { createClinicalFrontdoor } from '../frontdoor/runtime.js';
import type { ClinicalFrontdoor } from '../frontdoor/runtime.js';
import { createNotesPorts } from './adapters.js';
import { registerNotesParticipants } from './index.js';
import { NOTES_JOBS } from './jobs.js';
import type { NotesPorts } from './ports.js';
import { createClinicalNotes } from './runtime.js';
import type { ClinicalNotes } from './runtime.js';

export {
  ORG,
  PATIENT_HOST,
  STAFF_HOST,
  adminUrl,
  call,
  id,
  pg,
  repoRoot,
  saWrite,
  staffMember,
  writeHeaders,
  uuidv7,
};
export type { Kit, Resp, SeededSession };

export const A1 = id(101);
export const A2 = id(102);
export const B1 = id(201);
export const SVC = id(301);
export const SVC2 = id(302);
export const CURSOR_KEY = 'cursor-key-for-tests-0123456789abcdef';
export const QR_KEY = Buffer.from('qr-key-for-tests-0123456789abcdef0123');
export const PORTAL = 'https://portal.example.test/sign-in';

/** Synthetic template content for the tests. The rules and the advice text are made up here; no clinical meaning is claimed. */
export const TEMPLATE_KEY = 'synthetic-intake';
export const CONSENT_A = 'synthetic-consent-a';
export const CONSENT_B = 'synthetic-consent-b';
export const QUESTIONS = [
  { id: 'q_flag_a', type: 'boolean' },
  { id: 'q_flag_b', type: 'choice' },
  { id: 'q_score', type: 'number' },
  { id: 'q_note', type: 'text' },
];
export const RULES = [
  { question: 'q_flag_a', equals: true },
  { question: 'q_flag_b', in: ['red', 'purple'] },
  { question: 'q_score', gte: 8 },
];
export const ADVICE = 'Synthetic advice text for the test.';

export interface PatientKit {
  patientId: string;
  session: SeededSession;
  scope: ScopeSettings;
}

export interface NotesKit {
  k: Kit;
  chart: ClinicalChart;
  frontdoor: ClinicalFrontdoor;
  ports: FrontdoorPorts;
  notes: ClinicalNotes;
  notePorts: NotesPorts;
  audit: ChartAuditPort;
  flow: SchedulingFlowService;
  alerts: AlertService;
  org: OrganisationService;
  regs: ParticipantRegistries;
  api: KernelDb;
  worker: KernelDb;
  workerScope: ScopeSettings;
  clock: { at: Date | undefined };
  desk: SeededSession;
  nurse: SeededSession;
  nurse2: SeededSession;
  doctor: SeededSession;
  doctor2: SeededSession;
  /** `trainee_doctor` at A1 whose supervisor (staff_profile) is `supervisor`. */
  trainee: SeededSession;
  /** A `doctor` at A1: the trainee's supervisor. */
  supervisor: SeededSession;
  /** An `assistant` at A1 (prepare-only, D-18): supports `doctor`. */
  assistant: SeededSession;
  /** A visit checked in and started by `by` (default `doctor`): the reservation and encounter IDs. */
  consult(
    p: PatientKit,
    by?: SeededSession,
  ): Promise<{ reservationId: string; encounterId: string }>;
  /** Moves the session's sign-in back in time (the BQ-8 age check). */
  ageSignIn(s: SeededSession, hours: number): Promise<void>;
  coord: SeededSession;
  coordB: SeededSession;
  lead: SeededSession;
  mr: SeededSession;
  admin: SeededSession;
  mkPatient(n: number): Promise<PatientKit>;
  /** A confirmed in-person visit at A1 for the patient, checked in at the desk. Returns the check-in (reservation) ID. */
  checkedIn(p: PatientKit, o?: { clinician?: SeededSession; serviceId?: string }): Promise<string>;
  /** A confirmed visit, not checked in. */
  confirmed(p: PatientKit, serviceId?: string, clinician?: SeededSession): Promise<string>;
  /** Puts the staff member on the roster for the duty at the location now. */
  roster(
    s: SeededSession,
    duty: 'on_duty_doctor' | 'on_call_doctor',
    location?: string,
  ): Promise<void>;
  publishTemplate(o?: {
    key?: string;
    rules?: unknown[];
    advice?: string | null;
    questions?: unknown[];
    approvedBy?: string;
    version?: number;
    status?: 'published' | 'draft';
  }): Promise<void>;
  requireConsents(serviceId: string, keys: string[]): Promise<void>;
  publishConsent(key: string, version: number): Promise<void>;
  scall(
    s: SeededSession,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  pcall(
    p: PatientKit,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Resp>;
  staffScope(s: SeededSession, locations?: string[]): ScopeSettings;
  as<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  asWorker<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T>;
  merge(
    survivorId: string,
    mergedId: string,
    over?: Partial<ExecuteDeps>,
  ): Promise<{ requestId: string; result: ExecuteResult }>;
  close(): Promise<void>;
}

export async function setupNotes(name: string): Promise<NotesKit> {
  const holder: {
    k?: Kit;
    chart?: ClinicalChart;
    frontdoor?: ClinicalFrontdoor;
    ports?: FrontdoorPorts;
    notes?: ClinicalNotes;
    notePorts?: NotesPorts;
    flow?: SchedulingFlowService;
    core?: SchedulingCoreService;
    alerts?: AlertService;
    clock?: { at: Date | undefined };
  } = {};
  holder.clock = { at: undefined };
  const lazy = <T extends object>(get: () => T): T =>
    new Proxy({} as T, {
      get: (_t, prop) => {
        const target = get() as unknown as Record<string | symbol, unknown>;
        const v = target[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const lazyAudit = lazy(() => (holder.k as Kit).audit);
  const mreg = new JobRegistry();
  for (const j of MERGE_JOBS) mreg.defineJob(j);
  const merges = new MergeService({ queue: new Queue(mreg, 'api') });
  const org = new OrganisationService();

  const k = await retrySetup(() =>
    setup({
      name,
      fixtures: async (f) => {
        await standardFixtures(f);
        await f.sa.query(
          `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active)
           VALUES ($1, $3, 'Consult', 'Appointment', 30, 0, 'either', true), ($2, $3, 'Consult 2', 'Appointment 2', 30, 0, 'either', true)`,
          [SVC, SVC2, ORG],
        );
        // SVC is offered at A1 and A2; SVC2 at A1 only.
        await f.sa.query(
          `INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)`,
          [ORG, SVC, A1, A2, SVC2],
        );
      },
      controllers: [
        ...createMergeControllers({ db: lazyDb, merges }),
        ...createSchedulingControllers({
          db: lazyDb,
          scheduling: lazy(() => holder.core as SchedulingCoreService),
        }),
        ...createFlowControllers({
          db: lazyDb,
          flow: lazy(() => holder.flow as SchedulingFlowService),
        }),
        createAlertsController({
          db: lazyDb,
          alerts: lazy(() => holder.alerts as AlertService),
          scopeOf: (req) => requireAuthContext(req).scope,
        }),
      ],
      beforeStart: ({ identity, patient }) => {
        for (const [n, fn] of Object.entries({
          ...mergeResolvers(),
          ...schedulingResolvers(),
          ...flowResolvers(),
        }))
          identity.policy.registerResolver(n, fn);
        // The admin elevation check is BE-05's; the harness answers "elevated".
        (identity.policy as unknown as { deps: { elevation?: unknown } }).deps.elevation = {
          isElevated: () => Promise.resolve(true),
        };
        const chart = createClinicalChart({
          db: lazyDb,
          audit: lazyAudit,
          identity,
          patients: patient.patients,
          cursorKey: CURSOR_KEY,
        });
        holder.chart = chart;
        const ports = createFrontdoorPorts({
          flow: lazy(() => holder.flow as SchedulingFlowService),
          alerts: lazy(() => holder.alerts as AlertService),
          organisation: org,
          records: lazy(() => (holder.k as Kit).patient.records),
          patients: lazy(() => (holder.k as Kit).patient.patients),
          queue: lazy(() => new Queue((holder.k as Kit).registry, 'api')),
        });
        holder.ports = ports;
        const frontdoor = createClinicalFrontdoor({
          db: lazyDb,
          chart,
          audit: lazyAudit,
          identity,
          ports,
        });
        holder.frontdoor = frontdoor;
        const notePorts = createNotesPorts({
          alerts: lazy(() => holder.alerts as AlertService),
          queue: lazy(() => new Queue((holder.k as Kit).registry, 'api')),
        });
        holder.notePorts = notePorts;
        const notes = createClinicalNotes({
          db: lazyDb,
          audit: lazyAudit,
          chart,
          consentGate: frontdoor.consentGate,
          identity,
          ports: notePorts,
          cursorKey: CURSOR_KEY,
          now: () => (holder.clock as { at: Date | undefined }).at ?? new Date(),
        });
        holder.notes = notes;
        // Registered first: the chart's banner route and the front door's routes sit before the patient module's.
        patient.controllers.unshift(
          ...chart.controllers,
          ...frontdoor.controllers,
          ...notes.controllers,
        );
      },
    }),
  );
  holder.k = k;
  // BE-07 ships notifications.staff_scope_allows_patient as a fail-closed stub until BE-08/INT-02 replace it (migration 1201). This
  // harness installs the intended body (the patient.staff_scope check, like 1702 uses) in the THROWAWAY database only; no migration
  // of this ticket touches it. Without it a staff red-flag insert is refused by RLS.
  await k.sa.query(
    `CREATE OR REPLACE FUNCTION notifications.staff_scope_allows_patient(patient uuid) RETURNS boolean
       LANGUAGE sql STABLE SET search_path = pg_catalog AS
       $$ SELECT EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient AND s.location_id = ANY (kernel.uuids('app.location_ids')))
              OR patient = ANY (kernel.uuids('app.btg_patient_ids')) $$`,
  );
  return finish(k, holder, org, lazy);
}

async function finish(
  k: Kit,
  holder: {
    chart?: ClinicalChart;
    ports?: FrontdoorPorts;
    notes?: ClinicalNotes;
    notePorts?: NotesPorts;
    frontdoor?: ClinicalFrontdoor;
    flow?: SchedulingFlowService;
    core?: SchedulingCoreService;
    alerts?: AlertService;
    clock?: { at: Date | undefined };
  },
  org: OrganisationService,
  lazy: <T extends object>(get: () => T) => T,
): Promise<NotesKit> {
  void lazy;
  for (const d of [k.db, k.wdb])
    (d as unknown as { pool: { on(e: 'error', f: () => void): void } }).pool.on(
      'error',
      () => undefined,
    );
  for (const j of [
    ...MERGE_JOBS,
    ...SCHEDULING_CORE_JOBS,
    ...SCHEDULING_FLOW_JOBS,
    ...NOTIFICATIONS_JOBS,
    ...ALERT_JOBS,
    ...FRONTDOOR_JOBS,
    ...NOTES_JOBS,
  ])
    if (!safeHas(k, j.name)) k.registry.defineJob(j);
  // A stand-in for the handler of `audit.btg_opened` (the compliance alert, a later ticket): the event is published in the BTG
  // transaction, and the read tests look for the job it creates (the chart's testkit does the same).
  if (!safeHas(k, 'sink.on_btg_opened')) {
    k.registry.defineJob({
      name: 'sink.on_btg_opened',
      maxAttempts: 3,
      onMerged: 'resolve',
      carriesPatientIds: true,
      jobScope: 'patients',
      jobClass: 'handler',
    });
    k.registry.registerHandler('audit.btg_opened', 'sink');
  }
  registerSchedulingFlowHandlers(k.registry);
  registerFrontdoorHandlers(k.registry);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const apiQueue = new Queue(k.registry, 'api');
  const availability: AvailabilityPort = {
    resolve: () => Promise.resolve({ ok: true as const }),
    alternatives: (tx, q) => nearbyFreeStarts(tx, q),
  };
  const core = new SchedulingCoreService({
    audit: k.audit,
    organisation: org,
    availability,
    queue: apiQueue,
  });
  holder.core = core;
  const clock = holder.clock as { at: Date | undefined };
  holder.alerts = new AlertService({ queue: apiQueue });
  holder.flow = new SchedulingFlowService({
    audit: k.audit,
    organisation: org,
    availability,
    notifications: new NotificationService({
      queue: apiQueue,
      allowedLinkHosts: ['portal.example.test'],
    }),
    records: k.patient.records,
    queue: apiQueue,
    qrKey: { current: () => Promise.resolve(QR_KEY) },
    previsit: (holder.frontdoor as ClinicalFrontdoor).previsitPort,
    portalUrl: PORTAL,
    now: () => clock.at ?? new Date(),
  });

  const apiPool = new pg.Pool({ connectionString: k.urlFor('app_api'), max: 30 });
  const workerPool = new pg.Pool({ connectionString: k.urlFor('app_worker'), max: 8 });
  for (const pool of [apiPool, workerPool]) pool.on('error', () => undefined);
  const api = new KernelDb(apiPool as never);
  const worker = new KernelDb(workerPool as never);
  const workerScope: ScopeSettings = {
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'org',
  };
  await worker.withScope(workerScope, (tx) => org.applySettingDefaults(tx, undefined));

  const regs = new ParticipantRegistries();
  registerIdentityParticipants(regs);
  registerNotificationsParticipants(regs);
  registerDocumentsParticipants(regs);
  // The flow's participant covers the booking core's table as well; the clinical one composes the chart's part and this ticket's.
  const { registerSchedulingFlowParticipants } = await import('../../scheduling/flow/merge.js');
  registerSchedulingFlowParticipants(regs);
  registerNotesParticipants(regs);

  const lead = await (async () => {
    const p = await seedPrincipal(k, 'google', {
      name: 'Lead A1',
      email: `lead.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'front_desk_lead', A1);
    return seedSession(k, p, 'google');
  })();
  const mr = await staffMember(k, 'medical_records', A2, 'Records A2');
  const desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
  const nurse = await staffMember(k, 'triage_nurse', A1, 'Nurse A1');
  const nurse2 = await staffMember(k, 'triage_nurse', A1, 'Nurse A1 second');
  const doctor = await staffMember(k, 'doctor', A1, 'Doctor A1');
  const doctor2 = await staffMember(k, 'doctor', A1, 'Doctor A1 second');
  const supervisor = await staffMember(k, 'doctor', A1, 'Supervisor A1');
  const trainee = await staffMember(k, 'trainee_doctor', A1, 'Trainee A1');
  const assistant = await staffMember(k, 'assistant', A1, 'Assistant A1');
  for (const [who, sup] of [
    [supervisor, null],
    [doctor, null],
    [trainee, supervisor.seeded.principalId],
  ] as const)
    await k.sa.query(
      `INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, is_trainee, supervisor_principal_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        who.seeded.principalId,
        ORG,
        `Profile ${who.seeded.principalId.slice(0, 8)}`,
        who === trainee,
        sup,
      ],
    );
  await k.sa.query(
    `INSERT INTO identity.staff_support (id, organisation_id, assistant_principal_id, supported_principal_id, from_date)
     VALUES ($1, $2, $3, $4, current_date - 1)`,
    [uuidv7(), ORG, assistant.seeded.principalId, doctor.seeded.principalId],
  );
  const coord = await staffMember(k, 'care_coordinator', A1, 'Coordinator A1');
  const coordB = await staffMember(k, 'care_coordinator', A2, 'Coordinator A2');
  const admin = await (async () => {
    const p = await seedPrincipal(k, 'admin_pool', {
      name: 'Admin',
      email: `admin.${randomUUID().slice(0, 6)}@example.com`,
    });
    await assignRole(k, p.principalId, 'org_admin');
    return seedSession(k, p, 'admin_pool');
  })();

  const scall: NotesKit['scall'] = (s, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: STAFF_HOST,
      cookie: s.cookie,
      headers:
        method === 'GET' ? extra : { ...writeHeaders(s, STAFF_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });
  const pcall: NotesKit['pcall'] = (p, method, path, body, extra = {}) =>
    call(k.base, method, path, {
      host: PATIENT_HOST,
      cookie: p.session.cookie,
      headers:
        method === 'GET'
          ? extra
          : { ...writeHeaders(p.session, PATIENT_HOST, randomUUID()), ...extra },
      ...(body === undefined ? {} : { body }),
    });

  let seq = 0;
  let doctorSeq = 0;
  const link = async (patientId: string, n: number): Promise<PatientKit> => {
    const p = await seedPrincipal(k, 'patient_pool', { name: `Patient account ${n}` });
    await saWrite(
      k,
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [p.principalId, patientId, ORG],
    );
    return {
      patientId,
      session: await seedSession(k, p, 'patient_pool'),
      scope: {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: p.principalId,
        personId: p.personId,
        patientIds: [patientId],
      },
    };
  };
  const seedReservation = async (
    p: PatientKit,
    start: Date,
    serviceId: string,
    clinician?: SeededSession,
  ): Promise<string> => {
    const doc =
      clinician?.seeded ??
      (await seedPrincipal(k, 'google', { name: `Seed doctor ${++doctorSeq}` }));
    const rid = uuidv7();
    const end = new Date(start.getTime() + 30 * 60_000);
    await k.sa.query('BEGIN');
    try {
      await k.sa.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
        [ORG],
      );
      await k.sa.query(
        `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, period, status)
         VALUES ($1, $2, $3, $4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), 'confirmed')`,
        [rid, ORG, A1, doc.principalId, start.toISOString(), end.toISOString()],
      );
      await k.sa.query(
        `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, booked_by_principal_id, booked_via)
         VALUES ($1, $2, $3, $4, $5, $6, 'in_person', $6, 'staff')`,
        [rid, ORG, p.patientId, serviceId, A1, doc.principalId],
      );
      await k.sa.query('COMMIT');
    } catch (e) {
      await k.sa.query('ROLLBACK');
      throw e;
    }
    return rid;
  };
  let slot = 0;
  const nextStart = (): Date => new Date(Date.UTC(2031, 5, 10, 9, 0, 0) + ++slot * 40 * 60_000);

  const kit: NotesKit = {
    k,
    chart: holder.chart as ClinicalChart,
    frontdoor: holder.frontdoor as ClinicalFrontdoor,
    ports: holder.ports as FrontdoorPorts,
    notes: holder.notes as ClinicalNotes,
    notePorts: holder.notePorts as NotesPorts,
    audit: new BtgAwareAudit(k.audit),
    flow: holder.flow,
    alerts: holder.alerts,
    org,
    regs,
    api,
    worker,
    workerScope,
    clock,
    desk,
    nurse,
    nurse2,
    doctor,
    doctor2,
    trainee,
    supervisor,
    assistant,
    coord,
    coordB,
    lead,
    mr,
    admin,
    async mkPatient(n) {
      const pid = await registerViaApi(k, desk, A1, {
        givenName: `Given${n}`,
        familyName: `Family${n}`,
        dateOfBirth: '1980-05-17',
        phone: `+1212555${String(1000 + n)}`,
        email: `person${n}@example.test`,
      });
      return link(pid, n);
    },
    async consult(p, by = doctor) {
      const rid = await kit.checkedIn(p, { clinician: by });
      const r = await scall(by, 'POST', '/api/v1/encounters', { reservationId: rid });
      if (r.status !== 201) throw new Error(`start failed ${r.status} ${r.body}`);
      return { reservationId: rid, encounterId: r.json()['id'] as string };
    },
    async ageSignIn(s, hours) {
      // identity.guard_session makes auth_time immutable (a user cannot change it); a test with a superuser connection skips triggers.
      await k.sa.query(`SET session_replication_role = replica`);
      try {
        await k.sa.query(
          `UPDATE identity.session SET auth_time = now() - make_interval(secs => $2) WHERE id = $1`,
          [s.sessionId, hours * 3600],
        );
      } finally {
        await k.sa.query(`SET session_replication_role = DEFAULT`);
      }
    },
    async confirmed(p, serviceId = SVC, clinician) {
      return seedReservation(p, nextStart(), serviceId, clinician);
    },
    async checkedIn(p, o = {}) {
      const start = nextStart();
      const rid = await seedReservation(p, start, o.serviceId ?? SVC, o.clinician);
      clock.at = start;
      try {
        const scope: ScopeSettings = {
          audience: 'staff',
          realm: 'google',
          orgId: ORG,
          principalId: desk.seeded.principalId,
          personId: desk.seeded.personId,
          locationIds: [A1],
        };
        await api.withScope(scope, (tx) =>
          (holder.flow as SchedulingFlowService).checkIn(tx, { requestId: randomUUID() }, rid, {
            method: 'desk',
          }),
        );
      } finally {
        clock.at = undefined;
      }
      return rid;
    },
    async roster(s, duty, location = A1) {
      await k.sa.query(
        `INSERT INTO scheduling.roster_entry (id, organisation_id, location_id, duty, principal_id, period)
         VALUES ($1, $2, $3, $4, $5, tstzrange(now() - interval '1 hour', now() + interval '8 hours', '[)'))`,
        [uuidv7(), ORG, location, duty, s.seeded.principalId],
      );
    },
    async publishTemplate(o = {}) {
      const rules = o.rules ?? RULES;
      const schema: Record<string, unknown> = {
        questions: o.questions ?? QUESTIONS,
        red_flag_rules: rules,
        ...(o.advice === null ? {} : { emergency_advice: o.advice ?? ADVICE }),
      };
      await k.sa.query(
        `INSERT INTO organisation.questionnaire_template (id, organisation_id, key, version, schema, status, approved_by_note)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          uuidv7(),
          ORG,
          o.key ?? TEMPLATE_KEY,
          o.version ?? 1,
          JSON.stringify(schema),
          o.status ?? 'published',
          rules.length > 0 ? (o.approvedBy ?? 'Synthetic reviewer note for the test') : null,
        ],
      );
    },
    async publishConsent(key, version) {
      await k.sa.query(
        `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, body_document_id, status)
         VALUES ($1, $2, $3, $4, 'en', $6, $7, $5, 'published')`,
        [
          uuidv7(),
          ORG,
          key,
          version,
          randomUUID(),
          `Test consent ${key}`,
          `Placeholder wording for ${key}, test data only.`,
        ],
      );
    },
    async requireConsents(serviceId, keys) {
      for (const key of keys)
        await k.sa.query(
          `INSERT INTO organisation.service_required_consent (organisation_id, service_id, consent_template_key) VALUES ($1, $2, $3)`,
          [ORG, serviceId, key],
        );
    },
    scall,
    pcall,
    staffScope: (s, locations = [A1]) => ({
      audience: 'staff',
      realm: 'google',
      orgId: ORG,
      principalId: s.seeded.principalId,
      personId: s.seeded.personId,
      locationIds: locations,
    }),
    as: (scope, fn) => api.withScope(scope, fn),
    asWorker: (scope, fn) => worker.withScope(scope, fn),
    async merge(survivorId, mergedId, over = {}) {
      const r = await call(k.base, 'POST', '/api/v1/patient-merges', {
        cookie: lead.cookie,
        headers: writeHeaders(lead, undefined, randomUUID()),
        body: { survivorId, mergedId, reason: 'Same person registered twice' },
      });
      if (r.status !== 200) throw new Error(`request failed ${r.status} ${r.body}`);
      const requestId = r.json()['id'] as string;
      const a = await call(k.base, 'POST', `/api/v1/patient-merges/${requestId}/approve`, {
        cookie: mr.cookie,
        headers: writeHeaders(mr, undefined, randomUUID()),
      });
      if (a.status !== 200) throw new Error(`approve failed ${a.status} ${a.body}`);
      return {
        requestId,
        result: await executeMerge(
          {
            db: worker,
            orgId: ORG,
            registries: regs,
            // The staff-alert tables of BE-07 carry a patient_id; their participant is wired at integration (their README).
            notParticipants: {
              ...NOT_PARTICIPANT_TABLES,
              'notifications.staff_alert': 'BE-07 participant is wired at integration',
              'notifications.staff_alert_event': 'BE-07 participant is wired at integration',
            },
            ...over,
          },
          { requestId, jobId: `test:${++seq}`, attempt: 1, maxAttempts: 1 },
        ),
      };
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
