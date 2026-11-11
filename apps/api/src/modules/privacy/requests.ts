// Privacy requests (ARCHITECTURE 22.14, 23.1 ST-06, 29.2, 29.4; SHARED-BOUNDARIES 6.7; PRD RA-R1-14). Every method runs in the
// caller's scoped transaction, so row-level security is the second line after the guard and the triggers of migration 1901 the third.
// Order of locks (25.2): the patient root first (`lockPatients`), then the request row.
//
// Deletion (owner ruling 2026-11-11 C, item 1; D-8 is decided): a deletion request is recorded `received`, its identity is verified by
// compliance and compliance approves it like any other request. Approval only queues `privacy.execute_deletion`: this module deletes
// nothing itself. The worker job (apps/worker/src/jobs/privacy) checks legal holds and retention, deactivates the account, deletes what
// is outside the medical record, stores the statement on `privacy.deletion_record` and completes the request; the medical record is
// purged by the retention job when its retention ends. The legal-hold count that compliance sees on a request is a system job's result
// (`privacy.check_legal_holds`), because a patient session cannot read holds. A legacy `blocked_d8` row (recorded before the ruling)
// is treated like a received one once its identity is verified.
import type { Queue, Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import type { OrganisationService } from '../organisation/index.js';
import {
  InvalidTransitionError,
  PrivacyNotFoundError,
  PrivacyScopeError,
  PrivacyValidationError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import { RETENTION_DEFAULTS } from './retention.js';
import { REQUEST_KINDS } from './types.js';
import type {
  DeletionView,
  PackageStatus,
  PackageView,
  RequestKind,
  RequestMeta,
  RequestStatus,
  RequestView,
} from './types.js';

type Row = Record<string, unknown>;

export interface RequestDeps {
  audit: Pick<AuditService, 'record'>;
  organisation: Pick<OrganisationService, 'settingOrNull'>;
  queue: Queue;
  now?: () => Date;
}

/** 30 days to answer (a planning value until G2). The export package's life is a retention setting now (owner ruling C item 2): 7 days. */
export const DEFAULT_DUE_DAYS = 30;
export const DEFAULT_EXPORT_EXPIRY_DAYS = RETENTION_DEFAULTS.exportPackageDays;
export const ASSEMBLE_EXPORT_JOB = 'privacy.assemble_export';
export const CHECK_HOLDS_JOB = 'privacy.check_legal_holds';
export const EXECUTE_DELETION_JOB = 'privacy.execute_deletion';
export const CORRECTION_EVENT = 'privacy.correction_requested';

const MAX_DETAIL = 5120;
const MIN_REASON = 10;
const MAX_REASON = 2000;
const METHOD = /^[A-Za-z0-9][A-Za-z0-9 _.\-/]{2,99}$/;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const VIEW_SQL = `
  SELECT r.id, r.patient_id, r.kind, r.channel, r.status, r.detail, r.verification_method, r.verified_at, r.decided_at,
         r.decision_reason, r.due_at, r.legal_hold_documents, r.legal_hold_checked_at, r.created_at, r.row_version,
         to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_text,
         p.id AS pkg_id, p.status AS pkg_status, p.part_counts, p.size_bytes, p.expires_at, p.released_at, p.failure_code,
         dr.id AS del_id, dr.executed_at AS del_executed_at, dr.retained_until AS del_retained_until, dr.held_documents AS del_held,
         dr.statement_sent_at AS del_sent_at, dr.purge_state AS del_purge_state, dr.purged_at AS del_purged_at,
         dr.purge_deferred_reason AS del_deferred, dr.statement AS del_statement,
         to_char(dr.retained_until, 'YYYY-MM-DD') AS del_retained_text
    FROM privacy.request r
    LEFT JOIN LATERAL (SELECT x.* FROM privacy.export_package x WHERE x.request_id = r.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) p ON true
    LEFT JOIN privacy.deletion_record dr ON dr.request_id = r.id`;

export function toRequestView(r: Row): RequestView {
  const pkg: PackageView | null =
    r['pkg_id'] === null || r['pkg_id'] === undefined
      ? null
      : {
          id: String(r['pkg_id']),
          status: r['pkg_status'] as PackageStatus,
          partCounts: (r['part_counts'] ?? {}) as Record<string, unknown>,
          sizeBytes: r['size_bytes'] === null ? null : Number(r['size_bytes']),
          expiresAt: isoOrNull(r['expires_at']),
          releasedAt: isoOrNull(r['released_at']),
          failureCode: r['failure_code'] === null ? null : String(r['failure_code']),
        };
  return {
    id: String(r['id']),
    patientId: String(r['patient_id']),
    kind: r['kind'] as RequestKind,
    channel: r['channel'] as 'portal' | 'staff',
    status: r['status'] as RequestStatus,
    detail: r['detail'] === null ? null : String(r['detail']),
    verificationMethod: r['verification_method'] === null ? null : String(r['verification_method']),
    verifiedAt: isoOrNull(r['verified_at']),
    decidedAt: isoOrNull(r['decided_at']),
    decisionReason: r['decision_reason'] === null ? null : String(r['decision_reason']),
    dueAt: iso(r['due_at']),
    legalHold:
      r['legal_hold_checked_at'] === null || r['legal_hold_checked_at'] === undefined
        ? null
        : {
            documents: Number(r['legal_hold_documents']),
            checkedAt: iso(r['legal_hold_checked_at']),
          },
    package: pkg,
    deletion:
      r['del_id'] === null || r['del_id'] === undefined
        ? null
        : {
            executedAt: iso(r['del_executed_at']),
            retainedUntil: String(r['del_retained_text']),
            heldDocuments: Number(r['del_held']),
            statementSentAt: isoOrNull(r['del_sent_at']),
            purgeState: r['del_purge_state'] as DeletionView['purgeState'],
            purgedAt: isoOrNull(r['del_purged_at']),
            purgeDeferredReason:
              r['del_deferred'] === null
                ? null
                : (String(r['del_deferred']) as 'legal_hold' | 'document_retention'),
            statement: (r['del_statement'] ?? {}) as Record<string, unknown>,
          },
    createdAt: iso(r['created_at']),
    version: Number(r['row_version']),
  };
}

export type Decision = 'approve' | 'refuse' | 'retry' | 'fulfil';

export class RequestService {
  constructor(private readonly deps: RequestDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private person(tx: Tx): string {
    const p = tx.scope.personId;
    if (p === undefined) throw new PrivacyScopeError();
    return p;
  }

  private principal(tx: Tx): string {
    const p = tx.scope.principalId;
    if (p === undefined) throw new PrivacyScopeError();
    return p;
  }

  private isAdmin(tx: Tx): boolean {
    return tx.scope.audience === 'staff' && tx.scope.realm === 'admin_pool';
  }

  private async setting(tx: Tx, key: string, fallback: number): Promise<number> {
    const v = await this.deps.organisation.settingOrNull<unknown>(tx, key);
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365 ? v : fallback;
  }

  /** The patient's own record: the portal account's own patient (not a proxied one), after a merge the active survivor. */
  async ownPatientId(tx: Tx): Promise<string> {
    if (tx.scope.audience !== 'patient') throw new PrivacyScopeError();
    const proxy = new Set((tx.scope.proxyPatientIds ?? []).map((x) => x.toLowerCase()));
    const own = (tx.scope.patientIds ?? []).filter((x) => !proxy.has(x.toLowerCase()));
    if (own.length === 0) throw new PrivacyNotFoundError();
    const r = await tx.query(
      `SELECT id FROM patient.patient WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [own],
    );
    if (r.rows.length !== 1) throw new PrivacyNotFoundError();
    return String((r.rows[0] as Row)['id']);
  }

  private validateInput(input: { kind?: unknown; detail?: unknown }): {
    kind: RequestKind;
    detail: string | null;
  } {
    const bad: string[] = [];
    if (!REQUEST_KINDS.includes(input.kind as RequestKind)) bad.push('kind');
    let detail: string | null = null;
    if (input.detail !== undefined && input.detail !== null) {
      if (typeof input.detail !== 'string' || Buffer.byteLength(input.detail) > MAX_DETAIL)
        bad.push('detail');
      else detail = input.detail.normalize('NFC').trim() || null;
    }
    if (bad.length > 0) throw new PrivacyValidationError(bad);
    return { kind: input.kind as RequestKind, detail };
  }

  private async insert(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    channel: 'portal' | 'staff',
    input: { kind?: unknown; detail?: unknown },
  ): Promise<RequestView> {
    const v = this.validateInput(input);
    const days = await this.setting(tx, 'privacy_request_due_days', DEFAULT_DUE_DAYS);
    const id = uuidv7();
    const due = new Date(this.now().getTime() + days * 86_400_000);
    const status: RequestStatus = 'received';
    try {
      await tx.lockPatients([patientId], 'key_share');
      await tx.query(
        `INSERT INTO privacy.request (id, organisation_id, patient_id, kind, requested_by_principal_id, channel, detail, status, due_at, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4::uuid, $5, $6, $7, $8::timestamptz, $4::uuid)`,
        [id, patientId, v.kind, this.principal(tx), channel, v.detail, status, due.toISOString()],
      );
      if (v.kind === 'deletion')
        // The check is the system's (a patient session cannot read holds); the answer lands on the request for compliance.
        await this.deps.queue.enqueue(
          tx,
          CHECK_HOLDS_JOB,
          { requestId: id, patientId },
          { jobKey: `check_holds_${id}` },
        );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'privacy.request',
        resourceId: id,
        patientId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { kind: v.kind, channel, status },
      });
    } catch (e) {
      translateDbError(e);
    }
    return {
      id,
      patientId,
      kind: v.kind,
      channel,
      status,
      detail: v.detail,
      verificationMethod: null,
      verifiedAt: null,
      decidedAt: null,
      decisionReason: null,
      dueAt: due.toISOString(),
      legalHold: null,
      package: null,
      deletion: null,
      createdAt: this.now().toISOString(),
      version: 1,
    };
  }

  /** `POST /privacy-requests` (patient): the request is recorded under the patient's own record. */
  async createOwn(tx: Tx, meta: RequestMeta, input: Row): Promise<RequestView> {
    const patientId = await this.ownPatientId(tx);
    return this.insert(tx, meta, patientId, 'portal', input);
  }

  /**
   * `POST /patients/{patientId}/privacy-requests` (staff with `privacy.request.create_for_patient`): create only. Staff read nothing
   * back from this table (T-STAFF create only), so the answer is built from what was written.
   */
  async createForPatient(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    input: Row,
  ): Promise<RequestView> {
    if (tx.scope.audience !== 'staff' || tx.scope.realm !== 'google') throw new PrivacyScopeError();
    if (!isUuid(patientId)) throw new PrivacyNotFoundError();
    return this.insert(tx, meta, patientId.toLowerCase(), 'staff', input);
  }

  /** `GET /privacy-requests` (patient): the patient's own, newest first. */
  async listOwn(tx: Tx): Promise<RequestView[]> {
    if (tx.scope.audience !== 'patient') throw new PrivacyScopeError();
    const r = await tx.query(`${VIEW_SQL} ORDER BY r.created_at DESC, r.id DESC LIMIT 200`);
    return (r.rows as Row[]).map(toRequestView);
  }

  /** `GET /privacy-requests/{id}` (patient): 404 for another patient's request (RLS, TC-PR-04). */
  async getOwn(tx: Tx, id: string): Promise<RequestView> {
    if (tx.scope.audience !== 'patient') throw new PrivacyScopeError();
    if (!isUuid(id)) throw new PrivacyNotFoundError();
    const r = await tx.query(`${VIEW_SQL} WHERE r.id = $1::uuid`, [id]);
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) throw new PrivacyNotFoundError();
    return toRequestView(row);
  }

  /** `GET /admin/privacy-requests`: compliance sees requests and package metadata, never content (6.7). */
  async list(
    tx: Tx,
    opts: { status?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ items: RequestView[]; nextCursor: string | null }> {
    if (!this.isAdmin(tx)) throw new PrivacyScopeError();
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.status !== undefined) {
      if (
        ![
          'received',
          'identity_verified',
          'in_progress',
          'fulfilled',
          'refused',
          'blocked_d8',
        ].includes(opts.status)
      )
        throw new PrivacyValidationError(['status']);
      params.push(opts.status);
      where.push(`r.status = $${params.length}`);
    }
    if (opts.cursor !== undefined) {
      const m = /^([0-9T:.-]+Z)\|([0-9a-f-]{36})$/.exec(
        Buffer.from(opts.cursor, 'base64url').toString('utf8'),
      );
      if (m?.[1] === undefined || m[2] === undefined || !isUuid(m[2]))
        throw new PrivacyValidationError(['cursor']);
      params.push(m[1], m[2]);
      where.push(
        `(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const r = await tx.query(
      `${VIEW_SQL} ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`,
      params,
    );
    const rows = r.rows as Row[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRequestView),
      nextCursor:
        rows.length > limit && last !== undefined
          ? Buffer.from(`${String(last['created_text'])}|${String(last['id'])}`).toString(
              'base64url',
            )
          : null,
    };
  }

  private async locked(tx: Tx, id: string): Promise<Row> {
    if (!isUuid(id)) throw new PrivacyNotFoundError();
    const first = (
      await tx.query(`SELECT patient_id FROM privacy.request WHERE id = $1::uuid`, [id])
    ).rows[0] as Row | undefined;
    if (first === undefined) throw new PrivacyNotFoundError();
    // Compliance cannot see the patient root (the slice reaches requests, not patients), so `patient.lock_patients` refuses it; the merge
    // write guard (migration 1901, owned by the function-owner role) takes the same KEY SHARE lock when the row is written. The rare
    // deadlock with a merge that this order allows is retried by the scope wrapper (the whole transaction is rolled back first).
    if (!this.isAdmin(tx)) await tx.lockPatients([String(first['patient_id'])], 'key_share');
    const r = (await tx.query(`SELECT * FROM privacy.request WHERE id = $1::uuid FOR UPDATE`, [id]))
      .rows[0] as Row | undefined;
    if (r === undefined) throw new PrivacyNotFoundError();
    return r;
  }

  private async view(tx: Tx, id: string): Promise<RequestView> {
    const row = (await tx.query(`${VIEW_SQL} WHERE r.id = $1::uuid`, [id])).rows[0] as
      Row | undefined;
    if (row === undefined) throw new PrivacyNotFoundError();
    return toRequestView(row);
  }

  /**
   * `POST /admin/privacy-requests/{id}/verify-identity`: compliance records that the requester's identity was checked, and how.
   * Once. The request moves to `identity_verified`; a deletion request stays `blocked_d8` (D-8) with the verification recorded.
   */
  async verifyIdentity(
    tx: Tx,
    meta: RequestMeta,
    id: string,
    input: { method?: unknown },
  ): Promise<RequestView> {
    if (!this.isAdmin(tx)) throw new PrivacyScopeError();
    if (typeof input.method !== 'string' || !METHOD.test(input.method.trim()))
      throw new PrivacyValidationError(['method']);
    const person = this.person(tx);
    try {
      const r = await this.locked(tx, id);
      if (r['verified_at'] !== null || !['received', 'blocked_d8'].includes(String(r['status'])))
        throw new InvalidTransitionError();
      const next = r['status'] === 'blocked_d8' ? 'blocked_d8' : 'identity_verified';
      await tx.query(
        `UPDATE privacy.request SET status = $2, verification_method = $3, verified_by_person_id = $4::uuid, verified_at = $5::timestamptz
          WHERE id = $1::uuid`,
        [id, next, input.method.trim(), person, this.now().toISOString()],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'privacy.request',
        resourceId: id,
        patientId: String(r['patient_id']),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { status: next, identityVerified: true },
      });
      return await this.view(tx, id);
    } catch (e) {
      translateDbError(e);
    }
  }

  private async newPackage(tx: Tx, meta: RequestMeta, r: Row): Promise<string> {
    const packageId = uuidv7();
    await tx.query(
      `INSERT INTO privacy.export_package (id, organisation_id, request_id, patient_id, status, created_by)
       VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, 'assembling', $4::uuid)`,
      [packageId, r['id'], r['patient_id'], this.principal(tx)],
    );
    await this.deps.queue.enqueue(
      tx,
      ASSEMBLE_EXPORT_JOB,
      { requestId: String(r['id']), patientId: String(r['patient_id']), packageId },
      { jobKey: `assemble_export_${packageId}` },
    );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'create',
      resourceType: 'privacy.export_package',
      resourceId: packageId,
      patientId: String(r['patient_id']),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { status: 'assembling' },
    });
    return packageId;
  }

  /**
   * `POST /admin/privacy-requests/{id}/decide`: `{decision, reason?}`.
   *   approve  identity_verified -> in_progress. export/access: the package row and the assembly job (6.7 step 2); correction: the
   *            `privacy.correction_requested` event that `messaging` turns into a task (6.7 step 4); deletion: the job
   *            `privacy.execute_deletion` (owner ruling C item 1), which completes the request.
   *   refuse   any live request -> refused; the reason (10..2000 characters) is recorded.
   *   retry    an approved export/access request whose latest package failed: a new package and a new assembly job; a deletion
   *            request still in progress with no deletion record: the execution job again.
   *   fulfil   a correction request in_progress -> fulfilled (export and access requests are completed by the assembly job).
   */
  async decide(
    tx: Tx,
    meta: RequestMeta,
    id: string,
    input: { decision?: unknown; reason?: unknown },
  ): Promise<RequestView> {
    if (!this.isAdmin(tx)) throw new PrivacyScopeError();
    const decision = input.decision as Decision;
    if (!['approve', 'refuse', 'retry', 'fulfil'].includes(String(decision)))
      throw new PrivacyValidationError(['decision']);
    let reason: string | null = null;
    if (input.reason !== undefined && input.reason !== null) {
      if (typeof input.reason !== 'string') throw new PrivacyValidationError(['reason']);
      reason = input.reason.normalize('NFC').trim();
    }
    if (
      decision === 'refuse' &&
      (reason === null || reason.length < MIN_REASON || reason.length > MAX_REASON)
    )
      throw new PrivacyValidationError(['reason']);
    if (reason !== null && (reason.length < MIN_REASON || reason.length > MAX_REASON))
      throw new PrivacyValidationError(['reason']);
    const person = this.person(tx);
    try {
      const r = await this.locked(tx, id);
      const status = String(r['status']);
      const kind = String(r['kind']);
      const patientId = String(r['patient_id']);
      const now = this.now().toISOString();
      let change: Record<string, unknown>;
      if (decision === 'refuse') {
        if (status === 'fulfilled' || status === 'refused') throw new InvalidTransitionError();
        await tx.query(
          `UPDATE privacy.request SET status = 'refused', decided_by_person_id = $2::uuid, decided_at = $3::timestamptz, decision_reason = $4 WHERE id = $1::uuid`,
          [id, person, now, reason],
        );
        change = { status: 'refused' };
        // BE20-F2: a refused request leaves no live assembly behind (it would hold the one-live-package index forever).
        await tx.query(
          `UPDATE privacy.export_package SET status = 'failed', failure_code = 'privacy.request_refused' WHERE request_id = $1::uuid AND status = 'assembling'`,
          [id],
        );
      } else if (decision === 'approve') {
        // A legacy blocked_d8 deletion request (recorded before the ruling) is approvable once its identity is verified.
        const verified =
          status === 'identity_verified' || (status === 'blocked_d8' && r['verified_at'] !== null);
        if (!verified) throw new InvalidTransitionError();
        await tx.query(
          `UPDATE privacy.request SET status = 'in_progress', decided_by_person_id = $2::uuid, decided_at = $3::timestamptz, decision_reason = $4 WHERE id = $1::uuid`,
          [id, person, now, reason],
        );
        change = { status: 'in_progress' };
        if (kind === 'correction') {
          await this.deps.queue.publish(tx, CORRECTION_EVENT, { requestId: id, patientId });
        } else if (kind === 'deletion') {
          // The worker checks holds and retention, deactivates the account, deletes what is outside the medical record and completes
          // the request. Nothing is deleted in this transaction.
          await this.deps.queue.enqueue(
            tx,
            EXECUTE_DELETION_JOB,
            { requestId: id, patientId },
            { jobKey: `execute_deletion_${id}` },
          );
        } else {
          await this.newPackage(tx, meta, { id, patient_id: patientId });
        }
      } else if (decision === 'retry' && kind === 'deletion') {
        // The execution job gave up (or was lost): queue it again. Only while no deletion record exists.
        const done = (
          await tx.query(`SELECT 1 FROM privacy.deletion_record WHERE request_id = $1::uuid`, [id])
        ).rows.length;
        if (status !== 'in_progress' || done > 0) throw new InvalidTransitionError();
        await this.deps.queue.enqueue(
          tx,
          EXECUTE_DELETION_JOB,
          { requestId: id, patientId },
          { jobKey: `execute_deletion_${id}` },
        );
        change = { status: 'in_progress', retried: true };
      } else if (decision === 'retry') {
        if (status !== 'in_progress' || !['export', 'access'].includes(kind))
          throw new InvalidTransitionError();
        const latest = (
          await tx.query(
            `SELECT status FROM privacy.export_package WHERE request_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 1`,
            [id],
          )
        ).rows[0] as Row | undefined;
        if (latest?.['status'] !== 'failed') throw new InvalidTransitionError();
        await this.newPackage(tx, meta, { id, patient_id: patientId });
        change = { status: 'in_progress', retried: true };
      } else {
        if (status !== 'in_progress' || kind !== 'correction') throw new InvalidTransitionError();
        await tx.query(`UPDATE privacy.request SET status = 'fulfilled' WHERE id = $1::uuid`, [id]);
        change = { status: 'fulfilled' };
      }
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'privacy.request',
        resourceId: id,
        patientId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { ...change, decision },
      });
      return await this.view(tx, id);
    } catch (e) {
      translateDbError(e);
    }
  }
}
