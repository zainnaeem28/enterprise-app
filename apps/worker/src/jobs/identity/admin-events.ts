// `identity.admin_event` (ARCHITECTURE 26.3 B2-9, SEC02-F02): the human detection layer of the admin realm. For each event the
// worker writes the audit row the anonymous paths cannot write (`enrol`, `denied`) in a transaction of its own, then raises the
// compliance alert and queues the PHI-free notice to the security contact (`identity.admin_event_notice`) in a second one. The
// evidence (audit row, alert) therefore commits whatever the state of the mail channel (S1); a failing alert retries, and the audit
// insert is keyed by the job so the retry writes no second row (S4). The notice is its own retried job. Payloads are IDs and a
// snake_case kind only (BD-09).
import type { KernelDb, Queue, Tx } from '@ehr/kernel';
import { ADMIN_EVENT_KINDS, ADMIN_EVENT_NOTICE_JOB, type AdminEventKind } from './jobs.js';
import { isUuid, systemScope } from './scope.js';

export interface ComplianceAlertInput {
  type: 'btg_opened' | 'privileged_change' | 'kill_switch_used' | 'audit_anchor_mismatch';
  severity: 'low' | 'medium' | 'high' | 'critical';
  resourceType: string;
  resourceId: string;
  /** The permission whose holders (realm `admin_pool`) are told. */
  permission: string;
  /** Principals who are never recipients of this alert: the subject and the acting admin must not be the sole reviewer of their own change (C4). */
  excludePrincipalIds?: readonly string[];
}

/** Raises one compliance alert on the transaction handed in (the API's `AlertService.raise`, reached through `buildWorkerPorts`). */
export interface ComplianceAlertPort {
  raise(tx: Tx, input: ComplianceAlertInput, jobId: string): Promise<unknown>;
}

/** The PHI-free notice to the security contact mailbox: a kind and IDs, never a name, address or credential detail. */
export interface SecurityNotice {
  kind: AdminEventKind;
  principalId: string;
  jobRef: string;
}
export interface SecurityNoticePort {
  notify(notice: SecurityNotice): Promise<void>;
}

/** Holders of this permission are the compliance recipients of every admin-realm alert (reference data: compliance_officer, compliance_on_call). */
export const COMPLIANCE_PERMISSION = 'audit.btg.review';

/** Fewer than this many live security keys after a revocation or counter regression is itself critical (B2-9, two keys per admin). */
export const MIN_ACTIVE_CREDENTIALS = 2;

export interface AdminEventDeps {
  db: KernelDb;
  orgId: string;
  /** Worker-path queue, for the notice job. */
  queue: Queue;
  alerts: ComplianceAlertPort;
}

export interface AdminEventResult {
  audited: boolean;
  alerted: boolean;
  noticeQueued: boolean;
  activeCredentials: number | null;
}

const AUDIT_ACTION: Partial<Record<AdminEventKind, 'enrol' | 'denied'>> = {
  credential_enrolled: 'enrol',
  credential_revoked: 'enrol',
  counter_regression: 'enrol',
  handle_failures: 'denied',
};
const ALERTED: readonly AdminEventKind[] = [
  'credential_enrolled',
  'credential_revoked',
  'counter_regression',
  'enrolment_token_requested',
  'enrolment_token_approved',
  'role_change_decided',
  'handle_failures',
];
const CHECK_KEYS: readonly AdminEventKind[] = ['credential_revoked', 'counter_regression'];

