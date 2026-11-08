// The assignment sources the chart owns or can answer (ARCHITECTURE 27.4, BQ-5 default). The identity module's resolver cannot read
// patient or scheduling tables (SHARED-BOUNDARIES 3.2), so each rule's lookup is registered by a module above them; `clinical` is
// above both. Each is one indexed lookup in the caller's transaction, bounded by the caller's own RLS, and answers "no" on any doubt.
//
//   care_team   an active `patient.care_team_member` row for the principal, for the patient or a patient merged into it (closure)
//   reservation a reservation of the patient (or of a patient merged into it) with the principal as clinician, not cancelled or
//               expired and not a bare hold, starting no earlier than `assignment_lookback_months` ago
//   authored    an encounter or note the principal authored or co-signed: the tables belong to BE-17, which registers this source
//               (`registerChartAssignmentSources` does not register it; an absent source answers "no", fail closed)
import type { AssignmentResolver, AssignmentSource } from '../../identity/index.js';

const CLOSURE = `(SELECT $2::uuid UNION SELECT m.merged_id FROM patient.patient_merge m WHERE m.final_survivor_id = $2::uuid)`;

export const careTeamSource: AssignmentSource = async (tx, principalId, patientId) =>
  (
    await tx.query(
      `SELECT 1 FROM patient.care_team_member c
        WHERE c.principal_id = $1::uuid AND c.patient_id IN ${CLOSURE} AND c.to_date IS NULL LIMIT 1`,
      [principalId, patientId],
    )
  ).rows.length > 0;

export const reservationSource: AssignmentSource = async (tx, principalId, patientId, opts) =>
  (
    await tx.query(
      `SELECT 1 FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
        WHERE r.clinician_principal_id = $1::uuid AND r.patient_id IN ${CLOSURE}
          AND o.status NOT IN ('held', 'cancelled_patient', 'cancelled_clinic', 'expired')
          AND lower(o.period) >= now() - make_interval(months => $3::int)
        LIMIT 1`,
      [principalId, patientId, opts.lookbackMonths],
    )
  ).rows.length > 0;

/** Registers the `care_team` and `reservation` sources with the identity module's resolver. A second call throws (identity says so). */
export function registerChartAssignmentSources(
  resolver: Pick<AssignmentResolver, 'registerSource'>,
): void {
  resolver.registerSource('care_team', careTeamSource);
  resolver.registerSource('reservation', reservationSource);
}
