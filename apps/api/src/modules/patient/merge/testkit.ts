// Harness of the merge real-database tests (BE-09). Not a test file. Builds on the patient testkit (BE-08): a throwaway database
// migrated by the real pipeline, the real Nest application with the identity guard, the patient and the merge controllers,
// seeded sessions. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { JobRegistry, ParticipantRegistries, Queue, syncTaskTypes } from '@ehr/kernel';
import type { KernelDb } from '@ehr/kernel';
import { registerIdentityParticipants } from '../../identity/index.js';
import { registerNotificationsParticipants } from '../../notifications/index.js';
import {
  ORG,
  adminUrl,
  assignRole,
  call,
  id,
  pg,
  registerViaApi,
  saWrite,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
  writeHeaders,
} from '../testkit.js';
import type { Client, Kit, SeededSession } from '../testkit.js';
import { createMergeControllers, mergeResolvers } from './controller.js';
import { executeMerge } from './executor.js';
import type { ExecuteDeps, ExecuteResult } from './executor.js';
import { MERGE_JOBS } from './jobs.js';
import { MergeService } from './service.js';

export { ORG, adminUrl, call, id, pg, saWrite, writeHeaders };
export type { Client, Kit, SeededSession };

export const A1 = id(101);
export const A2 = id(102);
export const B1 = id(201);

export interface MergeKit {
  k: Kit;
  regs: ParticipantRegistries;
  failures: { requestId: string; code: string; errorName: string; sqlState?: string }[];
  lead: SeededSession; // front_desk_lead at A1 and B1 (requests)
  leadA1: SeededSession; // front_desk_lead at A1 only
  mr: SeededSession; // medical_records at A2 (approves; sees neither patient)
  mrA1: SeededSession; // medical_records at A1 (holds .request and .approve, sees A1 patients)
  mr2: SeededSession; // a second medical_records
  deskA1: SeededSession; // front_desk: no patient.merge permission
  deskB1: SeededSession;
  mkPatient(n: number, desk?: SeededSession, loc?: string): Promise<string>;
  request(
    who: SeededSession,
    survivorId: string,
    mergedId: string,
    reason?: string,
  ): ReturnType<typeof call>;
  approve(who: SeededSession, requestId: string, key?: string): ReturnType<typeof call>;
  run(
    requestId: string,
    over?: Partial<ExecuteDeps>,
    attempt?: number,
    max?: number,
  ): Promise<ExecuteResult>;
  /** Request by `lead`, approve by `mr`, execute: returns the request ID and the result. */
  merge(
    survivorId: string,
    mergedId: string,
  ): Promise<{ requestId: string; result: ExecuteResult }>;
  newClient(user?: string): Promise<Client>;
  close(): Promise<void>;
}

export const person = (n: number) => ({
  givenName: `Given${n}`,
  familyName: `Family${n}`,
  dateOfBirth: '1980-05-17',
  phone: `+1212555${String(1000 + n)}`,
  email: `person${n}@example.test`,
});

/**
 * The executor refuses a merge (before anything is written) unless a participant lists every table with a patient_id (22.16). The
 * database of this suite carries the tables of the combined revision (INT02-F08); the patient module may not import the modules above
 * it, so these stand-ins list those tables and report nothing found. The completeness check itself is unchanged and still asserted by
 * merge.dbtest.ts (an unregistered module fails the merge); the real participants are tested in their own modules.
 */
export const STAND_IN_TABLES: Readonly<Record<string, readonly string[]>> = {
  scheduling: [
    'scheduling.slot_reservation',
    'scheduling.check_in',
    'scheduling.queue_entry',
    'scheduling.waitlist_entry',
    'scheduling.waitlist_offer',
  ],
  telehealth: [
    'telehealth.video_session',
    'telehealth.participant',
    'telehealth.join_token',
    'telehealth.location_confirmation',
  ],
  documents: [
    'documents.document',
    'documents.document_version',
    'documents.deletion_request',
    'documents.legal_hold',
  ],
};

const ALERT_TABLES = ['notifications.staff_alert', 'notifications.staff_alert_event'] as const;
const reportNone = (tables: readonly string[]) =>
  tables.map((table) => ({ table, found: 0, repointed: 0, resolved: 0, kept: 0, deleted: [] }));

/**
 * Identity, notifications and the stand-ins of the combined revision. OPEN (INT02-F08): the real notifications participant still
 * lists only the BE-06 tables; the alert contribution (notifications/alerts/merge.ts: ALERT_MERGE_TABLES, repointAlertRows) was to be
 * wired into it "at integration" and is not, so on the combined revision every production merge fails with
 * patient.merge_participant_missing. That file is outside this ticket's paths (requested from the Orchestrator). Until it is wired
 * this wrapper adds the two alert tables, reporting nothing found, so the concurrency suite can exercise the locking; remove it with
 * the real wiring. The executor's completeness check is untouched.
 */
