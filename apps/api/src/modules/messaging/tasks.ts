// Tasks (ARCHITECTURE 22.12, 29.3; PRD RA-R1-25, F-DR-12). A task is assigned to a staff principal or to a role at a location, is seen by
// its creator and its assignee (row-level security; for a role-at-location task the ROLE is checked here, because the scope settings
// carry no roles), and only moves open -> done / cancelled (the trigger of migration 2001). Tasks that events create (a privacy
// correction request) are written by `corrections.ts` under the job's identity.
import type { Queue, Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import {
  MAX_DETAIL_BYTES,
  MAX_TITLE,
  TS_SQL,
  clampLimit,
  decodeCursor,
  encodeCursor,
  iso,
  isoOrNull,
  mustBeStaff,
  onlyKeys,
  optionalUuid,
  principalOf,
  textField,
  uuidField,
} from './common.js';
import type { Page, Row } from './common.js';
import {
  InvalidTransitionError,
  MessagingNotFoundError,
  MessagingScopeError,
  MessagingValidationError,
  PreconditionFailedError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { CallerRoles, RequestMeta, TaskSource, TaskStatus, TaskView } from './types.js';

export const TASK_CREATED_EVENT = 'messaging.task_created';

export interface TaskDeps {
  audit: Pick<AuditService, 'record'>;
  queue: Queue;
}

const TASK_COLS = `t.id, t.patient_id, t.title, t.detail, t.assignee_kind, t.assignee_principal_id, t.assignee_role_key,
  t.assignee_location_id, t.status, t.due_at, t.source, t.completed_at, t.created_at, t.created_by, t.row_version`;

export function toTaskView(r: Row): TaskView {
  return {
    id: String(r['id']),
    patientId: r['patient_id'] === null ? null : String(r['patient_id']),
    title: String(r['title']),
    detail: r['detail'] === null ? null : String(r['detail']),
    assignee:
      r['assignee_kind'] === 'principal'
        ? { kind: 'principal', principalId: String(r['assignee_principal_id']) }
        : {
            kind: 'role_location',
            roleKey: String(r['assignee_role_key']),
            locationId: String(r['assignee_location_id']),
          },
    status: r['status'] as TaskStatus,
    dueAt: isoOrNull(r['due_at']),
    source: r['source'] as TaskSource,
    completedAt: isoOrNull(r['completed_at']),
    createdAt: iso(r['created_at']),
    version: Number(r['row_version']),
  };
}

/** Does the caller hold `roleKey` at `locationId` (a role without a location holds everywhere)? */
const holdsRole = (c: CallerRoles, roleKey: string, locationId: string): boolean =>
  c.roles.some(
    (r) => r.key === roleKey && (r.locationId === undefined || r.locationId === locationId),
  );

function parseDue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d\d-\d\dT/.test(v))
    throw new MessagingValidationError(['dueAt']);
  return new Date(v).toISOString();
}

export class TaskService {
  constructor(private readonly deps: TaskDeps) {}

