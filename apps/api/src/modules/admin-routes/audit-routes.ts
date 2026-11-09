// Audit viewer, export and break-the-glass review for the admin realm (ARCHITECTURE 29.4 audit rows; RA-R1-12, ST-06, SA-F-11).
// Authorization (realm `admin_pool`, permission, live elevation grant where the route is a †) is the guard's and is declared on
// the controller. Each method runs in ONE transaction under the caller's own scope, so the table policies are the second line.
// The audit module does the work (`searchEvents`, `requestExport`, `reviewBtg`); this file adds the HTTP-shaped parsing, the
// export status and download hand-out, and the BTG list, which the audit module does not publish (README, N-BE24-1).
import type { KernelDb, ScopeSettings, Tx } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { AuditService } from '../audit/index.js';
import type { EventFilter } from '../audit/index.js';
import {
  cursorFor,
  exactBody,
  invalid,
  isUuid,
  notFound,
  optInt,
  optString,
  optUuid,
  parsePage,
  reqInstant,
  reqString,
  translate,
} from './http.js';
import type { Meta } from './http.js';

export type Row = Record<string, unknown>;

/** Signs a time-limited download for a finished export (object store; infrastructure). The URL is never logged or audited. */
export interface ExportUrlSigner {
  sign(objectKey: string, ttlSeconds: number): Promise<{ url: string; expiresAt: Date }>;
}

export interface AuditAdminDeps {
  db: KernelDb;
  audit: AuditService;
  /** The ID of the caller's live elevation grant (identity owns the table; the composition root supplies the lookup). */
  elevationIdOf: (tx: Tx, sessionId: string) => Promise<string | undefined>;
  signer?: ExportUrlSigner;
  now?: () => Date;
}

const SEARCH_BODY = ['from', 'to', 'actorPersonId', 'patientId', 'action', 'resourceType', 'limit'];
const FILTER_BODY = ['from', 'to', 'actorPersonId', 'patientId', 'action', 'resourceType'];
const REVIEW_STATUS = ['pending', 'justified', 'not_justified'] as const;
export const DOWNLOAD_TTL_SECONDS = 300;

