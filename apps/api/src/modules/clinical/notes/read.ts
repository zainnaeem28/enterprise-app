// The read side of the notes (decision HEAAA-286, FE10-R1-F02; ARCHITECTURE 29.3 rows 111-113, draft 8.3):
//
//   GET /clinicians/{id}/notes?status&limit&cursor   the caller's own unsigned notes (draft, pending_cosign)
//   GET /clinicians/{id}/cosign-queue?limit&cursor    the notes waiting for the caller's co-signature
//   GET /notes/{id}                                   one note, on the first read basis that applies
//
// The own-only check on `{id}` is the controller's, before any transaction. Rows are read under the caller's RLS. A read is audited on
// every allowed path (`view`, the nearest member of the closed action list of 22.2 to the decision's "read" / "list" events); a refusal
// is audited `denied` in its own transaction, with the note's resource type and ID.
import type { KernelDb, Tx } from '@ehr/kernel';
import type { AuditService } from '../../audit/index.js';
import type { AuthContext } from '../../identity/index.js';
import type { ChartAccess } from '../chart/access.js';
import type { ChartAuditPort } from '../chart/audit-port.js';
import type { BannerService } from '../chart/banner.js';
import { parseLimit } from '../chart/cursor.js';
import { isUuid } from '../chart/ids.js';
import { dateOnly, iso, isoOrNull, strOrNull } from '../frontdoor/common.js';
import type { Row } from '../frontdoor/common.js';
import { decodeCursor, encodeCursor, filterKey } from './cursor.js';
import type { CursorRoute } from './cursor.js';
import { NoteNotAssignedError, NotesNotFoundError, NotesValidationError } from './errors.js';
import { toNoteView } from './notes.js';
import type {
  NoteListItem,
  NoteListPage,
  NoteReadBasis,
  NoteReadView,
  RequestMeta,
} from './types.js';

