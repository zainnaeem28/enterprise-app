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
import { ADMIN_CONFIG_PATHS, isAdminConfigPath, ADMIN_CONFIG_NAV } from './paths.js';
import type { AdminConfigPath } from './paths.js';
import './admin-config.css';

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

export { ADMIN_CONFIG_PATHS, isAdminConfigPath, ADMIN_CONFIG_NAV };
export type { AdminConfigPath };
