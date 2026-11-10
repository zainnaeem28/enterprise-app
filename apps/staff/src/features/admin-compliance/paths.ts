import { adminStrings as s } from './strings.js';

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