function filterOf(o: Record<string, unknown>): EventFilter {
  const f: EventFilter = { from: reqInstant(o, 'from'), to: reqInstant(o, 'to') };
  const actor = optUuid(o, 'actorPersonId');
  const patient = optUuid(o, 'patientId');
  const action = optString(o, 'action', 40);
  const type = optString(o, 'resourceType', 100);
  if (actor !== undefined) f.actorPersonId = actor;
  if (patient !== undefined) f.patientId = patient;
  if (action !== undefined) f.action = action;
  if (type !== undefined) f.resourceType = type;
  return f;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

export class AuditAdminService {
  constructor(private readonly d: AuditAdminDeps) {}

  private run<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.d.db.withScope(scope, fn).catch((e: unknown) => {
      throw translate(e);
    });
  }

  /** `POST /admin/audit-events/search`: ≤ 31 days, one `view` audit row for the query (written by the audit module). */
  async search(scope: ScopeSettings, body: unknown, meta: Meta): Promise<Row> {
    const o = exactBody(body, SEARCH_BODY);
    const filter = filterOf(o);
    const limit = optInt(o, 'limit', 1, 500);
    const r = await this.run(scope, (tx) =>
      this.d.audit.searchEvents(tx, {
        ...meta,
        filter,
        ...(limit === undefined ? {} : { limit }),
      }),
    );
    return {
      items: r.events.map((e) => ({ ...e, occurredAt: iso(e.occurredAt) })),
      truncated: r.truncated,
    };
  }

  /** `POST /admin/audit-exports`: size-limited, asynchronous (the worker assembles it), audited as `export` with the reason. */
  async requestExport(
    scope: ScopeSettings,
    sessionId: string,
    body: unknown,
    meta: Meta,
  ): Promise<Row> {
    const o = exactBody(body, [...FILTER_BODY, 'reason']);
    const filter = filterOf(o);
    const reason = reqString(o, 'reason', 500);
    const out = await this.run(scope, async (tx) => {
      const elevationId = await this.d.elevationIdOf(tx, sessionId);
      if (elevationId === undefined) throw new ApiError(403, 'identity.elevation_required');
      return this.d.audit.requestExport(tx, { ...meta, filter, reason, elevationId });
    });
    return { id: out.exportId, status: 'queued' };
  }

  /** `GET /admin/audit-exports/{id}`: status only; never the content. */
  async exportStatus(scope: ScopeSettings, id: string): Promise<Row> {
    if (!isUuid(id)) throw notFound();
    return this.run(scope, async (tx) => {
      const r = (
        await tx.query(
          `SELECT id, status, row_count, expires_at, filter, reason, created_at
             FROM audit.export_job WHERE id = $1::uuid`,
          [id],
        )
      ).rows[0];
      if (r === undefined) throw notFound();
      return {
        id: r.id,
        status: r.status,
        rowCount: r.row_count === null ? null : Number(r.row_count),
        expiresAt: iso(r.expires_at),
        requestedAt: iso(r.created_at),
        reason: r.reason,
        filter: r.filter,
      };
    });
  }

  /**
   * `POST /admin/audit-exports/{id}/download-url`: only the person who requested the export, only while it is `ready` and
   * unexpired. The hand-out is itself audited (`download`) in the same transaction as the signing.
   */
  async downloadUrl(scope: ScopeSettings, id: string, body: unknown, meta: Meta): Promise<Row> {
    if (!isUuid(id)) throw notFound();
    const o = exactBody(body ?? {}, ['reason']);
    const reason = optString(o, 'reason', 500);
    return this.run(scope, async (tx) => {
      const r = (
        await tx.query(
          `SELECT status, object_key, expires_at, requested_by_person_id, now() >= expires_at AS expired
             FROM audit.export_job WHERE id = $1::uuid`,
          [id],
        )
      ).rows[0];
      if (r === undefined || r.requested_by_person_id !== tx.scope.personId) throw notFound();
      if (r.status !== 'ready' || r.expired === true || typeof r.object_key !== 'string')
        throw new ApiError(409, 'kernel.state_conflict');
      if (this.d.signer === undefined) throw new ApiError(503, 'kernel.unavailable', true);
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'download',
        resourceType: 'audit.export_job',
        resourceId: id,
        reason: reason ?? 'audit export download',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      let signed: { url: string; expiresAt: Date };
      try {
        signed = await this.d.signer.sign(r.object_key, DOWNLOAD_TTL_SECONDS);
      } catch {
        throw new ApiError(503, 'kernel.unavailable', true); // rolls the audit row back with it; no vendor text
      }
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    });
  }

  /** `GET /admin/btg-grants?reviewStatus`: newest first, one `view` audit row for the listing. */
  async listBtgGrants(scope: ScopeSettings, q: Record<string, unknown>, meta: Meta): Promise<Row> {
    const { limit, offset } = parsePage(q);
    const status = q['reviewStatus'];
    if (status !== undefined && !(REVIEW_STATUS as readonly unknown[]).includes(status))
      throw invalid([{ path: '/reviewStatus', code: 'kernel.invalid_value' }]);
    return this.run(scope, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT g.id, g.holder_person_id, g.patient_id, g.reason, g.opened_at, g.expires_at, g.revoked_at,
                  g.review_status, r.reviewer_person_id, r.outcome, r.note, r.reviewed_at
             FROM audit.btg_grant g LEFT JOIN audit.btg_review r ON r.grant_id = g.id
            WHERE ($1::text IS NULL OR g.review_status = $1)
            ORDER BY g.opened_at DESC, g.id DESC LIMIT ${limit + 1} OFFSET ${offset}`,
          [status ?? null],
        )
      ).rows;
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'view',
        resourceType: 'audit.btg_grant',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return {
        items: rows.slice(0, limit).map((g) => ({
          id: g.id,
          holderPersonId: g.holder_person_id,
          patientId: g.patient_id,
          reason: g.reason,
          openedAt: iso(g.opened_at),
          expiresAt: iso(g.expires_at),
          revokedAt: iso(g.revoked_at),
          reviewStatus: g.review_status,
          review:
            g.reviewer_person_id === null
              ? null
              : {
                  reviewerPersonId: g.reviewer_person_id,
                  outcome: g.outcome,
                  note: g.note ?? null,
                  reviewedAt: iso(g.reviewed_at),
                },
        })),
        nextCursor: rows.length > limit ? cursorFor(offset + limit) : null,
      };
    });
  }

  /**
   * `POST /admin/btg-grants/{id}/review` †: by a person other than the holder (`403 audit.self_review`, audited as a denial
   * after the rolled-back transaction), once (`409 audit.invalid_transition`).
   */
  async reviewBtg(scope: ScopeSettings, id: string, body: unknown, meta: Meta): Promise<Row> {
    if (!isUuid(id)) throw notFound();
    const o = exactBody(body, ['outcome', 'note']);
    const outcome = reqString(o, 'outcome', 20);
    if (outcome !== 'justified' && outcome !== 'not_justified')
      throw invalid([{ path: '/outcome', code: 'kernel.invalid_value' }]);
    const note = optString(o, 'note', 2000);
    try {
      await this.run(scope, (tx) =>
        this.d.audit.reviewBtg(tx, {
          ...meta,
          grantId: id,
          outcome,
          ...(note === undefined ? {} : { note }),
        }),
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === 'audit.self_review')
        await this.d.audit.recordDenied(this.d.db, scope, {
          requestId: meta.requestId,
          resourceType: 'audit.btg_grant',
          resourceId: id,
          denialReason: 'forbidden',
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      throw e;
    }
    return { id, reviewStatus: outcome };
  }
}
