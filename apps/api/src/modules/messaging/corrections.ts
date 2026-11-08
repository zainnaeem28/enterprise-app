// The handler of `privacy.correction_requested` (ARCHITECTURE 24; SHARED-BOUNDARIES 3.2 rule 2, "a correction request becomes a task
// through an outbox event that messaging handles"). It runs in the worker as a patients-scope system job for the patient in the event.
//
// Who gets the task: the patient's active primary clinician, else another active member of their care team (an active staff principal),
// else the care coordinator role at the location of their oldest open care relationship ("a staff-realm user with clinical permission at
// a location that cares for the patient", SHARED-BOUNDARIES 466). With nobody to give it to, the job fails and retries, then dead-letters
// where operations see it: a correction request must never be lost silently.
//
// One task per request however often the event is delivered (the partial unique index on source and source_ref). No title or detail
// carries anything from the request: staff open the request through privacy.
import type { KernelDb, Queue, Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import { MessagingValidationError } from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import { patientsScope } from './scope.js';
import { TASK_CREATED_EVENT } from './tasks.js';

type Row = Record<string, unknown>;

export interface CorrectionDeps {
  db: KernelDb;
  orgId: string;
  audit: Pick<AuditService, 'record'>;
  /** The worker-path queue. */
  queue: Queue;
  now?: () => Date;
}

/** Days given to act on a correction request (the privacy due date is the request's own; this is the task's reminder). */
export const CORRECTION_TASK_DAYS = 14;
export const CORRECTION_FALLBACK_ROLE = 'care_coordinator';

export class NoAssigneeError extends Error {
  constructor() {
    super('messaging.no_assignee: no active care-team member or care location for the patient');
    this.name = 'NoAssigneeError';
  }
}

async function chooseAssignee(
  tx: Tx,
  patientId: string,
): Promise<{ principalId: string } | { roleKey: string; locationId: string }> {
  const team = await tx.query(
    `SELECT c.principal_id FROM patient.care_team_member c
      WHERE c.patient_id = $1::uuid AND c.to_date IS NULL
      ORDER BY (c.role = 'primary_clinician') DESC, c.from_date, c.id LIMIT 1`,
    [patientId],
  );
  const t = team.rows[0] as Row | undefined;
  if (t !== undefined) return { principalId: String(t['principal_id']) };
  const rel = await tx.query(
    `SELECT location_id FROM patient.care_relationship WHERE patient_id = $1::uuid AND ended_at IS NULL ORDER BY started_at, id LIMIT 1`,
    [patientId],
  );
  const r = rel.rows[0] as Row | undefined;
  if (r === undefined) throw new NoAssigneeError();
  return { roleKey: CORRECTION_FALLBACK_ROLE, locationId: String(r['location_id']) };
}

/** Returns `created` or `already_exists` (a redelivery). `jobId` is the queue job's UUID (the task's `created_by_job`). */
export async function runOnCorrectionRequested(
  deps: CorrectionDeps,
  payload: Record<string, unknown>,
  jobId: string,
): Promise<'created' | 'already_exists'> {
  const requestId = payload['requestId'];
  const patientId = payload['patientId'];
  if (!isUuid(requestId)) throw new MessagingValidationError(['requestId']);
  if (!isUuid(patientId)) throw new MessagingValidationError(['patientId']);
  if (!isUuid(jobId)) throw new MessagingValidationError(['jobId']);
  const pid = patientId.toLowerCase();
  const now = deps.now?.() ?? new Date();
  return deps.db.withScope(patientsScope(deps.orgId, [pid]), async (tx) => {
    const to = await chooseAssignee(tx, pid);
    const id = uuidv7();
    const due = new Date(now.getTime() + CORRECTION_TASK_DAYS * 86_400_000).toISOString();
    const r = await tx.query(
      `INSERT INTO messaging.task (id, organisation_id, patient_id, title, detail, assignee_kind, assignee_principal_id, assignee_role_key,
                                   assignee_location_id, due_at, source, source_ref, created_by_job)
       VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, 'Review a patient data correction request', NULL, $3, $4::uuid, $5, $6::uuid,
               $7::timestamptz, 'privacy_correction', $8::uuid, $9::uuid)
       ON CONFLICT (source, source_ref) WHERE source <> 'manual' DO NOTHING`,
      [
        id,
        pid,
        'principalId' in to ? 'principal' : 'role_location',
        'principalId' in to ? to.principalId : null,
        'roleKey' in to ? to.roleKey : null,
        'locationId' in to ? to.locationId : null,
        due,
        requestId.toLowerCase(),
        jobId.toLowerCase(),
      ],
    );
    if ((r.rowCount ?? 0) === 0) return 'already_exists' as const;
    await deps.audit.record(tx, {
      jobId,
      action: 'create',
      resourceType: 'messaging.task',
      resourceId: id,
      patientId: pid,
      change: {
        source: 'privacy_correction',
        assignee: 'principalId' in to ? 'principal' : 'role_location',
      },
    });
    await deps.queue.publish(tx, TASK_CREATED_EVENT, { taskId: id, patientId: pid });
    return 'created' as const;
  });
}
