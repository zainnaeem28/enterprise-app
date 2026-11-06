// `patient.verify_staff_scope` (SHARED-BOUNDARIES 6.6, daily, organisation-wide): recomputes the staff-scope derivation for the
// whole organisation, compares it with the table, repairs through the same derivation and reports two counts. A missing row hides
// history from the staff who care for the patient (safety: an operations alert); an extra row exposes a patient to a location that
// does not care for them (privacy: a compliance alert with the affected count). The alert carries no patient data. The raising of
// the alerts is the composition root's (`onDrift`): the alert tables belong to BE-07. The job writes the summary audit row.
import type { KernelDb } from '@ehr/kernel';
import { systemScope } from './scope.js';

export interface DriftReport {
  missingRows: number;
  extraRows: number;
}

export interface VerifyDeps {
  db: KernelDb;
  orgId: string;
  jobId: string;
  /** Called after the repair has committed, once per kind of drift found. Must not throw into the job's result. */
  onDrift?: (kind: 'missing' | 'extra', count: number) => Promise<void> | void;
}

export async function runVerifyStaffScope(deps: VerifyDeps): Promise<DriftReport> {
  const report = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = await tx.query(`SELECT missing_rows, extra_rows FROM patient.verify_staff_scope()`);
    const row = r.rows[0] as Record<string, unknown>;
    const counts: DriftReport = {
      missingRows: Number(row['missing_rows']),
      extraRows: Number(row['extra_rows']),
    };
    // The summary row of the run, with the two counts and nothing else (8.1: no clinical value, no identifier).
    await tx.query(
      `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, change, outcome)
       VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'update', 'patient.staff_scope', $2::jsonb, 'allowed')`,
      [deps.jobId.slice(0, 200), JSON.stringify(counts)],
    );
    return counts;
  });
  try {
    if (report.missingRows > 0) await deps.onDrift?.('missing', report.missingRows);
    if (report.extraRows > 0) await deps.onDrift?.('extra', report.extraRows);
  } catch {
    // The repair is committed; a failing alert hook is the alert path's problem and is surfaced by its own monitoring.
  }
  return report;
}
