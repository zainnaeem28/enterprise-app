// Durable staff alerts (ARCHITECTURE 22.13, 5.4, 32.4; ADR-009, ADR-022).
//   raise        `notifications.raiseAlert(type, targets, resourceRef, patientId?)`: the alert row, its `created` event and (when an
//                escalation time is configured) the `notifications.escalate_alert` job, all in the CALLER's transaction. The
//                database trigger runs pg_notify in that transaction, so a rolled-back alert notifies nobody.
//   acknowledge  one transaction under a row lock: two targets acknowledging at once both get 200 and one `acknowledged` event.
//   escalate     see escalate.ts.   list / openIds   the own-targets reads (RLS decides what a caller sees).
// Targets are resolved to PRINCIPALS when the alert is created and again at each escalation (ADR-022). Admin-realm alerts
// never carry a patient ID: the service refuses one and the table refuses it too.
import type { Queue, Tx } from '@ehr/kernel';
import type { AuditService } from '../../audit/index.js';
import { NotificationsNotFoundError, NotificationsValidationError } from '../errors.js';
import { isUuid, uuidv7 } from '../ids.js';
import { AlertClosedError } from './errors.js';
import { ESCALATION_LEVEL } from './jobs.js';
import {
  ALERT_SEVERITIES,
  ALERT_TYPES,
  PATIENT_ALERT_TYPES,
  alertLink,
  type AcknowledgeResult,
  type AlertStatus,
  type AlertTargets,
  type AlertView,
  type OpenAlertId,
  type RaiseAlertInput,
  type RaisedAlert,
  type TargetResolver,
} from './types.js';

type Row = Record<string, unknown>;

const MAX_TARGETS = 500;
const RESOURCE_TYPE = /^[a-z][a-z0-9_]{0,60}$/;
const ROLE_KEY = /^[a-z][a-z0-9_]{0,60}$/;
const PERMISSION = /^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$/;
const LIST_STATUS = new Set(['open', 'escalated', 'acknowledged', 'closed']);
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** Who is calling: a request (API) or a job (worker), for the audit row. */
export interface AlertContext {
  requestId?: string;
  jobId?: string;
}

export interface AlertDeps {
  queue: Queue;
  /** Needed for `role_location` and `compliance_permission` targets. */
  resolver?: TargetResolver;
  audit?: AuditService;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

export function toView(r: Row): AlertView {
  return {
    alertId: String(r['id']),
    seq: Number(r['seq']),
    type: r['type'] as AlertView['type'],
    severity: r['severity'] as AlertView['severity'],
    status: r['status'] as AlertStatus,
    createdAt: iso(r['created_at']) as string,
    escalationLevel: Number(r['escalation_level']),
    // 29.3: set only while the alert is open with a scheduled escalation; null after acknowledge, escalation or close.
    escalatesAt: r['status'] === 'open' ? iso(r['escalate_at']) : null,
    acknowledgedAt: iso(r['acknowledged_at']),
    acknowledgedBy: (r['acknowledged_by'] as string | null) ?? null,
    acknowledgedByDisplayName: (r['display_name'] as string | null | undefined) ?? null,
    patientId: (r['patient_id'] as string | null) ?? null,
    resourceType: (r['resource_type'] as string | null) ?? null,
    resourceId: (r['resource_id'] as string | null) ?? null,
    link: alertLink(String(r['id'])),
  };
}

export const encodeCursor = (seq: number): string => Buffer.from(`s:${seq}`).toString('base64url');
export function decodeCursor(c: string): number {
  const m = /^s:([0-9]{1,18})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  if (m === null) throw new NotificationsValidationError(['cursor']);
  return Number(m[1]);
}

export class AlertService {
  constructor(private readonly d: AlertDeps) {}

  // --- raise ---------------------------------------------------------------------------------------------------

