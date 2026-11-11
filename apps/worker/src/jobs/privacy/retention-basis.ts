// What the retention date of a patient's medical record is computed from (owner ruling C item 2): the last encounter (the registration
// date stands in when there was none) and the date of birth (the minors rule). Read under the job's patients scope.
import type { Tx } from '@ehr/kernel';

type Row = Record<string, unknown>;

export interface RetentionBasis {
  lastEncounterDate: string | null;
  registeredDate: string;
  birthDate: string | null;
}

export async function readRetentionBasis(
  tx: Tx,
  patientId: string,
  patientIds: readonly string[],
): Promise<RetentionBasis> {
  const enc = (
    await tx.query(
      `SELECT to_char(max(coalesce(ended_at, started_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d
         FROM clinical.encounter WHERE patient_id = ANY($1::uuid[])`,
      [[...patientIds]],
    )
  ).rows[0] as Row | undefined;
  const reg = (
    await tx.query(
      `SELECT to_char(min(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM patient.patient WHERE id = ANY($1::uuid[])`,
      [[...patientIds]],
    )
  ).rows[0] as Row | undefined;
  const own = (
    await tx.query(
      `SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS d FROM patient.patient WHERE id = $1::uuid`,
      [patientId],
    )
  ).rows[0] as Row | undefined;
  const registered = reg?.['d'];
  if (typeof registered !== 'string') throw new Error('privacy retention: the patient is not visible');
  return {
    lastEncounterDate: typeof enc?.['d'] === 'string' ? enc['d'] : null,
    registeredDate: registered,
    birthDate: typeof own?.['d'] === 'string' ? own['d'] : null,
  };
}
