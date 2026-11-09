// Referrals (ARCHITECTURE 22.11 "Referral to another location", 22.16, 29.3; PRD RA-R1-30; AL-R2-01, AF-03, TDR-12).
//
// A referral is drafted, edited and SENT by staff of the referring location; an internal one reaches the target through a
// PHI-minimal inbox row (referral id, location, status: no patient column), the target staff accept or decline it there, and
// accepting creates the care relationship at the referral's OWN target location, never one from the request, after a re-check under
// a row lock. State machine (enforced by the trigger of 1701, which also pins the side that owns each step):
//   draft -> sent | cancelled        sent -> accepted | declined | cancelled        accepted -> completed
//   an external referral has no receiving side here: sent -> completed | cancelled, by the referrer.
// declined, completed and cancelled are final. A sent referral's target and reason cannot change.
//
// Lock order (25.2): the patient root first (`lockPatients`; for accept and decline the referral-bound `lockForReferral`, since the
// receiving location has no care relationship yet), then the rows. Accept needs `no_key_update` for the scope-owner function
// `ensure_referral_care_relationship`; the other writes need `key_share`.
import type { Tx } from '@ehr/kernel';
import type { AuthContext } from '../../identity/index.js';
import type { ChartAuditPort } from '../chart/audit-port.js';
import { iso, isoOrNull, staffPrincipal, strOrNull } from './common.js';
import type { Row } from './common.js';
import {
  FrontdoorNotFoundError,
  FrontdoorScopeError,
  FrontdoorValidationError,
  InvalidTransitionError,
  PreconditionFailedError,
  ReferralNotPendingError,
  ReferralTargetInvalidError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { CarePort, CatalogPort } from './ports.js';
import type {
  InboxItem,
  ReferralStatus,
  ReferralTargetKind,
  ReferralView,
  RequestMeta,
} from './types.js';

export const REFERRAL_PERMISSION = 'clinical.referral.manage';
const KINDS: readonly string[] = ['internal_location', 'internal_service', 'external'];

export interface ReferralDeps {
  audit: ChartAuditPort;
  catalog: Pick<CatalogPort, 'serviceOffered'>;
  care: CarePort;
}

export const toReferralView = (r: Row): ReferralView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  fromLocationId: String(r['from_location_id']),
  fromPrincipalId: String(r['from_principal_id']),
  targetKind: r['target_kind'] as ReferralTargetKind,
  targetLocationId: strOrNull(r['target_location_id']),
  targetServiceId: strOrNull(r['target_service_id']),
  targetExternalText: strOrNull(r['target_external_text']),
  reason: String(r['reason']),
  status: r['status'] as ReferralStatus,
  decidedBy: strOrNull(r['decided_by']),
  decidedAt: isoOrNull(r['decided_at']),
  declineReason: strOrNull(r['decline_reason']),
  createdAt: iso(r['created_at']),
  version: Number(r['row_version']),
});

interface Target {
  kind: ReferralTargetKind;
  locationId: string | null;
  serviceId: string | null;
  external: string | null;
}

const text = (v: unknown, min: number, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : undefined;
};

/** The target of a body, with the shape rule of 22.11: which fields go with which kind. Returns the bad field names too. */
function targetOf(b: Record<string, unknown>, bad: string[]): Target | undefined {
  const kind = b['targetKind'];
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    bad.push('targetKind');
    return undefined;
  }
  const loc = b['targetLocationId'];
  const svc = b['targetServiceId'];
  const ext = b['targetExternalText'];
  const t: Target = {
    kind: kind as ReferralTargetKind,
    locationId: null,
    serviceId: null,
    external: null,
  };
  if (loc !== undefined && loc !== null) {
    if (isUuid(loc)) t.locationId = loc.toLowerCase();
    else bad.push('targetLocationId');
  }
  if (svc !== undefined && svc !== null) {
    if (isUuid(svc)) t.serviceId = svc.toLowerCase();
    else bad.push('targetServiceId');
  }
  if (ext !== undefined && ext !== null) {
    const e = text(ext, 1, 500);
    if (e === undefined) bad.push('targetExternalText');
    else t.external = e;
  }
  if (
    kind === 'internal_location' &&
    (t.locationId === null || t.serviceId !== null || t.external !== null)
  )
    bad.push('target');
  if (kind === 'internal_service' && (t.serviceId === null || t.external !== null))
    bad.push('target');
  if (kind === 'external' && (t.external === null || t.locationId !== null || t.serviceId !== null))
    bad.push('target');
  return t;
}