  async raise(tx: Tx, input: RaiseAlertInput, ctx: AlertContext = {}): Promise<RaisedAlert> {
    const bad: string[] = [];
    if (!ALERT_TYPES.includes(input.type)) bad.push('type');
    if (!ALERT_SEVERITIES.includes(input.severity)) bad.push('severity');
    if (!RESOURCE_TYPE.test(input.resourceType)) bad.push('resourceType');
    if (!isUuid(input.resourceId)) bad.push('resourceId');
    if (input.locationId !== undefined && !isUuid(input.locationId)) bad.push('locationId');
    // ADR-022: only red_flag and note_unsigned name a patient; red_flag must.
    const patientType = PATIENT_ALERT_TYPES.includes(input.type);
    if (input.patientId !== undefined && (!patientType || !isUuid(input.patientId)))
      bad.push('patientId');
    if (input.type === 'red_flag' && input.patientId === undefined) bad.push('patientId');
    if (bad.length > 0) throw new NotificationsValidationError(bad);

    const principals = await this.resolveTargets(tx, input.targets);
    if (principals.length === 0 || principals.length > MAX_TARGETS)
      throw new NotificationsValidationError(['targets']);

    const setting = await this.escalationSetting(tx, input.type, input.locationId);
    const id = uuidv7();
    const byJob = tx.scope.audience === 'system';
    const t = input.targets;
    const inserted = await tx.query(
      `INSERT INTO notifications.staff_alert
         (id, organisation_id, type, severity, patient_id, resource_type, resource_id, location_id, target_kind,
          target_principal_ids, target_role_key, target_location_ids, target_permission, status, escalation_level, escalate_at,
          ${byJob ? 'created_by_job' : 'created_by'})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11, $12::uuid[], $13, 'open', 0,
          CASE WHEN $14::int IS NULL THEN NULL ELSE now() + make_interval(mins => $14::int) END, $15)
       RETURNING seq, escalate_at`,
      [
        id,
        tx.scope.orgId,
        input.type,
        input.severity,
        input.patientId ?? null,
        input.resourceType,
        input.resourceId,
        input.locationId ?? null,
        t.kind,
        principals,
        t.kind === 'role_location' ? t.roleKey : null,
        t.kind === 'role_location' ? [...t.locationIds] : null,
        t.kind === 'compliance_permission' ? t.permission : null,
        setting?.minutes ?? null,
        byJob ? (ctx.jobId ?? null) : (tx.scope.principalId ?? null),
      ],
    );
    const row = inserted.rows[0] as Row;
    const escalatesAt = row['escalate_at'] instanceof Date ? row['escalate_at'] : null;
    await this.event(tx, id, input.patientId ?? null, 'created', tx.scope.principalId ?? null);
    if (escalatesAt !== null) {
      await this.d.queue.enqueue(
        tx,
        'notifications.escalate_alert',
        input.patientId === undefined
          ? { alertId: id, level: ESCALATION_LEVEL }
          : { alertId: id, patientId: input.patientId, level: ESCALATION_LEVEL },
        { runAt: escalatesAt, jobKey: `alert:${id}:${ESCALATION_LEVEL}` },
      );
    }
    await this.audit(tx, 'create', id, input.patientId ?? null, ctx, {
      type: input.type,
      targets: principals.length,
    });
    return { alertId: id, seq: Number(row['seq']), escalatesAt, targetPrincipalIds: principals };
  }

  /** Principals for a target spec, de-duplicated and sorted. A role or permission needs the injected resolver. */
  async resolveTargets(tx: Tx, t: AlertTargets): Promise<string[]> {
    let ids: string[];
    switch (t.kind) {
      case 'principal':
        ids = [...t.principalIds];
        break;
      case 'role_location':
        if (!ROLE_KEY.test(t.roleKey) || t.locationIds.length === 0 || !t.locationIds.every(isUuid))
          throw new NotificationsValidationError(['targets']);
        ids = await this.resolver().roleHolders(tx, t.roleKey, t.locationIds);
        break;
      case 'compliance_permission':
        if (!PERMISSION.test(t.permission)) throw new NotificationsValidationError(['targets']);
        ids = await this.resolver().permissionHolders(tx, t.permission);
        break;
      default:
        throw new NotificationsValidationError(['targets']);
    }
    if (!ids.every(isUuid)) throw new NotificationsValidationError(['targets']);
    return [...new Set(ids.map((x) => x.toLowerCase()))].sort();
  }

