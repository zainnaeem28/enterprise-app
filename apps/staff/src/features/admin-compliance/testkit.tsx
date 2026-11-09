// CONTRACT MOCK of audit.yaml (POST /admin/audit-events/search, POST|GET /admin/audit-exports…, GET /admin/btg-grants, POST
// …/review), identity.yaml (GET /admin/principals, GET /admin/roles, POST /admin/role-change-requests[/{id}/approve|reject|cancel])
// and privacy.yaml (GET /admin/privacy-requests, POST …/verify-identity, POST …/decide). The bodies are copied from the BE-24,
// BE-05 and BE-20 controllers. No real API, database or security key runs in these tests.
import type { ReactNode } from 'react';
import { ElevationProvider, ElevationStore, createElevation } from '../admin-auth/index.js';
import { fakeKey, json, mockRuntime } from '../admin-auth/testkit.js';
import type { Seen } from '../admin-auth/testkit.js';
import { AdminCompliancePortal } from './AdminCompliancePortal.js';
import type { AdminCompliancePath } from './AdminCompliancePortal.js';

export { json, fakeKey, mockRuntime };
export type { Seen };

export const ID = (n: number) => `123e4567-e89b-42d3-a456-4266141740${String(n).padStart(2, '0')}`;
export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { code, requestId: 'req-1', ...extra });

export function portal(
  path: AdminCompliancePath,
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
      <AdminCompliancePortal runtime={runtime} path={path} navigate={() => undefined} />
    </ElevationProvider>
  );
  return { ui, seen, store, runtime };
}

export const event = (n: number, over: Record<string, unknown> = {}) => ({
  eventId: ID(n),
  occurredAt: '2026-11-08T10:00:00.000Z',
  actorPersonId: ID(90),
  realm: 'staff',
  audience: 'staff',
  action: 'view',
  resourceType: 'clinical.chart',
  resourceId: ID(n + 10),
  patientId: ID(70),
  locationId: null,
  btgGrantId: null,
  reason: null,
  ip: null,
  userAgent: null,
  outcome: 'allowed',
  denialReason: null,
  ...over,
});
export const grant = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  holderPersonId: ID(80),
  patientId: ID(70),
  reason: 'Patient collapsed in waiting room',
  openedAt: '2026-11-08T09:00:00.000Z',
  expiresAt: '2026-11-08T13:00:00.000Z',
  revokedAt: null,
  reviewStatus: 'pending',
  review: null,
  ...over,
});
export const principal = (n: number, over: Record<string, unknown> = {}) => ({
  principalId: ID(n),
  realm: 'admin_pool',
  handle: `admin.${n}`,
  status: 'active',
  displayName: `Admin ${n}`,
  ...over,
});
export const roles = [
  {
    key: 'compliance_officer',
    realm: 'admin_pool',
    privileged: true,
    locationBound: false,
    description: 'Compliance',
    permissions: ['audit.event.read'],
  },
  {
    key: 'system_admin',
    realm: 'admin_pool',
    privileged: true,
    locationBound: false,
    description: 'Admin',
    permissions: [],
  },
  {
    key: 'doctor',
    realm: 'google',
    privileged: false,
    locationBound: true,
    description: 'Doctor',
    permissions: [],
  },
];
export const change = (over: Record<string, unknown> = {}) => ({
  id: ID(60),
  status: 'requested',
  subjectPrincipalId: ID(1),
  requesterPersonId: ID(91),
  approverPersonId: null,
  add: [{ roleKey: 'compliance_officer' }],
  remove: [],
  before: [],
  expiresAt: '2026-11-10T10:00:00.000Z',
  decidedAt: null,
  ...over,
});
export const request = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  patientId: ID(70),
  kind: 'export',
  channel: 'portal',
  status: 'received',
  detail: null,
  verificationMethod: null,
  verifiedAt: null,
  decidedAt: null,
  decisionReason: null,
  dueAt: '2026-12-01T00:00:00.000Z',
  legalHold: null,
  package: null,
  createdAt: '2026-11-07T08:00:00.000Z',
  version: 1,
  ...over,
});