export class ReferralService {
  constructor(private readonly deps: ReferralDeps) {}

  private requireAt(ctx: AuthContext, locationId: string): void {
    if (!ctx.grants.has(REFERRAL_PERMISSION, locationId)) throw new FrontdoorScopeError();
  }

  private async readRow(tx: Tx, id: string, lock = false): Promise<Row | undefined> {
    const r = await tx.query(
      `SELECT * FROM clinical.referral WHERE id = $1::uuid${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return r.rows[0] as Row | undefined;
  }

  private async audit(
    tx: Tx,
    meta: RequestMeta,
    action: 'create' | 'update' | 'view',
    row: Row,
    locationId: string,
    change?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action,
      resourceType: 'clinical.referral',
      resourceId: String(row['id']),
      patientId: String(row['patient_id']),
      locationId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      ...(change === undefined ? {} : { change }),
    });
  }

  /** `POST /patients/{patientId}/referrals` (Idem): a draft from the caller's location. */
  async create(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
    body: Record<string, unknown>,
  ): Promise<ReferralView> {
    const principal = staffPrincipal(tx);
    if (!isUuid(patientId)) throw new FrontdoorNotFoundError();
    const bad: string[] = [];
    const from = body['fromLocationId'];
    if (!isUuid(from)) bad.push('fromLocationId');
    const reason = text(body['reason'], 1, 2048);
    if (reason === undefined) bad.push('reason');
    const target = targetOf(body, bad);
    if (bad.length > 0 || target === undefined) throw new FrontdoorValidationError(bad);
    const fromLoc = (from as string).toLowerCase();
    this.requireAt(ctx, fromLoc);
    const pid = patientId.toLowerCase();
    const id = uuidv7();
    try {
      await tx.lockPatients([pid], 'key_share');
      const r = await tx.query(
        `INSERT INTO clinical.referral (id, organisation_id, patient_id, from_location_id, from_principal_id, target_kind,
                                        target_location_id, target_service_id, target_external_text, reason, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $4::uuid) RETURNING *`,
        [
          id,
          pid,
          fromLoc,
          principal,
          target.kind,
          target.locationId,
          target.serviceId,
          target.external,
          reason,
        ],
      );
      await this.audit(tx, meta, 'create', r.rows[0] as Row, fromLoc, {
        targetKind: target.kind,
      });
      return toReferralView(r.rows[0] as Row);
    } catch (e) {
      throw this.fk(e);
    }
  }

  /** A foreign-key failure on a target (no such location or service) is an invalid target, not a server error. */
  private fk(e: unknown): never {
    if ((e as { code?: unknown } | null)?.code === '23503') throw new ReferralTargetInvalidError();
    return translateDbError(e);
  }

  async get(tx: Tx, ctx: AuthContext, meta: RequestMeta, id: string): Promise<ReferralView> {
    if (!isUuid(id)) throw new FrontdoorNotFoundError();
    const row = await this.readRow(tx, id.toLowerCase());
    if (row === undefined) throw new FrontdoorNotFoundError();
    this.requireAt(ctx, String(row['from_location_id']));
    await this.audit(tx, meta, 'view', row, String(row['from_location_id']));
    return toReferralView(row);
  }

  /** `GET /patients/{patientId}/referrals`: the referrals the caller's locations sent for the patient, newest first. */
  async listForPatient(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
  ): Promise<ReferralView[]> {
    if (!isUuid(patientId)) throw new FrontdoorNotFoundError();
    const r = await tx.query(
      `SELECT * FROM clinical.referral WHERE patient_id = $1::uuid ORDER BY created_at DESC, id LIMIT 200`,
      [patientId.toLowerCase()],
    );
    const rows = (r.rows as Row[]).filter((x) =>
      ctx.grants.has(REFERRAL_PERMISSION, String(x['from_location_id'])),
    );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.referral',
      patientId: patientId.toLowerCase(),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { count: rows.length },
    });
    return rows.map(toReferralView);
  }

  /**
   * `PATCH /referrals/{id}` (If-Match). Fields of a draft (kind, target, reason), or `{status: 'cancelled'}` (a draft or sent
   * referral, by the referrer), or `{status: 'completed'}` (an external sent referral, by the referrer; an accepted internal one, by
   * the receiving location). One kind of change per call.
   */
  async update(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
    expectedVersion: number,
    body: Record<string, unknown>,
  ): Promise<ReferralView> {
    staffPrincipal(tx);
    if (!isUuid(id)) throw new FrontdoorNotFoundError();
    const peek = await this.readRow(tx, id.toLowerCase());
    if (peek === undefined) throw new FrontdoorNotFoundError();
    try {
      await tx.lockPatients([String(peek['patient_id'])], 'key_share');
      const row = await this.readRow(tx, id.toLowerCase(), true);
      if (row === undefined) throw new FrontdoorNotFoundError();
      if (Number(row['row_version']) !== expectedVersion) throw new PreconditionFailedError();
      const status = body['status'];
      const fieldKeys = [
        'targetKind',
        'targetLocationId',
        'targetServiceId',
        'targetExternalText',
        'reason',
      ];
      const hasFields = fieldKeys.some((k) => body[k] !== undefined);
      if (status !== undefined && (hasFields || (status !== 'cancelled' && status !== 'completed')))
        throw new FrontdoorValidationError(['status']);
      let sql: string;
      let params: unknown[];
      let place: string;
      if (status === 'cancelled' || status === 'completed') {
        const side =
          status === 'completed' && row['status'] === 'accepted'
            ? String(row['target_location_id'])
            : String(row['from_location_id']);
        this.requireAt(ctx, side);
        place = side;
        sql = `UPDATE clinical.referral SET status = $2 WHERE id = $1::uuid RETURNING *`;
        params = [row['id'], status];
      } else {
        this.requireAt(ctx, String(row['from_location_id']));
        place = String(row['from_location_id']);
        if (row['status'] !== 'draft') throw new FrontdoorValidationError(['status']);
        const bad: string[] = [];
        const merged: Record<string, unknown> = {
          targetKind: row['target_kind'],
          targetLocationId: row['target_location_id'],
          targetServiceId: row['target_service_id'],
          targetExternalText: row['target_external_text'],
          ...Object.fromEntries(
            fieldKeys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]),
          ),
        };
        // Changing the kind clears the fields of the old kind unless the body sets them.
        if (body['targetKind'] !== undefined && body['targetKind'] !== row['target_kind'])
          for (const k of ['targetLocationId', 'targetServiceId', 'targetExternalText'])
            if (body[k] === undefined) merged[k] = null;
        const target = targetOf(merged, bad);
        const reason =
          body['reason'] === undefined ? String(row['reason']) : text(body['reason'], 1, 2048);
        if (reason === undefined) bad.push('reason');
        if (bad.length > 0 || target === undefined) throw new FrontdoorValidationError(bad);
        sql = `UPDATE clinical.referral SET target_kind = $2, target_location_id = $3, target_service_id = $4,
                      target_external_text = $5, reason = $6 WHERE id = $1::uuid RETURNING *`;
        params = [
          row['id'],
          target.kind,
          target.locationId,
          target.serviceId,
          target.external,
          reason,
        ];
      }
      const u = await tx.query(sql, params);
      if (u.rows[0] === undefined) throw new PreconditionFailedError();
      await this.audit(tx, meta, 'update', u.rows[0] as Row, place, {
        status: String((u.rows[0] as Row)['status']),
      });
      return toReferralView(u.rows[0] as Row);
    } catch (e) {
      throw this.fk(e);
    }
  }

  /**
   * `POST /referrals/{id}/send` (Idem). Internal referrals need a target location (for a service target the sender picks it now and
   * the location must offer the service: `422 clinical.referral_target_invalid`), and write the inbox row in this transaction.
   */
  async send(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
    body: Record<string, unknown>,
  ): Promise<ReferralView> {
    const principal = staffPrincipal(tx);
    if (!isUuid(id)) throw new FrontdoorNotFoundError();
    const peek = await this.readRow(tx, id.toLowerCase());
    if (peek === undefined) throw new FrontdoorNotFoundError();
    try {
      await tx.lockPatients([String(peek['patient_id'])], 'key_share');
      const row = await this.readRow(tx, id.toLowerCase(), true);
      if (row === undefined) throw new FrontdoorNotFoundError();
      this.requireAt(ctx, String(row['from_location_id']));
      if (row['status'] !== 'draft') throw new InvalidTransitionError();
      const kind = String(row['target_kind']);
      let targetLocation: string | null = null;
      if (kind !== 'external') {
        const given = body['targetLocationId'];
        if (given !== undefined && given !== null && !isUuid(given))
          throw new FrontdoorValidationError(['targetLocationId']);
        targetLocation =
          kind === 'internal_location'
            ? strOrNull(row['target_location_id'])
            : typeof given === 'string'
              ? given.toLowerCase()
              : strOrNull(row['target_location_id']);
        if (targetLocation === null) throw new ReferralTargetInvalidError();
        if (kind === 'internal_service') {
          const offered = await this.deps.catalog.serviceOffered(
            tx,
            String(row['target_service_id']),
            targetLocation,
          );
          if (!offered) throw new ReferralTargetInvalidError();
        }
      }
      const u = await tx.query(
        `UPDATE clinical.referral SET status = 'sent', target_location_id = $2 WHERE id = $1::uuid RETURNING *`,
        [row['id'], targetLocation],
      );
      if (kind !== 'external')
        await tx.query(
          `INSERT INTO clinical.referral_inbox (referral_id, organisation_id, target_location_id, patient_label_ref, created_by)
           VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $1::uuid, $3::uuid)`,
          [row['id'], targetLocation, principal],
        );
      await this.audit(tx, meta, 'update', u.rows[0] as Row, String(row['from_location_id']), {
        status: 'sent',
        targetKind: kind,
      });
      return toReferralView(u.rows[0] as Row);
    } catch (e) {
      throw this.fk(e);
    }
  }

  /** `GET /locations/{id}/referral-inbox`: location-only, no patient column; "a referral for service X from location Y". */
  async inbox(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    locationId: string,
  ): Promise<InboxItem[]> {
    staffPrincipal(tx);
    if (!isUuid(locationId)) throw new FrontdoorNotFoundError();
    const loc = locationId.toLowerCase();
    this.requireAt(ctx, loc);
    const r = await tx.query(
      `SELECT i.referral_id, i.target_location_id, i.status, i.created_at, f.from_location_id, f.target_service_id, f.status AS referral_status
         FROM clinical.referral_inbox i LEFT JOIN clinical.referral f ON f.id = i.referral_id
        WHERE i.target_location_id = $1::uuid ORDER BY i.created_at DESC, i.referral_id LIMIT 200`,
      [loc],
    );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.referral_inbox',
      locationId: loc,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { count: r.rows.length },
    });
    return (r.rows as Row[]).map((x) => ({
      referralId: String(x['referral_id']),
      targetLocationId: String(x['target_location_id']),
      status: x['status'] as InboxItem['status'],
      createdAt: iso(x['created_at']),
      fromLocationId: strOrNull(x['from_location_id']),
      targetServiceId: strOrNull(x['target_service_id']),
      referralStatus: strOrNull(x['referral_status']) as ReferralStatus | null,
    }));
  }

  /**
   * The accept / decline transaction (22.11, draft 7). Locks the patient root (no_key_update), then the inbox row and the referral,
   * and refuses (`409 clinical.referral_not_pending`) unless the inbox row is `pending`, its target is one of the caller's locations,
   * and the referral is `sent` with the SAME target location. The care relationship is created at the referral's own target
   * location, read from the locked row, never from the request.
   */
  private async decide(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
    decision: 'accepted' | 'declined',
    declineReason?: string,
  ): Promise<ReferralView> {
    staffPrincipal(tx);
    if (!isUuid(id)) throw new FrontdoorNotFoundError();
    const rid = id.toLowerCase();
    const peek = await this.readRow(tx, rid);
    if (peek === undefined) {
      // A referral the target can no longer read (cancelled by the sender after sending) leaves its inbox row behind: that row is
      // visible to the target location, and the answer is "not pending", not "not found".
      const stale = await tx.query(
        `SELECT 1 FROM clinical.referral_inbox WHERE referral_id = $1::uuid AND target_location_id = ANY($2::uuid[])`,
        [rid, tx.scope.locationIds ?? []],
      );
      throw stale.rows.length > 0 ? new ReferralNotPendingError() : new FrontdoorNotFoundError();
    }
    // A decided referral the caller can still read (accepted: the relationship exists) is "not pending"; the referral-bound lock
    // below would answer it with the same 404 as a missing one. The state is checked again under the lock.
    if (peek['status'] !== 'sent') throw new ReferralNotPendingError();
    try {
      await this.deps.care.lockForReferral(
        tx,
        rid,
        String(peek['patient_id']),
        decision === 'accepted' ? 'no_key_update' : 'key_share',
      );
      // The row is locked only while pending: the update policy shows a decided row to nobody, so a plain read comes first and a
      // decided row is "not pending", never "not found". A decision that wins the lock between the two reads leaves the second
      // read empty, which is the same answer.
      const seen = (
        await tx.query(`SELECT * FROM clinical.referral_inbox WHERE referral_id = $1::uuid`, [rid])
      ).rows[0] as Row | undefined;
      if (seen === undefined) throw new FrontdoorNotFoundError();
      const here = String(seen['target_location_id']);
      if (!(tx.scope.locationIds ?? []).map((x) => x.toLowerCase()).includes(here))
        throw new FrontdoorNotFoundError();
      this.requireAt(ctx, here);
      if (seen['status'] !== 'pending') throw new ReferralNotPendingError();
      const inbox = (
        await tx.query(
          `SELECT * FROM clinical.referral_inbox WHERE referral_id = $1::uuid AND status = 'pending' FOR UPDATE`,
          [rid],
        )
      ).rows[0] as Row | undefined;
      if (inbox === undefined) throw new ReferralNotPendingError();
      const row = await this.readRow(tx, rid, true);
      if (
        row === undefined ||
        inbox['status'] !== 'pending' ||
        row['status'] !== 'sent' ||
        String(row['target_location_id']) !== here
      )
        throw new ReferralNotPendingError();
      // R-REF-8: the care relationship is created on accept only, while the referral is still sent/pending and locked here, and
      // before both status updates (the database checks the pending state).
      if (decision === 'accepted') await this.deps.care.ensureForReferral(tx, meta, rid);
      const u = await tx.query(
        `UPDATE clinical.referral SET status = $2, decided_by = $3::uuid, decided_at = now(), decline_reason = $4 WHERE id = $1::uuid RETURNING *`,
        [rid, decision, tx.scope.principalId, declineReason ?? null],
      );
      await tx.query(
        `UPDATE clinical.referral_inbox SET status = $2, decided_at = now() WHERE referral_id = $1::uuid`,
        [rid, decision],
      );
      await this.audit(tx, meta, 'update', u.rows[0] as Row, here, { status: decision });
      return toReferralView(u.rows[0] as Row);
    } catch (e) {
      throw this.fk(e);
    }
  }

  accept(tx: Tx, ctx: AuthContext, meta: RequestMeta, id: string): Promise<ReferralView> {
    return this.decide(tx, ctx, meta, id, 'accepted');
  }

  decline(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
    body: Record<string, unknown>,
  ): Promise<ReferralView> {
    const reason = text(body['reason'], 1, 500);
    if (reason === undefined) throw new FrontdoorValidationError(['reason']);
    return this.decide(tx, ctx, meta, id, 'declined', reason);
  }
}
