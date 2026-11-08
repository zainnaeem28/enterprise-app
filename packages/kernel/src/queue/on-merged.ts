// Job-start handling of a merged patient ID (SHARED-BOUNDARIES 9.2, SBR-12). `lookup` answers from the merge map in the caller's own
// transaction; this module decides what the job type's `on_merged` declaration means. A patient-carrying type that declares nothing
// is treated as `fail` (the registry refuses to define one, so this is the second line).
import type { JobType } from './enqueue.js';

export type PatientState =
  { state: 'active' } | { state: 'merged'; survivorId: string } | { state: 'unknown' };

/** The job goes to the dead-letter state with this code (shown in the operations view); retrying cannot help. */
export class JobPatientMergedError extends Error {
  readonly code = 'patient.merged';
  constructor(readonly patientId: string) {
    super('patient.merged');
    this.name = 'JobPatientMergedError';
  }
}

export async function applyOnMerged(
  type: Pick<JobType, 'carriesPatientIds' | 'onMerged'>,
  patientIds: readonly string[],
  lookup: (patientId: string) => Promise<PatientState>,
): Promise<string[]> {
  if (!type.carriesPatientIds) return [...patientIds];
  const declared = (type.onMerged as string | undefined) ?? 'fail';
  const out: string[] = [];
  for (const id of patientIds) {
    const s = await lookup(id);
    if (s.state === 'active') out.push(id);
    else if (s.state === 'merged' && declared === 'resolve') out.push(s.survivorId);
    else throw new JobPatientMergedError(id);
  }
  return out;
}