export function registerCombinedParticipants(regs: ParticipantRegistries): void {
  registerIdentityParticipants(regs);
  const own = new ParticipantRegistries();
  registerNotificationsParticipants(own);
  for (const real of own.mergeParticipants())
    regs.registerMergeParticipant({
      ...real,
      tables: [...real.tables, ...ALERT_TABLES.filter((t) => !real.tables.includes(t))],
      repointPatient: async (tx, merged, survivor, requestId) => {
        const done = await real.repointPatient(tx, merged, survivor, requestId);
        const have = new Set(done.map((c) => c.table));
        return [...done, ...reportNone(ALERT_TABLES.filter((t) => !have.has(t)))];
      },
    });
  for (const e of own.exportContributors()) regs.registerExportContributor(e);
  registerStandInParticipants(regs);
}

export function registerStandInParticipants(regs: ParticipantRegistries): void {
  for (const [module, tables] of Object.entries(STAND_IN_TABLES))
    regs.registerMergeParticipant({
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
}

export async function setupMerge(name: string): Promise<MergeKit> {
  const mreg = new JobRegistry();
  for (const j of MERGE_JOBS) mreg.defineJob(j);
  const holder: { k?: Kit } = {};
  // The controllers are built before the kit exists (the kit builds the app), so they reach the database lazily.
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const merges = new MergeService({ queue: new Queue(mreg, 'api') });
  const k = await setup({
    name,
    fixtures: standardFixtures,
    controllers: createMergeControllers({ db: lazyDb, merges }),
    beforeStart: ({ identity }) => {
      for (const [n, fn] of Object.entries(mergeResolvers()))
        identity.policy.registerResolver(n, fn);
    },
  });
  holder.k = k;
  try {
    for (const j of MERGE_JOBS) k.registry.defineJob(j);
    const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
    await wc.connect();
    await syncTaskTypes(wc, k.registry);
    await wc.end();

    const regs = new ParticipantRegistries();
    registerCombinedParticipants(regs);
    const failures: MergeKit['failures'] = [];

    const lead = await (async () => {
      const p = await seedPrincipal(k, 'google', {
        name: 'Lead AB',
        email: `lead.ab.${randomUUID().slice(0, 6)}@example.com`,
      });
      await assignRole(k, p.principalId, 'front_desk_lead', A1);
      await assignRole(k, p.principalId, 'front_desk_lead', B1);
      return seedSession(k, p, 'google');
    })();
    const leadA1 = await staffMember(k, 'front_desk_lead', A1, 'Lead A1');
    const mr = await staffMember(k, 'medical_records', A2, 'Records A2');
    const mrA1 = await staffMember(k, 'medical_records', A1, 'Records A1');
    const mr2 = await staffMember(k, 'medical_records', A2, 'Records A2 second');
    const deskA1 = await staffMember(k, 'front_desk', A1, 'Desk A1');
    const deskB1 = await staffMember(k, 'front_desk', B1, 'Desk B1');

    let seq = 0;
    const extra: Client[] = [];
    const kit: MergeKit = {
      k,
      regs,
      failures,
      lead,
      leadA1,
      mr,
      mrA1,
      mr2,
      deskA1,
      deskB1,
      mkPatient: (n, desk = deskA1, loc = A1) => registerViaApi(k, desk, loc, person(n)),
      request: (who, survivorId, mergedId, reason = 'Same person registered twice') =>
        call(k.base, 'POST', '/api/v1/patient-merges', {
          cookie: who.cookie,
          headers: writeHeaders(who, undefined, randomUUID()),
          body: { survivorId, mergedId, reason },
        }),
      approve: (who, requestId, key = randomUUID()) =>
        call(k.base, 'POST', `/api/v1/patient-merges/${requestId}/approve`, {
          cookie: who.cookie,
          headers: writeHeaders(who, undefined, key),
        }),
      run: (requestId, over = {}, attempt = 1, max = 1) =>
        executeMerge(
          {
            db: k.wdb,
            orgId: ORG,
            registries: regs,
            onFailure: (f) => {
              failures.push(f);
            },
            ...over,
          },
          { requestId, jobId: `test:${++seq}`, attempt, maxAttempts: max },
        ),
      async merge(survivorId, mergedId) {
        const r = await kit.request(lead, survivorId, mergedId);
        if (r.status !== 200) throw new Error(`request failed ${r.status} ${r.body}`);
        const requestId = r.json()['id'] as string;
        const a = await kit.approve(mr, requestId);
        if (a.status !== 200) throw new Error(`approve failed ${a.status} ${a.body}`);
        return { requestId, result: await kit.run(requestId) };
      },
      async newClient(user = new URL(adminUrl as string).username) {
        const c: Client = new pg.Client({ connectionString: k.urlFor(user) });
        c.on('error', () => undefined); // a backend ended by close() is not an uncaught exception
        await c.connect();
        extra.push(c);
        return c;
      },
      close: async () => {
        // Clients a test opened and left open (an assertion failed first) are ended before the database is dropped.
        await Promise.allSettled(extra.map((c) => c.end()));
        await k.close();
      },
    };
    return kit;
  } catch (e) {
    await k.close().catch(() => undefined); // a failed setup must not leave the database, pools or server open
    throw e;
  }
}
