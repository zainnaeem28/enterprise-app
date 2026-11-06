// The documents core (ARCHITECTURE 22.7, 25.10, 23.1 ST-06; PRD BR-28, BR-29). Every method runs in the caller's scoped transaction,
// so row-level security is the second line after the guard; the rules that must hold whatever calls this (a file is served only
// when scanned clean, only staff confirm, a held or retained document is never deleted) are the database's (migrations 1000-1003),
// not this code's. This code decides what to ask, in the order 25.2 requires: the patient root first (`lockPatients`), then the
// document row.
//
// No file name, no PHI and no free text reaches an object key, a URL, a log line or an audit row: the key is random, the audit row
// holds IDs and an action, and a hold's reason lives only in its own row.
import { randomBytes } from 'node:crypto';
import type { Queue, Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import type { OrganisationService } from '../organisation/index.js';
import {
  DocumentNotFoundError,
  DocumentsScopeError,
  DocumentsValidationError,
  InvalidTransitionError,
  LegalHoldError,
  NotAvailableError,
  PreconditionFailedError,
  RetentionError,
  TooLargeError,
  TypeNotAllowedError,
  UploadLimitError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { ObjectStorePort } from './ports.js';
import { ALLOWED_TYPES, CLASSIFICATIONS, PATIENT_UPLOAD_CLASSIFICATIONS } from './types.js';
import type {
  Classification,
  CreateUploadInput,
  DeletionOutcome,
  DeletionRequestView,
  DocumentStatus,
  DocumentView,
  DownloadUrl,
  HoldAction,
  RequestMeta,
  UploadTicket,
} from './types.js';

type Row = Record<string, unknown>;

export interface DocumentsDeps {
  audit: AuditService;
  organisation: Pick<OrganisationService, 'settingOrNull'>;
  store: ObjectStorePort;
  queue: Queue;
  now?: () => Date;
}

/** Upload URL lifetime (25.10) and download URL lifetime (29.2). */
export const UPLOAD_URL_SECONDS = 300;
export const DOWNLOAD_URL_SECONDS = 60;
const DEFAULT_MAX_MB = 20;
const DEFAULT_PER_DAY = 20;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const dateOrNull = (v: unknown): string | null =>
  v instanceof Date
    ? v.toISOString().slice(0, 10)
    : v === null || v === undefined
      ? null
      : String(v);

const READ_SQL = `
  SELECT d.id, d.patient_id, d.classification, d.suggested_classification, d.status, d.upload_channel, d.created_at, d.confirmed_at,
         d.retention_until, d.row_version, d.current_version, d.uploaded_by,
         v.content_type, v.size_bytes, v.scan_status, v.bucket, v.object_key,
         (SELECT h.action = 'placed' FROM documents.legal_hold h WHERE h.document_id = d.id ORDER BY h.seq DESC LIMIT 1) AS on_hold
    FROM documents.document d
    LEFT JOIN documents.document_version v ON v.document_id = d.id AND v.version = d.current_version`;

/**
 * File names are validated and discarded. Exactly one extension, and it is the one the declared type allows: `report.pdf.exe`,
 * `invoice.exe.pdf` and `scan.png` declared as a PDF are all refused (TC-DOC-03).
 */
export function fileNameAllowed(name: string, contentType: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2f || c === 0x5c) return false; // control characters and path separators
  }
  const parts = name.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === undefined) return false;
  return (ALLOWED_TYPES[contentType] ?? []).includes(parts[1].toLowerCase());
}