  private resolver(): TargetResolver {
    if (this.d.resolver === undefined) throw new NotificationsValidationError(['targets']);
    return this.d.resolver;
  }

  /**
   * Minutes until escalation for a type at a location, or undefined when none is configured. Source: `staff_alert_setting`
   * (location row first, then the organisation row). For `red_flag` the clinical setting `red_flag_escalation_minutes`
   * (D-12a) is the fallback. There is no default for `red_flag` anywhere: a missing value means no timer (ALR-N1).
   */
  async escalationSetting(
    tx: Tx,
    type: string,
    locationId?: string,
  ): Promise<{ minutes: number; duty: string | null } | undefined> {
    const r = await tx.query(
      `SELECT escalate_after_min, escalate_to_duty FROM notifications.staff_alert_setting
        WHERE alert_type = $1 AND (location_id IS NULL OR location_id = $2::uuid)
        ORDER BY location_id NULLS LAST LIMIT 1`,
      [type, locationId ?? null],
    );
    const row = r.rows[0] as Row | undefined;
    if (row !== undefined)
      return { minutes: Number(row['escalate_after_min']), duty: String(row['escalate_to_duty']) };
    if (type !== 'red_flag') return undefined;
    const s = await tx.query(
      `SELECT value FROM kernel.setting
        WHERE key = 'red_flag_escalation_minutes' AND (location_id IS NULL OR location_id = $1::uuid)
        ORDER BY location_id NULLS LAST LIMIT 1`,
      [locationId ?? null],
    );
    const v = (s.rows[0] as Row | undefined)?.['value'];
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10080
      ? { minutes: v, duty: null }
      : undefined;
  }

  // --- acknowledge ---------------------------------------------------------------------------------------------

  /**
   * `POST /alerts/{id}/acknowledge`. The alert row is locked first, so two targets acknowledging at the same moment run one
   * after the other: the first writes `acknowledged` and its event, the second finds the stored values and answers 200 with
   * `alreadyAcknowledged: true` and no new event. A closed alert is 409. An alert the caller may not see is 404.
   */
  async acknowledge(tx: Tx, alertId: string, ctx: AlertContext = {}): Promise<AcknowledgeResult> {
    if (!isUuid(alertId)) throw new NotificationsNotFoundError();
    const me = tx.scope.principalId;
    if (me === undefined) throw new NotificationsNotFoundError();
    const found = await tx.query(
      `SELECT id, status, patient_id, escalation_level, acknowledged_by, acknowledged_at
         FROM notifications.staff_alert WHERE id = $1 FOR UPDATE`,
      [alertId],
    );
    const row = found.rows[0] as Row | undefined;
    if (row === undefined) throw new NotificationsNotFoundError();
    if (row['status'] === 'closed') throw new AlertClosedError();
    if (row['status'] === 'acknowledged') {
      return {
        alertId,
        status: 'acknowledged',
        acknowledgedAt: iso(row['acknowledged_at']) as string,
        acknowledgedBy: String(row['acknowledged_by']),
        escalationLevel: Number(row['escalation_level']),
        escalatesAt: null,
        alreadyAcknowledged: true,
      };
    }
    const upd = await tx.query(
      `UPDATE notifications.staff_alert
          SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), escalate_at = NULL
        WHERE id = $1 RETURNING acknowledged_at, escalation_level`,
      [alertId, me],
    );
    const u = upd.rows[0] as Row;
    const patientId = (row['patient_id'] as string | null) ?? null;
    await this.event(tx, alertId, patientId, 'acknowledged', me);
    await this.audit(tx, 'update', alertId, patientId, ctx, { status: 'acknowledged' });
    return {
      alertId,
      status: 'acknowledged',
      acknowledgedAt: iso(u['acknowledged_at']) as string,
      acknowledgedBy: me,
      escalationLevel: Number(u['escalation_level']),
      escalatesAt: null,
      alreadyAcknowledged: false,
    };
  }

