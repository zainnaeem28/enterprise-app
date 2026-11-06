import type { ScopeSettings } from '@ehr/kernel';

/** The scope of an organisation-wide system job (T-SYS): audience `system`, job scope `org`, worker realm. */
export function systemScope(orgId: string): ScopeSettings {
  return { audience: 'system', realm: 'worker', orgId, jobScope: 'org' };
}

/** A patients-scope system job narrowed to the given patient IDs (T-SYS, SHARED-BOUNDARIES 6.1). */
export function patientsScope(orgId: string, patientIds: readonly string[]): ScopeSettings {
  return {
    audience: 'system',
    realm: 'worker',
    orgId,
    jobScope: 'patients',
    jobPatientIds: patientIds,
  };
}
