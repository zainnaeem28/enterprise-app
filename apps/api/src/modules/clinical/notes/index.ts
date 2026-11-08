// Public surface of the clinical notes (ARCHITECTURE 24, ticket BE-17). Other modules import only from here.
// Composition, at start-up (after the chart's and the front door's, which this builds on):
//   1. define NOTES_JOBS in the API's and the worker's JobRegistry (and sync queue task types);
//   2. registerNotesParticipants() INSTEAD of registerFrontdoorParticipants(): the registry takes one clinical participant, and this
//      composes the chart's, the front door's and this ticket's parts;
//   3. API: createClinicalNotes({ db, audit, chart, consentGate: frontdoor.consentGate, identity, ports: createNotesPorts({...}) });
//      register `controllers` (after the scheduling resolvers); it registers its resolvers (`reservation-body`, `encounter`, `note`) and
//      the `authored` assignment source with the identity module;
//   4. worker: a `clinical.note_sign_reminder` handler that calls `runNoteSignReminder` (outside this ticket's paths; README).
import { defaultRegistries } from '@ehr/kernel';
import type { ParticipantRegistries, Tx } from '@ehr/kernel';
import type { ClinicalExportPart, ClinicalMergePart } from '../chart/merge.js';
import { registerFrontdoorParticipants } from '../frontdoor/index.js';
import { notesExportPart, notesMergePart } from './merge.js';
import type { NoteReminderService, ReminderOutcome } from './reminder.js';

export { createClinicalNotes } from './runtime.js';
export type { ClinicalNotes, NotesDeps } from './runtime.js';
export { createNotesPorts } from './adapters.js';
export type { NotesPortDeps } from './adapters.js';
export type {
  EventPort,
  JobPort,
  NoteAlertInput,
  NoteAlertPort,
  NotesPorts,
  ReservationInfo,
  ReservationPort,
} from './ports.js';
export { createNotesControllers, notesResolvers } from './controller.js';
export type { NotesControllerDeps } from './controller.js';
export {
  EncounterService,
  MAX_DEFER_REASON,
  MIN_DEFER_REASON,
  NOTE_SIGN_REMINDER_JOB,
  toEncounterView,
} from './encounters.js';
export {
  NOTE_SIGNED_EVENT,
  NoteService,
  SIGN_PERMISSION,
  TRAINEE_ROLE,
  toNoteView,
} from './notes.js';
export { NoteReminderService } from './reminder.js';
export type { ReminderOutcome } from './reminder.js';
export { authoredSource, registerNotesAssignmentSources } from './assignment.js';
export {
  NOTES_CONFLICT_RULES,
  NOTES_MERGE_TABLES,
  notesExportPart,
  notesMergePart,
} from './merge.js';
export { NOTES_EVENTS, NOTES_JOBS } from './jobs.js';
export { NOTE_SIGN_DEADLINE_HOURS, NOTE_SIGN_MAX_AUTH_AGE, hoursSetting } from './settings.js';
export {
  DEFAULT_TEMPLATE,
  NOTE_TEMPLATES,
  applySections,
  emptyBody,
  templateOf,
} from './templates.js';
export {
  CosignNotSupervisorError,
  NoteLockedError,
  NoteUnsignedError,
  ReauthRequiredError,
} from './errors.js';
export type {
  AddendumView,
  EncounterStatus,
  EncounterView,
  NoteSections,
  NoteStatus,
  NoteView,
  StartedEncounter,
} from './types.js';

/** What the worker's `clinical.note_sign_reminder` handler calls, in its transaction (a patients-scope system job). */
export function runNoteSignReminder(
  reminder: Pick<NoteReminderService, 'run'>,
  tx: Tx,
  payload: { encounterId?: unknown; patientId?: unknown },
): Promise<ReminderOutcome> {
  return reminder.run(tx, payload);
}

/**
 * Registers the single `clinical` merge participant and export contributor: the chart's part, the front door's, this ticket's, and
 * `extra` parts.
 */
export function registerNotesParticipants(
  registries: ParticipantRegistries = defaultRegistries,
  extra: { merge?: readonly ClinicalMergePart[]; export?: readonly ClinicalExportPart[] } = {},
): void {
  registerFrontdoorParticipants(registries, {
    merge: [notesMergePart, ...(extra.merge ?? [])],
    export: [notesExportPart, ...(extra.export ?? [])],
  });
}
