// Job types and events of the clinical notes (ARCHITECTURE 33.1, 24).
//
// `clinical.note_sign_reminder` runs `note_sign_deadline_hours` (G2 setting, default 24) after an encounter was completed WITHOUT a
// signed note (a recorded deferral): it raises the `note_unsigned` alert to the clinician unless a note was signed or submitted
// meanwhile (`NoteReminderService.run`). Enqueued by `EncounterService.complete` in the completing transaction (so it exists exactly
// when the encounter completed). The worker's handler (apps/worker/src/jobs/clinical) is outside this ticket's paths: see the module
// README (request to the Orchestrator); `runNoteSignReminder` is what it calls.
import type { JobType } from '@ehr/kernel';

export const NOTES_JOBS: readonly JobType[] = [
  {
    name: 'clinical.note_sign_reminder',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
];

/** Events this module publishes (24). */
export const NOTES_EVENTS = ['clinical.note_signed'] as const;
