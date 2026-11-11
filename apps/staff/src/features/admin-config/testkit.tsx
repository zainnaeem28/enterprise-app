// CONTRACT MOCK of organisation.yaml (BE-23 admin routes), integration-core.yaml (GET /admin/integrations, POST …/test,
// PUT …/secrets/{name}) and clinical.yaml (GET|POST /admin/vital-ranges, POST …/retire). Bodies are copied from the BE-23 service
// (apps/api/src/modules/organisation/admin) and the integration-core connection record. The integration list and the vital-range
// rows have opaque response types in the contract, so their row shape here is the connection record / 22.11 table, not a proven
// wire format. No real API, database or security key runs in these tests.
import type { ReactNode } from 'react';
import { ElevationProvider, ElevationStore, createElevation } from '../admin-auth/index.js';
import { fakeKey, json, mockRuntime } from '../admin-auth/testkit.js';
import type { Seen } from '../admin-auth/testkit.js';
import { AdminConfigPortal } from './AdminConfigPortal.js';
import type { AdminConfigPath } from './AdminConfigPortal.js';

export { json, fakeKey, mockRuntime };
export type { Seen };

export const ID = (n: number) => `123e4567-e89b-42d3-a456-4266141740${String(n).padStart(2, '0')}`;
export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { code, requestId: 'req-1', ...extra });
export const page = (items: unknown[], nextCursor: string | null = null) =>
  json(200, { items, nextCursor });

export function portal(
  path: AdminConfigPath,
  handler: (seen: Seen) => Response | Promise<Response>,
  opts: { granted?: boolean } = { granted: true },
) {
  const { runtime, seen } = mockRuntime(handler);
  const store = new ElevationStore();
  if (opts.granted !== false) store.grant(new Date(Date.now() + 600_000).toISOString());
  const keys = fakeKey();
  const elevation = createElevation(runtime, keys.key, store);
  const ui: ReactNode = (
    <ElevationProvider elevation={elevation}>
      <AdminConfigPortal runtime={runtime} path={path} navigate={() => undefined} />
    </ElevationProvider>
  );
  return { ui, seen, store, runtime, keys };
}

export const location = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  name: `Clinic ${n}`,
  kind: 'clinic',
  timeZone: 'America/New_York',
  address: null,
  stateCode: 'AA',
  phone: null,
  active: true,
  rowVersion: 1,
  ...over,
});
export const service = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  internalName: `Service ${n}`,
  patientDisplayName: `Service ${n}`,
  durationMin: 30,
  bufferMin: 0,
  mode: 'either',
  priceCents: null,
  currency: null,
  feeCents: null,
  conditionRevealing: false,
  active: true,
  rowVersion: 1,
  ...over,
});
export const policy = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  serviceId: ID(30),
  locationId: null,
  leadTimeMin: 60,
  cutoffHours: 24,
  lateChange: 'block',
  maxFuturePerPatient: 3,
  waitlistEnabled: true,
  overbookCapPerSession: 0,
  holdMinutes: null,
  noShowGraceMin: null,
  rowVersion: 1,
  ...over,
});
export const integration = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  kind: 'email',
  vendor: 'ses',
  enabled: true,
  health: 'ok',
  lastTestAt: '2026-11-08T10:00:00.000Z',
  lastTestResult: null,
  rowVersion: 2,
  ...over,
});
