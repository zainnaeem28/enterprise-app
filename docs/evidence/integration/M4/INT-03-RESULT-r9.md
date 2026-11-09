# INT-03 integration round 9 (HEAAA-386, closing round)

Candidate: HEAAA-344 branch tip `acff4ac` (`raw/int03-r9/gates/candidate-commit.txt`). Nothing had to be merged in this round: the reviewed INT03-F16 (`5b8a92c`, review HEAAA-381 PASS), INT03-F18 (`6052c0d`, HEAAA-383 PASS) and the INT03-F17 decision (`47a038e`, `acff4ac`, HEAAA-385 PASS, option B: patient messaging stays flag-off in R1, messaging acceptance is staff to staff) were already on the branch. No product code was changed by this round. Raw output: `raw/int03-r9/` (`gates/` = gate runs, `ui/` = scripts, process logs, screenshots, run logs). Journey stack as in r8: built API, worker and staff/patient apps as separate processes on a throwaway migrated database, fixture IdPs, synthetic data. SQL fixtures are disclosed in `ui/setup.mjs` (r8 data plus a second staff principal holding front_desk + care_coordinator) and `ui/grant-role.mjs` (adds the seeded role `assistant` to that principal for the messaging step). The patient_messaging flag was NOT enabled (D-5 default).

## Gates (all exit 0, `gates/exit-codes.txt`)
| Check | Result |
|---|---|
| install --frozen-lockfile, lint, format:check, typecheck, build, test:boundary | pass |
| unit | 1086 tests in 9 reports, none skipped or failed |
| integration-db (N-1 skipped) | **green on the first run**: 104 + 23 + 890 + 84 = 1101 tests, 0 failures, 0 skipped |
| secrets (gitleaks, history + tree) | pass, no leaks |
| SAST (Semgrep) | pass: 1182 files, 4 non-blocking MEDIUM (npm/pnpm settings) |
| deps (OSV) | pass: 2 non-blocking (minimatch 6.9, yaml 4.3) |
N-1 migration: not run, no release tag (recorded limitation). Red-flag rule content: still BLOCKED on D-12a.

## Journeys (Chromium on the real stack; screenshots and per-step API calls in `raw/int03-r9/ui/`)
| Journey | Result |
|---|---|
| Staff app served (F16) | **PASS**: the real staff app loads, sign-in works, full nav. Doctor surface: `explore-*`. |
| Schedule | **PASS** (`doctor-02-schedule`): booked visits listed, `GET /clinicians/{id}/schedule` 200. |
| Front desk (`frontdesk-*`, `register-*`; principal front_desk + care_coordinator only) | **PASS**: arrivals board, check in (`POST /appointments/{id}/check-in` 200), triage queue, forms review, follow-ups, register a new patient (`POST /patients/match` 200 then `POST /patients` 201, MRN issued), duplicate warning for an existing patient (Open existing / Create anyway). |
| Notes (`doctor-*`) | **PASS** on a fresh checked-in visit: open chart from schedule, start consultation (`POST /encounters` 201, note 201), write SOAP, save draft (PATCH 200), sign and lock (`POST /notes/{id}/sign` 200), notes-to-sign list. |
| Tasks | **PASS** (doctor surface): create (201) and mark done (PATCH 200). |
| Messages, staff to staff (RA-R1-25) | **PASS in the UI**: doctor sends to the second principal (`POST /threads` 201), the recipient sees it unread, opens and replies (`POST /threads/{id}/messages` 201), the doctor reads the reply (`doctor-readback-*`, `staff2-*`). |
| Patient portal re-run, flag off (`patient/`) | **PASS**: sign-in (`/me` 200), profile, notification preferences, privacy, appointments (booked visits listed), privacy export request (201, stays "Received"). Messages screens: `GET /patients/{id}/threads` 404, shown as not-found (as decided in F17; TC-MSG-03 N/A). |
| Brand site, real API (`site-realapi-*`) | **PASS for the directory**: services (3), doctor, location render from `GET /public/v1/*` on the real API (F18 works); Book links carry `?serviceId=&clinicianId=` to the patient app; robots, sitemap, healthz 200. Defects below. |

## New findings (returned to Orchestrator; nothing fixed in this round)
- **INT03-F19 (medium)**: Tasks & messages are not reachable for the front-desk roles. `navigationFor` puts "Tasks & messages" only on the `doctor` surface; a principal with only front_desk + care_coordinator gets no nav entry and `/tasks` answers "We can't find this" (`frontdesk-08-tasks-route-for-front-desk`). RA-R1-25 (staff create tasks and send messages) is met only for doctor-surface roles; the messaging step above needed the extra `assistant` role (fixture).
- **INT03-F20 (medium)**: an in-progress visit cannot be reopened. Clicking the visit again after a consultation was started calls `POST /encounters` -> 409 and shows "Something went wrong on our side", with no way back to the draft note (`f1-reopen-409/doctor-04-note-editor`). From Patients search the chart only says "Open a visit from your schedule".
- **INT03-F21 (medium)**: the chart's Documents panel errors for every patient: `GET /patients/{id}/documents` 404 ("The document list could not be loaded"), so upload/list are not usable (`doctor-03-visit-open-chart`).
- **INT03-F22 (low)**: the brand site labels a video service "In person": `pages.tsx:108` tests `mode === 'telehealth'`, the API sends `video` (`site-realapi-03-services`, `curl /public/v1/services`).
- Known and unchanged: `GET /alerts` 404 and `/alerts/stream` 403 (alerts page and live banner broken); `GET /public/v1/clinicians/{id}/next-available` is not built (needs `scheduling.next_available`), so doctor pages say no online appointments; staff `POST /holds` is 403 (BE-13 README O-1, staff booking routes not mounted), so the test visits were booked through the patient API (`ui/staff-book.mjs`, `staff-book-run-staff-403.txt`); Waitlist has no screen.
- Not run: patient merge, referrals, reporting, clinical front-door/vitals journeys in a browser; patient-to-staff boundary re-check; N-1.
- Environment: Playwright's Chromium headless shell had to be installed (`playwright install chromium`); `LD_LIBRARY_PATH=/tmp/r5-libs/usr/lib/x86_64-linux-gnu`, `FONTCONFIG_FILE=/tmp/fe07-fonts/fonts.conf`. Port 4340 was held by a foreign process, so the site ran on 4350.

## State
Verified on this candidate: all gates (first-run green integration-db), staff schedule/front desk/notes/tasks/staff messages, brand site directory, patient portal. **Not** marked Integrated and not ready for BUILD_REVIEW: F19-F22 are open and unreviewed, and the unrun items above remain. Closing round: no further round has been started; the Orchestrator decides.
