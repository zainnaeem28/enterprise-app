// Clinical notes (ARCHITECTURE 22.11, 23.2, 29.3; PRD RA-R1-09, BR-11, BR-12; BQ-8; ST-02).
//
//   POST  /encounters/{id}/notes   a draft from a template (clinical.note.write, chart-level access)
//   PATCH /notes/{id}              autosave of the draft's sections, by its author, with If-Match
//   POST  /notes/{id}/sign         signs and LOCKS the note. Needs `clinical.note.sign` (the author, or the encounter's clinician for a
//                                  draft an assistant prepared). A trainee (role `trainee_doctor`, no sign permission) submits the
//                                  note for co-signature instead: `pending_cosign`, locked, waiting for the author's supervisor. An
//                                  assistant cannot sign. Signing needs a sign-in no older than `note_sign_max_auth_age` (BQ-8)
//   POST  /notes/{id}/cosign       the supervisor named on the note records the co-signature and releases the note (BR-12)
//   POST  /notes/{id}/addenda      a signed note changes only through an addendum (BR-11): author, time, the survivor's patient ID
//
// The service checks every rule first so the caller gets a registry code; the triggers of migration 1801 hold the same rules for any
// writer, and the policies of 1802 pin the writer. Lock order (25.2): the patient (key_share) after the reads, then the note row.
import type { Tx } from '@ehr/kernel';
import type { AuthContext } from '../../identity/index.js';
import type { ChartAccess } from '../chart/access.js';
import type { ChartAuditPort } from '../chart/audit-port.js';
import { isUuid, uuidv7 } from '../chart/ids.js';
import { iso, isoOrNull, strOrNull } from '../frontdoor/common.js';
import type { Row } from '../frontdoor/common.js';
import {
  CosignNotSupervisorError,
  InvalidTransitionError,
  NoteLockedError,
  NotesNotFoundError,
  NotesScopeError,
  NotesValidationError,
  PreconditionFailedError,
  ReauthRequiredError,
  translateDbError,
} from './errors.js';
import type { NotesPorts } from './ports.js';
import { NOTE_SIGN_MAX_AUTH_AGE, hoursSetting } from './settings.js';
import {
  DEFAULT_TEMPLATE,
  NOTE_TEMPLATES,
  applySections,
  emptyBody,
  templateOf,
} from './templates.js';
import type { AddendumView, NoteStatus, NoteView, RequestMeta } from './types.js';

export const SIGN_PERMISSION = 'clinical.note.sign';
export const TRAINEE_ROLE = 'trainee_doctor';
export const NOTE_SIGNED_EVENT = 'clinical.note_signed';
export const MAX_ADDENDUM_BYTES = 51_200;

export interface NoteDeps {
  audit: ChartAuditPort;
  access: Pick<ChartAccess, 'requireChart'>;
  ports: Pick<NotesPorts, 'events'>;
  now?: () => Date;
}

export function toNoteView(r: Row, cosignedAt: unknown = null): NoteView {
  const body = r['body'];
  const stored =
    body !== null && typeof body === 'object'
      ? ((body as { sections?: unknown }).sections as Record<string, string> | undefined)
      : undefined;
  // jsonb does not keep key order: the sections are returned in the template's order.
  const order = NOTE_TEMPLATES.find((x) => x.id === r['template_id'])?.sections ?? [];
  const sections =
    stored === undefined
      ? undefined
      : Object.fromEntries([
          ...order.filter((k) => k in stored).map((k) => [k, String(stored[k])] as const),
          ...Object.entries(stored).filter(([k]) => !order.includes(k)),
        ]);
  return {
    id: String(r['id']),
    encounterId: String(r['encounter_id']),
    patientId: String(r['patient_id']),
    authorPrincipalId: String(r['author_principal_id']),
    templateId: String(r['template_id']),
    body: { sections: sections ?? {} },
    status: r['status'] as NoteStatus,
    submittedForCosignAt: isoOrNull(r['submitted_for_cosign_at']),
    cosignRequiredFrom: strOrNull(r['cosign_required_from']),
    signedAt: isoOrNull(r['signed_at']),
    signedBy: strOrNull(r['signed_by']),
    cosignedAt: isoOrNull(cosignedAt),
    createdAt: iso(r['created_at']),
    version: Number(r['row_version']),
  };
}

