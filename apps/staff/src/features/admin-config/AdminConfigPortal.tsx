import { useMemo } from 'react';
import type { ShellRuntime } from '@ehr/app-shell';
import { Clinics } from './Clinics.js';
import { FlagsBanners } from './FlagsBanners.js';
import { Integrations } from './Integrations.js';
import { Policies } from './Policies.js';
import { Services } from './Services.js';
import { Templates } from './Templates.js';
import { VitalRanges } from './VitalRanges.js';
import { createConfigApi } from './api.js';
import { ConfigContext } from './hooks.js';
import { configStrings as s } from './strings.js';
import './admin-config.css';

/** The paths this feature serves in the administrator realm (UI-UX 3.2). They carry no record identifier. */
export const ADMIN_CONFIG_PATHS = [
  '/admin/clinics',
  '/admin/services',
  '/admin/policies',
  '/admin/templates',
  '/admin/integrations',
  '/admin/flags',
  '/admin/vital-ranges',
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
];

/**
 * Admin configuration: clinics, services, booking policies, templates, integrations, flags & banners and vital ranges (FE-14).
 * The host mounts it inside an `ElevationProvider` (FE-17) under the administrator realm bar. Every route it calls needs a live
 * elevation grant; the server authorizes each call and audits each change.
 */
export function AdminConfigPortal({
  runtime,
  path,
  navigate,
}: {
  runtime: Pick<ShellRuntime, 'api'>;
  path: AdminConfigPath;
  navigate: (path: string) => void;
}) {
  const api = useMemo(() => createConfigApi(runtime.api), [runtime.api]);
  return (
    <ConfigContext.Provider value={{ api }}>
      <div className="ehr-admin ehr-admin-config">
        <nav aria-label={s.portalTitle} className="ehr-subnav">
          <ul>
            {ADMIN_CONFIG_NAV.map((i) => (
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
        {path === '/admin/clinics' && <Clinics />}
        {path === '/admin/services' && <Services />}
        {path === '/admin/policies' && <Policies />}
        {path === '/admin/templates' && <Templates />}
        {path === '/admin/integrations' && <Integrations />}
        {path === '/admin/flags' && <FlagsBanners />}
        {path === '/admin/vital-ranges' && <VitalRanges />}
      </div>
    </ConfigContext.Provider>
  );
}
