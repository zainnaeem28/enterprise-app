/* eslint-disable boundaries/module-boundaries -- test support: builds on the scheduling flow kit (BE-13), which builds on the booking core's and the patient kit */
// Harness of the telehealth real-database tests (BE-15). Not a test file. Builds on the scheduling flow kit: a throwaway database migrated
// by the real pipeline (including 1500-1502), the real booking core and flow, the real queue (telehealth task types synced), seeded
// patients and doctors, and on top of it the telehealth service, the job service, the worker's real telehealth jobs and its real video
// adapter behind integration-core's real `VendorGateway`. The vendor itself is the in-memory contract stub (FakeVideoTransport): it proves
// nothing about a real vendor (C-11, C-10). Synthetic data only.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Queue, createLogger, syncTaskTypes } from '@ehr/kernel';
import type { JobType, ScopeSettings } from '@ehr/kernel';
import { registerTelehealthParticipants } from './merge.js';
import { TELEHEALTH_JOBS, registerTelehealthHandlers } from './jobs.js';
import { TelehealthJobService } from './job-service.js';
import { telehealthPort } from './port.js';
import type { VideoVendorPort } from './port.js';
import { TelehealthService } from './service.js';
import { ORG, id, pg, repoRoot } from '../patient/testkit.js';
import { A1, SVC, setupFlow, slotStart } from '../scheduling/flow/testkit.js';
import type { Doctor, FlowKit, PatientKit } from '../scheduling/flow/testkit.js';

export { A1, ORG, SVC, id, slotStart };
export type { Doctor, PatientKit };

