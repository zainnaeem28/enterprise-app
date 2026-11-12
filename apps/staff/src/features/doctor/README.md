# Doctor portal (FE-10, HEAAA-125)

Staff screens for DR-01..DR-07, DR-09 and the alert tray of UI-UX 4, 7.4 and 8: schedule, patient list, chart summary, note editor with the
sign dialog, addenda, co-sign queue, alert tray and the break-the-glass dialog, plus the video pane beside the note (DR-04). Entry point:
`DoctorPortal` (`index.ts`), one component for the four paths in `DOCTOR_PATHS` (`/schedule`, `/patients`, `/alerts`, `/notes-to-sign`),
which are the doctor items FE-08 already offers. Permissions only decide what is drawn; the server authorizes every call.

**Review base.** The branch merges the prerequisite branches (FE-08, FE-06, FE-09 with BE-18 and BE-13, BE-17, BE-07) unchanged; they are
not on `main` yet. The FE-10 change is `git diff 914d50d -- apps/staff/src/features/doctor`; nothing outside that folder is edited. A few
helpers are imported from `../preconsult` (`http.ts`, `useLoad.ts`, `format.ts`, `LoadError`), read-only.

## Acceptance map

| Acceptance                                                                     | Where it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chart summary shows name, DOB and photo (BR-34) and the allergy block          | `Chart.tsx` + `PatientBanner`/`AllergyBlock` from `@ehr/ui`, fed by `GET /patients/{id}/chart-summary` (`patientBanner`, `photoUrl`). Recorded, none recorded and `null` ("not shown", never "none") each tested. Unit "chart summary"; Playwright "chart summary and note"                                                                                                                                                                                                                                                                                                          |
| Note editor with sign dialog re-authenticating on `401 auth.reauth_required`   | `NoteEditor.tsx`, `SignFlow.tsx`. The draft is saved with `If-Match` before the dialog opens; the dialog restates name and DOB; a 401 opens "Confirm it's you", the second sign-in opens in a new tab (the reauth route answers 302 to Google), and "Sign now" repeats the request with the **same `Idempotency-Key`** and the held version. Unit "starts the consultation, saves a draft ... signs after re-authentication with the same key"; Playwright asserts both keys are equal                                                                                               |
| Trainee path                                                                   | Without `clinical.note.sign` the button says "Submit for co-signature", the dialog says what happens, and the locked note shows "Submitted for co-signature" (`pending_cosign`)                                                                                                                                                                                                                                                                                                                                                                                                      |
| Addenda                                                                        | After sign/submit the note is read-only; signed notes offer "Add addendum to note" (`POST /notes/{id}/addenda`, one key per attempt). Addenda added in this session are listed with the time                                                                                                                                                                                                                                                                                                                                                                                         |
| Co-sign queue                                                                  | `NotesToSign.tsx`, tab only with `clinical.note.cosign`; review, confirm dialog with name and DOB, `POST /notes/{id}/cosign`, `403 clinical.cosign_not_supervisor` in words, re-authentication as for signing. **See limitation 1**                                                                                                                                                                                                                                                                                                                                                  |
| Alert tray with paused-stream state                                            | `Alerts.tsx`, `alerts.ts`: `GET /alerts`, SSE stream (`alertStreamUrl`), passive 60 s `open-ids` poll. Countdown from the `Date` header (never the device clock alone); "Escalation time not set" when there is none; acknowledge with a key; `alert_closed` removes the row; refused stream = `AlertBar state="paused"` with Reload, dropped stream = "Check for alerts"; an open red flag shows a bar on every doctor screen, no close control. Tests: "alert tray" (unit, 6) and two Playwright tests (the paused one uses the browser's real `EventSource`, refused by the mock) |
| BTG reason dialog; out-of-assignment access refused until a reason is entered  | `Chart.tsx`: `403 clinical.not_assigned` with `btgAvailable` shows the refusal and the button (only with `audit.btg.open`); `BreakTheGlassDialog` will not call out under 10 characters; only then `POST /patients/{id}/break-glass {reason}`; the chart loads and "Emergency access" shows. Unit "break the glass" (2), Playwright (both viewports)                                                                                                                                                                                                                                 |
| Video plus notes side by side (DR-04) against the video adapter interface only | `video.ts` (`VideoAdapter`, `VideoHandle`), `VideoNotes.tsx`: two columns from 900 px, stacked below; no vendor is named anywhere. Without an adapter the pane says video is not connected and the note still works. The browser tests use a stand-in adapter that draws a box. Unit "video and notes"; Playwright asserts the layout in both viewports                                                                                                                                                                                                                              |
| Consent gate (UI-UX 8)                                                         | `409 clinical.consents_missing` shows "Telehealth consent not signed.", disables Start, and offers "Start with emergency exception" with a required reason (`emergencyException.reason`)                                                                                                                                                                                                                                                                                                                                                                                             |

State catalogue (UI-UX 6) covered: loading skeleton, refresh with old content kept ("Updated at"), empty, 403/404/429/5xx pages with reference
code, 412/428 in words, validation with inline messages, idempotent retry (one key per step, reused after a timeout or 5xx, dropped on a
definite answer), offline banner with writes disabled, permission-limited note for a part a role cannot read.

## Limitations and open points (not hidden)

1. **Notes lists (F02, resolved by HEAAA-290).** "Notes to sign" reads `GET /clinicians/{id}/notes`; the co-sign queue reads
   `GET /clinicians/{id}/cosign-queue` (tab only with `clinical.note.cosign`); review and "Open" read `GET /notes/{id}`, so a draft resumes
   after a reload and a supervisor sees the queue without having opened a note. First page only (no cursor paging yet: `nextCursor` is
   ignored; the default page size applies).
2. **Schedule** reads `GET /clinicians/{id}/schedule` (own reservations of one location-day, today). It needs
   `scheduling.booking.own_schedule`, which the seeded doctor holds. A role without it gets a plain sentence.
3. **Patient list is a lookup.** `POST /patients/lookup` (`patient.lookup`): an MRN alone, or a name (at most 4 words of 2+ letters) with
   an optional date of birth. The form refuses a date of birth alone and mixed MRN forms before sending. More than 25 matches shows a
   "narrow the search" note. No "my patients" list exists. Alert rows get name and date of birth through the same lookup (`patientIds`).
4. **Wired into the staff app (F04, authorised by the Orchestrator).** `StaffApp.tsx` renders `<DoctorPortal/>` for `isDoctorPath(path)`
   and nothing else of the app changed (plus the doctor-navigation test, which now sees the portal). The `/tasks` item is now served by `MessagesPortal` (`features/messages`).
   `e2e/harness` still mounts the portal on its own for the browser tests.
5. **Contract gaps (Architect).** Request and response bodies of the notes, chart and alert routes are `OpaqueObject` in the generated
   types, so `types.ts` parses the shapes of the controllers. The staff video host routes are `GET .../video-session/host` and
   `POST .../video-session/admit|end` on the BE-15 branch (its D1); they are called untyped and are not on the prerequisites of this ticket.
   `422 clinical.supervisor_missing` and `409 clinical.invalid_transition` are not in the contract (BE-17 README, limitation 2).
6. **Re-authentication is a top-level POST.** `POST /auth/reauth` answers 302 to Google, so a form with `target=_blank` opens it and the
   draft stays on this page. The form cannot carry the CSRF header; whether the route needs it is for integration (INT) to confirm against
   the real API. Not exercised against a real identity provider.
7. **Emergency access banner** shows while this page holds the grant it opened. After a reload the grant is still active on the server but
   no route tells the client, so the banner does not return. Needs the grant on the chart response or a `GET` for active grants.
8. **Photo.** The banner shows `photoUrl` (60 s signed URL) as the API sends it; no photo upload or refresh logic here.
9. **No real API, database or identity provider ran.** All unit and Playwright tests are contract mocks with shapes copied from the
   controllers. The acceptance "work against the real API" is **not demonstrated**; it needs the integrated candidate. The vendor video
   service is undecided (C-11), so nothing here proves real video.
10. **Screenshots** are full-page captures: the sticky patient banner can appear mid-page in them. The sandbox lacked system libraries and
    fonts for Chromium; they were unpacked under `/tmp` without root and are not part of the repo. Icons and fonts differ from production.
11. **Not in this ticket:** completing the encounter, problem/allergy/medication editing, DR-08 tasks, DR-11..13 availability, EPCS and
    prescriptions (R2). TC-PC style human legibility checks for these screens are pending (human).

## Checks (raw output in `evidence/raw`, screenshots in `evidence/screenshots`, see `evidence/MANIFEST.md`)

Run from `apps/staff`; Playwright needs Chromium (`pnpm exec playwright install chromium-headless-shell`).

```
pnpm exec tsc -p tsconfig.json --noEmit
NODE_ENV=test pnpm exec vitest run
pnpm exec playwright test -c src/features/doctor/e2e/playwright.config.ts
# from the repo root:
pnpm exec eslint apps/staff/src/features/doctor
pnpm exec prettier --check apps/staff/src/features/doctor
```

## Review round 1 response (FE10-R1)

- F03 fixed: not-assigned banner, emergency-access button and the `Patient` fallback now come from `strings.ts`.

## Review round 2 response (F01, F02, F04)

Candidate rebased by fast-forward onto `1348b737` (HEAAA-290, backend: doctor permissions, `patient.lookup`, own-schedule, notes routes).

- F01 fixed: `testkit.tsx` and the browser spec use the seeded doctor permissions (no `patient.read`, no `scheduling.check_in`; with
  `patient.lookup`, `notifications.alert.read`/`acknowledge`, `scheduling.booking.own_schedule`). No call to `/patients/search`,
  `/patients/{id}/banner` or `/locations/{id}/arrivals` remains; the alert tray and red-flag bars render for the real role.
- F02 fixed: see limitation 1; new tests list drafts and the queue from the server, resume a draft via `GET /notes/{id}`, and hide the queue call without the permission.
- F04 fixed: see limitation 4.
- Still contract mocks: no real API, database or identity provider ran. The DB-backed suites of HEAAA-290 were **not** run by me.
