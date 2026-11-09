import { useMemo } from 'react';
import type { ShellRuntime } from '@ehr/app-shell';
import { AuditLog } from './AuditLog.js';
import { BtgReview } from './BtgReview.js';
import { PrivacyRequests } from './PrivacyRequests.js';
import { UsersRoles } from './UsersRoles.js';
import { createComplianceApi } from './api.js';
import { ComplianceContext } from './context.js';
import { adminStrings as s } from './strings.js';
import './admin-compliance.css';

/** The paths this feature serves in the administrator realm (UI-UX 3.2). They carry no record identifier. */
export const ADMIN_COMPLIANCE_PATHS = [
  '/admin/audit',
  '/admin/btg',
  '/admin/users',
  '/admin/privacy',
] as const;
export type AdminCompliancePath = (typeof ADMIN_COMPLIANCE_PATHS)[number];
export const isAdminCompliancePath = (path: string): path is AdminCompliancePath =>
  (ADMIN_COMPLIANCE_PATHS as readonly string[]).includes(path);

export const ADMIN_COMPLIANCE_NAV: { path: AdminCompliancePath; label: string }[] = [
  { path: '/admin/audit', label: s.navAudit },
  { path: '/admin/btg', label: s.navBtg },
  { path: '/admin/privacy', label: s.navPrivacy },
  { path: '/admin/users', label: s.navUsers },
];

/**
 * Admin audit log, break-the-glass review, users & roles with approvals, and privacy requests (FE-13). The host mounts it inside an
 * `ElevationProvider` (FE-17) under the administrator realm bar. Permissions only decide what the server lets through; the server
 * authorizes every call and enforces requester ≠ approver.
 */
export function AdminCompliancePortal({
  runtime,
  path,
  navigate,
}: {
  runtime: Pick<ShellRuntime, 'api'>;
  path: AdminCompliancePath;
  navigate: (path: string) => void;
}) {
  const api = useMemo(() => createComplianceApi(runtime.api), [runtime.api]);
  return (
    <ComplianceContext.Provider value={{ api }}>
      <div className="ehr-admin">
        <nav aria-label={s.portalTitle} className="ehr-subnav">
          <ul>
            {ADMIN_COMPLIANCE_NAV.map((i) => (
              <li key={i.path}>
                <a
                  href={i.path}
                  aria-current={i.path === path ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(i.path);
                  }}
                >
                  {i.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {path === '/admin/audit' && <AuditLog />}
        {path === '/admin/btg' && <BtgReview />}
        {path === '/admin/users' && <UsersRoles />}
        {path === '/admin/privacy' && <PrivacyRequests />}
      </div>
    </ComplianceContext.Provider>
  );
}
