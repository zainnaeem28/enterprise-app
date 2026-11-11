import { configStrings as s } from './strings.js';

/** The paths this feature serves in the administrator realm (UI-UX 3.2). They carry no record identifier. */
export const ADMIN_CONFIG_PATHS = [
  '/admin/clinics',
  '/admin/services',
  '/admin/policies',
  '/admin/templates',
  '/admin/integrations',
  '/admin/flags',
  '/admin/vital-ranges',
  '/admin/licensing',
] as const;
export type AdminConfigPath = (typeof ADMIN_CONFIG_PATHS)[number];
export const isAdminConfigPath = (path: string): path is AdminConfigPath =>
  (ADMIN_CONFIG_PATHS as readonly string[]).includes(path);

export const ADMIN_CONFIG_NAV: { path: AdminConfigPath; label: string }[] = [
  { path: '/admin/clinics', label: s.navClinics },
  { path: '/admin/services', label: s.navServices },
  { path: '/admin/policies', label: s.navPolicies },
  { path: '/admin/templates', label: s.navTemplates },
  { path: '/admin/integrations', label: s.navIntegrations },
  { path: '/admin/flags', label: s.navFlags },
  { path: '/admin/vital-ranges', label: s.navVitals },
  { path: '/admin/licensing', label: s.navLicensing },
];
