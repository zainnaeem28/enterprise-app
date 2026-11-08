import type { ScopeSettings } from '@ehr/kernel';

/** What a service method needs from the HTTP request for the audit row (the actor and scope come from the transaction). */
export interface RequestMeta {
  requestId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type ScopeLike = Readonly<ScopeSettings>;

export const SEX_AT_BIRTH = ['female', 'male', 'intersex', 'unknown'] as const;
export type SexAtBirth = (typeof SEX_AT_BIRTH)[number];

export interface Demographics {
  givenName: string;
  familyName: string;
  middleName?: string;
  dateOfBirth: string; // YYYY-MM-DD
  sexAtBirth?: SexAtBirth;
  genderIdentity?: string;
  phone?: string;
  email?: string;
  address?: Record<string, unknown>;
  stateCode: string;
  preferredLanguage?: string;
  preferredPharmacy?: Record<string, unknown>;
}

export interface RegisterInput extends Demographics {
  /** Front desk only: the match check of the caller, the acknowledgement and the registering location. */
  matchCheckId?: string;
  duplicateAcknowledged?: boolean;
  acknowledgeReason?: string;
  locationId?: string;
}

export interface MatchCandidate {
  candidateRef: string;
  strength: 'exact' | 'probable';
  matchedFields: string[];
  inScope: boolean;
  /** Present only for a candidate inside the caller's scope. */
  display?: {
    patientId: string;
    mrn: string;
    givenName: string;
    familyName: string;
    dateOfBirth: string;
  };
}

export interface MatchResult {
  matchCheckId: string;
  candidates: MatchCandidate[];
}

export interface PatientRecord {
  id: string;
  mrn: string;
  givenName: string;
  familyName: string;
  middleName: string | null;
  dateOfBirth: string;
  sexAtBirth: string | null;
  genderIdentity: string | null;
  phone: string | null;
  email: string | null;
  address: Record<string, unknown> | null;
  stateCode: string;
  preferredLanguage: string;
  photoDocumentId: string | null;
  preferredPharmacy: Record<string, unknown> | null;
  status: 'active' | 'merged';
  mergedInto: string | null;
  createdVia: 'self' | 'front_desk';
  rowVersion: number;
}

/** BR-34: name, date of birth, record number, photo. The allergy part is filled by `clinical` (28.2, BE-16); null here. */
export interface PatientBanner {
  patientId: string;
  mrn: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  photoDocumentId: string | null;
  allergySummary: null;
  merged: boolean;
}

export interface IdentityLabel {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  mrn: string;
  merged: boolean;
  survivorId?: string;
}

/** The reference kinds of `POST /admin/patient-labels` (contract) and the audit resource type each one is recorded under. */
export const LABEL_REFERENCE_KINDS = {
  audit_event: 'audit.event',
  privacy_request: 'privacy.request',
  consent: 'patient.consent',
  incident: 'privacy.incident',
} as const;
export type LabelReferenceKind = keyof typeof LABEL_REFERENCE_KINDS;

/** `POST /patients/lookup` item (draft 8.3, FE-10): the minimised projection, no contact, no sex, no photo. */
export interface PatientLookupItem {
  patientId: string;
  mrn: string;
  givenName: string;
  middleName: string | null;
  familyName: string;
  dateOfBirth: string;
}

export interface PatientLookupResult {
  items: PatientLookupItem[];
  truncated: boolean;
}
