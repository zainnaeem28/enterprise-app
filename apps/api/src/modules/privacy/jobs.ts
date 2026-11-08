// Job types and events of the privacy module (ARCHITECTURE 33.1, 24). Keep apps/worker/src/jobs/privacy/jobs.ts in step (each side's
// test pins the same list).
//
//   privacy.assemble_export   request approved. Payload {requestId, patientId, packageId}. Chunked per contributor (6.7). on_merged = resolve:
//                             the package row follows the patient (22.16), so the job reads the patient from the row, not the payload.
//   privacy.check_legal_holds deletion request recorded. Payload {requestId, patientId}. Counts the documents under a legal hold for the
//                             patient and every merged ID and writes the result on the request (a patient session cannot read holds).
//   privacy.expire_packages   daily, organisation scope: expires packages past `expires_at` and removes their objects.
import type { JobType } from '@ehr/kernel';

export const PRIVACY_JOBS: readonly JobType[] = [
  {
    name: 'privacy.assemble_export',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'privacy.check_legal_holds',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'privacy.expire_packages',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab: the expiry daily at 03:50 (33.1). */
export const PRIVACY_CRONTAB = '50 3 * * * privacy.expire_packages';

/** Events this module publishes (24). */
export const PRIVACY_EVENTS = ['privacy.correction_requested', 'privacy.export_ready'] as const;