export async function runAdminEvent(
  deps: AdminEventDeps,
  payload: Record<string, unknown>,
  jobId: string,
  jobRef: string,
): Promise<AdminEventResult> {
  const kind = payload['kind'];
  const principalId = payload['principalId'];
  if (typeof kind !== 'string' || !(ADMIN_EVENT_KINDS as readonly string[]).includes(kind))
    throw new Error('identity.admin_event: bad kind');
  if (!isUuid(principalId)) throw new Error('identity.admin_event: bad principalId');
  const k = kind as AdminEventKind;
  const principal = principalId.toLowerCase();
  const sessionId = isUuid(payload['sessionId']) ? payload['sessionId'].toLowerCase() : undefined;
  // The subject is excluded from the recipients; so is the acting admin when the producer names them (`actorPrincipalId`).
  const exclude = [principal];
  const actor = payload['actorPrincipalId'];
  if (isUuid(actor)) exclude.push(actor.toLowerCase());
  const ref = jobRef.slice(0, 200);

  // Step 1: the audit row, committed on its own so that nothing after it can erase it.
  const action = AUDIT_ACTION[k];
  const audited = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    if (action === undefined) return false;
    const change: Record<string, unknown> = { kind: k };
    if (k === 'credential_enrolled') {
      // The token that enrolled this key names who asked for it and who approved it (two different people, C4).
      const t = (
        await tx.query(
          `SELECT requested_by_person_id::text AS requested, approved_by_person_id::text AS approved
             FROM identity.enrolment_token WHERE principal_id = $1::uuid AND status = 'used'
            ORDER BY used_at DESC LIMIT 1`,
          [principal],
        )
      ).rows[0];
      if (t !== undefined) {
        change['requestedByPersonId'] = t['requested'];
        change['approvedByPersonId'] = t['approved'];
      }
      if (sessionId !== undefined) change['sessionId'] = sessionId;
    }
    // A retry (the alert step failed, or the job crashed after this commit) finds the row by its job reference and writes none.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ref]);
    await tx.query(
      `INSERT INTO audit.event (event_id, organisation_id, job_id, actor_principal_id, realm, audience, action, resource_type,
                                resource_id, change, outcome, denial_reason)
       SELECT gen_random_uuid(), kernel.uuid1('app.org_id'), $1, $2::uuid, 'worker', 'system', $3, 'identity.principal', $2::uuid,
              $4::jsonb, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM audit.event
                           WHERE resource_type = 'identity.principal' AND resource_id = $2::uuid AND job_id = $1 AND action = $3)`,
      [
        ref,
        principal,
        action,
        JSON.stringify(change),
        action === 'denied' ? 'denied' : 'allowed',
        action === 'denied' ? 'forbidden' : null,
      ],
    );
    return true;
  });

  if (!ALERTED.includes(k))
    return { audited, alerted: false, noticeQueued: false, activeCredentials: null };

  // Step 2: the alert and the queued notice commit together; the notice is sent by its own job.
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    let active: number | null = null;
    if (CHECK_KEYS.includes(k)) {
      const r = await tx.query(
        `SELECT count(*)::int AS n FROM identity.admin_credential WHERE principal_id = $1::uuid AND revoked_at IS NULL`,
        [principal],
      );
      active = Number(r.rows[0]?.['n'] ?? 0);
    }
    const critical =
      k === 'counter_regression' || (active !== null && active < MIN_ACTIVE_CREDENTIALS);
    await deps.alerts.raise(
      tx,
      {
        type: 'privileged_change',
        severity: critical ? 'critical' : 'high',
        resourceType: 'identity_principal',
        resourceId: principal,
        permission: COMPLIANCE_PERMISSION,
        excludePrincipalIds: exclude,
      },
      jobId,
    );
    await deps.queue.enqueue(
      tx,
      ADMIN_EVENT_NOTICE_JOB,
      { kind: k, principalId: principal },
      { jobKey: `notice:${jobId}` },
    );
    return { audited, alerted: true, noticeQueued: true, activeCredentials: active };
  });
}

/** `identity.admin_event_notice`: sends the PHI-free notice. Failing here never touches the audit row or the alert (S1). */
export async function runAdminEventNotice(
  deps: { notice: SecurityNoticePort },
  payload: Record<string, unknown>,
  jobRef: string,
): Promise<void> {
  const kind = payload['kind'];
  const principalId = payload['principalId'];
  if (typeof kind !== 'string' || !(ADMIN_EVENT_KINDS as readonly string[]).includes(kind))
    throw new Error('identity.admin_event_notice: bad kind');
  if (!isUuid(principalId)) throw new Error('identity.admin_event_notice: bad principalId');
  await deps.notice.notify({
    kind: kind as AdminEventKind,
    principalId: principalId.toLowerCase(),
    jobRef,
  });
}

/**
 * Dead-lettered `identity.admin_event` / `identity.admin_event_notice` jobs (attempts used up, not running). The worker emits the
 * count as the gauge `AdminEventDeadLettered` (alarm at > 0): a lost detection must be visible (S1).
 */
export async function adminEventDeadLetters(db: KernelDb, orgId: string): Promise<number> {
  return db.withScope(systemScope(orgId), async (tx) => {
    const r = await tx.query(
      `SELECT count(*)::int AS n FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id
        WHERE t.identifier IN ('identity.admin_event', 'identity.admin_event_notice')
          AND j.locked_at IS NULL AND j.attempts >= j.max_attempts`,
    );
    return Number(r.rows[0]?.['n'] ?? 0);
  });
}
