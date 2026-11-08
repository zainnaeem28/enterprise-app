// Follow-ups (PRD RA-R1-30; UI-UX PC-07/PC-08). A follow-up is a record that a patient is to be seen again by a due date, with an
// owner and a status; BOOKING the visit is scheduling's (SHARED-BOUNDARIES 4), so a follow-up only points at the reservation once
// staff have booked it: open -> booked (with the reservation) -> done | cancelled; a booked follow-up whose visit was cancelled goes
// back to open. The permission is `clinical.referral.manage` (the catalogue has no separate follow-up permission; module README).
import type { Tx } from '@ehr/kernel';
import type { AuthContext } from '../../identity/index.js';
import type { ChartAuditPort } from '../chart/audit-port.js';
import { dateOnly, iso, isoOrNull, staffPrincipal, strOrNull } from './common.js';
import type { Row } from './common.js';
import {
  FrontdoorNotFoundError,
  FrontdoorScopeError,
  FrontdoorValidationError,
  PreconditionFailedError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { CheckInPort } from './ports.js';
import { REFERRAL_PERMISSION } from './referrals.js';
import type { FollowUpStatus, FollowUpView, RequestMeta } from './types.js';

export interface FollowUpDeps {
  audit: ChartAuditPort;
  checkIns: Pick<CheckInPort, 'reservation'>;
  now?: () => Date;
}

const STATUSES: readonly string[] = ['open', 'booked', 'done', 'cancelled'];
const DAY = 86_400_000;

export const toFollowUpView = (r: Row): FollowUpView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  locationId: String(r['location_id']),
  serviceId: strOrNull(r['service_id']),
  requestedBy: String(r['requested_by']),
  ownerPrincipalId: strOrNull(r['owner_principal_id']),
  dueOn: dateOnly(r['due_on']),
  reason: String(r['reason']),
  status: r['status'] as FollowUpStatus,
  bookedReservationId: strOrNull(r['booked_reservation_id']),
  closedAt: isoOrNull(r['closed_at']),
  createdAt: iso(r['created_at']),
  version: Number(r['row_version']),
});

const validDate = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : undefined;
};

const reasonOf = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length >= 1 && t.length <= 500 ? t : undefined;
};

export class FollowUpService {
  private readonly now: () => Date;

