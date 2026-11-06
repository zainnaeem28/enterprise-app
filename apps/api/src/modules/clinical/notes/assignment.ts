// The `authored` assignment source (ARCHITECTURE 27.4, BQ-5 default): the principal authored or co-signed an encounter or a note for
// the patient (or for a patient merged into it, via the closure), no earlier than `assignment_lookback_months` ago. The tables are this
// module's, so this module registers the lookup (identity cannot import clinical); the chart registers `care_team` and `reservation`.
// One indexed lookup per table in the caller's transaction, bounded by the caller's own RLS; any doubt answers "no".
import type { AssignmentResolver, AssignmentSource } from '../../identity/index.js';

const CLOSURE = `(SELECT $2::uuid UNION SELECT m.merged_id FROM patient.patient_merge m WHERE m.final_survivor_id = $2::uuid)`;

export const authoredSource: AssignmentSource = async (tx, principalId, patientId, opts) =>
  (
    await tx.query(
      `SELECT 1 FROM clinical.encounter e
        WHERE e.clinician_principal_id = $1::uuid AND e.patient_id IN ${CLOSURE}
          AND e.created_at >= now() - make_interval(months => $3::int)
       UNION ALL
       SELECT 1 FROM clinical.note n
        WHERE n.author_principal_id = $1::uuid AND n.patient_id IN ${CLOSURE}
          AND n.created_at >= now() - make_interval(months => $3::int)
       UNION ALL
       SELECT 1 FROM clinical.note_cosign c
        WHERE c.supervisor_principal_id = $1::uuid AND c.patient_id IN ${CLOSURE}
          AND c.cosigned_at >= now() - make_interval(months => $3::int)
       LIMIT 1`,
      [principalId, patientId, opts.lookbackMonths],
    )
  ).rows.length > 0;

/** Registers the `authored` source with the identity module's resolver. A second call throws (identity says so). */
export function registerNotesAssignmentSources(
  resolver: Pick<AssignmentResolver, 'registerSource'>,
): void {
  resolver.registerSource('authored', authoredSource);
}
