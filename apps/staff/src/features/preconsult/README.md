# Pre-consultation desk (FE-09, HEAAA-119)

Staff screens for PC-01..PC-08 and the duplicate and merge screens of UI-UX 7.3 and 8: arrivals board, check-in (desk and QR), forms
review, triage with vitals and the red-flag bar, queue, follow-ups, no-shows, registration with the duplicate warning, duplicate
queue, merge request and approval. Entry point: `PreconsultDesk` (`index.ts`), one component for the four paths in `PRECONSULT_PATHS`
(`/arrivals`, `/triage`, `/forms`, `/follow-ups`), which are the pre-consultation items FE-08 already offers. Permissions only decide
what is drawn; the server authorizes every call.

**Review base.** The branch merges the prerequisite branches (FE-08 with FE-06, BE-18 with BE-13 and BE-09) unchanged; they are not on
`main` yet. The FE-09 change is `git diff f9722c7 -- apps/staff/src/features/preconsult`; nothing outside that folder is edited.

## Acceptance map

| Acceptance                                                                                                                                        | Where it holds                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red-flag bar reads "Red flag raised. The on-duty doctor has been alerted." and offers no action                                                   | `Triage.tsx` uses `AlertBar state="raised"` (text `redFlagCreator` from `@ehr/ui`), shown from the triage response `redFlag` or the current assessment. No button, no doctor name, no countdown, no acknowledged state (UXR-08 B). Unit test "raises the red-flag bar…"; Playwright "queue … red-flag bar"                                                        |
| Allergy block follows UI-UX 8 incl. `null`                                                                                                        | `PatientBanner`/`AllergyBlock` fed by `GET /patients/{id}/banner` and the banner in vitals/triage answers. Recorded, none recorded and `null` ("not shown", never "none") each tested in jsdom and Chromium                                                                                                                                                       |
| Duplicate warning at registration (7.3)                                                                                                           | `Registration.tsx` + `DuplicateWarning`: `POST /patients/match` first, the agreed sentence, only in-scope candidates with fields, out-of-scope = one sentence with no data, "Open existing record" / "Create anyway (reason required)", `POST /patients` with `matchCheckId`, `duplicateAcknowledged`, `acknowledgeReason`; a changed field invalidates the check |
| Merge request/approval screens; unauthorised users see no merge actions                                                                           | `Merge.tsx`: tab and controls only with `patient.merge.request` / `patient.merge.approve`; request needs the survivor's MRN typed and a reason; approval shows status, hides records and reason the API hides, confirms in a risk dialog; self-approval refusal shown in words. Tests "does not offer merge…", "hides Request a merge…"                           |
| Arrivals, check-in (incl. QR), forms review, triage with vitals and out-of-range highlighting, queue with wait time, follow-up and no-show queues | `ArrivalsBoard`, `CheckIn` (+ `QrCode`, `qr.ts`), `FormsReview`, `Triage` (`RangeText` for the stored `rangeStatus`), `Queue` (wait = server `waitSeconds` + time since load), `FollowUps`, `NoShows`. **Against contract mocks only, see below**                                                                                                                 |

State catalogue (UI-UX 6) covered: loading (skeleton, "still working"), refresh (old content kept, "Updated at"), empty (nothing exists),
403/404/429/5xx pages with reference code, 412 and 428 in words with a list refresh, validation (summary that takes focus + inline),
idempotent retry (one `Idempotency-Key` per step, reused after a timeout or 5xx, dropped on a definite answer), offline banner with
vitals and triage disabled, permission-limited note for a part a role cannot read, partial failure per part on the forms review.
Phone: tables become cards; triage entry is not offered under 600 px (UI-UX 9). Session end and release prompts come from the shell.

## Limitations and open points (not hidden)

1. **Contract mocks, not the real API.** All unit and Playwright tests mock the API with shapes copied from the controllers on the
   prerequisite branches. No real API, database or identity provider ran. The acceptance line "work against the real API" is **not
   yet demonstrated**; it needs the integrated candidate (INT-03).
2. **Not wired into the staff app.** `StaffApp.tsx` is outside the allowed paths. Request to Orchestrator: in `StaffApp.tsx` render
   `<PreconsultDesk runtime={runtime} path={path} navigate={navigate} openChart={...}/>` when `isPreconsultPath(path)` instead of
   `NotAvailable`. `e2e/harness` mounts it for the browser tests.
3. **Contract gaps (Architect).** `clinical.yaml` does not list `GET /check-ins/{id}/triage` or the follow-up routes
   (`GET /locations/{id}/follow-ups`, `POST /patients/{id}/follow-ups`, `PATCH /follow-ups/{id}`), although the API serves them. They are
   called through the same client but untyped (`api.ts`, `loose`). Request and response bodies of the other routes are `OpaqueObject`.
4. **Not delivered: PC-05 assign doctor/room.** The front desk has no route that lists doctors or rooms (`GET /locations/{id}/roster`
   needs `scheduling.roster.manage`) and the arrivals and queue views give only IDs. The queue shows "Doctor assigned / No doctor
   assigned". Needs a roster read for the desk or names on the views.
5. **Location names.** No route returns location names to staff: a user with several locations sees "Location 1, 2…".
6. **Merge approver finds the request by reference.** No route lists merge requests; the requester is shown the request ID to pass on.
   The API's merge view also omits `caller_is_requester` (ARCHITECTURE 9.2), so Approve is offered to the requester too and the server
   refusal (`patient.merge_self_approval`) is shown in words. A work-queue route or the field would remove both.
7. **Insurance.** The staff realm cannot read coverages (`permission: 'patient'`), so the screen shows only the done/to-do flag
   ("Whether an insurance card was uploaded"). "Needs fixing" is shown for a withdrawn consent only.
8. **No-show outcome** (contacted / rebooked / closed, PC-08): the API has no outcome field. The screen records it as a follow-up
   task that is closed with the outcome (text on the screen says so).
9. **QR.** The encoder is local (`qr.ts`, no dependency added) and encodes the daily token only. The patient-side landing and its
   payload (PP-20) are not defined in the contract; if it expects a URL, change the one `QrCode text=` argument. Decoded 205/205
   times by an independent decoder (`evidence/raw/qr-decode-check.txt`; jsQR was installed in `/tmp` for that check only).
10. **`unit_mismatch` entry** is not offered because staff cannot read range units (UI-UX 8, UXR-11). No range value exists in the UI.
11. **TC-PC-15 (legibility) is a human test** and is pending. Screenshots were taken in a sandbox without Inter or symbol fonts, so the
    status icons render as empty boxes there; that is the sandbox, not the app.
12. **Test tooling.** `@testing-library/user-event` is not a dependency, so `desk.test.tsx` has a small `fireEvent` shim. Chromium needed
    system libraries and fonts that the sandbox lacked; they were unpacked under `/tmp` without root and are not part of the repo.
13. Waitlist (`/waitlist`) is not part of this ticket and stays "not available".

## Checks (raw output in `evidence/raw`, screenshots in `evidence/screenshots`, see `evidence/MANIFEST.md`)

Run from `apps/staff`; Playwright needs Chromium (`pnpm exec playwright install chromium-headless-shell`).

```
pnpm exec tsc -p tsconfig.json --noEmit
NODE_ENV=test pnpm exec vitest run
pnpm exec playwright test -c src/features/preconsult/e2e/playwright.config.ts
# from the repo root:
pnpm exec eslint apps/staff/src/features/preconsult
pnpm exec prettier --check apps/staff/src/features/preconsult
```
