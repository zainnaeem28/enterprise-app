// Shapes of the clinical notes (ARCHITECTURE 22.11, 23.2, 29.3). Plain data; the only import is a type.
import type { RequestMeta } from '../chart/types.js';

export type { RequestMeta };

export type EncounterStatus = 'open' | 'in_consultation' | 'completed' | 'cancelled';
export type NoteStatus = 'draft' | 'pending_cosign' | 'signed';

export interface EncounterView {
  id: string;
  patientId: string;
  locationId: string;
  reservationId: string | null;
  clinicianPrincipalId: string;
  mode: 'in_person' | 'video';
  status: EncounterStatus;
  startedAt: string | null;
  endedAt: string | null;
  noteDeferredReason: string | null;
  /** The row version: the route's ETag (`If-Match` on complete). */
  version: number;
}

/** What the sections of a note hold: plain text per section key of the note's template. */
export type NoteSections = Record<string, string>;

export interface NoteView {
  id: string;
  encounterId: string;
  patientId: string;
  authorPrincipalId: string;
  templateId: string;
  body: { sections: NoteSections };
  status: NoteStatus;
  submittedForCosignAt: string | null;
  cosignRequiredFrom: string | null;
  signedAt: string | null;
  signedBy: string | null;
  cosignedAt: string | null;
  createdAt: string;
  version: number;
}

export interface AddendumView {
  id: string;
  noteId: string;
  patientId: string;
  authorPrincipalId: string;
  body: string;
  signedAt: string;
}

/** `POST /encounters`: the encounter and which consents the start relied on (an emergency exception, when one was needed). */
export interface StartedEncounter {
  encounter: EncounterView;
  consentExceptionId: string | null;
}

/** What a read of a note rested on (decision HEAAA-286): recorded in the audit event's `change.basis`. */
export type NoteReadBasis = 'author' | 'supervisor' | 'btg' | 'assigned';

/** `GET /clinicians/{id}/notes` and `…/cosign-queue` items: no body, no photo, no contact. */
export interface NoteListItem {
  noteId: string;
  encounterId: string;
  patientId: string;
  patientBanner: { patientId: string; displayName: string; dateOfBirth: string; mrn: string };
  authorPrincipalId: string;
  authorDisplayName: string;
  status: NoteStatus;
  templateId: string;
  createdAt: string;
  updatedAt: string | null;
  submittedForCosignAt: string | null;
  rowVersion: number;
}

export interface NoteListPage {
  items: NoteListItem[];
  nextCursor: string | null;
}

/** `GET /notes/{id}`. */
export interface NoteReadView {
  id: string;
  encounterId: string;
  patientId: string;
  authorPrincipalId: string;
  templateId: string;
  status: NoteStatus;
  body: { sections: NoteSections };
  createdAt: string;
  updatedAt: string | null;
  submittedForCosignAt: string | null;
  cosignRequiredFrom: string | null;
  signedAt: string | null;
  signedBy: string | null;
  cosign: { supervisorPrincipalId: string; cosignedAt: string } | null;
  addenda: { id: string; authorPrincipalId: string; body: string; signedAt: string }[];
  rowVersion: number;
  timeZone: string;
}
