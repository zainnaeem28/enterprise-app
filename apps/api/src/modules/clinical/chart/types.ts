// Shapes of the clinical chart (ARCHITECTURE 22.11, 28.2, 29.3). Plain data; no module imports.
export interface RequestMeta {
  requestId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type EntryStatus = 'active' | 'resolved' | 'inactive' | 'entered_in_error';
export type MedicationStatus = 'active' | 'stopped' | 'entered_in_error';
export type AllergyCategory = 'drug' | 'food' | 'environment';
export type AllergySeverity = 'mild' | 'moderate' | 'severe' | 'unknown';
export type CodeSystem = 'rxnorm' | 'snomed' | 'icd10cm' | 'loinc';

export const PROBLEM_SYSTEMS = ['snomed', 'icd10cm'] as const;
export const ALLERGY_SYSTEMS = ['rxnorm', 'snomed'] as const;
export const MEDICATION_SYSTEMS = ['rxnorm'] as const;
export const TERMINOLOGY_SYSTEMS = ['rxnorm', 'snomed', 'icd10cm', 'loinc'] as const;

export interface ProblemView {
  id: string;
  patientId: string;
  codeSystem: string | null;
  code: string | null;
  display: string;
  coded: boolean;
  status: EntryStatus;
  onsetDate: string | null;
  resolvedDate: string | null;
  recordedByPrincipalId: string;
  createdAt: string;
  version: number;
}

export interface AllergyView {
  id: string;
  patientId: string;
  codeSystem: string | null;
  code: string | null;
  display: string;
  coded: boolean;
  category: AllergyCategory;
  reaction: string | null;
  severity: AllergySeverity;
  status: EntryStatus;
  onsetDate: string | null;
  resolvedDate: string | null;
  recordedByPrincipalId: string;
  createdAt: string;
  version: number;
}

export interface MedicationView {
  id: string;
  patientId: string;
  codeSystem: 'rxnorm' | null;
  code: string | null;
  display: string;
  coded: boolean;
  doseText: string | null;
  status: MedicationStatus;
  startDate: string | null;
  endDate: string | null;
  recordedByPrincipalId: string;
  createdAt: string;
  version: number;
}

export type RangeStatus = 'in_range' | 'out_of_range' | 'no_range' | 'unit_mismatch';

/** The vital shape of `POST /check-ins/{id}/vitals` (29.3, draft 8): the same object appears in the chart summary. */
export interface VitalView {
  vitalId: string;
  loincCode: string;
  value: number | null;
  unit: string | null;
  measuredAt: string;
  rangeStatus: RangeStatus;
  rangeLow: number | null;
  rangeHigh: number | null;
  correctsId: string | null;
  enteredInError: boolean;
}

export interface VitalRangeView {
  id: string;
  loincCode: string;
  unit: string;
  sex: 'any' | 'female' | 'male';
  ageYears: { from: number; to: number | null };
  low: number | null;
  high: number | null;
  status: 'active' | 'retired';
  approvedByNote: string;
  createdAt: string;
  retiredAt: string | null;
}

export interface Concept {
  system: CodeSystem;
  code: string;
  display: string;
}

export interface AllergyBannerItem {
  allergyId: string;
  display: string;
  category: AllergyCategory;
  severity: AllergySeverity;
  coded: boolean;
}

/** `patientBanner.allergies` (28.2). */
export interface AllergySummary {
  state: 'recorded' | 'none_recorded';
  items: AllergyBannerItem[];
  moreCount: number;
  uncodedCount: number;
  lastChangedAt: string | null;
}

/** `patientBanner` (BR-34, 28.2). `allergies` is null unless the caller passes the chart-read or pre-visit guard. */
export interface PatientBannerView {
  patientId: string;
  displayName: string;
  dateOfBirth: string;
  mrn: string;
  photoUrl?: string;
  allergies: AllergySummary | null;
}
