import type { ScopeSettings } from '@ehr/kernel';

/** An organisation-wide system job (T-SYS): audience `system`, job scope `org`, worker realm. */
export function systemScope(orgId: string): ScopeSettings {
  return { audience: 'system', realm: 'worker', orgId, jobScope: 'org' };
}

/** A patients-scope system job narrowed to the given patient IDs (T-SYS, SHARED-BOUNDARIES 6.1, 6.7). */
export function patientsScope(orgId: string, patientIds: readonly string[]): ScopeSettings {
  return {
    audience: 'system',
    realm: 'worker',
    orgId,
    jobScope: 'patients',
    jobPatientIds: patientIds,
  };
}