  /**
   * `POST /tasks` (`messaging.task.manage`): body `{title, detail?, patientId?, dueAt?, assignee}` with `assignee` either
   * `{principalId}` or `{roleKey, locationId}`. A task about a patient needs the patient in the caller's scope (404 otherwise);
   * an assignee outside the caller's organisation is refused (TC-MSG-02).
   */
  async create(tx: Tx, meta: RequestMeta, input: Row): Promise<TaskView> {
    mustBeStaff(tx);
    onlyKeys(input, ['title', 'detail', 'patientId', 'dueAt', 'assignee']);
    const me = principalOf(tx);
    const title = textField(input['title'], 'title', MAX_TITLE);
    const detail =
      input['detail'] === undefined || input['detail'] === null
        ? null
        : textField(input['detail'], 'detail', MAX_DETAIL_BYTES, MAX_DETAIL_BYTES);
    const patientId = optionalUuid(input['patientId'], 'patientId');
    const dueAt = parseDue(input['dueAt']);
    const a = input['assignee'];
    if (a === null || typeof a !== 'object' || Array.isArray(a))
      throw new MessagingValidationError(['assignee']);
    const ao = a as Row;
    let kind: 'principal' | 'role_location';
    let principalId: string | null = null;
    let roleKey: string | null = null;
    let locationId: string | null = null;
    if (ao['principalId'] !== undefined) {
      onlyKeys(ao, ['principalId']);
      kind = 'principal';
      principalId = uuidField(ao['principalId'], 'assignee/principalId');
    } else {
      onlyKeys(ao, ['roleKey', 'locationId']);
      kind = 'role_location';
      roleKey = textField(ao['roleKey'], 'assignee/roleKey', 61);
      if (!/^[a-z][a-z0-9_]{0,60}$/.test(roleKey))
        throw new MessagingValidationError(['assignee/roleKey']);
      locationId = uuidField(ao['locationId'], 'assignee/locationId');
    }
    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO messaging.task (id, organisation_id, patient_id, title, detail, assignee_kind, assignee_principal_id, assignee_role_key,
                                     assignee_location_id, due_at, source, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, $5, $6::uuid, $7, $8::uuid, $9::timestamptz, 'manual', $10::uuid)`,
        [id, patientId, title, detail, kind, principalId, roleKey, locationId, dueAt, me],
      );
    } catch (e) {
      translateDbError(e, 'assignee');
    }
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'create',
      resourceType: 'messaging.task',
      resourceId: id,
      patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { assignee: kind, source: 'manual' },
    });
    // IDs only (BD-09): no title, no detail.
    await this.deps.queue.publish(tx, TASK_CREATED_EVENT, { taskId: id, patientId });
    return this.get(tx, id);
  }

  async get(tx: Tx, id: string): Promise<TaskView> {
    mustBeStaff(tx);
    if (!isUuid(id)) throw new MessagingNotFoundError();
    const r = await tx.query(`SELECT ${TASK_COLS} FROM messaging.task t WHERE t.id = $1::uuid`, [
      id.toLowerCase(),
    ]);
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) throw new MessagingNotFoundError();
    return toTaskView(row);
  }

  /**
   * `GET /tasks` (`messaging.task.manage`): tasks assigned to the caller, created by them, or assigned to a role they hold at a location.
   * `?status=` filters (default: open first).
   */
  async list(
    tx: Tx,
    who: CallerRoles,
    opts: { status?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<TaskView>> {
    mustBeStaff(tx);
    const me = principalOf(tx);
    const limit = clampLimit(opts.limit);
    const pairs = who.roles
      .filter((r) => r.locationId !== undefined)
      .map((r) => `${r.key}@${r.locationId}`);
    const global = who.roles.filter((r) => r.locationId === undefined).map((r) => r.key);
    const p: unknown[] = [me, pairs, global];
    let w = `(t.assignee_principal_id = $1::uuid OR t.created_by = $1::uuid
              OR (t.assignee_kind = 'role_location' AND (t.assignee_role_key || '@' || t.assignee_location_id::text = ANY($2::text[]) OR t.assignee_role_key = ANY($3::text[]))))`;
    if (opts.status !== undefined) {
      if (!['open', 'done', 'cancelled'].includes(opts.status))
        throw new MessagingValidationError(['status']);
      p.push(opts.status);
      w += ` AND t.status = $${p.length}`;
    }
    const cur = decodeCursor(opts.cursor);
    if (cur !== null) {
      p.push(cur.ts, cur.id);
      w += ` AND (t.created_at, t.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`;
    }
    p.push(limit + 1);
    const r = await tx.query(
      `SELECT ${TASK_COLS}, ${TS_SQL('t.created_at')} AS created_text FROM messaging.task t WHERE ${w} ORDER BY t.created_at DESC, t.id DESC LIMIT $${p.length}`,
      p,
    );
    const rows = r.rows as Row[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toTaskView),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(String(last['created_text']), String(last['id']))
          : null,
    };
  }

  /**
   * `PATCH /tasks/{id}` (`messaging.task.manage`, If-Match): body `{status: 'done' | 'cancelled'}` to complete (the assignee, a holder of
   * the assigned role at its location, or the creator) or cancel (the creator), or `{title?, detail?, dueAt?}` to edit an open task
   * (the creator). One kind of change per request.
   */
  async patch(
    tx: Tx,
    meta: RequestMeta,
    who: CallerRoles,
    id: string,
    version: number,
    input: Row,
  ): Promise<TaskView> {
    mustBeStaff(tx);
    onlyKeys(input, ['status', 'title', 'detail', 'dueAt']);
    const me = principalOf(tx);
    const cur = await this.get(tx, id);
    if (cur.version !== version) throw new PreconditionFailedError();
    if (cur.status !== 'open') throw new InvalidTransitionError();
    const creatorRow = await tx.query(`SELECT created_by FROM messaging.task WHERE id = $1::uuid`, [
      cur.id,
    ]);
    const isCreator = (creatorRow.rows[0] as Row | undefined)?.['created_by'] === me;
    const isAssignee =
      cur.assignee.kind === 'principal'
        ? cur.assignee.principalId === me
        : holdsRole(who, cur.assignee.roleKey, cur.assignee.locationId);

    // The policy shows a role-at-location task to every member of staff at the location; the service shows it to the role's holders only.
    if (!isCreator && !isAssignee) throw new MessagingNotFoundError();
    let change: Record<string, unknown>;
    if (input['status'] !== undefined) {
      if (Object.keys(input).length !== 1) throw new MessagingValidationError(['status']);
      const to = input['status'];
      if (to !== 'done' && to !== 'cancelled') throw new MessagingValidationError(['status']);
      if (to === 'done' ? !(isCreator || isAssignee) : !isCreator) throw new MessagingScopeError();
      try {
        const u = await tx.query(
          `UPDATE messaging.task SET status = $3, completed_at = now(), completed_by = $4::uuid WHERE id = $1::uuid AND row_version = $2::bigint`,
          [cur.id, version, to, me],
        );
        if ((u.rowCount ?? 0) !== 1) throw new PreconditionFailedError();
      } catch (e) {
        if (e instanceof PreconditionFailedError) throw e;
        translateDbError(e);
      }
      change = { status: to };
    } else {
      if (Object.keys(input).length === 0) throw new MessagingValidationError(['body']);
      if (!isCreator) throw new MessagingScopeError();
      const title =
        input['title'] === undefined ? cur.title : textField(input['title'], 'title', MAX_TITLE);
      const detail =
        input['detail'] === undefined
          ? cur.detail
          : input['detail'] === null
            ? null
            : textField(input['detail'], 'detail', MAX_DETAIL_BYTES, MAX_DETAIL_BYTES);
      const due = input['dueAt'] === undefined ? cur.dueAt : parseDue(input['dueAt']);
      try {
        const u = await tx.query(
          `UPDATE messaging.task SET title = $3, detail = $4, due_at = $5::timestamptz WHERE id = $1::uuid AND row_version = $2::bigint`,
          [cur.id, version, title, detail, due],
        );
        if ((u.rowCount ?? 0) !== 1) throw new PreconditionFailedError();
      } catch (e) {
        if (e instanceof PreconditionFailedError) throw e;
        translateDbError(e);
      }
      change = { edited: Object.keys(input) };
    }
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'update',
      resourceType: 'messaging.task',
      resourceId: cur.id,
      patientId: cur.patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change,
    });
    return this.get(tx, cur.id);
  }
}
