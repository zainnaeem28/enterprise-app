// Merge and export participation of the documents module (ARCHITECTURE 22.7, 22.16, 24): `documents.repointPatient` and
// `documents.exportPart`. Both run in the caller's transaction (the merge transaction of 25.4, the export job) as `system` in a
// patients-scope job whose `job_patient_ids` include the IDs involved.
//
//   documents.document          R, every status: the record follows the patient (a quarantined or deleted document too)
//   documents.document_version  R, every row (TDR-02): the scan and OCR jobs still update it, so a merge during `scanning` re-points it
//                               and the job's retry resolves to the survivor and finishes there (38.2 item 11)
//   documents.deletion_request  R while `pending`, K once decided
//   documents.legal_hold        K, append-only: counted as kept and never touched; a later change is a new row with the survivor's ID
//
// No unique constraint involves the patient, so no conflict rule applies (the one-pending-request index is per document).
import { defaultRegistries } from '@ehr/kernel';
import type { ExportContributor, MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { DocumentsScopeError, DocumentsValidationError } from './errors.js';
import { isUuid } from './ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

export const DOCUMENTS_MERGE_TABLES = [
  'documents.document',
  'documents.document_version',
  'documents.deletion_request',
  'documents.legal_hold',
] as const;

export const DOCUMENTS_CONFLICT_RULES: readonly ConflictRule[] = [
  {
    table: 'documents.document',
    rule: 'No unique constraint on the patient. R in every status: the document keeps its ID and moves to the survivor',
  },
  {
    table: 'documents.document_version',
    rule: 'PK (document_id, version) does not involve the patient. R in every state (TDR-02): a version that is scanning when the merge runs is re-pointed and the retried scan job finishes it on the survivor',
  },
  {
    table: 'documents.deletion_request',
    rule: 'UQ (document_id) WHERE pending is per document, so re-pointing cannot collide. R while pending; K once decided',
  },
  { table: 'documents.legal_hold', rule: 'Append-only, all K: counted as kept, never touched' },
];

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new DocumentsScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new DocumentsScopeError();
}

const count = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

export const documentsMergeParticipant: MergeParticipant = {
  module: 'documents',
  tables: DOCUMENTS_MERGE_TABLES,
  conflictRules: DOCUMENTS_CONFLICT_RULES,
  async repointPatient(
    tx: Tx,
    mergedId: string,
    survivorId: string,
    requestId: string,
  ): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new DocumentsValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);

    // Lock first, in id order: a concurrent classify, confirm or scan write of one of these rows waits (a status change under a
    // merge would otherwise move a row between R and K after it had been counted).
    await tx.query(
      `SELECT d.id FROM documents.document d WHERE d.patient_id = $1::uuid ORDER BY d.id FOR UPDATE`,
      [mergedId],
    );
    await tx.query(
      `SELECT v.document_id FROM documents.document_version v WHERE v.patient_id = $1::uuid ORDER BY v.document_id, v.version FOR UPDATE`,
      [mergedId],
    );
    await tx.query(
      `SELECT r.id FROM documents.deletion_request r WHERE r.patient_id = $1::uuid ORDER BY r.id FOR UPDATE`,
      [mergedId],
    );

    const out: MergeCounts[] = [];

    const docs = await count(
      tx,
      `SELECT count(*)::int AS n FROM documents.document WHERE patient_id = $1::uuid`,
      [mergedId],
    );
    const docsMoved = await tx.query(
      `UPDATE documents.document SET patient_id = $2::uuid WHERE patient_id = $1::uuid`,
      [mergedId, survivorId],
    );
    out.push({
      table: 'documents.document',
      found: docs,
      repointed: docsMoved.rowCount ?? 0,
      resolved: 0,
      kept: 0,
      deleted: [],
    });

    const vers = await count(
      tx,
      `SELECT count(*)::int AS n FROM documents.document_version WHERE patient_id = $1::uuid`,
      [mergedId],
    );
    const versMoved = await tx.query(
      `UPDATE documents.document_version SET patient_id = $2::uuid WHERE patient_id = $1::uuid`,
      [mergedId, survivorId],
    );
    out.push({
      table: 'documents.document_version',
      found: vers,
      repointed: versMoved.rowCount ?? 0,
      resolved: 0,
      kept: 0,
      deleted: [],
    });

    const reqs = await count(
      tx,
      `SELECT count(*)::int AS n FROM documents.deletion_request WHERE patient_id = $1::uuid`,
      [mergedId],
    );
    const reqsKept = await count(
      tx,
      `SELECT count(*)::int AS n FROM documents.deletion_request WHERE patient_id = $1::uuid AND outcome <> 'pending'`,
      [mergedId],
    );
    const reqsMoved = await tx.query(
      `UPDATE documents.deletion_request SET patient_id = $2::uuid WHERE patient_id = $1::uuid AND outcome = 'pending'`,
      [mergedId, survivorId],
    );
    out.push({
      table: 'documents.deletion_request',
      found: reqs,
      repointed: reqsMoved.rowCount ?? 0,
      resolved: 0,
      kept: reqsKept,
      deleted: [],
    });

    const holds = await count(
      tx,
      `SELECT count(*)::int AS n FROM documents.legal_hold WHERE patient_id = $1::uuid`,
      [mergedId],
    );
    out.push({
      table: 'documents.legal_hold',
      found: holds,
      repointed: 0,
      resolved: 0,
      kept: holds,
      deleted: [],
    });

    // 22.16 step 4: no R row may be left on the merged ID, and every table's counts add up.
    const left =
      (await count(
        tx,
        `SELECT count(*)::int AS n FROM documents.document WHERE patient_id = $1::uuid`,
        [mergedId],
      )) +
      (await count(
        tx,
        `SELECT count(*)::int AS n FROM documents.document_version WHERE patient_id = $1::uuid`,
        [mergedId],
      )) +
      (await count(
        tx,
        `SELECT count(*)::int AS n FROM documents.deletion_request WHERE patient_id = $1::uuid AND outcome = 'pending'`,
        [mergedId],
      ));
    if (left !== 0)
      throw new Error('documents.repointPatient: an R row is left on the merged patient');
    for (const c of out)
      if (c.found !== c.repointed + c.kept + c.resolved)
        throw new Error(`documents.repointPatient: counts do not add up for ${c.table}`);
    return out;
  },
};

