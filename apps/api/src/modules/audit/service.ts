// The audit module's published interface (ARCHITECTURE 24): record, recordDenied, activeBtgGrants, disclosuresFor,
// openBtg, reviewBtg, plus the compliance viewer search and the export request. Every method runs inside a transaction
// handle opened by the kernel (`withScope`), so scope settings, RLS and the bounded-transaction trigger apply.
import type { KernelDb, Logger, Queue, Tx } from '@ehr/kernel';
import {
  buildRow,
  INSERT_SQL,
  insertParams,
  type AuditEnvelope,
  type DeniedEnvelope,
} from './envelope.js';
import {
  AuditEnvelopeError,
  AuditError,
  AuditScopeError,
  ExportTooLargeError,
  SelfReviewError,
} from './errors.js';
import { filterSql, SEARCH_MAX_DAYS, validateFilter, type EventFilter } from './filter.js';
import { isUuid, uuidv7 } from './ids.js';

export const DEFAULT_BTG_SECONDS = 4 * 60 * 60;
export const DEFAULT_EXPORT_MAX_ROWS = 1_000_000;
export const SEARCH_PAGE = 100;
export const SEARCH_PAGE_MAX = 500;
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface AuditDeps {
  logger?: Logger;
  /** Called when the separate denial transaction fails (8.1 rule 2): raise the operations alert here. */
  onDenialWriteFailure?: (info: { requestId: string | null }) => void;
  /** Needed by openBtg (publishes `audit.btg_opened`) and requestExport (enqueues `audit.export`). */
  queue?: Queue;
}

export interface ActiveBtgGrant {
  grantId: string;
  patientId: string;
  expiresAt: Date;
}

export interface RequestMeta {
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
}

const rowsOf = (r: { rows: Record<string, unknown>[] }): Record<string, unknown>[] => r.rows;

export class AuditService {
  constructor(private readonly deps: AuditDeps = {}) {}

  /**
   * `audit.record(envelope)` (8.1 rule 1): inserts in the CALLER'S transaction, so a failed insert rolls the business
   * change back and PHI is never accessed without an audit row. The actor, realm, audience and organisation come from
   * the transaction's scope. The insert is refused by the database unless `transaction_timeout` is set and at most 60 s.
   * Returns the event id.
   */
  async record(tx: Tx, envelope: AuditEnvelope): Promise<string> {
    const eventId = envelope.eventId ?? uuidv7();
    const row = buildRow(tx.scope, envelope, eventId);
    await tx.query(INSERT_SQL, insertParams(row));
    return eventId;
  }

  /**
   * `audit.recordDenied(envelope)` (8.1 rule 2): the API has already rolled the business transaction back; this writes
   * the `denied` event in a NEW, short transaction on the same scope settings. If that write fails the caller still
   * gets the denial (fail closed): the failure is logged by class only and the operations alert hook is called. Never throws.
   */
  async recordDenied(
    db: KernelDb,
    scope: Parameters<KernelDb['withScope']>[0],
    envelope: DeniedEnvelope,
  ): Promise<{ recorded: boolean }> {
    try {
      const eventId = envelope.eventId ?? uuidv7();
      const row = buildRow(scope, envelope, eventId);
      await db.withScope(scope, (tx) =>
        tx.query(INSERT_SQL, insertParams(row)).then(() => undefined),
      );
      return { recorded: true };
    } catch (err) {
      this.deps.logger?.error('audit denial write failed', {
        errorName: err instanceof Error ? err.name : typeof err,
        sqlstate: (err as { code?: unknown } | null)?.code,
      });
      try {
        this.deps.onDenialWriteFailure?.({ requestId: envelope.requestId ?? null });
      } catch {
        // an alert hook that throws must not turn the denial into a different answer
      }
      return { recorded: false };
    }
  }

