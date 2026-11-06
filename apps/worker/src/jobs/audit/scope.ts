import type { ScopeSettings } from '@ehr/kernel';

/** The scope of an organisation-wide system job (T-SYS): audience `system`, job scope `org`, worker realm. */
export function systemScope(orgId: string, personId?: string): ScopeSettings {
  return {
    audience: 'system',
    realm: 'worker',
    orgId,
    jobScope: 'org',
    ...(personId === undefined ? {} : { personId }),
  };
}

export const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
