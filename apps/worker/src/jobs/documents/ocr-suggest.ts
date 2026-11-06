// `documents.ocr_suggest` (ARCHITECTURE 25.10, 33.1): the OCR classification SUGGESTION for a clean file. It decides nothing: staff
// classify and confirm. Started by `documents.await_scan` with the version already `ocr_status = pending`; resolves to the survivor
// after a merge like every patient job. A vendor that is disabled or not configured makes the suggestion `skipped` (OCR is optional,
// C-10); a vendor that keeps failing makes it `failed` after the last attempt and raises an operations alert. A suggestion outside
// the closed classification list is dropped.
import type { Tx } from '@ehr/kernel';
import { VendorRejectedError, VendorUnavailableError } from '../integration-core/index.js';
import type { VendorGateway } from '../integration-core/index.js';
import { isUuid } from './ids.js';
import type { DocumentsJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

type Row = Record<string, unknown>;

export const CLASSIFICATIONS = [
  'insurance_card',
  'id_document',
  'consent',
  'referral_letter',
  'external_record',
  'clinical_photo',
  'patient_upload_other',
  'questionnaire_attachment',
] as const;

export interface OcrDeps extends DocumentsJobDeps {
  gateway: VendorGateway;
}

export type OcrOutcome =
  'suggested' | 'no_suggestion' | 'skipped' | 'failed' | 'already_final' | 'gone';

export async function runOcrSuggest(
  deps: OcrDeps,
  payload: Record<string, unknown>,
  attempt: { number: number; max: number },
): Promise<OcrOutcome> {
  const documentId = payload['documentId'];
  const version = payload['version'];
  const patientId = payload['patientId'];
  if (!isUuid(documentId) || !Number.isInteger(version) || !isUuid(patientId))
    throw new Error('documents.ocr_suggest: bad payload');
  const v = version as number;
  let pid = patientId.toLowerCase();

  const under = async <T>(fn: (tx: Tx) => Promise<T | 'gone'>): Promise<T | 'gone'> => {
    let r = await deps.db.withScope(patientsScope(deps.orgId, [pid]), fn);
    if (r === 'gone' && deps.survivorOf !== undefined) {
      const s = (await deps.survivorOf(pid))?.toLowerCase();
      if (s !== undefined && s !== pid) {
        pid = s;
        r = await deps.db.withScope(patientsScope(deps.orgId, [pid]), fn);
      }
    }
    return r;
  };
  const setOcr = (
    status: 'skipped' | 'failed' | 'done',
    suggestion?: string,
  ): Promise<'gone' | true> =>
    under<true>(async (tx) => {
      const u = await tx.query(
        `UPDATE documents.document_version SET ocr_status = $3 WHERE document_id = $1::uuid AND version = $2 AND ocr_status IN ('pending', 'failed')`,
        [documentId, v, status],
      );
      if ((u.rowCount ?? 0) === 0) return 'gone';
      if (suggestion !== undefined)
        await tx.query(
          `UPDATE documents.document SET suggested_classification = $2 WHERE id = $1::uuid AND status = 'clean'`,
          [documentId, suggestion],
        );
      return true;
    });

  const claimed = await under<Row | 'final' | 'skip'>(async (tx) => {
    const r = (
      await tx.query(
        `SELECT d.status, v.object_key, v.bucket, v.scan_status, v.ocr_status
           FROM documents.document d JOIN documents.document_version v ON v.document_id = d.id AND v.version = $2 WHERE d.id = $1::uuid`,
        [documentId, v],
      )
    ).rows[0] as Row | undefined;
    if (r === undefined) return 'gone';
    if (r['scan_status'] !== 'clean' || r['bucket'] !== 'clean') return 'final';
    if (r['ocr_status'] !== 'pending' && r['ocr_status'] !== 'failed') return 'final';
    return r['status'] === 'clean' ? r : 'skip'; // already confirmed or deleted: a suggestion is no use any more
  });
  if (claimed === 'gone') return 'gone';
  if (claimed === 'final') return 'already_final';
  if (claimed === 'skip') {
    await setOcr('skipped');
    return 'skipped';
  }

  try {
    const res = await deps.gateway.callVendor(
      'ocr',
      'classify',
      { bucket: 'clean', key: String(claimed['object_key']) },
      {
        type: 'documents.document_version',
        id: documentId,
        idempotencyToken: `ocr_${documentId.replace(/-/g, '')}_${v}`,
      },
    );
    const t = (res.data as { documentType?: unknown } | null)?.documentType;
    const suggestion =
      typeof t === 'string' && (CLASSIFICATIONS as readonly string[]).includes(t) ? t : undefined;
    await setOcr('done', suggestion);
    return suggestion === undefined ? 'no_suggestion' : 'suggested';
  } catch (e) {
    if (e instanceof VendorUnavailableError && e.reason === 'disabled') {
      await setOcr('skipped');
      return 'skipped';
    }
    const last = attempt.number >= attempt.max;
    if (e instanceof VendorRejectedError || last) {
      await setOcr('failed');
      deps.alert?.({ kind: 'ocr_failed', documentId, version: v, patientId: pid });
      return 'failed';
    }
    throw e; // unavailable: the queue retries with back-off
  }
}