  // --- close / add targets (T-SYS) ----------------------------------------------------------------------------

  /** Closes an alert whose resource is resolved (for example a BTG grant that ended). Idempotent; `closed` is final. */
  async close(tx: Tx, alertId: string, ctx: AlertContext = {}): Promise<boolean> {
    const r = await tx.query(
      `SELECT status, patient_id FROM notifications.staff_alert WHERE id = $1 FOR UPDATE`,
      [alertId],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) throw new NotificationsNotFoundError();
    if (row['status'] === 'closed') return false;
    await tx.query(
      `UPDATE notifications.staff_alert SET status = 'closed', escalate_at = NULL WHERE id = $1`,
      [alertId],
    );
    const patientId = (row['patient_id'] as string | null) ?? null;
    await this.event(tx, alertId, patientId, 'closed', tx.scope.principalId ?? null);
    await this.audit(tx, 'update', alertId, patientId, ctx, { status: 'closed' });
    return true;
  }

  /**
   * `notifications.escalate(alertId, targets)` (24): the owning module re-targets after `alert_unacknowledged` (25.5). Targets
   * are resolved to principals now (ADR-022) and ADDED to the alert; nobody who could see it loses sight of it. Only a worker
   * (T-SYS) may call it. A closed alert is refused. Returns the principals added.
   */
  async addEscalationTargets(
    tx: Tx,
    alertId: string,
    targets: AlertTargets,
    ctx: AlertContext = {},
  ): Promise<string[]> {
    if (tx.scope.audience !== 'system') throw new NotificationsNotFoundError();
    const wanted = await this.resolveTargets(tx, targets);
    const r = await tx.query(
      `SELECT status, patient_id, target_principal_ids FROM notifications.staff_alert WHERE id = $1 FOR UPDATE`,
      [alertId],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) throw new NotificationsNotFoundError();
    if (row['status'] === 'closed') throw new AlertClosedError();
    const have = new Set(row['target_principal_ids'] as string[]);
    const added = wanted.filter((p) => !have.has(p));
    if (added.length === 0) return [];
    if (have.size + added.length > MAX_TARGETS) throw new NotificationsValidationError(['targets']);
    await tx.query(
      `UPDATE notifications.staff_alert SET target_principal_ids = $2::uuid[] WHERE id = $1`,
      [alertId, [...have, ...added].sort()],
    );
    await this.audit(tx, 'update', alertId, (row['patient_id'] as string | null) ?? null, ctx, {
      targetsAdded: added.length,
    });
    return added;
  }

  // --- reads (own targets; RLS decides) -----------------------------------------------------------------------

  async list(
    tx: Tx,
    q: { status?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ items: AlertView[]; nextCursor: string | null }> {
    const bad: string[] = [];
    if (q.status !== undefined && !LIST_STATUS.has(q.status)) bad.push('status');
    const limit = q.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) bad.push('limit');
    let before: number | null = null;
    if (q.cursor !== undefined) {
      try {
        before = decodeCursor(q.cursor);
      } catch {
        bad.push('cursor');
      }
    }
    if (bad.length > 0) throw new NotificationsValidationError(bad);
    // `status=open` means open AND escalated (N-6): an escalated alert is not yet acknowledged.
    const statuses =
      q.status === undefined
        ? null
        : q.status === 'open' || q.status === 'escalated'
          ? q.status === 'open'
            ? ['open', 'escalated']
            : ['escalated']
          : [q.status];
    const r = await tx.query(
      `SELECT a.*, p.display_name
         FROM notifications.staff_alert a
         LEFT JOIN identity.staff_profile p ON p.principal_id = a.acknowledged_by
        WHERE $4::uuid = ANY(a.target_principal_ids)
          AND ($1::text[] IS NULL OR a.status = ANY($1::text[])) AND ($2::bigint IS NULL OR a.seq < $2::bigint)
        ORDER BY a.seq DESC LIMIT $3`,
      [statuses, before, limit + 1, this.me(tx)],
    );
    const rows = r.rows as Row[];
    const page = rows.slice(0, limit);
    return {
      items: page.map(toView),
      nextCursor:
        rows.length > limit ? encodeCursor(Number((page[page.length - 1] as Row)['seq'])) : null,
    };
  }

