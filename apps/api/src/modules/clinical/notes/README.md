# Clinical notes (BE-17)

Encounters (start, complete), SOAP notes (draft, autosave, sign and lock), addenda, trainee co-signature, the unsigned-note reminder,
and the merge / export participation of these tables. Migrations `1800`-`1802`. ARCHITECTURE 22.11, 22.16, 23.2, 24, 25.5, 29.3, 33.1;
BQ-8; PRD RA-R1-09, BR-09, BR-11, BR-12; TC-CL-01..07.

## Routes (ARCHITECTURE 29.3)

| Route                            | Permission (resolver)                                | Notes                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /encounters`               | `clinical.consultation.start` (body `reservationId`) | Idem. Consent gate (BE-18's `ConsentGateService`), encounter row, occupancy `checked_in -> in_consultation`, one transaction. `409 clinical.consents_missing`, or `emergencyException.reason` records one exception |
| `POST /encounters/{id}/complete` | `clinical.consultation.start` (`encounter`)          | Idem, If-Match. `409 clinical.note_unsigned` unless a note is signed / submitted for co-signature or `deferNoteReason` is given                                                                                     |
| `POST /encounters/{id}/notes`    | `clinical.note.write` (`encounter`)                  | Idem. Draft from template `soap`                                                                                                                                                                                    |
| `PATCH /notes/{id}`              | `clinical.note.write` (`note`)                       | If-Match (`428` / `412`). Author only, draft only; `409 clinical.note_locked`                                                                                                                                       |
| `POST /notes/{id}/sign`          | `clinical.note.write` (`note`)                       | Idem, If-Match. See "Signing"                                                                                                                                                                                       |
| `POST /notes/{id}/cosign`        | `clinical.note.cosign` (`note`)                      | Idem. `403 clinical.cosign_not_supervisor`                                                                                                                                                                          |
| `POST /notes/{id}/addenda`       | `clinical.note.write` (`note`)                       | Idem. `{body}` text only                                                                                                                                                                                            |

Every response carries `patientBanner` (x-banner). The module also registers the `authored` assignment source (27.4).

## Signing

`sign` is declared with the write permission because a trainee has no `clinical.note.sign` (27.3) and still submits.

- **Signs and locks** when the caller holds `clinical.note.sign` at the encounter's place and is the author or the encounter's clinician
  (a doctor signs the draft an assistant prepared). `signed_by` = the signer.
- **Submits for co-signature** (`pending_cosign`, locked) when the caller is the author, holds role `trainee_doctor` and no sign
  permission. `cosign_required_from` = the author's `staff_profile.supervisor_principal_id` (`422` if there is none).
- **Refused `403 auth.forbidden`** for everyone else (an assistant, another doctor).
- **`401 auth.reauth_required`** when the session's `auth_time` is older than `note_sign_max_auth_age` (setting, default 12 h, BQ-8). The
  client signs in again and repeats the request with the same idempotency key. The same check guards the co-signature.
- The supervisor named on the note records the co-signature (`note_cosign` row, then the note becomes `signed` with
  `signed_by` = supervisor; `author_principal_id` keeps the author). The author or any other doctor gets `403 clinical.cosign_not_supervisor`.

The database holds the same rules for any writer (migration 1801): a signed note accepts no update or delete from any role (not even the
owner); content changes only in a draft and only by its author; `draft -> signed` needs the signer to hold `clinical.note.sign` (so an
assistant is refused in SQL too); `pending_cosign -> signed` needs the `note_cosign` row of the named supervisor, who must hold
`clinical.note.cosign`; a co-signature and an addendum are append-only; an encounter completes only with a note signed / submitted or a
recorded deferral.

## Reminder (33.1, TC-CL-06)

A completion with a deferral enqueues `clinical.note_sign_reminder` for `ended_at + note_sign_deadline_hours` (24 h) in the completing
transaction. `NoteReminderService.run` (called by the worker's handler through `runNoteSignReminder`) raises one `note_unsigned` alert
to the clinician (and the authors of drafts on the encounter) unless a note was signed or submitted meanwhile. The alert row holds IDs only.

## Merge participant (22.16, 38.2 item 11)

`notesMergePart` / `notesExportPart` are composed with the chart's and the front door's parts by `registerNotesParticipants`
(the registry takes ONE `clinical` participant). Encounter: R `open`, `in_consultation`; K `completed`, `cancelled`. Note: R `draft`,
`pending_cosign`; K `signed`. `note_cosign`, `note_addendum`: K, never touched. A signed note is re-pointed by nothing, ever; a NEW
addendum on a merged patient's signed note carries the survivor's patient ID (the trigger accepts the note's patient or the survivor of a
merge). Test: `notes.dbtest.ts` "merge participant and export part".

## Recorded departures from 22.11 (all additive)

1. `organisation_id`, `created_at`/`created_by`, `row_version`/`updated_at` on every table (21.4).
2. `encounter.reservation_id` is a plain unique uuid (scheduling's table); `consent_exception.encounter_id` (BE-18) stays a plain uuid.
3. `note.template_id` is a text key of a built-in template (`soap`: subjective, objective, assessment, plan). 22.11 has no template table.
4. `note.submitted_for_cosign_at` is new; `cosign_required_from` holds the supervisor's principal ID.
5. A trainee note waiting for co-signature counts as "submitted" for completing the encounter and for the reminder. Decision for the
   Architect to confirm (ST-01 says "note signed or deferral recorded").

## Limitations and requests to other owners (not changed here: outside the allowed paths)

1. **Worker handler.** `clinical.note_sign_reminder` needs a handler in `apps/worker/src/jobs/clinical` that opens a patients-scope system
   transaction and calls `runNoteSignReminder(reminder, tx, payload)`. `NOTES_JOBS` declares the job.
2. **Contract gaps** (`packages/contracts/openapi/clinical.yaml`, Architect): `POST /encounters` and `POST .../notes`, `.../addenda`
   answer `201` (the file lists `200`); `POST /encounters` can answer `409 clinical.invalid_transition` (a second start, a visit not
   checked in); `POST /notes/{id}/cosign` can answer `401 auth.reauth_required` and `409 clinical.invalid_transition`; the sign and
   submit routes answer `422` for a trainee without a supervisor (`clinical.supervisor_missing`).
3. **Reminder after a merge.** A completed encounter is a K row and stays on the merged ID; a reminder job whose patient was resolved
   to the survivor cannot read it and ends without an alert. Only a merge inside the 24 h window is affected.
4. **Catalog lists.** `db/tools/catalog-lists.mjs` is the owner's list: `catalog-lists.requested.patch` adds the guard function
   `clinical.notes_guard_open_patient` to `patientGuardFunctions` and `definerInventory`. With it applied the four new tables leave the
   M-5 patient-guard violations (checked on a throwaway database); the remaining violations belong to other tickets' objects.
5. **Doctor editing an assistant's draft** is not allowed (`PATCH` is author-only, 29.3): the doctor signs it as written, or the assistant
   edits first; the doctor's changes go in an addendum.
6. A cancelled encounter (`open -> cancelled`) exists in the state machine but R1 has no route that creates an `open` encounter.

## Run the tests

```
pnpm --filter @ehr/api run build
cd apps/api
EHR_TEST_ADMIN_URL=postgres://postgres@HOST:5432/postgres node --test --test-force-exit \
  dist/src/modules/clinical/notes/notes.dbtest.js
```
