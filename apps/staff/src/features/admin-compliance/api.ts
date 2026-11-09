import { guard } from '../preconsult/http.js';
import type { Api, Outcome } from '../preconsult/http.js';
import {
  parseBtgGrant,
  parseAuditSearch,
  parseDownload,
  parseExportJob,
  parsePage,
  parsePrincipal,
  parsePrivacyRequest,
  parseRole,
  parseRoleChange,
} from './types.js';
import type {
  AuditEvent,
  BtgGrant,
  ExportJob,
  Page,
  Principal,
  PrivacyRequest,
  Role,
  RoleChange,
  RoleRef,
} from './types.js';

type Method = 'GET' | 'POST';
type LooseCall = (
  path: string,
  init: {
    params: {
      header: Record<string, string>;
      path?: Record<string, string>;
      query?: Record<string, string>;
    };
    body?: unknown;
  },
) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

export interface AuditFilter {
  from: string;
  to: string;
  actorPersonId?: string;
  patientId?: string;
  action?: string;
  resourceType?: string;
}
export type PrivacyDecision = 'approve' | 'refuse' | 'retry' | 'fulfil';

/**
 * Every call the admin compliance screens make. The generated types of these operations are opaque, so they go through the same
 * untyped seam the other staff features use, with the bodies of the BE-24 audit routes, the BE-05 identity admin controller and
 * the BE-20 privacy controller. Privileged calls (export, BTG review, role change, approval) are run by the caller inside
 * `callPrivileged`, so a missing grant opens the security-key dialog first. Nothing here keeps a value in storage.
 */
export function createComplianceApi(api: Api) {
  const header = api.header;
  const loose = api as unknown as Record<Method, LooseCall>;
  const paged = (cursor?: string, extra: Record<string, string> = {}) => ({
    limit: '50',
    ...extra,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const withMatch = (v: number | undefined) =>
    v === undefined ? header : { ...header, 'If-Match': `W/"${v}"` };

  return {
    // The raw Response is part of the result of the privileged calls (callPrivileged looks at it), so these return the loose answer too.
    searchAudit: (f: AuditFilter): Promise<Outcome<{ items: AuditEvent[]; truncated: boolean }>> =>
      guard(
        () =>
          loose.POST('/api/v1/admin/audit-events/search', {
            params: { header },
            body: { ...f, limit: 200 },
          }),
        parseAuditSearch,
      ),
    requestExportRaw: (f: AuditFilter, reason: string) =>
      loose.POST('/api/v1/admin/audit-exports', { params: { header }, body: { ...f, reason } }),
    exportStatus: (id: string): Promise<Outcome<ExportJob>> =>
      guard(
        () => loose.GET('/api/v1/admin/audit-exports/{id}', { params: { header, path: { id } } }),
        parseExportJob,
      ),
    downloadRaw: (id: string) =>
      loose.POST('/api/v1/admin/audit-exports/{id}/download-url', {
        params: { header, path: { id } },
        body: {},
      }),
    btgGrants: (reviewStatus: string, cursor?: string): Promise<Outcome<Page<BtgGrant>>> =>
      guard(
        () =>
          loose.GET('/api/v1/admin/btg-grants', {
            params: { header, query: paged(cursor, { reviewStatus }) },
          }),
        parsePage(parseBtgGrant),
      ),
    reviewBtgRaw: (id: string, outcome: 'justified' | 'not_justified', note: string) =>
      loose.POST('/api/v1/admin/btg-grants/{id}/review', {
        params: { header, path: { id } },
        body: { outcome, note },
      }),
    principals: (q: string, realm: string, cursor?: string): Promise<Outcome<Page<Principal>>> =>
      guard(
        () =>
          loose.GET('/api/v1/admin/principals', {
            params: {
              header,
              query: paged(cursor, {
                ...(q === '' ? {} : { q }),
                ...(realm === '' ? {} : { realm }),
              }),
            },
          }),
        parsePage(parsePrincipal),
      ),
    roles: (): Promise<Outcome<Page<Role>>> =>
      guard(() => loose.GET('/api/v1/admin/roles', { params: { header } }), parsePage(parseRole)),
    requestRoleChangeRaw: (subjectPrincipalId: string, add: RoleRef[], remove: RoleRef[]) =>
      loose.POST('/api/v1/admin/role-change-requests', {
        params: { header },
        body: { subjectPrincipalId, add, remove },
      }),
    decideRoleChangeRaw: (id: string, decision: 'approve' | 'reject' | 'cancel') =>
      loose.POST(`/api/v1/admin/role-change-requests/{id}/${decision}`, {
        params: { header, path: { id } },
        body: {},
      }),
    privacyRequests: (status: string, cursor?: string): Promise<Outcome<Page<PrivacyRequest>>> =>
      guard(
        () =>
          loose.GET('/api/v1/admin/privacy-requests', {
            params: { header, query: paged(cursor, status === '' ? {} : { status }) },
          }),
        parsePage(parsePrivacyRequest),
      ),
    verifyIdentity: (
      id: string,
      method: string,
      version?: number,
    ): Promise<Outcome<PrivacyRequest>> =>
      guard(
        () =>
          loose.POST('/api/v1/admin/privacy-requests/{id}/verify-identity', {
            params: { header: withMatch(version), path: { id } },
            body: { method },
          }),
        parsePrivacyRequest,
      ),
    decidePrivacy: (
      id: string,
      decision: PrivacyDecision,
      reason: string,
      version?: number,
    ): Promise<Outcome<PrivacyRequest>> =>
      guard(
        () =>
          loose.POST('/api/v1/admin/privacy-requests/{id}/decide', {
            params: { header: withMatch(version), path: { id } },
            body: reason === '' ? { decision } : { decision, reason },
          }),
        parsePrivacyRequest,
      ),
  };
}
export type ComplianceApi = ReturnType<typeof createComplianceApi>;
export { parseRoleChange, parseExportJob, parseDownload, parseBtgGrant };
export type { RoleChange, ExportJob };