/**
 * The privacy export part (22.16, 24): metadata only. The files are fetched by the export assembler through download URLs for the
 * versions listed here, so no object key and no URL is ever stored in the package. A hold's reason is the record's own text and is
 * part of the export (it is the patient's record of how the document was treated).
 */
export const documentsExportContributor: ExportContributor = {
  module: 'documents',
  async exportPart(tx: Tx, patientIds: readonly string[]): Promise<unknown> {
    if (patientIds.some((p) => !isUuid(p))) throw new DocumentsValidationError(['patientIds']);
    const ids = [...patientIds];
    const iso = (v: unknown): string | null =>
      v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);
    const docs = await tx.query(
      `SELECT d.id, d.patient_id, d.classification, d.suggested_classification, d.status, d.upload_channel, d.uploaded_by, d.confirmed_by,
              d.confirmed_at, d.retention_until, d.deleted_at, d.created_at
         FROM documents.document d WHERE d.patient_id = ANY($1::uuid[]) ORDER BY d.created_at, d.id`,
      [ids],
    );
    const vers = await tx.query(
      `SELECT v.document_id, v.version, v.patient_id, v.content_type, v.size_bytes, v.scan_status, v.scanned_at, v.ocr_status,
              encode(v.sha256, 'hex') AS sha256, (v.scan_status = 'clean' AND v.bucket = 'clean' AND v.object_removed_at IS NULL) AS retrievable
         FROM documents.document_version v WHERE v.patient_id = ANY($1::uuid[]) ORDER BY v.document_id, v.version`,
      [ids],
    );
    const holds = await tx.query(
      `SELECT h.id, h.document_id, h.patient_id, h.action, h.reason, h.created_at FROM documents.legal_hold h
        WHERE h.patient_id = ANY($1::uuid[]) ORDER BY h.seq`,
      [ids],
    );
    const reqs = await tx.query(
      `SELECT r.id, r.document_id, r.patient_id, r.outcome, r.reason_recorded, r.decided_at, r.created_at FROM documents.deletion_request r
        WHERE r.patient_id = ANY($1::uuid[]) ORDER BY r.created_at, r.id`,
      [ids],
    );
    return {
      documents: (docs.rows as Row[]).map((x) => ({
        id: x['id'],
        patientId: x['patient_id'],
        classification: x['classification'],
        suggestedClassification: x['suggested_classification'],
        status: x['status'],
        uploadChannel: x['upload_channel'],
        uploadedByPrincipalId: x['uploaded_by'],
        confirmedByPrincipalId: x['confirmed_by'],
        confirmedAt: iso(x['confirmed_at']),
        retentionUntil:
          x['retention_until'] instanceof Date
            ? (x['retention_until'] as Date).toISOString().slice(0, 10)
            : x['retention_until'],
        deletedAt: iso(x['deleted_at']),
        createdAt: iso(x['created_at']),
      })),
      versions: (vers.rows as Row[]).map((x) => ({
        documentId: x['document_id'],
        version: x['version'],
        patientId: x['patient_id'],
        contentType: x['content_type'],
        sizeBytes: Number(x['size_bytes']),
        scanStatus: x['scan_status'],
        scannedAt: iso(x['scanned_at']),
        ocrStatus: x['ocr_status'],
        sha256: x['sha256'],
        retrievable: x['retrievable'] === true,
      })),
      legalHolds: (holds.rows as Row[]).map((x) => ({
        id: x['id'],
        documentId: x['document_id'],
        patientId: x['patient_id'],
        action: x['action'],
        reason: x['reason'],
        createdAt: iso(x['created_at']),
      })),
      deletionRequests: (reqs.rows as Row[]).map((x) => ({
        id: x['id'],
        documentId: x['document_id'],
        patientId: x['patient_id'],
        outcome: x['outcome'],
        reasonRecorded: x['reason_recorded'],
        decidedAt: iso(x['decided_at']),
        createdAt: iso(x['created_at']),
      })),
    };
  },
};

/** Registers both with the kernel registries at start-up. A second call is a RegistryError. */
export function registerDocumentsParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registries.registerMergeParticipant(documentsMergeParticipant);
  registries.registerExportContributor(documentsExportContributor);
}
