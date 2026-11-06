/* eslint-disable boundaries/module-boundaries -- test support: reaches the patient kit (real app, sessions, roles) the way the messaging, privacy and documents kits do */
// Harness of the reporting real-database tests (BE-21). Not a test file. A throwaway database migrated by the real pipeline (including 2100-2101),
// the real Nest application with the identity guard and the reporting controller, the real queue, seeded admin-realm and staff sessions.
// Synthetic data only.
import { randomBytes, randomUUID } from 'node:crypto';
import { KernelDb, syncTaskTypes } from '@ehr/kernel';
import {
  ORG,
  STAFF_HOST,
  assignRole,
  call,
  id,
  pg,
  saWrite,
  seedPrincipal,
  seedSession,
  setup,
  staffMember,
  standardFixtures,
} from '../patient/testkit.js';
import type { Kit, Resp, SeededSession } from '../patient/testkit.js';
import { createReporting } from './runtime.js';
import { REPORTING_JOBS } from './jobs.js';

export { ORG, STAFF_HOST, call, id, pg, saWrite };
export type { Kit, Resp, SeededSession };
export const ORG2 = '00000000-0000-7000-8000-0000000000a2';
export const A1 = id(101);

export interface ReportingKit {
  k: Kit;
  /** Admin realm, role org_admin (reporting.ops.read, no compliance slice). */
  admin: SeededSession;
  /** Admin realm, role compliance_officer (reporting.ops.read and the btg_grants slice). */
  compliance: SeededSession;
  /** Google realm, role doctor (no reporting permission). */
  doctor: SeededSession;
  /** Admin realm, role without reporting.ops.read. */
  noPerm: SeededSession;
  get(s: SeededSession | undefined, path?: string): Promise<Resp>;
  close(): Promise<void>;
}

export async function setupReporting(name: string): Promise<ReportingKit> {
  const holder: { k?: Kit } = {};
  const lazyDb = {
    withScope: (...a: Parameters<KernelDb['withScope']>) => (holder.k as Kit).db.withScope(...a),
  } as unknown as KernelDb;
  const reporting = createReporting({ db: lazyDb });
  const k = await setup({
    name,
    fixtures: async (f) => {
      await standardFixtures(f);
    },
    controllers: reporting.controllers,
  });
  holder.k = k;
  for (const d of [k.db, k.wdb])
    (d as unknown as { pool: { on(e: 'error', f: () => void): void } }).pool.on(
      'error',
      () => undefined,
    );
  for (const j of REPORTING_JOBS) k.registry.defineJob(j);
  const wc = new pg.Client({ connectionString: k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, k.registry);
  await wc.end();

  const adminSession = async (role: string, label: string): Promise<SeededSession> => {
    const p = await seedPrincipal(k, 'admin_pool', {
      name: label,
      email: `${role}.${randomBytes(4).toString('hex')}@example.com`,
    });
    await assignRole(k, p.principalId, role);
    return seedSession(k, p, 'admin_pool');
  };
  const admin = await adminSession('org_admin', 'Org Admin');
  const compliance = await adminSession('compliance_officer', 'Compliance Officer');
  const noPerm = await adminSession('compliance_on_call', 'On Call');
  const doctor = await staffMember(k, 'doctor', A1, 'Doctor A1');
  return {
    k,
    admin,
    compliance,
    doctor,
    noPerm,
    get: (s, path = '/api/v1/admin/reports/ops') =>
      call(k.base, 'GET', path, {
        host: STAFF_HOST,
        ...(s === undefined ? {} : { cookie: s.cookie }),
      }),
    close: () => k.close(),
  };
}

// --- seeding (superuser; synthetic rows) --------------------------------------------------------------------------------
export const uuid = (): string => randomUUID();
