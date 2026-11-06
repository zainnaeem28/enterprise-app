// Types of the documents module (ARCHITECTURE 22.7, 25.10, 29.2, 29.3).

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

/** What a patient may declare for their own upload (22.7); staff may name any. */
export const PATIENT_UPLOAD_CLASSIFICATIONS: readonly Classification[] = [
  'insurance_card',
  'id_document',
  'patient_upload_other',
  'questionnaire_attachment',
];

/** Documents released to the patient once clean (22.7 T-PAT-OWN). */
export const PATIENT_RELEASED_CLASSIFICATIONS: readonly Classification[] = [
  'insurance_card',
  'consent',
  'patient_upload_other',
  'questionnaire_attachment',
];

export type DocumentStatus =
  'awaiting_upload' | 'scanning' | 'quarantined' | 'clean' | 'confirmed' | 'deleted';
export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error';
export type DeletionOutcome = 'pending' | 'deleted' | 'refused_legal_hold' | 'refused_retention';
export type HoldAction = 'placed' | 'released';

/** The allow list (NFR-17): what the upload URL can be issued for and what the sniffer accepts. */
export const ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};

export interface RequestMeta {
  requestId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreateUploadInput {
  patientId: string;
  contentType: string;
  sizeBytes: number;
  /** Validated and discarded: never stored, logged or put in a key. */
  fileName?: string | null;
  classification?: Classification | null;
}

export interface UploadTicket {
  documentId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

export interface DocumentView {
  id: string;
  patientId: string;
  classification: Classification;
  /** Staff only. */
  suggestedClassification: Classification | null;
  status: DocumentStatus;
  uploadChannel: 'patient' | 'staff';
  uploadedAt: string;
  confirmedAt: string | null;
  retentionUntil: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  /** Staff only. */
  onLegalHold?: boolean;
  version: number;
}

export interface DeletionRequestView {
  id: string;
  documentId: string;
  outcome: DeletionOutcome;
  reasonRecorded: string | null;
  decidedAt: string | null;
}

export interface DownloadUrl {
  url: string;
  expiresAt: string;
}
