# HEAAA-666: BR-34 banner cases on candidate `cdc388d`

Candidate: `cdc388d2a348388a23ecef00305ecf0e34fa0aa4` (QS-01), the revision of the R2 QA run. Built from a clean worktree (`pnpm -r build`). Stack: real built API and worker, a throwaway PostgreSQL database migrated to 2500, fixture OIDC IdPs, the built staff app (`vite preview`), Chromium 1.64.1 (Playwright). Node v24.22.2. Synthetic data only. Executed by QA on 2026-11-10. This is QA execution evidence; it is not human acceptance and it is not clinical review.

Test source: `banner.test.mjs` (API, real stack), `ui.mjs` (real browser), `cl08.mjs`. Raw output: `api-spec.txt`, `api-junit.xml`, `api-stdout.txt`, `staff-component-tests.txt`, `screens/`. The harness overlay is the same as R2 (QA640-H1: journeys libs from 264b914 plus the R2 `stack-up.mjs`).

## Per-case results

| Case | Result | Basis |
| --- | --- | --- |
| TC-PC-07 | **FAIL** | F-1, F-2, F-3 |
| TC-PC-13 | **FAIL** | F-2, F-3, F-4, F-5 |
| TC-PC-14 | **PASS (API and top of screen); photo path and human part NOT executed** | below |
| TC-PC-15 | **PASS on the API steps 1-5, with deviation F-4; screen and 360/1280 px legibility NOT executed (human)** | below |
| TC-CL-08 | **FAIL** | F-6 (the lists, name, DOB and uncoded marks pass; history and documents are null) |
| TC-CL-09 | **PENDING (human). Not executed, not marked done.** | |

## Findings (BR-34 defects are severity-high per PRD 8.3)

* **F-1 (high). The banner does not stay in view.** In the doctor workspace (DR-03 chart, with the Documents panel and the Visit note editor under it) the banner is `position: sticky`, but only inside the Chart section. After scrolling to the Visit note (page height 1739 px at 1280 px, 1926 px at 360 px), the banner top is -357 px (1280) and -406 px (360); the name and DOB are off screen. TC-PC-07 step 3 expects them visible at the bottom of a long screen. Evidence: `screens/doctor-note-scrolled-1280.png`, `doctor-note-scrolled-360.png`. Same off-screen result on the chart-only screens at 360 px and at 640 px width (200 % zoom): `dobInView: false`, top -159 to -471 (`ui.mjs` output in this file's table below). Not executed: DR-04 video notes, DR-05 sign dialog, DR-06 addendum (the note editor passes name and DOB to the sign dialog by props, not asserted here).
* **F-2 (high). PC-02 Check-in has no banner.** After the desk searches and lists patients, the screen shows name, MRN and DOB in a text row and "Show visits"; there is no photo or initials and no banner. `screens/fd-PC-02-check-in-patient-chosen.png`.
* **F-3 (high). The triage and vitals screen cannot show its banner on the real stack.** The screen calls `GET /patients/{id}/banner`, which returns `{ "patientBanner": {...} }`; `parseBanner` (`apps/staff/src/features/preconsult/types.ts:203`) reads `displayName` from the response root, so it returns `undefined` and the screen shows "Something went wrong on our side" instead of the banner (`screens/fd-triage-vitals.png`, user holding front_desk and triage_nurse at A1). The desk component tests pass because their mock returns the flat shape (`desk.test.tsx` `banner()`); a mock does not prove the integrated call.
* **F-4 (medium). Role and route mismatch with the case text.** `GET /patients/{id}/banner` and `GET /patients/{id}` return 403 `auth.forbidden` for a doctor (permission `patient.read`, which the doctor role does not hold; the staff app uses `/patients/lookup` for alerts). TC-PC-13 step 5 and TC-PC-15 step 1 call that route for the doctor roles. Chart routes with `banner: true` do serve the doctor. Decision needed: change the case or the role. Not a leak (the response is a refusal).
* **F-5 (high). `GET /patients/{id}` (route inventory "patient") returns a non-conforming banner** for front desk: `{patientId, mrn, givenName, familyName, dateOfBirth, photoDocumentId, allergySummary: null, merged}`. ARCH 28.2 names `displayName`, `allergies` and `photoUrl`. A client reading the contract finds no `displayName`. (The same patient through `GET /patients/{id}/banner` is conforming.)
* **F-6 (medium). Chart summary history and documents are null.** `GET /patients/{id}/chart-summary` returns `encounters: null`, `documents: null` (re-run here on `cdc388d`: `cl08.mjs`; same as TC-CL-08b in the HEAAA-661 supplement). TC-CL-08 expects history and documents visible.
* **F-7 (low, observation).** `GET /check-ins/{id}/triage` with no triage recorded returns no `patientBanner` (the route is `banner: true`). It names no patient data, but the screen has nothing to show the banner from.

## What passed (API, real stack; `api-spec.txt`)

* TC-PC-13 (API): every `banner:true` route reached by an authorised role carries `patientId`, `displayName`, `dateOfBirth`, `mrn` for the URL's patient: chart-summary, problems, allergies, medications, documents, questionnaire-responses, vitals POST, triage POST and GET (after a triage exists), encounter POST, note POST and GET, and `/banner` for nurse and front desk. Stale tab: no patient identifier is in any staff screen path (UI-UX 3.2, the workspace is in memory), so "open directly by URL" and the stale-tab step do not apply to the UI; at the API a banner always names the URL's patient.
* TC-PC-14: no-photo patient has no `photoUrl` and the UI shows initials; a 120-character name is carried whole and wraps at 1280, 360 and 640 px without horizontal scroll, DOB visible; two patients with the same name differ by DOB and MRN (API) and by DOB in the UI (MRN is behind "Show details" at 360 px, by design).
* TC-PC-15 (API): 15 allergies created, 3 set to `resolved`, `entered_in_error`, `inactive`; the banner shows `state = recorded`, 10 items, `moreCount` 2, severe first, none of the 3 excluded; same for the assigned doctor (via chart-summary), triage nurse and front desk (via `/banner`); a patient with no allergy gives `none_recorded` with no items and no "No known allergies"; `medical_records` gets `allergies = null`, a call adds 0 `clinical.allergy_summary` audit rows, a nurse call adds 1; a patient session gets 403.
* Staff app component tests (doctor and preconsult): 60 passed.

## Not executed, with reason

* Photo present (photoUrl): there is no object store in this stack (same limit as R2), so a patient photo cannot be uploaded. Only the no-photo path ran.
* The uncoded count of 1 in TC-PC-15: no licensed terminology is loaded, so all 12 allergies are free text (`uncodedCount` 12); the arithmetic and the cap ran, the mixed coded/uncoded split did not.
* BTG doctor (`STF-DR-A2`), print view, SH-02 document viewer, DR-04/05/06 screens with a banner, the Alert tray patient links, red block and chip legibility at 360 and 1280 px: not executed. The last is a human check.
* Safari/Firefox: not run for this task.

## UI run values (`ui.mjs`)

Chart-only screen (DR-03), banner at top: name, DOB, avatar visible at 1280, 360, 640 px. After scrolling 4000 px: 1280 px stays at top 0 only because that page does not scroll; at 360 and 640 px DOB is off screen.