export const LISTED_STATUSES = ['draft', 'pending_cosign'] as const;
const BTG_PERMISSION = 'audit.btg.open';
const SORT_KEY = `to_char(coalesce(n.updated_at, n.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const QUEUE_KEY = `to_char(n.submitted_for_cosign_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface NoteReadDeps {
  db: KernelDb;
  audit: ChartAuditPort;
  denied: Pick<AuditService, 'recordDenied'>;
  access: Pick<ChartAccess, 'chartRead'>;
  banner: Pick<BannerService, 'bannerFor'>;
  cursorKey: string;
  now?: () => Date;
}

const listItem = (r: Row): NoteListItem => ({
  noteId: String(r['id']),
  encounterId: String(r['encounter_id']),
  patientId: String(r['patient_id']),
  patientBanner: {
    patientId: String(r['patient_id']),
    displayName: `${strOrNull(r['given_name']) ?? ''} ${strOrNull(r['family_name']) ?? ''}`.trim(),
    dateOfBirth: r['date_of_birth'] === null ? '' : dateOnly(r['date_of_birth']),
    mrn: strOrNull(r['mrn']) ?? '',
  },
  authorPrincipalId: String(r['author_principal_id']),
  authorDisplayName: strOrNull(r['author_display_name']) ?? '',
  status: r['status'] as NoteListItem['status'],
  templateId: String(r['template_id']),
  createdAt: iso(r['created_at']),
  updatedAt: isoOrNull(r['updated_at']),
  submittedForCosignAt: isoOrNull(r['submitted_for_cosign_at']),
  rowVersion: Number(r['row_version']),
});

const LIST_SELECT = `SELECT n.id, n.encounter_id, n.patient_id, n.author_principal_id, n.status, n.template_id, n.created_at, n.updated_at,
       n.submitted_for_cosign_at, n.row_version, p.given_name, p.family_name, p.date_of_birth, p.mrn,
       sp.display_name AS author_display_name`;
const LIST_FROM = `  FROM clinical.note n
  LEFT JOIN patient.patient p ON p.id = n.patient_id
  LEFT JOIN identity.staff_profile sp ON sp.principal_id = n.author_principal_id`;

export class NoteReadService {
  private readonly now: () => Date;
  constructor(private readonly deps: NoteReadDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private principal(tx: Tx): string {
    const p = tx.scope.principalId;
    if (tx.scope.audience !== 'staff' || p === undefined || !isUuid(p))
      throw new NotesNotFoundError();
    return p.toLowerCase();
  }

  private statusFilter(raw: unknown): string[] {
    if (raw === undefined) return [...LISTED_STATUSES];
    const list = Array.isArray(raw) ? raw : [raw];
    const out = new Set<string>();
    for (const s of list) {
      if (typeof s !== 'string' || !(LISTED_STATUSES as readonly string[]).includes(s))
        throw new NotesValidationError(['status']);
      out.add(s);
    }
    if (out.size === 0) throw new NotesValidationError(['status']);
    return [...out];
  }

  private cursorOf(
    tx: Tx,
    route: CursorRoute,
    filter: string,
    raw: unknown,
  ): { k: string; i: string } | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw new NotesValidationError(['cursor']);
    const c = decodeCursor(
      this.deps.cursorKey,
      this.now(),
      { principalId: this.principal(tx), route, filter },
      raw,
    );
    if (!isUuid(c.i)) throw new NotesValidationError(['cursor']);
    return c;
  }

  private async page(
    tx: Tx,
    meta: RequestMeta,
    route: CursorRoute,
    filter: string,
    limit: number,
    rows: Row[],
  ): Promise<NoteListPage> {
    const more = rows.length > limit;
    const shown = rows.slice(0, limit);
    const last = shown[shown.length - 1];
    const items = shown.map(listItem);
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.note',
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { patientIds: [...new Set(items.map((x) => x.patientId))].slice(0, limit) },
    });
    return {
      items,
      nextCursor:
        more && last !== undefined
          ? encodeCursor(
              this.deps.cursorKey,
              this.now(),
              { principalId: this.principal(tx), route, filter },
              { k: String(last['sort_key']), i: String(last['id']) },
            )
          : null,
    };
  }

  /** `GET /clinicians/{id}/notes`: the caller's draft and pending notes, newest change first. */
  async listMine(
    tx: Tx,
    meta: RequestMeta,
    q: { status?: unknown; limit?: unknown; cursor?: unknown },
  ): Promise<NoteListPage> {
    const me = this.principal(tx);
    const statuses = this.statusFilter(q.status);
    const limit = parseLimit(q.limit);
    const filter = filterKey(statuses);
    const cur = this.cursorOf(tx, 'notes', filter, q.cursor);
    const r = await tx.query(
      `${LIST_SELECT}, ${SORT_KEY} AS sort_key
${LIST_FROM}
 WHERE n.author_principal_id = $1::uuid AND n.status = ANY($2::text[])
   AND ($3::timestamptz IS NULL OR (coalesce(n.updated_at, n.created_at), n.id) < ($3::timestamptz, $4::uuid))
 ORDER BY coalesce(n.updated_at, n.created_at) DESC, n.id DESC
 LIMIT $5::int`,
      [me, statuses, cur?.k ?? null, cur?.i ?? null, limit + 1],
    );
    return this.page(tx, meta, 'notes', filter, limit, r.rows as Row[]);
  }

  /** `GET /clinicians/{id}/cosign-queue`: the notes that wait for the caller, oldest first. */
  async cosignQueue(
    tx: Tx,
    meta: RequestMeta,
    q: { limit?: unknown; cursor?: unknown },
  ): Promise<NoteListPage> {
    const me = this.principal(tx);
    const limit = parseLimit(q.limit);
    const cur = this.cursorOf(tx, 'cosign-queue', '', q.cursor);
    const r = await tx.query(
      `${LIST_SELECT}, ${QUEUE_KEY} AS sort_key
${LIST_FROM}
 WHERE n.status = 'pending_cosign' AND n.cosign_required_from = $1::uuid
   AND ($2::timestamptz IS NULL OR (n.submitted_for_cosign_at, n.id) > ($2::timestamptz, $3::uuid))
 ORDER BY n.submitted_for_cosign_at ASC, n.id ASC
 LIMIT $4::int`,
      [me, cur?.k ?? null, cur?.i ?? null, limit + 1],
    );
    return this.page(tx, meta, 'cosign-queue', '', limit, r.rows as Row[]);
  }

  /** The first basis that applies, in the decision's order, or undefined. */
  private async basisOf(tx: Tx, ctx: AuthContext, note: Row): Promise<NoteReadBasis | undefined> {
    const me = this.principal(tx);
    if (String(note['author_principal_id']).toLowerCase() === me) return 'author';
    if (
      note['status'] === 'pending_cosign' &&
      note['cosign_required_from'] !== null &&
      String(note['cosign_required_from']).toLowerCase() === me
    )
      return 'supervisor';
    const signed = await tx.query(
      `SELECT 1 FROM clinical.note_cosign WHERE note_id = $1::uuid AND supervisor_principal_id = $2::uuid`,
      [String(note['id']), me],
    );
    if (signed.rows.length > 0) return 'supervisor';
    const patientId = String(note['patient_id']);
    if (await this.deps.access.chartRead(tx, ctx, patientId))
      return ctx.scope.btgPatientIds?.some((p) => p.toLowerCase() === patientId.toLowerCase()) ===
        true
        ? 'btg'
        : 'assigned';
    return undefined;
  }

  /** The 28.2 banner without photo, contacts or allergies: for the author and supervisor bases. */
  private async plainBanner(tx: Tx, patientId: string): Promise<Record<string, unknown>> {
    const r = await tx.query(
      `SELECT id, mrn, given_name, family_name, date_of_birth FROM patient.patient WHERE id = $1::uuid`,
      [patientId],
    );
    const p = r.rows[0] as Row | undefined;
    if (p === undefined) throw new NotesNotFoundError();
    return {
      patientId: String(p['id']),
      displayName: `${String(p['given_name'])} ${String(p['family_name'])}`.trim(),
      dateOfBirth: dateOnly(p['date_of_birth']),
      mrn: String(p['mrn']),
      allergies: null,
    };
  }

  /** `GET /notes/{id}`: one note with its co-signature and addenda, or `403 clinical.not_assigned` (audited) when no basis applies. */
  async get(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
  ): Promise<{ note: NoteReadView; patientBanner: unknown; basis: NoteReadBasis }> {
    this.principal(tx);
    if (!isUuid(id)) throw new NotesNotFoundError();
    const noteId = id.toLowerCase();
    const row = (
      await tx.query(
        `SELECT n.*, e.location_id, l.time_zone
           FROM clinical.note n
           JOIN clinical.encounter e ON e.id = n.encounter_id
           JOIN organisation.location l ON l.id = e.location_id
          WHERE n.id = $1::uuid`,
        [noteId],
      )
    ).rows[0] as Row | undefined;
    if (row === undefined) throw new NotesNotFoundError();
    const patientId = String(row['patient_id']);
    const basis = await this.basisOf(tx, ctx, row);
    if (basis === undefined) {
      await this.deps.denied.recordDenied(this.deps.db, ctx.scope, {
        requestId: meta.requestId,
        resourceType: 'clinical.note',
        resourceId: noteId,
        patientId,
        denialReason: 'forbidden',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      throw new NoteNotAssignedError(ctx.grants.has(BTG_PERMISSION));
    }
    const cosign = (
      await tx.query(
        `SELECT supervisor_principal_id, cosigned_at FROM clinical.note_cosign WHERE note_id = $1::uuid`,
        [noteId],
      )
    ).rows[0] as Row | undefined;
    const addenda = (
      await tx.query(
        `SELECT id, author_principal_id, body, signed_at FROM clinical.note_addendum WHERE note_id = $1::uuid ORDER BY signed_at, id`,
        [noteId],
      )
    ).rows as Row[];
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.note',
      resourceId: noteId,
      patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { basis },
    });
    const base = toNoteView(row);
    const patientBanner =
      basis === 'author' || basis === 'supervisor'
        ? await this.plainBanner(tx, patientId)
        : await this.deps.banner.bannerFor(tx, ctx, meta, patientId);
    if (patientBanner === undefined) throw new NotesNotFoundError();
    return {
      basis,
      patientBanner,
      note: {
        id: base.id,
        encounterId: base.encounterId,
        patientId: base.patientId,
        authorPrincipalId: base.authorPrincipalId,
        templateId: base.templateId,
        status: base.status,
        body: base.body,
        createdAt: base.createdAt,
        updatedAt: isoOrNull(row['updated_at']),
        submittedForCosignAt: base.submittedForCosignAt,
        cosignRequiredFrom: base.cosignRequiredFrom,
        signedAt: base.signedAt,
        signedBy: base.signedBy,
        cosign:
          cosign === undefined
            ? null
            : {
                supervisorPrincipalId: String(cosign['supervisor_principal_id']),
                cosignedAt: iso(cosign['cosigned_at']),
              },
        addenda: addenda.map((a) => ({
          id: String(a['id']),
          authorPrincipalId: String(a['author_principal_id']),
          body: String(a['body']),
          signedAt: iso(a['signed_at']),
        })),
        rowVersion: base.version,
        timeZone: String(row['time_zone']),
      },
    };
  }
}
