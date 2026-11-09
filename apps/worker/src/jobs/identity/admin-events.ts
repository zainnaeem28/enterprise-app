// `identity.admin_event` (ARCHITECTURE 26.3 B2-9, SEC02-F02): the human detection layer of the admin realm. For each event the
// worker writes the audit row the anonymous paths cannot write (`enrol`, `denied`), raises the compliance alert and sends the
// PHI-free notice to the security contact, all in one transaction: a failing notice rolls the audit row and the alert back and the
// job retries, then dead-letters visibly after its attempts. Payloads are IDs and a snake_case kind only (BD-09).
import type { KernelDb, Tx } from '@ehr/kernel';
import { ADMIN_EVENT_KINDS, type AdminEventKind } from './jobs.js';
import { isUuid, systemScope } from './scope.js';

export interface ComplianceAlertInput {
  type: 'btg_opened' | 'privileged_change' | 'kill_switch_used' | 'audit_anchor_mismatch';
  severity: 'low' | 'medium' | 'high' | 'critical';
  resourceType: string;
  resourceId: string;
  /** The permission whose holders (realm `admin_pool`) are told. */
  permission: string;
}

/** Raises one compliance alert on the transaction handed in (the API's `AlertService.raise`, reached through `buildWorkerPorts`). */
export interface ComplianceAlertPort {
  raise(tx: Tx, input: ComplianceAlertInput, jobId: string): Promise<unknown>;
}

/**
 * The PHI-free notice to the security contact mailbox: a kind and IDs, never a name, address or credential detail. The run-level
 * `bootstrap_run` notice (INT04-F02b) holds the mode, run ID, CI run reference, ticket reference, token expiry and the two principal IDs.
 */
export type SecurityNotice =
  | { kind: Exclude<AdminEventKind, 'bootstrap_run'>; principalId: string; jobRef: string }
  | {
      kind: 'bootstrap_run';
      jobRef: string;
      run: {
        mode: 'create' | 'reissue';
        runId: string;
        runRef: string;
        ticketRef: string;
        tokenExpiresAt: string;
        principalIds: string[];
      };
    };
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
  alerts: ComplianceAlertPort;
  notice: SecurityNoticePort;
}

export interface AdminEventResult {
  audited: boolean;
  alerted: boolean;
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
  if (kind === 'bootstrap_run') return runBootstrapRunEvent(deps, payload['runId'], jobId, jobRef);
  if (!isUuid(principalId)) throw new Error('identity.admin_event: bad principalId');
  const k = kind as Exclude<AdminEventKind, 'bootstrap_run'>;
  const principal = principalId.toLowerCase();
  const sessionId = isUuid(payload['sessionId']) ? payload['sessionId'].toLowerCase() : undefined;

  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    let active: number | null = null;
    const action = AUDIT_ACTION[k];
    if (action !== undefined) {
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
      await tx.query(
        `INSERT INTO audit.event (event_id, organisation_id, job_id, actor_principal_id, realm, audience, action, resource_type,
                                  resource_id, change, outcome, denial_reason)
         VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, $2::uuid, 'worker', 'system', $3, 'identity.principal', $2::uuid,
                 $4::jsonb, $5, $6)`,
        [
          jobRef.slice(0, 200),
          principal,
          action,
          JSON.stringify(change),
          action === 'denied' ? 'denied' : 'allowed',
          action === 'denied' ? 'forbidden' : null,
        ],
      );
    }
    if (CHECK_KEYS.includes(k)) {
      const r = await tx.query(
        `SELECT count(*)::int AS n FROM identity.admin_credential WHERE principal_id = $1::uuid AND revoked_at IS NULL`,
        [principal],
      );
      active = Number(r.rows[0]?.['n'] ?? 0);
    }
    const alerted = ALERTED.includes(k);
    if (alerted) {
      const critical =
        k === 'counter_regression' || (active !== null && active < MIN_ACTIVE_CREDENTIALS);
      await deps.alerts.raise(
        tx,
        {
          type: 'privileged_change',
          severity: critical ? 'critical' : 'high',
          resourceType: 'identity.principal',
          resourceId: principal,
          permission: COMPLIANCE_PERMISSION,
        },
        jobId,
      );
      await deps.notice.notify({ kind: k, principalId: principal, jobRef });
    }
    return { audited: action !== undefined, alerted, activeCredentials: active };
  });
}

/**
 * The run-level event of `identity.bootstrap_admins` (INT04-F02b, decision log section 3 step 4): reads the run row, raises a `privileged_change`
 * alert of severity `high` and sends one notice. It writes no audit row: the function did. With no compliance officer assigned yet, the
 * notice to the security contact mailbox is the detection layer (a precondition of the run).
 */
async function runBootstrapRunEvent(
  deps: AdminEventDeps,
  runId: unknown,
  jobId: string,
  jobRef: string,
): Promise<AdminEventResult> {
  if (!isUuid(runId)) throw new Error('identity.admin_event: bad runId');
  const id = runId.toLowerCase();
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const row = (
      await tx.query(
        `SELECT mode, run_ref, ticket_ref, token_expires_at, principal_ids::text[] AS principal_ids
           FROM identity.bootstrap_run WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0];
    if (row === undefined) throw new Error('identity.admin_event: bootstrap run not found');
    await deps.alerts.raise(
      tx,
      {
        type: 'privileged_change',
        severity: 'high',
        resourceType: 'bootstrap_run',
        resourceId: id,
        permission: COMPLIANCE_PERMISSION,
      },
      jobId,
    );
    const expires = row['token_expires_at'];
    await deps.notice.notify({
      kind: 'bootstrap_run',
      jobRef,
      run: {
        mode: row['mode'] === 'reissue' ? 'reissue' : 'create',
        runId: id,
        runRef: String(row['run_ref']),
        ticketRef: String(row['ticket_ref']),
        tokenExpiresAt: expires instanceof Date ? expires.toISOString() : String(expires),
        principalIds: row['principal_ids'] as string[],
      },
    });
    return { audited: false, alerted: true, activeCredentials: null };
  });
}
