import type { ScopeSettings } from '@ehr/kernel';

/** The scope of an organisation-wide system job (T-SYS): audience `system`, job scope `org`, worker realm. */
export function systemScope(orgId: string): ScopeSettings {
  return { audience: 'system', realm: 'worker', orgId, jobScope: 'org' };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
