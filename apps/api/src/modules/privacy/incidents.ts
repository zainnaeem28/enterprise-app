// The privacy and security incident register (ARCHITECTURE 22.14, 29.4; SHARED-BOUNDARIES 6.7; PRD A-16). Compliance only
// (`privacy.incident.manage`, slice key `incidents`, admin realm). An incident names the patients it touches and the audit events that
// show it (IDs only); it moves forward through open, investigating, notified, closed, and is final once closed (trigger, 1901).
// The incident has no patient column of its own, so no patient root is locked: `incident_patient` is exempt from the merge guard.
import type { Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import {
  PreconditionFailedError,
  PrivacyNotFoundError,
  PrivacyScopeError,
  PrivacyValidationError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import { SEVERITIES } from './types.js';
import type { IncidentStatus, IncidentView, RequestMeta, Severity } from './types.js';

type Row = Record<string, unknown>;

export interface IncidentDeps {
  audit: Pick<AuditService, 'record'>;
  now?: () => Date;
}

const STATUSES: readonly IncidentStatus[] = ['open', 'investigating', 'notified', 'closed'];
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

interface Link {
  patientId: string;
  auditEventIds: string[];
}

function parseLinks(v: unknown, field: string): Link[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 1000) throw new PrivacyValidationError([field]);
  const seen = new Set<string>();
  return v.map((x: unknown) => {
    const o = typeof x === 'object' && x !== null ? (x as Row) : {};
    const events = o['auditEventIds'] ?? [];
    if (
      !isUuid(o['patientId']) ||
      !Array.isArray(events) ||
      events.length > 1000 ||
      !events.every(isUuid)
    )
      throw new PrivacyValidationError([field]);
    const patientId = (o['patientId'] as string).toLowerCase();
    if (seen.has(patientId)) throw new PrivacyValidationError([field]);
    seen.add(patientId);
    return {
      patientId,
      auditEventIds: [...new Set((events as string[]).map((e) => e.toLowerCase()))],
    };
  });
}

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw new PrivacyValidationError([field]);
  const s = v.normalize('NFC').trim();
  if (s.length < 1 || Buffer.byteLength(s) > max) throw new PrivacyValidationError([field]);
  return s;
}

function when(v: unknown, field: string): Date {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v)))
    throw new PrivacyValidationError([field]);
  return new Date(v);
}