  /** `GET /alerts/open-ids` (passive): the caller's open and escalated alerts, in `seq` order. */
  async openIds(tx: Tx): Promise<{ items: OpenAlertId[] }> {
    const r = await tx.query(
      `SELECT id, seq, status, escalation_level, escalate_at FROM notifications.staff_alert
        WHERE $1::uuid = ANY(target_principal_ids) AND status IN ('open', 'escalated') ORDER BY seq ASC LIMIT 1000`,
      [this.me(tx)],
    );
    return {
      items: (r.rows as Row[]).map((x) => ({
        alertId: String(x['id']),
        seq: Number(x['seq']),
        status: x['status'] as AlertStatus,
        escalationLevel: Number(x['escalation_level']),
        escalatesAt: x['status'] === 'open' ? iso(x['escalate_at']) : null,
      })),
    };
  }

  /**
   * The stream's reconnect replay (32.2 point 2): the caller's open and escalated alerts with `seq > afterSeq`, in `seq` order.
   * `limit + 1` rows are read so the caller can tell that the replay would exceed `limit` (then it sends `resync`).
   */
  async replay(tx: Tx, afterSeq: number, limit: number): Promise<AlertView[]> {
    const r = await tx.query(
      `SELECT a.*, NULL::text AS display_name FROM notifications.staff_alert a
        WHERE $1::uuid = ANY(a.target_principal_ids) AND a.status IN ('open', 'escalated') AND a.seq > $2::bigint
        ORDER BY a.seq ASC LIMIT $3`,
      [this.me(tx), afterSeq, limit + 1],
    );
    return (r.rows as Row[]).map(toView);
  }

  /** One alert as the caller sees it (the stream's detail read). Undefined when it is not visible. */
  async view(tx: Tx, alertId: string): Promise<AlertView | undefined> {
    const r = await tx.query(
      `SELECT a.*, p.display_name FROM notifications.staff_alert a
         LEFT JOIN identity.staff_profile p ON p.principal_id = a.acknowledged_by
        WHERE a.id = $1 AND $2::uuid = ANY(a.target_principal_ids)`,
      [alertId, this.me(tx)],
    );
    const row = r.rows[0] as Row | undefined;
    return row === undefined ? undefined : toView(row);
  }

  /** The reads are "own targets" (29.3): RLS also lets a red flag's creator see the row, but never in a tray or a stream. */
  private me(tx: Tx): string {
    const id = tx.scope.principalId;
    if (id === undefined) throw new NotificationsNotFoundError();
    return id;
  }

  // --- internals ------------------------------------------------------------------------------------------------

  async event(
    tx: Tx,
    alertId: string,
    patientId: string | null,
    kind: 'created' | 'delivered' | 'acknowledged' | 'escalated' | 'closed',
    principalId: string | null,
  ): Promise<void> {
    const byJob = tx.scope.audience === 'system';
    await tx.query(
      `INSERT INTO notifications.staff_alert_event
         (id, organisation_id, alert_id, patient_id, kind, principal_id${byJob ? '' : ', created_by'})
       VALUES ($1, $2, $3, $4, $5, $6${byJob ? '' : ', $7'})`,
      [
        uuidv7(),
        tx.scope.orgId,
        alertId,
        patientId,
        kind,
        principalId,
        ...(byJob ? [] : [principalId]),
      ],
    );
  }

  private async audit(
    tx: Tx,
    action: 'create' | 'update',
    alertId: string,
    patientId: string | null,
    ctx: AlertContext,
    change: Record<string, unknown>,
  ): Promise<void> {
    if (this.d.audit === undefined || (ctx.requestId === undefined && ctx.jobId === undefined))
      return;
    await this.d.audit.record(tx, {
      action,
      requestId: ctx.requestId ?? null,
      jobId: ctx.jobId ?? null,
      resourceType: 'notifications.staff_alert',
      resourceId: alertId,
      patientId,
      change,
    });
  }
}