export class DocumentsService {
  constructor(private readonly deps: DocumentsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private principal(tx: Tx): string {
    const p = tx.scope.principalId;
    if (p === undefined) throw new DocumentsScopeError();
    return p;
  }

  private isStaff(tx: Tx): boolean {
    return tx.scope.audience === 'staff' && tx.scope.realm === 'google';
  }

  private channel(tx: Tx): 'patient' | 'staff' {
    if (tx.scope.audience === 'patient') return 'patient';
    if (this.isStaff(tx)) return 'staff';
    throw new DocumentsScopeError();
  }

  private toView(tx: Tx, r: Row): DocumentView {
    const staff = tx.scope.audience === 'staff';
    return {
      id: String(r['id']),
      patientId: String(r['patient_id']),
      classification: r['classification'] as Classification,
      suggestedClassification: staff
        ? ((r['suggested_classification'] as Classification | null) ?? null)
        : null,
      status: r['status'] as DocumentStatus,
      uploadChannel: r['upload_channel'] as 'patient' | 'staff',
      uploadedAt: iso(r['created_at']),
      confirmedAt: isoOrNull(r['confirmed_at']),
      retentionUntil: dateOrNull(r['retention_until']),
      contentType:
        r['content_type'] === null || r['content_type'] === undefined
          ? null
          : String(r['content_type']),
      sizeBytes:
        r['size_bytes'] === null || r['size_bytes'] === undefined ? null : Number(r['size_bytes']),
      ...(staff && r['on_hold'] !== null && r['on_hold'] !== undefined
        ? { onLegalHold: r['on_hold'] === true }
        : {}),
      version: Number(r['row_version']),
    };
  }

  private async row(tx: Tx, documentId: string, lock = false): Promise<Row | undefined> {
    if (!isUuid(documentId)) return undefined;
    // FOR UPDATE OF d only: the version row and the hold subquery are read, not locked.
    const r = await tx.query(`${READ_SQL} WHERE d.id = $1::uuid${lock ? ' FOR UPDATE OF d' : ''}`, [
      documentId,
    ]);
    return r.rows[0] as Row | undefined;
  }

  /** The document as the caller's RLS shows it, or undefined. */
  async get(tx: Tx, documentId: string): Promise<DocumentView | undefined> {
    const r = await this.row(tx, documentId);
    return r === undefined ? undefined : this.toView(tx, r);
  }

  async list(tx: Tx, patientId: string): Promise<DocumentView[]> {
    if (!isUuid(patientId)) throw new DocumentsValidationError(['patientId']);
    const r = await tx.query(
      `${READ_SQL} WHERE d.patient_id = $1::uuid ORDER BY d.created_at DESC, d.id DESC LIMIT 500`,
      [patientId],
    );
    return (r.rows as Row[]).map((x) => this.toView(tx, x));
  }

  // ===== upload (25.10) =============================================================================================
  /**
   * `POST /patients/{patientId}/document-uploads`: one `document` (`awaiting_upload`) and its version 1 with a random key in the
   * quarantine bucket, and a presigned PUT for exactly that key, type and length, valid five minutes.
   */
  async createUpload(tx: Tx, meta: RequestMeta, input: CreateUploadInput): Promise<UploadTicket> {
    const channel = this.channel(tx);
    const principal = this.principal(tx);
    if (!isUuid(input.patientId)) throw new DocumentsValidationError(['patientId']);
    if (typeof input.contentType !== 'string' || ALLOWED_TYPES[input.contentType] === undefined)
      throw new TypeNotAllowedError();
    if (
      input.fileName !== undefined &&
      input.fileName !== null &&
      !fileNameAllowed(input.fileName, input.contentType)
    )
      throw new TypeNotAllowedError();
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1)
      throw new DocumentsValidationError(['sizeBytes']);
    const maxMb =
      (await this.deps.organisation.settingOrNull<number>(tx, 'upload_max_mb')) ?? DEFAULT_MAX_MB;
    if (input.sizeBytes > maxMb * 1024 * 1024) throw new TooLargeError();
    let classification: Classification;
    if (channel === 'patient') {
      const c = input.classification ?? 'patient_upload_other';
      if (!PATIENT_UPLOAD_CLASSIFICATIONS.includes(c))
        throw new DocumentsValidationError(['classification']);
      classification = c;
    } else {
      if (
        input.classification === undefined ||
        input.classification === null ||
        !CLASSIFICATIONS.includes(input.classification)
      )
        throw new DocumentsValidationError(['classification']);
      classification = input.classification;
    }
    const patientId = input.patientId.toLowerCase();
    try {
      // The patient root first (25.2 rule 1): visibility (PM008 -> 404) and not merged on write (PM001).
      await tx.lockPatients([patientId], 'key_share');
      // uploads_per_day per uploader over the last 24 hours (31.1).
      const perDay =
        (await this.deps.organisation.settingOrNull<number>(tx, 'uploads_per_day')) ??
        DEFAULT_PER_DAY;
      const used = Number(
        (
          await tx.query(
            `SELECT count(*)::int AS n FROM documents.document
              WHERE uploaded_by = $1::uuid AND created_at > $2::timestamptz - interval '24 hours'`,
            [principal, this.now().toISOString()],
          )
        ).rows[0]?.['n'] ?? 0,
      );
      if (used >= perDay) throw new UploadLimitError();

      const id = uuidv7();
      const key = `q/${randomBytes(16).toString('hex')}`;
      await tx.query(
        `INSERT INTO documents.document (id, organisation_id, patient_id, classification, status, current_version, uploaded_by, upload_channel, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, 'awaiting_upload', 1, $4::uuid, $5, $4::uuid)`,
        [id, patientId, classification, principal, channel],
      );
      await tx.query(
        `INSERT INTO documents.document_version (document_id, version, organisation_id, patient_id, object_key, bucket, size_bytes, content_type, declared_content_type, created_by)
         VALUES ($1::uuid, 1, kernel.uuid1('app.org_id'), $2::uuid, $3, 'quarantine', $4::bigint, $5, $5, $6::uuid)`,
        [id, patientId, key, input.sizeBytes, input.contentType, principal],
      );
      const put = this.deps.store.presignPut(
        {
          bucket: 'quarantine',
          key,
          contentType: input.contentType,
          contentLength: input.sizeBytes,
          expiresSeconds: UPLOAD_URL_SECONDS,
        },
        this.now(),
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'documents.document',
        resourceId: id,
        patientId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      return {
        documentId: id,
        uploadUrl: put.url,
        uploadHeaders: put.headers,
        expiresAt: put.expiresAt.toISOString(),
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST /document-uploads/{id}/complete`: the status becomes `scanning` and `documents.await_scan` is queued, in the same
   * transaction. Completing twice is the same answer. The service cannot see the object (the API has no content access): the scan
   * job finds out whether the browser really uploaded anything.
   */
  async completeUpload(
    tx: Tx,
    meta: RequestMeta,
    documentId: string,
  ): Promise<{ status: 'scanning' }> {
    this.channel(tx);
    const first = await this.row(tx, documentId);
    if (first === undefined) throw new DocumentNotFoundError();
    const patientId = String(first['patient_id']);
    if (first['status'] === 'scanning') return { status: 'scanning' };
    if (first['status'] !== 'awaiting_upload') throw new InvalidTransitionError();
    try {
      await tx.lockPatients([patientId], 'key_share');
      const r = await this.row(tx, documentId, true);
      if (r === undefined) {
        // A concurrent completion changed the row under us (the patient's update policy no longer matches it): same answer.
        if ((await this.row(tx, documentId))?.['status'] === 'scanning')
          return { status: 'scanning' };
        throw new DocumentNotFoundError();
      }
      if (r['status'] === 'scanning') return { status: 'scanning' };
      if (r['status'] !== 'awaiting_upload') throw new InvalidTransitionError();
      const version = Number(r['current_version']);
      await tx.query(
        `UPDATE documents.document_version SET scan_requested_at = $3::timestamptz WHERE document_id = $1::uuid AND version = $2`,
        [documentId, version, this.now().toISOString()],
      );
      await tx.query(`UPDATE documents.document SET status = 'scanning' WHERE id = $1::uuid`, [
        documentId,
      ]);
      await this.deps.queue.enqueue(
        tx,
        'documents.await_scan',
        { documentId, version, patientId },
        { jobKey: `await_scan_${documentId}_${version}` },
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'documents.document',
        resourceId: documentId,
        patientId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { status: 'scanning' },
      });
      return { status: 'scanning' };
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== download (BR-28) =============================================================================================
  /**
   * `POST /documents/{id}/download-url`: a 60-second URL for the clean copy, audited as `download`. A document that is not clean
   * (still scanning, quarantined, deleted) has no URL for anyone: 409 documents.not_available. One the caller cannot see is 404.
   */
  async downloadUrl(tx: Tx, meta: RequestMeta, documentId: string): Promise<DownloadUrl> {
    const r = await this.row(tx, documentId);
    if (r === undefined) throw new DocumentNotFoundError();
    const servable =
      (r['status'] === 'clean' || r['status'] === 'confirmed') &&
      r['scan_status'] === 'clean' &&
      r['bucket'] === 'clean' &&
      typeof r['object_key'] === 'string';
    if (!servable) throw new NotAvailableError();
    const url = this.deps.store.presignGet(
      {
        bucket: 'clean',
        key: String(r['object_key']),
        contentType: String(r['content_type']),
        expiresSeconds: DOWNLOAD_URL_SECONDS,
      },
      this.now(),
    );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'download',
      resourceType: 'documents.document',
      resourceId: documentId,
      patientId: String(r['patient_id']),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { url: url.url, expiresAt: url.expiresAt.toISOString() };
  }

  // ===== classification and confirmation (BR-28) =======================================================================
  private expect(r: Row, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && Number(r['row_version']) !== expectedVersion)
      throw new PreconditionFailedError();
  }

  /** `PUT /documents/{id}/classification`: staff set the classification of a clean, unconfirmed document. */
  async classify(
    tx: Tx,
    meta: RequestMeta,
    documentId: string,
    input: { classification: Classification; expectedVersion?: number },
  ): Promise<DocumentView> {
    if (!this.isStaff(tx)) throw new DocumentsScopeError();
    if (!CLASSIFICATIONS.includes(input.classification))
      throw new DocumentsValidationError(['classification']);
    const first = await this.row(tx, documentId);
    if (first === undefined) throw new DocumentNotFoundError();
    const patientId = String(first['patient_id']);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const r = await this.row(tx, documentId, true);
      if (r === undefined) throw new DocumentNotFoundError();
      this.expect(r, input.expectedVersion);
      if (r['status'] !== 'clean') throw new InvalidTransitionError();
      await tx.query(`UPDATE documents.document SET classification = $2 WHERE id = $1::uuid`, [
        documentId,
        input.classification,
      ]);
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'documents.document',
        resourceId: documentId,
        patientId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { classification: input.classification },
      });
      return this.toView(tx, (await this.row(tx, documentId)) as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST /documents/{id}/confirm`: a staff member confirms the classification of a clean document; it becomes the record. The
   * retention date is set here from the `document_retention_years` setting, which has no default (D-8 and the legal period are
   * open inputs): with no value the date stays empty and every deletion request is refused for retention (fail closed).
   */
  async confirm(
    tx: Tx,
    meta: RequestMeta,
    documentId: string,
    input: { expectedVersion?: number } = {},
  ): Promise<DocumentView> {
    if (!this.isStaff(tx)) throw new DocumentsScopeError();
    const principal = this.principal(tx);
    const first = await this.row(tx, documentId);
    if (first === undefined) throw new DocumentNotFoundError();
    const patientId = String(first['patient_id']);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const r = await this.row(tx, documentId, true);
      if (r === undefined) throw new DocumentNotFoundError();
      this.expect(r, input.expectedVersion);
      if (r['status'] !== 'clean') throw new InvalidTransitionError();
      const years = await this.deps.organisation.settingOrNull<number>(
        tx,
        'document_retention_years',
      );
      const now = this.now();
      const retention =
        typeof years === 'number' && Number.isInteger(years) && years >= 1
          ? new Date(Date.UTC(now.getUTCFullYear() + years, now.getUTCMonth(), now.getUTCDate()))
              .toISOString()
              .slice(0, 10)
          : null;
      await tx.query(
        `UPDATE documents.document SET status = 'confirmed', confirmed_by = $2::uuid, confirmed_at = $3::timestamptz, retention_until = $4::date WHERE id = $1::uuid`,
        [documentId, principal, now.toISOString(), retention],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'documents.document',
        resourceId: documentId,
        patientId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { status: 'confirmed' },
      });
      return this.toView(tx, (await this.row(tx, documentId)) as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== legal holds (BR-29) ===========================================================================================
  /** `POST /documents/{id}/legal-holds`: a new append-only row (`placed` or `released`) with the reason. Never an update. */
  async setLegalHold(
    tx: Tx,
    meta: RequestMeta,
    documentId: string,
    input: { action: HoldAction; reason: string },
  ): Promise<{ id: string; action: HoldAction }> {
    if (!this.isStaff(tx)) throw new DocumentsScopeError();
    const principal = this.principal(tx);
    const person = tx.scope.personId;
    if (person === undefined) throw new DocumentsScopeError();
    if (input.action !== 'placed' && input.action !== 'released')
      throw new DocumentsValidationError(['action']);
    if (
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 10 ||
      input.reason.length > 500
    )
      throw new DocumentsValidationError(['reason']);
    const first = await this.row(tx, documentId);
    if (first === undefined) throw new DocumentNotFoundError();
    const patientId = String(first['patient_id']);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const r = await this.row(tx, documentId, true);
      if (r === undefined) throw new DocumentNotFoundError();
      const id = uuidv7();
      // The row carries the document's CURRENT patient (a merge may have re-pointed it): the hold follows the record (SBR-16).
      await tx.query(
        `INSERT INTO documents.legal_hold (id, organisation_id, document_id, patient_id, action, reason, by_person_id, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid)`,
        [
          id,
          documentId,
          String(r['patient_id']),
          input.action,
          input.reason.trim(),
          person,
          principal,
        ],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'documents.legal_hold',
        resourceId: id,
        patientId: String(r['patient_id']),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { action: input.action, documentId },
      });
      return { id, action: input.action };
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== deletion (BR-29, AC-31) =======================================================================================
  private deletionView(r: Row): DeletionRequestView {
    return {
      id: String(r['id']),
      documentId: String(r['document_id']),
      outcome: r['outcome'] as DeletionOutcome,
      reasonRecorded: r['reason_recorded'] === null ? null : String(r['reason_recorded']),
      decidedAt: isoOrNull(r['decided_at']),
    };
  }

  /**
   * `POST /documents/{id}/deletion-requests`: records the request. If a legal hold is in force the request is recorded as
   * `refused_legal_hold` with the reason, and so for a retention period that has not ended; the caller is then told 409 with the
   * recorded request. Otherwise it stays `pending` until a holder of `documents.deletion.decide` decides it. The refusal is
   * written and committed (the controller answers 409 after the transaction), never rolled back with the answer.
   */
  async requestDeletion(
    tx: Tx,
    meta: RequestMeta,
    documentId: string,
  ): Promise<DeletionRequestView> {
    this.channel(tx);
    const principal = this.principal(tx);
    const first = await this.row(tx, documentId);
    if (first === undefined) throw new DocumentNotFoundError();
    const patientId = String(first['patient_id']);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const r = await this.row(tx, documentId, true);
      if (r === undefined) throw new DocumentNotFoundError();
      if (r['status'] !== 'confirmed') throw new InvalidTransitionError();
      const blocker = await this.blocker(tx, documentId);
      const id = uuidv7();
      const outcome: DeletionOutcome =
        blocker === 'legal_hold'
          ? 'refused_legal_hold'
          : blocker === 'retention'
            ? 'refused_retention'
            : 'pending';
      await tx.query(
        `INSERT INTO documents.deletion_request (id, organisation_id, document_id, patient_id, requested_by, outcome, reason_recorded, decided_at, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5, $6, CASE WHEN $5 = 'pending' THEN NULL ELSE $7::timestamptz END, $4::uuid)`,
        [
          id,
          documentId,
          String(r['patient_id']),
          principal,
          outcome,
          blocker,
          this.now().toISOString(),
        ],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'documents.deletion_request',
        resourceId: id,
        patientId: String(r['patient_id']),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { outcome, documentId },
      });
      return {
        id,
        documentId,
        outcome,
        reasonRecorded: blocker,
        decidedAt: blocker === null ? null : this.now().toISOString(),
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  private async blocker(tx: Tx, documentId: string): Promise<'legal_hold' | 'retention' | null> {
    const b = (await tx.query(`SELECT documents.deletion_blockers($1::uuid) AS b`, [documentId]))
      .rows[0]?.['b'];
    return b === 'legal_hold' || b === 'retention' ? b : null;
  }

  /**
   * `POST /deletion-requests/{id}/decide`: a holder of `documents.deletion.decide` applies the request. The checks run again under
   * the document's lock (a hold may have been placed since the request): a hold or an open retention period records the refusal
   * and the result is the refusal; otherwise the document is `deleted` (the record stays; the object is removed by the sweep).
   */
  async decideDeletion(tx: Tx, meta: RequestMeta, requestId: string): Promise<DeletionRequestView> {
    if (!this.isStaff(tx)) throw new DocumentsScopeError();
    const principal = this.principal(tx);
    if (!isUuid(requestId)) throw new DocumentNotFoundError();
    const req0 = (
      await tx.query(`SELECT * FROM documents.deletion_request WHERE id = $1::uuid`, [requestId])
    ).rows[0] as Row | undefined;
    if (req0 === undefined) throw new DocumentNotFoundError();
    if (req0['outcome'] !== 'pending') return this.deletionView(req0); // a decided request is kept: the same answer again
    try {
      await tx.lockPatients([String(req0['patient_id'])], 'key_share');
      const doc = await this.row(tx, String(req0['document_id']), true);
      if (doc === undefined) throw new DocumentNotFoundError();
      const req = (
        await tx.query(`SELECT * FROM documents.deletion_request WHERE id = $1::uuid FOR UPDATE`, [
          requestId,
        ])
      ).rows[0] as Row | undefined;
      if (req === undefined) {
        // Decided by someone else while we waited (the update policy only matches pending rows): the same answer.
        const done = (
          await tx.query(`SELECT * FROM documents.deletion_request WHERE id = $1::uuid`, [
            requestId,
          ])
        ).rows[0] as Row | undefined;
        if (done === undefined) throw new DocumentNotFoundError();
        return this.deletionView(done);
      }
      if (req['outcome'] !== 'pending') return this.deletionView(req);
      const patientId = String(doc['patient_id']);
      const blocker = await this.blocker(tx, String(doc['id']));
      const now = this.now().toISOString();
      if (doc['status'] !== 'confirmed') throw new InvalidTransitionError();
      let outcome: DeletionOutcome;
      if (blocker === null) {
        outcome = 'deleted';
        // The request is decided first: the document's trigger requires a request decided `deleted`.
        await tx.query(
          `UPDATE documents.deletion_request SET outcome = 'deleted', decided_at = $2::timestamptz, decided_by = $3::uuid WHERE id = $1::uuid`,
          [requestId, now, principal],
        );
        await tx.query(
          `UPDATE documents.document SET status = 'deleted', deleted_at = $2::timestamptz WHERE id = $1::uuid`,
          [String(doc['id']), now],
        );
      } else {
        outcome = blocker === 'legal_hold' ? 'refused_legal_hold' : 'refused_retention';
        await tx.query(
          `UPDATE documents.deletion_request SET outcome = $2, reason_recorded = $3, decided_at = $4::timestamptz, decided_by = $5::uuid WHERE id = $1::uuid`,
          [requestId, outcome, blocker, now, principal],
        );
      }
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'documents.deletion_request',
        resourceId: requestId,
        patientId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { outcome, documentId: String(doc['id']) },
      });
      return {
        id: requestId,
        documentId: String(doc['id']),
        outcome,
        reasonRecorded: blocker,
        decidedAt: now,
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== for other modules ===============================================================================================
  /**
   * `documents.attachToPatient` (24): the check other modules make before they store a document reference (insurance card front
   * and back, a consent signature, a referral letter): the document is visible to the caller, belongs to that patient, and is clean
   * or confirmed. It returns nothing the caller could not read; otherwise 404 (not visible or another patient's) or 409
   * documents.not_available. It does not move the document: the reference is the other module's row.
   */
  async attachToPatient(
    tx: Tx,
    documentId: string,
    patientId: string,
  ): Promise<{ documentId: string; status: DocumentStatus }> {
    if (!isUuid(patientId)) throw new DocumentsValidationError(['patientId']);
    const r = await this.row(tx, documentId);
    if (r === undefined || String(r['patient_id']).toLowerCase() !== patientId.toLowerCase())
      throw new DocumentNotFoundError();
    if (r['status'] !== 'clean' && r['status'] !== 'confirmed') throw new NotAvailableError();
    return { documentId, status: r['status'] as DocumentStatus };
  }
}

export { LegalHoldError, RetentionError };