export class IncidentService {
  constructor(private readonly deps: IncidentDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private guard(tx: Tx): string {
    if (
      tx.scope.audience !== 'staff' ||
      tx.scope.realm !== 'admin_pool' ||
      tx.scope.principalId === undefined
    )
      throw new PrivacyScopeError();
    return tx.scope.principalId;
  }

  private async load(tx: Tx, ids: string[]): Promise<IncidentView[]> {
    if (ids.length === 0) return [];
    const inc = (
      await tx.query(
        `SELECT id, title, description, severity, status, discovered_at, notification_deadline, closed_at, created_at, row_version,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_text
           FROM privacy.incident WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC, id DESC`,
        [ids],
      )
    ).rows as Row[];
    const links = (
      await tx.query(
        `SELECT incident_id, patient_id, audit_event_ids FROM privacy.incident_patient WHERE incident_id = ANY($1::uuid[]) ORDER BY patient_id`,
        [ids],
      )
    ).rows as Row[];
    return inc.map((r) => ({
      id: String(r['id']),
      title: String(r['title']),
      description: String(r['description']),
      severity: r['severity'] as Severity,
      status: r['status'] as IncidentStatus,
      discoveredAt: iso(r['discovered_at']),
      notificationDeadline: isoOrNull(r['notification_deadline']),
      closedAt: isoOrNull(r['closed_at']),
      patients: links
        .filter((l) => String(l['incident_id']) === String(r['id']))
        .map((l) => ({
          patientId: String(l['patient_id']),
          auditEventIds: (l['audit_event_ids'] as string[]).map(String),
        })),
      createdAt: iso(r['created_at']),
      version: Number(r['row_version']),
    }));
  }

  /** `GET /admin/incidents`: newest first, one page after the cursor. */
  async list(
    tx: Tx,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: IncidentView[]; nextCursor: string | null }> {
    this.guard(tx);
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
    const params: unknown[] = [];
    let where = '';
    if (opts.cursor !== undefined) {
      const m = /^([0-9T:.-]+Z)\|([0-9a-f-]{36})$/.exec(
        Buffer.from(opts.cursor, 'base64url').toString('utf8'),
      );
      if (m?.[1] === undefined || m[2] === undefined || !isUuid(m[2]))
        throw new PrivacyValidationError(['cursor']);
      params.push(m[1], m[2]);
      where = 'WHERE (created_at, id) < ($1::timestamptz, $2::uuid)';
    }
    const page = (
      await tx.query(
        `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_text
           FROM privacy.incident ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
        params,
      )
    ).rows as Row[];
    const shown = page.slice(0, limit);
    const last = shown[shown.length - 1];
    return {
      items: await this.load(
        tx,
        shown.map((x) => String(x['id'])),
      ),
      nextCursor:
        page.length > limit && last !== undefined
          ? Buffer.from(`${String(last['created_text'])}|${String(last['id'])}`).toString(
              'base64url',
            )
          : null,
    };
  }

  private async addLinks(
    tx: Tx,
    incidentId: string,
    links: Link[],
    principal: string,
  ): Promise<void> {
    for (const l of links) {
      // A patient already linked gains the new events (the trigger only allows adding).
      await tx.query(
        `INSERT INTO privacy.incident_patient (incident_id, patient_id, organisation_id, audit_event_ids, created_by)
         VALUES ($1::uuid, $2::uuid, kernel.uuid1('app.org_id'), $3::uuid[], $4::uuid)
         ON CONFLICT (incident_id, patient_id) DO UPDATE
           SET audit_event_ids = ARRAY(SELECT DISTINCT e FROM unnest(privacy.incident_patient.audit_event_ids || EXCLUDED.audit_event_ids) AS e)`,
        [incidentId, l.patientId, l.auditEventIds, principal],
      );
    }
  }

  /** `POST /admin/incidents`: title, description, severity, `discoveredAt`, optional `notificationDeadline` and `patients`. */
  async create(tx: Tx, meta: RequestMeta, input: Row): Promise<IncidentView> {
    const principal = this.guard(tx);
    const title = text(input['title'], 'title', 200);
    const description = text(input['description'], 'description', 10240);
    if (!SEVERITIES.includes(input['severity'] as Severity))
      throw new PrivacyValidationError(['severity']);
    const discovered = when(input['discoveredAt'], 'discoveredAt');
    if (discovered.getTime() > this.now().getTime() + 60_000)
      throw new PrivacyValidationError(['discoveredAt']);
    const deadline =
      input['notificationDeadline'] === undefined || input['notificationDeadline'] === null
        ? null
        : when(input['notificationDeadline'], 'notificationDeadline');
    if (deadline !== null && deadline.getTime() < discovered.getTime())
      throw new PrivacyValidationError(['notificationDeadline']);
    const links = parseLinks(input['patients'], 'patients');
    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO privacy.incident (id, organisation_id, title, description, severity, status, discovered_at, notification_deadline, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2, $3, $4, 'open', $5::timestamptz, $6::timestamptz, $7::uuid)`,
        [
          id,
          title,
          description,
          input['severity'],
          discovered.toISOString(),
          deadline?.toISOString() ?? null,
          principal,
        ],
      );
      await this.addLinks(tx, id, links, principal);
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'privacy.incident',
        resourceId: id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { severity: input['severity'], patients: links.length },
      });
    } catch (e) {
      this.fk(e);
      translateDbError(e);
    }
    const v = (await this.load(tx, [id]))[0];
    if (v === undefined) throw new PrivacyNotFoundError();
    return v;
  }

  private fk(e: unknown): void {
    if ((e as { code?: unknown } | null)?.code === '23503')
      throw new PrivacyValidationError(['patients']);
  }

  /**
   * `PATCH /admin/incidents` (the catalogue names no identifier, so the body carries `id`; If-Match carries the row version): title,
   * description, severity, `status` (forward only), `notificationDeadline`, and `patients` to add (events are only ever added).
   */
  async update(
    tx: Tx,
    meta: RequestMeta,
    expectedVersion: number,
    input: Row,
  ): Promise<IncidentView> {
    const principal = this.guard(tx);
    const id = input['id'];
    if (!isUuid(id)) throw new PrivacyValidationError(['id']);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    const fields: string[] = [];
    if (input['title'] !== undefined) {
      set('title', text(input['title'], 'title', 200));
      fields.push('title');
    }
    if (input['description'] !== undefined) {
      set('description', text(input['description'], 'description', 10240));
      fields.push('description');
    }
    if (input['severity'] !== undefined) {
      if (!SEVERITIES.includes(input['severity'] as Severity))
        throw new PrivacyValidationError(['severity']);
      set('severity', input['severity']);
      fields.push('severity');
    }
    if (input['notificationDeadline'] !== undefined) {
      set(
        'notification_deadline',
        input['notificationDeadline'] === null
          ? null
          : when(input['notificationDeadline'], 'notificationDeadline').toISOString(),
        '::timestamptz',
      );
      fields.push('notificationDeadline');
    }
    if (input['status'] !== undefined) {
      if (!STATUSES.includes(input['status'] as IncidentStatus))
        throw new PrivacyValidationError(['status']);
      set('status', input['status']);
      if (input['status'] === 'closed') set('closed_at', this.now().toISOString(), '::timestamptz');
      fields.push('status');
    }
    const links = parseLinks(input['patients'], 'patients');
    if (links.length > 0) fields.push('patients');
    if (fields.length === 0) throw new PrivacyValidationError(['body']);
    try {
      const cur = (
        await tx.query(`SELECT row_version FROM privacy.incident WHERE id = $1::uuid FOR UPDATE`, [
          id,
        ])
      ).rows[0] as Row | undefined;
      if (cur === undefined) throw new PrivacyNotFoundError();
      if (Number(cur['row_version']) !== expectedVersion) throw new PreconditionFailedError();
      if (sets.length > 0)
        await tx.query(
          `UPDATE privacy.incident SET ${sets.join(', ')} WHERE id = $1::uuid`,
          params,
        );
      await this.addLinks(tx, id, links, principal);
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'privacy.incident',
        resourceId: id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { fields },
      });
    } catch (e) {
      this.fk(e);
      translateDbError(e);
    }
    const v = (await this.load(tx, [id]))[0];
    if (v === undefined) throw new PrivacyNotFoundError();
    return v;
  }
}
