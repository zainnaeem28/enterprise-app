// Threads and messages (ARCHITECTURE 22.12, 29.2, 29.3; PRD RA-R1-25, F-DR-12, F-PP-09 (S)). Every method runs in the caller's scoped
// transaction, so row-level security is the second line after the route guard and the triggers of migration 2001 the third.
//
// A thread's creator becomes its owner and adds the other participants; nobody can make themselves a participant of a thread they did
// not create (the policy of thread_participant, TC-MSG-02 and 38.2 item 16, is the authority, not this file). Messages are never changed.
// Patient messaging (kind `patient`) exists only while the organisation flag `patient_messaging` is on (D-5, default off): with it off
// the patient routes answer 404 and the database refuses a patient thread.
//
// No message text goes to an audit row, an event payload, a log or a notification (BD-09): audit rows carry IDs and the thread's kind.
import type { Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import {
  MAX_ATTACHMENTS,
  MAX_BODY_BYTES,
  MAX_PARTICIPANTS,
  MAX_SUBJECT,
  TS_SQL,
  clampLimit,
  decodeCursor,
  encodeCursor,
  iso,
  isoOrNull,
  mustBePatient,
  mustBeStaff,
  onlyKeys,
  optionalUuid,
  principalOf,
  requirePatientMessaging,
  textField,
  uuidField,
  uuidList,
} from './common.js';
import type { Page, Row } from './common.js';
import {
  MessagingNotFoundError,
  MessagingScopeError,
  MessagingValidationError,
  translateDbError,
} from './errors.js';
import { InvalidTransitionError } from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { MessageView, RequestMeta, ThreadKind, ThreadView } from './types.js';

export interface ThreadDeps {
  audit: Pick<AuditService, 'record'>;
}

const THREAD_SQL = `
  SELECT t.id, t.kind, t.patient_id, t.subject, t.status, t.location_id, t.created_at, t.row_version,
         ${TS_SQL('t.created_at')} AS created_text,
         me.role AS me_role, me.last_read_at AS me_read,
         (SELECT count(*)::int FROM messaging.message m
           WHERE m.thread_id = t.id AND m.author_principal_id <> kernel.uuid1('app.principal_id')
             AND (me.last_read_at IS NULL OR m.sent_at > me.last_read_at)) AS unread
    FROM messaging.thread t
    LEFT JOIN messaging.thread_participant me
           ON me.thread_id = t.id AND me.principal_id = kernel.uuid1('app.principal_id')`;

export function toThreadView(r: Row): ThreadView {
  return {
    id: String(r['id']),
    kind: r['kind'] as ThreadKind,
    patientId: r['patient_id'] === null ? null : String(r['patient_id']),
    subject: String(r['subject']),
    status: r['status'] as 'open' | 'closed',
    locationId: r['location_id'] === null ? null : String(r['location_id']),
    createdAt: iso(r['created_at']),
    version: Number(r['row_version']),
    me:
      r['me_role'] === null || r['me_role'] === undefined
        ? null
        : { role: r['me_role'] as 'member' | 'owner', lastReadAt: isoOrNull(r['me_read']) },
    unread: Number(r['unread'] ?? 0),
  };
}

export function toMessageView(r: Row): MessageView {
  return {
    id: String(r['id']),
    threadId: String(r['thread_id']),
    authorPrincipalId: String(r['author_principal_id']),
    body: String(r['body']),
    attachmentDocumentIds: ((r['attachment_document_ids'] as string[] | null) ?? []).map(String),
    sentAt: iso(r['sent_at']),
  };
}

export class ThreadService {
  constructor(private readonly deps: ThreadDeps) {}

  /**
   * `POST /threads` (staff, `messaging.thread.staff`): body `{subject, participantIds?, patientId?, locationId?, body?}`. The caller
   * becomes the owner. A thread about a patient needs the patient in the caller's scope (or a break-the-glass grant); out of scope is 404.
   */
  async createStaff(tx: Tx, meta: RequestMeta, input: Row): Promise<ThreadView> {
    mustBeStaff(tx);
    onlyKeys(input, [
      'subject',
      'participantIds',
      'patientId',
      'locationId',
      'body',
      'attachmentDocumentIds',
    ]);
    return this.create(tx, meta, {
      kind: 'staff',
      subject: textField(input['subject'], 'subject', MAX_SUBJECT),
      patientId: optionalUuid(input['patientId'], 'patientId'),
      locationId: optionalUuid(input['locationId'], 'locationId'),
      participantIds: uuidList(input['participantIds'], 'participantIds', MAX_PARTICIPANTS),
      first: input['body'] === undefined ? null : input,
    });
  }

  /**
   * `POST /patients/{patientId}/threads` (patient, only while the flag `patient_messaging` is on; else 404): body
   * `{subject, recipientPrincipalIds, body}`. The patient owns the thread and names the staff who receive it.
   */
  async createForPatient(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    input: Row,
  ): Promise<ThreadView> {
    mustBePatient(tx);
    await requirePatientMessaging(tx);
    onlyKeys(input, ['subject', 'recipientPrincipalIds', 'body', 'attachmentDocumentIds']);
    const pid = uuidField(patientId, 'patientId');
    const own = new Set((tx.scope.patientIds ?? []).map((x) => x.toLowerCase()));
    const proxy = new Set((tx.scope.proxyPatientIds ?? []).map((x) => x.toLowerCase()));
    if (!own.has(pid) || proxy.has(pid)) throw new MessagingNotFoundError();
    const recipients = uuidList(input['recipientPrincipalIds'], 'recipientPrincipalIds', 5);
    if (recipients.length === 0) throw new MessagingValidationError(['recipientPrincipalIds']);
    if (input['body'] === undefined) throw new MessagingValidationError(['body']);
    return this.create(tx, meta, {
      kind: 'patient',
      subject: textField(input['subject'], 'subject', MAX_SUBJECT),
      patientId: pid,
      locationId: null,
      participantIds: recipients,
      first: input,
    });
  }

  private async create(
    tx: Tx,
    meta: RequestMeta,
    v: {
      kind: ThreadKind;
      subject: string;
      patientId: string | null;
      locationId: string | null;
      participantIds: string[];
      first: Row | null;
    },
  ): Promise<ThreadView> {
    const me = principalOf(tx);
    const id = uuidv7();
    if (v.locationId !== null) {
      // The location must be one of the caller's organisation (row-level security hides every other organisation's).
      const l = await tx.query(`SELECT 1 FROM organisation.location WHERE id = $1::uuid`, [
        v.locationId,
      ]);
      if (l.rows.length === 0) throw new MessagingValidationError(['locationId']);
    }
    // Validate the first message before anything is written (the whole request is one transaction either way).
    const first = v.first === null ? null : this.parseMessage(v.first);
    try {
      await tx.query(
        `INSERT INTO messaging.thread (id, organisation_id, kind, patient_id, subject, status, location_id, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2, $3::uuid, $4, 'open', $5::uuid, $6::uuid)`,
        [id, v.kind, v.patientId, v.subject, v.locationId, me],
      );
    } catch (e) {
      translateDbError(e);
    }
    try {
      await this.addParticipant(tx, id, me, 'owner');
      for (const p of new Set(v.participantIds))
        if (p !== me) await this.addParticipant(tx, id, p, 'member');
    } catch (e) {
      translateDbError(e, 'participantIds');
    }
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'create',
      resourceType: 'messaging.thread',
      resourceId: id,
      patientId: v.patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { kind: v.kind, participants: v.participantIds.length + 1 },
    });
    if (first !== null) await this.insertMessage(tx, meta, id, v.patientId, first);
    return this.get(tx, id);
  }

  private async addParticipant(
    tx: Tx,
    threadId: string,
    principalId: string,
    role: 'owner' | 'member',
  ): Promise<void> {
    // No RETURNING and no ON CONFLICT: both make PostgreSQL apply the SELECT policy, which shows a caller only their own row (22.12).
    // A caller names each principal once (create and addParticipants dedupe); a second row for the same pair is the primary key's 23505.
    await tx.query(
      `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by)
       VALUES ($1::uuid, $2::uuid, kernel.uuid1('app.org_id'), $3, $4::uuid)`,
      [threadId, principalId, role, principalOf(tx)],
    );
  }

  /**
   * Adds participants to a thread the caller owns (the owner policy, 22.12 (b)). Not a route of the catalogue: the module's service
   * surface for the staff screens of FE-12 once the route is added to the contract.
   */
  async addParticipants(
    tx: Tx,
    meta: RequestMeta,
    threadId: string,
    principalIds: readonly string[],
  ): Promise<void> {
    mustBeStaff(tx);
    const t = await this.load(tx, threadId);
    if (t.status !== 'open') throw new InvalidTransitionError();
    try {
      for (const p of new Set(principalIds))
        await this.addParticipant(tx, t.id, uuidField(p, 'participantIds'), 'member');
    } catch (e) {
      translateDbError(e, 'participantIds');
    }
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'update',
      resourceType: 'messaging.thread',
      resourceId: t.id,
      patientId: t.patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { participantsAdded: principalIds.length },
    });
  }

  /** Closes a thread (an owner only; final). */
  async close(tx: Tx, meta: RequestMeta, threadId: string): Promise<ThreadView> {
    const t = await this.load(tx, threadId);
    try {
      const u = await tx.query(
        `UPDATE messaging.thread SET status = 'closed' WHERE id = $1::uuid AND status = 'open'`,
        [t.id],
      );
      if ((u.rowCount ?? 0) !== 1) throw new InvalidTransitionError();
    } catch (e) {
      if (e instanceof InvalidTransitionError) throw e;
      translateDbError(e);
    }
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'update',
      resourceType: 'messaging.thread',
      resourceId: t.id,
      patientId: t.patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { status: 'closed' },
    });
    return this.get(tx, t.id);
  }

  private async load(tx: Tx, threadId: string): Promise<ThreadView> {
    if (!isUuid(threadId)) throw new MessagingNotFoundError();
    const r = await tx.query(`${THREAD_SQL} WHERE t.id = $1::uuid`, [threadId.toLowerCase()]);
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) throw new MessagingNotFoundError();
    return toThreadView(row);
  }

  async get(tx: Tx, threadId: string): Promise<ThreadView> {
    if (tx.scope.audience !== 'staff' && tx.scope.audience !== 'patient')
      throw new MessagingScopeError();
    return this.load(tx, threadId);
  }

  /** `GET /threads` (staff): the threads the caller created or takes part in, newest first. */
  async listStaff(
    tx: Tx,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Page<ThreadView>> {
    mustBeStaff(tx);
    return this.list(tx, `t.kind = 'staff'`, [], opts);
  }

  /** `GET /patients/{patientId}/threads` (patient, flag on; else 404): the patient's own threads. */
  async listForPatient(
    tx: Tx,
    patientId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Page<ThreadView>> {
    mustBePatient(tx);
    await requirePatientMessaging(tx);
    const pid = uuidField(patientId, 'patientId');
    const own = new Set((tx.scope.patientIds ?? []).map((x) => x.toLowerCase()));
    if (!own.has(pid)) throw new MessagingNotFoundError();
    const page = await this.list(tx, `t.kind = 'patient' AND t.patient_id = $1::uuid`, [pid], opts);
    // The patient has no route for a thread's messages (29.2 lists only the two thread routes), so each thread carries its own.
    for (const t of page.items) {
      const r = await tx.query(
        `SELECT m.id, m.thread_id, m.author_principal_id, m.body, m.attachment_document_ids, m.sent_at
           FROM messaging.message m WHERE m.thread_id = $1::uuid ORDER BY m.sent_at, m.id LIMIT 200`,
        [t.id],
      );
      t.messages = (r.rows as Row[]).map(toMessageView);
    }
    return page;
  }

  private async list(
    tx: Tx,
    where: string,
    params: unknown[],
    opts: { limit?: number; cursor?: string },
  ): Promise<Page<ThreadView>> {
    const limit = clampLimit(opts.limit);
    const cur = decodeCursor(opts.cursor);
    const p = [...params];
    let w = where;
    if (cur !== null) {
      p.push(cur.ts, cur.id);
      w += ` AND (t.created_at, t.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`;
    }
    p.push(limit + 1);
    const r = await tx.query(
      `${THREAD_SQL} WHERE ${w} ORDER BY t.created_at DESC, t.id DESC LIMIT $${p.length}`,
      p,
    );
    const rows = r.rows as Row[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toThreadView),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(String(last['created_text']), String(last['id']))
          : null,
    };
  }

  private parseMessage(input: Row): { body: string; attachments: string[] } {
    return {
      body: textField(input['body'], 'body', MAX_BODY_BYTES, MAX_BODY_BYTES),
      attachments: uuidList(
        input['attachmentDocumentIds'],
        'attachmentDocumentIds',
        MAX_ATTACHMENTS,
      ),
    };
  }

  /** `POST /threads/{id}/messages` (staff): body `{body, attachmentDocumentIds?}`. Only a participant posts, only into an open thread. */
  async post(tx: Tx, meta: RequestMeta, threadId: string, input: Row): Promise<MessageView> {
    mustBeStaff(tx);
    onlyKeys(input, ['body', 'attachmentDocumentIds']);
    const m = this.parseMessage(input);
    const t = await this.load(tx, threadId);
    if (t.kind === 'patient') await requirePatientMessaging(tx);
    return this.insertMessage(tx, meta, t.id, t.patientId, m);
  }

  private async insertMessage(
    tx: Tx,
    meta: RequestMeta,
    threadId: string,
    patientId: string | null,
    m: { body: string; attachments: string[] },
  ): Promise<MessageView> {
    const me = principalOf(tx);
    if (m.attachments.length > 0) {
      const d = await tx.query(
        `SELECT count(*)::int AS n FROM documents.document WHERE id = ANY($1::uuid[])`,
        [m.attachments],
      );
      if (Number((d.rows[0] as Row | undefined)?.['n'] ?? 0) !== m.attachments.length)
        throw new MessagingValidationError(['attachmentDocumentIds']);
    }
    const id = uuidv7();
    let row: Row | undefined;
    try {
      const r = await tx.query(
        `INSERT INTO messaging.message (id, organisation_id, thread_id, patient_id, author_principal_id, body, attachment_document_ids)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid[])
         RETURNING id, thread_id, author_principal_id, body, attachment_document_ids, sent_at`,
        [id, threadId, patientId, me, m.body, m.attachments],
      );
      row = r.rows[0] as Row | undefined;
    } catch (e) {
      translateDbError(e);
    }
    if (row === undefined) throw new MessagingNotFoundError();
    // The author has read their own message.
    await tx.query(
      `UPDATE messaging.thread_participant SET last_read_at = now() WHERE thread_id = $1::uuid AND principal_id = $2::uuid`,
      [threadId, me],
    );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'create',
      resourceType: 'messaging.message',
      resourceId: id,
      patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { threadId, attachments: m.attachments.length },
    });
    return toMessageView(row);
  }

  /**
   * `GET /threads/{id}/messages` (staff, and the patient of a patient thread through their own route): oldest first. Reading marks
   * the thread read for the caller, and a read of a thread about a patient is audited (`view`).
   */
  async messages(
    tx: Tx,
    meta: RequestMeta,
    threadId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Page<MessageView>> {
    const t = await this.load(tx, threadId);
    if (t.kind === 'patient') await requirePatientMessaging(tx);
    const limit = clampLimit(opts.limit);
    const cur = decodeCursor(opts.cursor);
    const p: unknown[] = [t.id];
    let w = 'm.thread_id = $1::uuid';
    if (cur !== null) {
      p.push(cur.ts, cur.id);
      w += ` AND (m.sent_at, m.id) > ($2::timestamptz, $3::uuid)`;
    }
    p.push(limit + 1);
    const r = await tx.query(
      `SELECT m.id, m.thread_id, m.author_principal_id, m.body, m.attachment_document_ids, m.sent_at, ${TS_SQL('m.sent_at')} AS sent_text
         FROM messaging.message m WHERE ${w} ORDER BY m.sent_at, m.id LIMIT $${p.length}`,
      p,
    );
    const rows = r.rows as Row[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    if (t.me !== null)
      await tx.query(
        `UPDATE messaging.thread_participant SET last_read_at = now() WHERE thread_id = $1::uuid AND principal_id = kernel.uuid1('app.principal_id')`,
        [t.id],
      );
    if (t.patientId !== null)
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'view',
        resourceType: 'messaging.thread',
        resourceId: t.id,
        patientId: t.patientId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
    return {
      items: page.map(toMessageView),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(String(last['sent_text']), String(last['id']))
          : null,
    };
  }
}
