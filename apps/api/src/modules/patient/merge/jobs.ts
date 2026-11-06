// The execute job of the merge (ARCHITECTURE 33.1, 25.4) and the CI check on job types that carry patient IDs (SHARED-BOUNDARIES
// 9.2 "Jobs and events that name a merged ID"). `patient.execute_merge` declares `fail`: the approval named those exact records, so
// if either is no longer active the request fails with `patient.already_merged` and the job is never redirected to a survivor. Its
// payload is the request ID only (BD-09); the patient IDs are read from the request row, so the job does not "carry patient IDs"
// in the sense of the kernel registry (which lets a patient-carrying type declare `resolve` only).
import type { JobType } from '@ehr/kernel';

export const EXECUTE_MERGE_JOB = 'patient.execute_merge';

export const MERGE_JOBS: readonly JobType[] = [
  {
    name: EXECUTE_MERGE_JOB,
    // Transient failures (deadlock, lock timeout, 60 s bound) are retried whole; the last attempt records `failed`.
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'patients',
    jobClass: 'job',
  },
];

/** The declared behaviour for a job whose payload names a merged patient. Only `resolve` is expressible by the kernel type. */
export interface JobDeclaration {
  name: string;
  carriesPatientIds: boolean;
  onMerged: string | undefined;
}

/**
 * The CI check of TC-MG-10 step 4: lists job types and their `on_merged` declaration and returns the violations. A job type that
 * carries patient IDs and declares nothing (or anything but `resolve` / `fail`) is a violation, and so is one that declares
 * `none`. Types that carry no patient IDs need no declaration.
 */
export function jobDeclarationViolations(types: readonly JobDeclaration[]): string[] {
  const out: string[] = [];
  for (const t of types) {
    if (!t.carriesPatientIds) continue;
    if (t.onMerged !== 'resolve' && t.onMerged !== 'fail')
      out.push(`${t.name}: carries patient IDs but declares on_merged = ${String(t.onMerged)}`);
  }
  return out;
}

/** Name, carries-patient-ids and declaration of every type, for the listing the CI check prints. */
export function listJobDeclarations(types: readonly JobType[]): JobDeclaration[] {
  return types.map((t) => ({
    name: t.name,
    carriesPatientIds: t.carriesPatientIds,
    onMerged: t.onMerged === 'none' ? undefined : t.onMerged,
  }));
}