const toAddendumView = (r: Row): AddendumView => ({
  id: String(r['id']),
  noteId: String(r['note_id']),
  patientId: String(r['patient_id']),
  authorPrincipalId: String(r['author_principal_id']),
  body: String(r['body']),
  signedAt: iso(r['signed_at']),
});

const staffId = (tx: Tx): string => {
  const p = tx.scope.principalId;
  if (tx.scope.audience !== 'staff' || p === undefined || !isUuid(p))
    throw new NotesNotFoundError();
  return p;
};

export class NoteService {
  private readonly now: () => Date;
  constructor(private readonly deps: NoteDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async load(tx: Tx, id: string, lock = false): Promise<Row> {
    if (!isUuid(id)) throw new NotesNotFoundError();
    const r = await tx.query(
      `SELECT * FROM clinical.note WHERE id = $1::uuid ${lock ? 'FOR UPDATE' : ''}`,
      [id.toLowerCase()],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) throw new NotesNotFoundError();
    return row;
  }

  private async cosignedAt(tx: Tx, noteId: string): Promise<unknown> {
    const r = await tx.query(
      `SELECT cosigned_at FROM clinical.note_cosign WHERE note_id = $1::uuid`,
      [noteId],
    );
    return (r.rows[0] as Row | undefined)?.['cosigned_at'] ?? null;
  }

  /** The patient the chart-level check is made for: the survivor when the note's patient was merged (9.2). */
  private async livePatient(tx: Tx, patientId: string): Promise<string> {
    const r = await tx.query(
      `SELECT final_survivor_id FROM patient.patient_merge WHERE merged_id = $1::uuid`,
      [patientId],
    );
    const s = (r.rows[0] as Row | undefined)?.['final_survivor_id'];
    return s === undefined || s === null ? patientId : String(s);
  }

  private async audit(
    tx: Tx,
    meta: RequestMeta,
    action: 'create' | 'update' | 'sign' | 'cosign' | 'addend',
    note: Row,
    resourceType: string,
    resourceId: string,
    change: Record<string, unknown>,
    patientId = String(note['patient_id']),
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action,
      resourceType,
      resourceId,
      patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change,
    });
  }

  /** The sign-in must be recent (BQ-8): `401 auth.reauth_required`, and the client signs in again and repeats the request. */
  private async requireRecentSignIn(tx: Tx, ctx: AuthContext): Promise<void> {
    const hours = await hoursSetting(tx, NOTE_SIGN_MAX_AUTH_AGE);
    const age = this.now().getTime() - ctx.session.authTime.getTime();
    if (!(age <= hours * 3_600_000)) throw new ReauthRequiredError();
  }

  /** `POST /encounters/{id}/notes` (Idem): a draft from a template, by the caller. */
  async create(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    encounterId: string,
    input: { templateId?: unknown },
  ): Promise<NoteView> {
    const principal = staffId(tx);
    if (!isUuid(encounterId)) throw new NotesNotFoundError();
    const tpl = templateOf(input.templateId === undefined ? DEFAULT_TEMPLATE : input.templateId);
    const enc = (
      await tx.query(`SELECT id, patient_id, status FROM clinical.encounter WHERE id = $1::uuid`, [
        encounterId.toLowerCase(),
      ])
    ).rows[0] as Row | undefined;
    if (enc === undefined) throw new NotesNotFoundError();
    const patientId = String(enc['patient_id']);
    await this.deps.access.requireChart(tx, ctx, meta, patientId);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const id = uuidv7();
      const r = await tx.query(
        `INSERT INTO clinical.note (id, organisation_id, encounter_id, patient_id, author_principal_id, template_id, body, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $4::uuid) RETURNING *`,
        [id, String(enc['id']), patientId, principal, tpl.id, JSON.stringify(emptyBody(tpl))],
      );
      const row = r.rows[0] as Row;
      await this.audit(tx, meta, 'create', row, 'clinical.note', id, {
        templateId: tpl.id,
        encounterId: String(enc['id']),
      });
      return toNoteView(row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `PATCH /notes/{id}` (If-Match): the autosave. Only the author, only while the note is a draft; a signed note (or one waiting for its
   * co-signature) is `409 clinical.note_locked`; a stale version is `412` (TC-CL-05) and nothing is written.
   */
  async save(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
    expectedVersion: number,
    input: { sections?: unknown },
  ): Promise<NoteView> {
    const principal = staffId(tx);
    const first = await this.load(tx, id);
    if (String(first['author_principal_id']) !== principal) throw new NotesScopeError();
    await this.deps.access.requireChart(tx, ctx, meta, String(first['patient_id']));
    try {
      await tx.lockPatients([String(first['patient_id'])], 'key_share');
      const n = await this.load(tx, id, true);
      if (n['status'] !== 'draft') throw new NoteLockedError();
      if (Number(n['row_version']) !== expectedVersion) throw new PreconditionFailedError();
      const tpl = templateOf(n['template_id']);
      const body = applySections(tpl, n['body'], input.sections);
      const r = await tx.query(
        `UPDATE clinical.note SET body = $2::jsonb WHERE id = $1::uuid RETURNING *`,
        [String(n['id']), JSON.stringify(body)],
      );
      const row = r.rows[0] as Row;
      await this.audit(tx, meta, 'update', row, 'clinical.note', String(row['id']), {
        sections: Object.keys(input.sections as Record<string, unknown>).sort(),
      });
      return toNoteView(row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST /notes/{id}/sign` (Idem, If-Match). The author with `clinical.note.sign`, or that permission's holder who is the encounter's
   * clinician, signs and locks. A trainee submits for co-signature. Everyone else (an assistant) is `403 auth.forbidden`.
   */
  async sign(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
    expectedVersion: number,
  ): Promise<NoteView> {
    const principal = staffId(tx);
    const first = await this.load(tx, id);
    const enc = (
      await tx.query(
        `SELECT clinician_principal_id, location_id FROM clinical.encounter WHERE id = $1::uuid`,
        [String(first['encounter_id'])],
      )
    ).rows[0] as Row | undefined;
    if (enc === undefined) throw new NotesNotFoundError();
    const locationId = String(enc['location_id']);
    const author = String(first['author_principal_id']);
    const isAuthor = author === principal;
    const direct =
      ctx.grants.has(SIGN_PERMISSION, locationId) &&
      (isAuthor || String(enc['clinician_principal_id']) === principal);
    const trainee =
      !direct &&
      isAuthor &&
      !ctx.grants.has(SIGN_PERMISSION, locationId) &&
      ctx.roles.some((r) => r.key === TRAINEE_ROLE);
    if (!direct && !trainee) throw new NotesScopeError();
    await this.deps.access.requireChart(tx, ctx, meta, String(first['patient_id']));
    try {
      await tx.lockPatients([String(first['patient_id'])], 'key_share');
      const n = await this.load(tx, id, true);
      if (n['status'] !== 'draft') throw new NoteLockedError();
      if (Number(n['row_version']) !== expectedVersion) throw new PreconditionFailedError();
      await this.requireRecentSignIn(tx, ctx);
      if (direct) {
        const r = await tx.query(
          `UPDATE clinical.note SET status = 'signed', signed_at = now(), signed_by = $2::uuid WHERE id = $1::uuid RETURNING *`,
          [String(n['id']), principal],
        );
        const row = r.rows[0] as Row;
        await this.audit(tx, meta, 'sign', row, 'clinical.note', String(row['id']), {
          encounterId: String(row['encounter_id']),
        });
        await this.deps.ports.events.publish(tx, NOTE_SIGNED_EVENT, {
          noteId: String(row['id']),
          encounterId: String(row['encounter_id']),
          patientId: String(row['patient_id']),
        });
        return toNoteView(row);
      }
      const sup = (
        await tx.query(
          `SELECT supervisor_principal_id FROM identity.staff_profile WHERE principal_id = $1::uuid`,
          [author],
        )
      ).rows[0] as Row | undefined;
      const supervisor = sup?.['supervisor_principal_id'];
      if (supervisor === null || supervisor === undefined)
        throw new NotesValidationError(['supervisor'], 'clinical.supervisor_missing');
      const r = await tx.query(
        `UPDATE clinical.note SET status = 'pending_cosign', submitted_for_cosign_at = now(), cosign_required_from = $2::uuid
          WHERE id = $1::uuid RETURNING *`,
        [String(n['id']), String(supervisor)],
      );
      const row = r.rows[0] as Row;
      await this.audit(tx, meta, 'update', row, 'clinical.note', String(row['id']), {
        status: 'pending_cosign',
        cosignRequiredFrom: String(supervisor),
      });
      return toNoteView(row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST /notes/{id}/cosign` (Idem): the supervisor the note waits for records the co-signature and the note is released (BR-12). Any
   * other caller (including the author) is `403 clinical.cosign_not_supervisor`. The same recent-sign-in rule as for a signature applies.
   */
  async cosign(tx: Tx, ctx: AuthContext, meta: RequestMeta, id: string): Promise<NoteView> {
    const principal = staffId(tx);
    const first = await this.load(tx, id);
    if (
      first['cosign_required_from'] === null ||
      String(first['cosign_required_from']) !== principal
    )
      throw new CosignNotSupervisorError();
    try {
      await tx.lockPatients([String(first['patient_id'])], 'key_share');
      const n = await this.load(tx, id, true);
      if (n['status'] !== 'pending_cosign') throw new InvalidTransitionError();
      await this.requireRecentSignIn(tx, ctx);
      const c = await tx.query(
        `INSERT INTO clinical.note_cosign (note_id, organisation_id, patient_id, supervisor_principal_id, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $3::uuid) RETURNING cosigned_at`,
        [String(n['id']), String(n['patient_id']), principal],
      );
      const r = await tx.query(
        `UPDATE clinical.note SET status = 'signed', signed_at = now(), signed_by = $2::uuid WHERE id = $1::uuid RETURNING *`,
        [String(n['id']), principal],
      );
      const row = r.rows[0] as Row;
      await this.audit(tx, meta, 'cosign', row, 'clinical.note', String(row['id']), {
        authorPrincipalId: String(row['author_principal_id']),
      });
      await this.deps.ports.events.publish(tx, NOTE_SIGNED_EVENT, {
        noteId: String(row['id']),
        encounterId: String(row['encounter_id']),
        patientId: String(row['patient_id']),
      });
      return toNoteView(row, (c.rows[0] as Row)['cosigned_at']);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST /notes/{id}/addenda` (Idem): the only way a signed note changes (BR-11, TC-CL-02, TC-CL-07). The addendum names its author and
   * time and carries the patient the chart now belongs to: the survivor when the note's patient was merged (9.2). The note is not touched.
   */
  async addAddendum(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    id: string,
    input: { body?: unknown },
  ): Promise<AddendumView> {
    const principal = staffId(tx);
    const text = typeof input.body === 'string' ? input.body : '';
    if (text.trim().length < 1 || Buffer.byteLength(text, 'utf8') > MAX_ADDENDUM_BYTES)
      throw new NotesValidationError(['body']);
    const n = await this.load(tx, id);
    const live = await this.livePatient(tx, String(n['patient_id']));
    await this.deps.access.requireChart(tx, ctx, meta, live);
    try {
      await tx.lockPatients([...new Set([String(n['patient_id']), live])], 'key_share');
      const cur = await this.load(tx, id, true);
      if (cur['status'] !== 'signed') throw new InvalidTransitionError();
      const aid = uuidv7();
      const r = await tx.query(
        `INSERT INTO clinical.note_addendum (id, organisation_id, note_id, patient_id, author_principal_id, body, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5, $4::uuid) RETURNING *`,
        [aid, String(cur['id']), live, principal, text],
      );
      const row = r.rows[0] as Row;
      await this.audit(
        tx,
        meta,
        'addend',
        cur,
        'clinical.note_addendum',
        aid,
        { noteId: String(cur['id']) },
        live,
      );
      return toAddendumView(row);
    } catch (e) {
      translateDbError(e);
    }
  }
}