  constructor(private readonly deps: FollowUpDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  private requireAt(ctx: AuthContext, locationId: string): void {
    if (!ctx.grants.has(REFERRAL_PERMISSION, locationId)) throw new FrontdoorScopeError();
  }

  private dueOk(due: string): boolean {
    const t = Date.parse(`${due}T00:00:00Z`);
    const n = this.now().getTime();
    return t >= n - 2 * DAY && t <= n + 3 * 366 * DAY;
  }

  private async audit(
    tx: Tx,
    meta: RequestMeta,
    action: 'create' | 'update' | 'view',
    row: Row | undefined,
    patientId: string | null,
    locationId: string,
    change?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action,
      resourceType: 'clinical.follow_up',
      resourceId: row === undefined ? null : String(row['id']),
      patientId,
      locationId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      ...(change === undefined ? {} : { change }),
    });
  }

  /** `POST /patients/{patientId}/follow-ups` (Idem). */
  async create(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
    body: Record<string, unknown>,
  ): Promise<FollowUpView> {
    const principal = staffPrincipal(tx);
    if (!isUuid(patientId)) throw new FrontdoorNotFoundError();
    const bad: string[] = [];
    if (!isUuid(body['locationId'])) bad.push('locationId');
    const due = validDate(body['dueOn']);
    if (due === undefined || !this.dueOk(due)) bad.push('dueOn');
    const reason = reasonOf(body['reason']);
    if (reason === undefined) bad.push('reason');
    const svc = body['serviceId'];
    if (svc !== undefined && svc !== null && !isUuid(svc)) bad.push('serviceId');
    const owner = body['ownerPrincipalId'];
    if (owner !== undefined && owner !== null && !isUuid(owner)) bad.push('ownerPrincipalId');
    if (bad.length > 0) throw new FrontdoorValidationError(bad);
    const loc = (body['locationId'] as string).toLowerCase();
    this.requireAt(ctx, loc);
    const pid = patientId.toLowerCase();
    try {
      await tx.lockPatients([pid], 'key_share');
      const r = await tx.query(
        `INSERT INTO clinical.follow_up (id, organisation_id, patient_id, location_id, service_id, requested_by, owner_principal_id, due_on, reason, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4, $5::uuid, $6, $7::date, $8, $5::uuid) RETURNING *`,
        [
          uuidv7(),
          pid,
          loc,
          typeof svc === 'string' ? svc.toLowerCase() : null,
          principal,
          typeof owner === 'string' ? owner.toLowerCase() : null,
          due,
          reason,
        ],
      );
      await this.audit(tx, meta, 'create', r.rows[0] as Row, pid, loc, { dueOn: due });
      return toFollowUpView(r.rows[0] as Row);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === '23503')
        throw new FrontdoorValidationError(['serviceId', 'ownerPrincipalId', 'locationId']);
      translateDbError(e);
    }
  }

  /** `GET /locations/{locationId}/follow-ups?status=` — the task list of the pre-consultation desk (PC-07), due date first. */
  async listForLocation(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    locationId: string,
    status?: string,
  ): Promise<FollowUpView[]> {
    staffPrincipal(tx);
    if (!isUuid(locationId)) throw new FrontdoorNotFoundError();
    if (status !== undefined && !STATUSES.includes(status))
      throw new FrontdoorValidationError(['status']);
    const loc = locationId.toLowerCase();
    this.requireAt(ctx, loc);
    const r = await tx.query(
      `SELECT * FROM clinical.follow_up WHERE location_id = $1::uuid AND ($2::text IS NULL OR status = $2)
        ORDER BY due_on, id LIMIT 200`,
      [loc, status ?? null],
    );
    await this.audit(tx, meta, 'view', undefined, null, loc, { count: r.rows.length });
    return (r.rows as Row[]).map(toFollowUpView);
  }

  async listForPatient(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
  ): Promise<FollowUpView[]> {
    staffPrincipal(tx);
    if (!isUuid(patientId)) throw new FrontdoorNotFoundError();
    const r = await tx.query(
      `SELECT * FROM clinical.follow_up WHERE patient_id = $1::uuid ORDER BY due_on DESC, id LIMIT 200`,
      [patientId.toLowerCase()],
    );
    const rows = (r.rows as Row[]).filter((x) =>
      ctx.grants.has(REFERRAL_PERMISSION, String(x['location_id'])),
    );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.follow_up',
      patientId: patientId.toLowerCase(),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { count: rows.length },
    });
    return rows.map(toFollowUpView);
  }

  /**
   * `PATCH /follow-ups/{id}` (If-Match). Owner, due date, reason, service; or one status step: `booked` (with `bookedReservationId`,
   * a reservation of the same patient), `open` (the booking fell through), `done`, `cancelled`.
   */
  async update(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
    expectedVersion: number,
    body: Record<string, unknown>,
  ): Promise<FollowUpView> {
    staffPrincipal(tx);
    if (!isUuid(id)) throw new FrontdoorNotFoundError();
    const peek = (
      await tx.query(`SELECT patient_id, location_id FROM clinical.follow_up WHERE id = $1::uuid`, [
        id.toLowerCase(),
      ])
    ).rows[0] as Row | undefined;
    if (peek === undefined) throw new FrontdoorNotFoundError();
    this.requireAt(ctx, String(peek['location_id']));
    try {
      await tx.lockPatients([String(peek['patient_id'])], 'key_share');
      const row = (
        await tx.query(`SELECT * FROM clinical.follow_up WHERE id = $1::uuid FOR UPDATE`, [
          id.toLowerCase(),
        ])
      ).rows[0] as Row | undefined;
      if (row === undefined) throw new FrontdoorNotFoundError();
      if (Number(row['row_version']) !== expectedVersion) throw new PreconditionFailedError();
      const bad: string[] = [];
      const sets: string[] = [];
      const params: unknown[] = [row['id']];
      const set = (col: string, v: unknown, cast = ''): void => {
        params.push(v);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (body['dueOn'] !== undefined) {
        const d = validDate(body['dueOn']);
        if (d === undefined || !this.dueOk(d)) bad.push('dueOn');
        else set('due_on', d, '::date');
      }
      if (body['reason'] !== undefined) {
        const r = reasonOf(body['reason']);
        if (r === undefined) bad.push('reason');
        else set('reason', r);
      }
      if (body['ownerPrincipalId'] !== undefined) {
        const o = body['ownerPrincipalId'];
        if (o !== null && !isUuid(o)) bad.push('ownerPrincipalId');
        else set('owner_principal_id', o === null ? null : (o as string).toLowerCase(), '::uuid');
      }
      if (body['serviceId'] !== undefined) {
        const s = body['serviceId'];
        if (s !== null && !isUuid(s)) bad.push('serviceId');
        else set('service_id', s === null ? null : (s as string).toLowerCase(), '::uuid');
      }
      const status = body['status'];
      if (status !== undefined) {
        if (typeof status !== 'string' || !STATUSES.includes(status) || status === row['status']) {
          bad.push('status');
        } else {
          set('status', status);
          if (status === 'booked') {
            const rid = body['bookedReservationId'];
            if (!isUuid(rid)) bad.push('bookedReservationId');
            else {
              const res = await this.deps.checkIns.reservation(tx, rid.toLowerCase());
              if (res === undefined || res.patientId !== String(row['patient_id']))
                bad.push('bookedReservationId');
              else set('booked_reservation_id', res.checkInId, '::uuid');
            }
          } else {
            set(
              'booked_reservation_id',
              status === 'open' ? null : (row['booked_reservation_id'] ?? null),
              '::uuid',
            );
          }
          if (status === 'done' || status === 'cancelled') sets.push('closed_at = now()');
        }
      } else if (body['bookedReservationId'] !== undefined) {
        bad.push('bookedReservationId');
      }
      if (bad.length > 0) throw new FrontdoorValidationError(bad);
      if (sets.length === 0) throw new FrontdoorValidationError(['body']);
      const u = await tx.query(
        `UPDATE clinical.follow_up SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING *`,
        params,
      );
      await this.audit(
        tx,
        meta,
        'update',
        u.rows[0] as Row,
        String(row['patient_id']),
        String(row['location_id']),
        {
          status: String((u.rows[0] as Row)['status']),
        },
      );
      return toFollowUpView(u.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }
}