  /**
   * `activeBtgGrants(principal)` (identity, scope build): grants of the principal that are neither revoked nor expired.
   * T-PRINCIPAL: the policy shows a staff transaction only its own principal's grants.
   */
  async activeBtgGrants(tx: Tx, principalId: string): Promise<ActiveBtgGrant[]> {
    if (!isUuid(principalId)) throw new AuditEnvelopeError(['principalId']);
    const r = await tx.query(
      `SELECT id, patient_id, expires_at FROM audit.btg_grant
        WHERE holder_principal_id = $1::uuid AND revoked_at IS NULL AND expires_at > now()
        ORDER BY expires_at, id`,
      [principalId],
    );
    return rowsOf(r).map((x) => ({
      grantId: x.id as string,
      patientId: x.patient_id as string,
      expiresAt: x.expires_at as Date,
    }));
  }

  /** `audit.openBtg` (ST-06): a grant for the calling principal, the audit row and the compliance event, in one transaction. */
  async openBtg(
    tx: Tx,
    input: RequestMeta & { patientId: string; reason: string; durationSeconds?: number },
  ): Promise<{ grantId: string; expiresAt: Date }> {
    const s = tx.scope;
    if (s.audience !== 'staff' || s.principalId === undefined || s.personId === undefined)
      throw new AuditScopeError();
    if (s.realm !== 'google' && s.realm !== 'admin_pool') throw new AuditScopeError();
    const reason = input.reason.trim();
    const bad: string[] = [];
    if (!isUuid(input.patientId)) bad.push('patientId');
    if (reason.length < 10 || reason.length > 500) bad.push('reason');
    const seconds = input.durationSeconds ?? DEFAULT_BTG_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 24 * 3600)
      bad.push('durationSeconds');
    if (bad.length > 0) throw new AuditEnvelopeError(bad);
    const grantId = uuidv7();
    const r = await tx.query(
      `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id,
                                    reason, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8), $3)
       RETURNING expires_at`,
      [grantId, s.orgId, s.principalId, s.personId, s.realm, input.patientId, reason, seconds],
    );
    const expiresAt = (rowsOf(r)[0] as { expires_at: Date }).expires_at;
    const eventId = await this.record(tx, {
      requestId: input.requestId,
      action: 'btg_open',
      resourceType: 'audit.btg_grant',
      resourceId: grantId,
      patientId: input.patientId,
      btgGrantId: grantId,
      reason,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    // `audit.btg_opened` (24): the compliance alert is a handler of this event, in the same transaction (SBR-14).
    await this.deps.queue?.publish(tx, 'audit.btg_opened', {
      eventId,
      organisationId: s.orgId as string,
      grantId,
      patientId: input.patientId,
    });
    return { grantId, expiresAt };
  }

  /** `audit.reviewBtg` (ST-06): reviewer is never the holder (403 audit.self_review); pending -> justified | not_justified once. */
  async reviewBtg(
    tx: Tx,
    input: RequestMeta & { grantId: string; outcome: 'justified' | 'not_justified'; note?: string },
  ): Promise<void> {
    const s = tx.scope;
    if (s.audience !== 'staff' || s.personId === undefined) throw new AuditScopeError();
    const bad: string[] = [];
    if (!isUuid(input.grantId)) bad.push('grantId');
    if (input.outcome !== 'justified' && input.outcome !== 'not_justified') bad.push('outcome');
    if (input.note !== undefined && input.note.length > 2000) bad.push('note');
    if (bad.length > 0) throw new AuditEnvelopeError(bad);
    const g = rowsOf(
      await tx.query(
        `SELECT holder_person_id, patient_id, review_status FROM audit.btg_grant WHERE id = $1::uuid FOR UPDATE`,
        [input.grantId],
      ),
    )[0] as { holder_person_id: string; patient_id: string; review_status: string } | undefined;
    if (g === undefined) throw new AuditError('kernel.not_found', 404);
    if (g.holder_person_id === s.personId) throw new SelfReviewError();
    if (g.review_status !== 'pending') throw new AuditError('audit.invalid_transition', 409);
    await tx.query(
      `INSERT INTO audit.btg_review (grant_id, organisation_id, reviewer_person_id, outcome, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.grantId,
        s.orgId,
        s.personId,
        input.outcome,
        input.note ?? null,
        s.principalId ?? null,
      ],
    );
    await tx.query(`UPDATE audit.btg_grant SET review_status = $2 WHERE id = $1::uuid`, [
      input.grantId,
      input.outcome,
    ]);
    await this.record(tx, {
      requestId: input.requestId,
      action: 'btg_review',
      resourceType: 'audit.btg_grant',
      resourceId: input.grantId,
      patientId: g.patient_id,
      btgGrantId: input.grantId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  /**
   * `POST /admin/audit-events/search`: the compliance viewer. Range at most 31 days, one page, newest first, and one
   * `view` audit row for the query itself (viewing audit is audited). Terms are not stored in the audit row.
   */
  async searchEvents(
    tx: Tx,
    input: RequestMeta & { filter: EventFilter; limit?: number },
  ): Promise<{ events: AuditEventView[]; truncated: boolean }> {
    validateFilter(input.filter, SEARCH_MAX_DAYS);
    const limit = Math.min(Math.max(input.limit ?? SEARCH_PAGE, 1), SEARCH_PAGE_MAX);
    const { where, params } = filterSql(input.filter);
    const r = await tx.query(
      `SELECT event_id, occurred_at, actor_person_id, realm, audience, action, resource_type, resource_id, patient_id,
              location_id, btg_grant_id, reason, host(ip) AS ip, user_agent, outcome, denial_reason
         FROM audit.event WHERE ${where}
        ORDER BY occurred_at DESC, event_id DESC LIMIT ${limit + 1}`,
      params,
    );
    const rows = rowsOf(r);
    await this.record(tx, {
      requestId: input.requestId,
      action: 'view',
      resourceType: 'audit.event',
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      events: rows.slice(0, limit).map(toView),
      truncated: rows.length > limit,
    };
  }

  /** The size limit: setting `audit_export_max_rows` (RA-R1-12), 1,000,000 when the setting is absent. */
  async exportMaxRows(tx: Tx): Promise<number> {
    const r = rowsOf(
      await tx.query(
        `SELECT value FROM kernel.setting WHERE key = 'audit_export_max_rows' AND location_id IS NULL`,
      ),
    )[0] as { value: unknown } | undefined;
    const v = r?.value;
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_EXPORT_MAX_ROWS;
  }

  /**
   * `POST /admin/audit-exports` (SA-F-11): checks the size limit with a bounded count, stores the job, audits the
   * request as `export` with its reason, and enqueues chunk 0 of `audit.export` in the same transaction. The export
   * itself runs asynchronously, in chunks, in the worker; 422 `audit.export_too_large` over the limit.
   */
  async requestExport(
    tx: Tx,
    input: RequestMeta & { filter: EventFilter; reason: string; elevationId: string },
  ): Promise<{ exportId: string }> {
    const s = tx.scope;
    if (s.audience !== 'staff' || s.personId === undefined) throw new AuditScopeError();
    validateFilter(input.filter);
    const reason = input.reason.trim();
    const bad: string[] = [];
    if (reason.length < 1 || reason.length > 500) bad.push('reason');
    if (!isUuid(input.elevationId)) bad.push('elevationId');
    if (bad.length > 0) throw new AuditEnvelopeError(bad);
    if (this.deps.queue === undefined) throw new AuditError('kernel.unavailable', 503, true);
    const max = await this.exportMaxRows(tx);
    const { where, params } = filterSql(input.filter);
    const counted = rowsOf(
      await tx.query(
        `SELECT count(*)::bigint AS n FROM (SELECT 1 FROM audit.event WHERE ${where} LIMIT ${max + 1}) s`,
        params,
      ),
    )[0] as { n: string };
    if (Number(counted.n) > max) throw new ExportTooLargeError();
    const exportId = uuidv7();
    await tx.query(
      `INSERT INTO audit.export_job (id, organisation_id, requested_by_person_id, reason, filter, elevation_id, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        exportId,
        s.orgId,
        s.personId,
        reason,
        JSON.stringify(filterJson(input.filter)),
        input.elevationId,
        s.principalId ?? null,
      ],
    );
    await this.record(tx, {
      requestId: input.requestId,
      action: 'export',
      resourceType: 'audit.export_job',
      resourceId: exportId,
      reason,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await this.deps.queue.enqueue(
      tx,
      'audit.export',
      { exportId, organisationId: s.orgId as string, chunk: 0 },
      { jobKey: `${exportId}:0` },
    );
    return { exportId };
  }

  /**
   * `disclosuresFor(patientIds)` (privacy export): the audit events about these patients, oldest first, one page after
   * the given cursor. A privacy export job reads it under its system scope (T-SYS). IDs and actions only: no IP, no agent.
   */
  async disclosuresFor(
    tx: Tx,
    patientIds: readonly string[],
    opts: { after?: { occurredAt: string; eventId: string }; limit?: number } = {},
  ): Promise<{ events: DisclosureView[]; next: { occurredAt: string; eventId: string } | null }> {
    if (patientIds.length === 0 || patientIds.length > 1000 || !patientIds.every(isUuid))
      throw new AuditEnvelopeError(['patientIds']);
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
    const params: unknown[] = [[...patientIds]];
    let cursor = '';
    if (opts.after !== undefined) {
      if (!ISO_MICROS.test(opts.after.occurredAt) || !isUuid(opts.after.eventId))
        throw new AuditEnvelopeError(['after']);
      params.push(opts.after.occurredAt, opts.after.eventId);
      cursor = ' AND (occurred_at, event_id) > ($2::timestamptz, $3::uuid)';
    }
    const rows = rowsOf(
      await tx.query(
        `SELECT event_id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
                actor_person_id, action, resource_type, resource_id, patient_id, location_id, btg_grant_id, outcome
           FROM audit.event WHERE patient_id = ANY ($1::uuid[])${cursor}
          ORDER BY occurred_at, event_id LIMIT ${limit + 1}`,
        params,
      ),
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page.map((x) => ({
        eventId: x.event_id as string,
        occurredAt: x.occurred_at as string,
        actorPersonId: (x.actor_person_id as string | null) ?? null,
        action: x.action as string,
        resourceType: x.resource_type as string,
        resourceId: (x.resource_id as string | null) ?? null,
        patientId: x.patient_id as string,
        locationId: (x.location_id as string | null) ?? null,
        btgGrantId: (x.btg_grant_id as string | null) ?? null,
        outcome: x.outcome as string,
      })),
      next:
        rows.length > limit && last !== undefined
          ? { occurredAt: last.occurred_at as string, eventId: last.event_id as string }
          : null,
    };
  }
}

export interface AuditEventView {
  eventId: string;
  occurredAt: Date;
  actorPersonId: string | null;
  realm: string;
  audience: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  patientId: string | null;
  locationId: string | null;
  btgGrantId: string | null;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  outcome: string;
  denialReason: string | null;
}

export interface DisclosureView {
  eventId: string;
  /** UTC instant with microseconds (`2026-11-06T02:03:17.123456Z`): the cursor of the next page uses the same text. */
  occurredAt: string;
  actorPersonId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  patientId: string;
  locationId: string | null;
  btgGrantId: string | null;
  outcome: string;
}

function toView(x: Record<string, unknown>): AuditEventView {
  const n = (k: string): string | null => (x[k] as string | null | undefined) ?? null;
  return {
    eventId: x.event_id as string,
    occurredAt: x.occurred_at as Date,
    actorPersonId: n('actor_person_id'),
    realm: x.realm as string,
    audience: x.audience as string,
    action: x.action as string,
    resourceType: x.resource_type as string,
    resourceId: n('resource_id'),
    patientId: n('patient_id'),
    locationId: n('location_id'),
    btgGrantId: n('btg_grant_id'),
    reason: n('reason'),
    ip: n('ip'),
    userAgent: n('user_agent'),
    outcome: x.outcome as string,
    denialReason: n('denial_reason'),
  };
}

/** The stored filter: ISO instants, as the worker reads them back. */
export function filterJson(f: EventFilter): Record<string, string> {
  const o: Record<string, string> = { from: f.from.toISOString(), to: f.to.toISOString() };
  if (f.actorPersonId !== undefined) o.actorPersonId = f.actorPersonId;
  if (f.patientId !== undefined) o.patientId = f.patientId;
  if (f.action !== undefined) o.action = f.action;
  if (f.resourceType !== undefined) o.resourceType = f.resourceType;
  return o;
}
