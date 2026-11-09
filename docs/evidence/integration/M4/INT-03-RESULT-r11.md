# INT-03 integration round 11 (HEAAA-407, closing round)

Candidate: `7a11a3e` (`raw/int03-r11/gates/candidate-commit.txt`), tested in a clean detached worktree. It contains the reviewed F20-R3 fix (`7a11a3e`, HEAAA-405 PASS) and the reviewed F21-O1 code (`afa2018`, HEAAA-406 PASS) on top of everything tested in r10. Nothing was merged or changed in this round. Raw output: `raw/int03-r11/` (`gates/`, `ui/` = scripts, logs, screenshots, run logs). Stack as in r10: built API, worker, staff, patient and site as separate processes on a throwaway migrated database, fixture IdPs, synthetic data, SQL fixtures in `ui/setup.mjs`; `ui/public-proxy.mjs` only forwards the site's API origin to the integrations Host. The visit was booked through the patient API (staff holds are the O-1 limitation). The database was dropped and all processes stopped afterwards.

## Gates (all exit 0, `gates/exit-codes.txt`)
| Check | Result |
|---|---|
| install --frozen-lockfile, lint, format:check, typecheck, build, test:boundary | pass |
| unit | 1099 tests in 9 reports, none skipped or failed |
| integration-db (N-1 skipped) | green on the first run: 104 + 23 + 892 + 84 tests, 0 failures, 0 skipped |
| secrets (gitleaks, history + tree) | pass, no leaks |
| SAST (Semgrep) | pass, none blocking (`gates/sast.txt`) |
| deps (OSV) | pass, none blocking (`gates/deps.txt`) |

## Journeys (Chromium on the real stack; screenshots and per-step API calls in `raw/int03-r11/ui/`)
| Item | Result |
|---|---|
| **F20 reopen an in-progress visit via the draft picker** | **PASS**. Front desk checked the visit in (`POST /appointments/{id}/check-in` 200). Doctor started the consultation (`POST /encounters` 201, note 201) and saved a draft (`PATCH /notes/{id}` 200) (`reopen-03`, `reopen-04`). Back on the chart, "Start consultation" gives `POST /encounters` 409 `clinical.invalid_transition`, then `GET /clinicians/{principal id}/notes` **200** (r10: `/clinicians//notes` 404), and "Open this draft" opens the note (`GET /notes/{id}` 200) with the saved text "Synthetic: reopen test, cough." (`reopen2-03`, `reopen2-04-pick-draft.png`). The empty-clinician-id 404 of r10 is gone. |
| **F21 documents list with patient banner** | **PASS** at API level on the staff host: `GET /patients/{id}/documents` 200 with keys `items,nextCursor,patientBanner`; banner = displayName, dateOfBirth, mrn, allergies (`docsbanner-api-body.txt`); an unknown patient id gives 404. The chart's documents panel renders (upload control, "No documents yet", `docsbanner-02-open-chart-documents.png`). The staff UI does not yet render `patientBanner` from this response (it uses the chart-summary banner), so the banner is shown by the API only. Upload/download not exercised (object store refuses, disclosed in HEAAA-393). |
| F19 tasks for front desk (`frontdesk-*`) | **PASS**: "Tasks & messages" in the nav, `/tasks` 200, create `POST /tasks` 201, mark done `PATCH` 200; arrivals, check-in, triage, forms, follow-ups, register also load. |
| F22 site label | **PASS** on the site served from this tip: `/services` shows "General appointment ... In person" and "Video visit ... Video visit"; directory from `GET /public/v1/*`; Book links carry `?serviceId=&clinicianId=`; robots, sitemap, healthz 200 (`site-realapi-*`). |

## Process notes (not product findings)
- `raw/int03-r11/ui/attempt1-not-checked-in/`: a first reopen attempt pressed "Start consultation" on a visit that had not been checked in and got 409 `invalid_transition`; the generic error is the expected response for that state. It is my ordering mistake, discarded. The valid run checks in first (as r10 did).
- Stale site servers from earlier rounds were still listening on 4351 and served my first site run; they were stopped and the site run repeated from this tip (cwd and log checked). Only the repeated run is evidence.
- The same screenshot step in `staff-reopen` (`reopen-*`) fails on "pick-draft" because that script never presses Start consultation after the reopen; `staff-reopen2` is the proper picker test.
- Cosmetic, observed only: after "Open this draft" the editor shows "Draft not saved yet" above the loaded text (`reopen2-04-pick-draft.png`). Not filed as blocking.
- A Chromium runner had to be provisioned for this host per `docs/evidence/integration/M3/BROWSER-RUNNER-AND-0704.md`.

## Recorded limitations (unchanged)
Staff booking holds 403 (O-1), Waitlist screen, next-available (doctor pages say no online appointments), N-1 migration (no release tag), red-flag rule content (blocked on D-12a). Not run in this round: doctor sign-and-lock flow re-run, patient portal, patient merge, referrals, reporting, document upload/download, an actual alert.

## State
Gates are green on `7a11a3e`; F20 (reopen via draft picker, closes F20-R3), F21 (documents list patientBanner, staff UI does not display it yet), F19 and F22 are verified in a browser on the real stack. No new failure. Not marked Integrated and not ready for BUILD_REVIEW by me; no further round started. The Orchestrator decides the next step.
