// Documents as the API returns them (apps/api documents controller `docBody`): no file name, object key or hash.

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
export type Classification = (typeof CLASSIFICATIONS)[number];

/** What a patient may declare for their own upload (ARCHITECTURE 22.7); staff may name any. */
export const PATIENT_UPLOAD_CLASSIFICATIONS: readonly Classification[] = [
  'insurance_card',
  'id_document',
  'patient_upload_other',
  'questionnaire_attachment',
];

export const DOCUMENT_STATUSES = [
  'awaiting_upload',
  'scanning',
  'quarantined',
  'clean',
  'confirmed',
  'deleted',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** The upload allow list (NFR-17); the server re-checks type and content. */
export const ALLOWED_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

export interface DocumentRecord {
  id: string;
  patientId: string;
  classification: Classification;
  /** Staff only; a suggestion, never a decision. */
  suggestedClassification: Classification | null;
  status: DocumentStatus;
  uploadedAt: string;
  confirmedAt: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  onLegalHold: boolean;
  /** Row version, known only after a classify/confirm response (ETag); the list response carries none. */
  version?: number;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const isClass = (v: unknown): v is Classification =>
  typeof v === 'string' && (CLASSIFICATIONS as readonly string[]).includes(v);
const isStatus = (v: unknown): v is DocumentStatus =>
  typeof v === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(v);

/** Reads one document; anything that is not a recognisable document is refused rather than guessed. */
export function parseDocument(raw: unknown, fallbackVersion?: number): DocumentRecord | undefined {
  const d = rec(raw);
  if (typeof d['id'] !== 'string' || typeof d['patientId'] !== 'string') return undefined;
  if (!isClass(d['classification']) || !isStatus(d['status'])) return undefined;
  if (typeof d['uploadedAt'] !== 'string') return undefined;
  const version = typeof d['version'] === 'number' ? d['version'] : fallbackVersion;
  return {
    id: d['id'],
    patientId: d['patientId'],
    classification: d['classification'],
    suggestedClassification: isClass(d['suggestedClassification'])
      ? d['suggestedClassification']
      : null,
    status: d['status'],
    uploadedAt: d['uploadedAt'],
    confirmedAt: typeof d['confirmedAt'] === 'string' ? d['confirmedAt'] : null,
    contentType: typeof d['contentType'] === 'string' ? d['contentType'] : null,
    sizeBytes: typeof d['sizeBytes'] === 'number' ? d['sizeBytes'] : null,
    onLegalHold: d['onLegalHold'] === true,
    ...(version === undefined ? {} : { version }),
  };
}

/** A file can be opened only once the scan is clean (the server enforces the same, 409 `documents.not_available`). */
export const isOpenable = (status: DocumentStatus): boolean =>
  status === 'clean' || status === 'confirmed';

/** Still moving through upload or scan: the list keeps refreshing. */
export const isPending = (status: DocumentStatus): boolean =>
  status === 'awaiting_upload' || status === 'scanning';
