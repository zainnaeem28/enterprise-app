// The compliance alert of the daily staff-scope drift check (SHARED-BOUNDARIES 6.6, QA-EXEC-F10, TC-AZ-09). `patient.verify_staff_scope`
// calls `onDrift` after it has repaired the table; this raises the `scope_drift` alert to the holders of the compliance permission,
// under system scope, through the API's alert port. IDs and counts only: the alert names the run, never a patient or a location.
// An extra row exposes a patient to a location that does not care for them (privacy: high); a missing row hides history from the staff
// who care for the patient (safety: medium). The resource ID is derived from the run and the kind, so a retried run raises one alert.
import type { KernelDb, Logger } from '@ehr/kernel';
import { COMPLIANCE_PERMISSION, type ComplianceAlertPort } from '../identity/admin-events.js';
import { jobUuid } from '../messaging/index.js';
import { systemScope } from './scope.js';
import type { VerifyDeps } from './verify-staff-scope.js';

export function scopeDriftAlerter(deps: {
  db: KernelDb;
  orgId: string;
  alerts: ComplianceAlertPort;
  log?: Pick<Logger, 'error'>;
}): NonNullable<VerifyDeps['onDrift']> {
  return async (kind, count, jobId) => {
    const resourceId = jobUuid(`patient.scope_drift.${kind}`, jobId);
    try {
      await deps.db.withScope(systemScope(deps.orgId), (tx) =>
        deps.alerts.raise(
          tx,
          {
            type: 'scope_drift',
            severity: kind === 'extra' ? 'high' : 'medium',
            resourceType: 'patient_staff_scope',
            resourceId,
            permission: COMPLIANCE_PERMISSION,
          },
          resourceId,
        ),
      );
    } catch (e) {
      // The repair is committed and the job must not fail for it, but a lost compliance alert is never silent.
      deps.log?.error('scope drift found but the alert could not be raised', {
        kind,
        count,
        error: e instanceof Error ? e.name : 'error',
      });
    }
  };
}