interface WorkerTelehealth {
  TELEHEALTH_JOBS: readonly JobType[];
  FakeVideoTransport: new (o?: { supportsIdempotencyToken?: boolean }) => FakeTransport;
  VideoAdapter: new (t: unknown) => unknown;
  runOnReservationConfirmed(
    deps: TelehealthKit['jobs'],
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<'scheduled' | 'skipped' | 'gone'>;
  runCreateMeeting(
    deps: TelehealthKit['jobs'],
    payload: Record<string, unknown>,
    jobRef?: string,
  ): Promise<'created' | 'exists' | 'skipped' | 'gone'>;
  runEndStale(
    deps: TelehealthKit['jobs'],
    jobRef?: string,
  ): Promise<{
    listed: number;
    ended: number;
    failed: number;
    vendorClosed: number;
    vendorFailed: number;
  }>;
  createTelehealthTasks(deps: TelehealthKit['jobs']): Record<string, unknown>;
}

export interface FakeTransport {
  readonly calls: {
    op: string;
    recording?: boolean;
    externalId?: string;
    meetingId?: string;
    ttlSeconds?: number;
  }[];
  readonly meetings: Map<string, { meetingId: string; ended: boolean; recording: boolean }>;
  readonly tokens: Set<string>;
  unavailable: boolean;
  failNext: number;
}

interface WorkerCore {
  AdapterRegistry: new () => { register(a: unknown): void };
  VendorGateway: new (d: Record<string, unknown>) => {
    callVendor(
      kind: string,
      op: string,
      args: Record<string, unknown>,
      corr: Record<string, unknown>,
    ): Promise<{ data: unknown }>;
  };
}

export interface TelehealthKit {
  f: FlowKit;
  telehealth: TelehealthService;
  /** The same service as the worker runs it (worker queue path is not needed: it publishes nothing). */
  jobService: TelehealthJobService;
  video: FakeTransport;
  W: WorkerTelehealth;
  jobs: {
    db: FlowKit['worker'];
    orgId: string;
    queue: Queue;
    telehealth: ReturnType<typeof telehealthPort>;
    vendor: { callVendor: WorkerCore['VendorGateway']['prototype']['callVendor'] };
    log: ReturnType<typeof createLogger>;
    survivorOf: FlowKit['jobs']['survivorOf'];
  };
  /** The host's own scope (staff, google realm, the doctor's principal, at A1). */
  hostScope(d: Doctor): ScopeSettings;
  /** The doctor is licensed in these states (replaces what was there). */
  license(doctorId: string, states: string[]): Promise<void>;
  /**
   * A confirmed VIDEO visit written directly (any time), with its session made by the worker's real handler and its room by the real
   * create_meeting job. Returns the reservation ID.
   */
  video_visit(
    p: PatientKit,
    d: Doctor,
    start: Date,
    opts?: { minutes?: number; room?: boolean },
  ): Promise<string>;
  sessionOf(reservationId: string): Promise<Record<string, unknown> | undefined>;
  close(): Promise<void>;
}

export async function setupTelehealth(name: string): Promise<TelehealthKit> {
  const f = await setupFlow(name);
  const k = f.k;
  const W = async <T>(path: string): Promise<T> =>
    (await import(pathToFileURL(`${repoRoot}apps/worker/dist/${path}`).href)) as T;
  const w = await W<WorkerTelehealth>('jobs/telehealth/index.js');
  const core = await W<WorkerCore>('jobs/integration-core/index.js');

  // The placeholder states of the ticket (D-2 is not answered): NY allowed, NJ known but not an operating state (flow kit), CA allowed here.
  await k.sa.query(
    `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('CA', $1, 'California') ON CONFLICT DO NOTHING`,
    [ORG],
  );
  await k.sa.query(
    `INSERT INTO organisation.operating_state (organisation_id, jurisdiction_code, telehealth_allowed, effective_from) VALUES ($1, 'CA', true, '2020-01-01')`,
    [ORG],
  );

  // The video connection: enabled, vendor name only (no secret: the stub needs none).
  const connectionId = randomUUID();
  await k.sa.query(
    `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, settings, enabled)
     VALUES ($1, $2, 'video', 'sandboxvendor', '{}'::jsonb, true)`,
    [connectionId, ORG],
  );

  // Task types for the telehealth jobs, then the queue paths.
  for (const j of TELEHEALTH_JOBS) {
    try {
      k.registry.get(j.name);
    } catch {
      k.registry.defineJob(j);
    }
  }
  registerTelehealthHandlers(k.registry);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();
  const apiQueue = new Queue(k.registry, 'api');
  const workerQueue = new Queue(k.registry, 'worker');

  // The vendor side: the worker's real adapter behind the real gateway over the contract stub.
  const video = new w.FakeVideoTransport();
  const adapters = new core.AdapterRegistry();
  adapters.register(new w.VideoAdapter(video));
  const gateway = new core.VendorGateway({
    db: f.worker,
    orgId: ORG,
    adapters,
    credentials: () => ({ get: () => Promise.reject(new Error('the stub needs no credential')) }),
    maxAttempts: 2,
    backoffBaseMs: 1,
    backoffCapMs: 2,
    sleep: () => Promise.resolve(),
  });

  // The API side's port over the same gateway.
  const vendor: VideoVendorPort = {
    async issueJoinToken(req) {
      const r = await gateway.callVendor(
        'video',
        'join_token',
        {
          meetingId: req.meetingId,
          participantRef: req.participantRef,
          ttlSeconds: req.ttlSeconds,
          role: req.role,
        },
        { type: 'telehealth.session', idempotencyToken: req.idempotencyToken },
      );
      const d = r.data as { attendeeId: string; attendeeToken: string };
      return { attendeeId: d.attendeeId, attendeeToken: d.attendeeToken };
    },
    async endMeeting(req) {
      await gateway.callVendor(
        'video',
        'end_meeting',
        { meetingId: req.meetingId },
        { type: 'telehealth.session', idempotencyToken: req.idempotencyToken },
      );
    },
  };

  const telehealth = new TelehealthService({
    db: f.api,
    audit: k.audit,
    organisation: f.org,
    vendor,
    queue: apiQueue,
  });
  const jobService = new TelehealthJobService({ audit: k.audit });
  registerTelehealthParticipants(f.regs);

  const jobs: TelehealthKit['jobs'] = {
    db: f.worker,
    orgId: ORG,
    queue: workerQueue,
    telehealth: telehealthPort(jobService),
    vendor: gateway,
    log: createLogger({ sink: () => undefined }),
    survivorOf: f.jobs.survivorOf,
  };

  const kit: TelehealthKit = {
    f,
    telehealth,
    jobService,
    video,
    W: w,
    jobs,
    hostScope: (d) => ({
      audience: 'staff',
      realm: 'google',
      orgId: ORG,
      principalId: d.principalId,
      personId: d.personId,
      locationIds: [A1],
    }),
    async license(doctorId, states) {
      await k.sa.query(`DELETE FROM identity.licensed_state WHERE principal_id = $1`, [doctorId]);
      for (const s of states)
        await k.sa.query(
          `INSERT INTO identity.licensed_state (principal_id, jurisdiction_code, organisation_id) VALUES ($1, $2, $3)`,
          [doctorId, s, ORG],
        );
    },
    async video_visit(p, d, start, opts = {}) {
      const rid = await f.seed(p, d.principalId, start, {
        mode: 'video',
        ...(opts.minutes === undefined ? {} : { minutes: opts.minutes }),
      });
      const payload = { reservationId: rid, patientId: p.patientId };
      await w.runOnReservationConfirmed(jobs, payload);
      if (opts.room !== false) await w.runCreateMeeting(jobs, payload);
      return rid;
    },
    async sessionOf(rid) {
      return (
        await k.q(`SELECT * FROM telehealth.video_session WHERE reservation_id = $1`, [rid])
      )[0] as Record<string, unknown> | undefined;
    },
    close: () => f.close(),
  };
  return kit;
}

export const newId = (): string => randomUUID();
