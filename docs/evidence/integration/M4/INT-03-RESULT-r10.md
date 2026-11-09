# INT-03 integration round 10 (HEAAA-395, closing round)

Candidate: `317f3d7` (`raw/int03-r10/gates/candidate-commit.txt`), run in a clean detached worktree so that unreviewed work in progress on the branch (HEAAA-400, F21-O1 banner/host code, later committed as `afa2018`) was NOT part of the test. It contains the reviewed F19/F22 (`16c4a47`, HEAAA-394 round 1 PASS), F20-R1 (`63fdca0`, round 2 PASS) and F21 (`8528642`, HEAAA-393 PASS). Nothing was merged or changed in this round. Raw output: `raw/int03-r10/` (`gates/`, `ui/` = scripts, logs, screenshots, run logs). Stack as in r9: built API, worker, staff, patient and site as separate processes on a throwaway migrated database, fixture IdPs, synthetic data; SQL fixtures as in r9 (`ui/setup.mjs`); `ui/public-proxy.mjs` only forwards the site's API origin to the integrations Host. Visits were booked through the patient API (staff holds are the O-1 limitation).

Process note: a first front-desk run in this round was invalid and discarded: stale preview servers from an earlier round were still listening on 4674/4675 and served an old staff bundle. They were stopped and the apps restarted from this tip; all results below are from the restarted stack (served bundle checked against `apps/staff/dist`).

## Gates (all exit 0, `gates/exit-codes.txt`)
| Check | Result |
|---|---|
| install --frozen-lockfile, lint, format:check, typecheck, build, test:boundary | pass |
| unit | 1096 tests in 9 reports, none skipped or failed |
| integration-db (N-1 skipped) | green on the first run: 104 + 23 + 84 + 891 tests, 0 failures |
| secrets (gitleaks, history + tree) | pass, no leaks |
| SAST (Semgrep) | pass: 1182 files, 4 non-blocking MEDIUM (npm/pnpm settings) |
| deps (OSV) | pass: 2 non-blocking (minimatch 6.9, yaml 4.3) |

## Journeys (Chromium on the real stack; screenshots and per-step API calls in `raw/int03-r10/ui/`)
| Item | Result |
|---|---|
| F19 tasks for front desk (`frontdesk-*`, principal front_desk + care_coordinator only) | **PASS**: "Tasks & messages" is in the nav, `/tasks` loads (`GET /tasks` 200), create (`POST /tasks` 201) and mark done (`PATCH` 200). Arrivals board, check-in (`POST /appointments/{id}/check-in` 200), triage queue, forms, follow-ups, register form also load. |
| Doctor flow (`doctor-*`) | **PASS**: schedule, open chart, start consultation (`POST /encounters` 201, note 201), save draft, sign and lock (200), notes-to-sign, tasks, staff-to-staff thread (`POST /threads` 201). |
| F21 documents in the chart | **PASS**: `GET /patients/{id}/documents` 200 on the staff host; the panel shows the upload control and "No documents yet" (`reopen-0[36]-*`). Upload/download are not exercised (object store refuses, disclosed in HEAAA-393). |
| F21 alerts | **PASS**: `GET /alerts` 200 and `GET /alerts/stream` 200 on every staff screen; Alerts page shows "No open alerts" (`reopen-09-alerts-page`). No alert was raised, so display of a real alert is not shown. |
| F22 site label | **PASS**: `/services` shows "General appointment ... In person" and "Video visit ... Video visit"; directory from `GET /public/v1/*`; Book links carry `?serviceId=&clinicianId=`; robots, sitemap, healthz 200 (`site-realapi-*`). |
| F20 reopen an in-progress visit | **FAIL (new, F20-R3)**: see below. |

## New finding (returned to Orchestrator; nothing fixed in this round)
- **INT03-F20-R3 (medium)**: the F20-R1 draft picker never lists drafts on the real stack. Re-opening a visit that already has a consultation and pressing "Start consultation" gives `POST /encounters` 409, then `GET /api/v1/clinicians//notes` **404** (empty clinician id), and the screen shows "Something went wrong on our side" with no "Open this draft" choice (`reopen2-run.txt`, `reopen2-02-*`, `reopen2-03-pick-draft`). Cause: `NoteEditor.tsx:95` calls `api.myNotes(visit.clinicianId)`, but the schedule item contract (`ClinicianScheduleItem`, `packages/contracts/openapi/scheduling.yaml`) has no `clinicianId`, so `doctor/types.ts:215` yields `''`. The unit test passes because its fixture supplies a clinicianId. Safe (no wrong draft is opened), but the clinician still cannot get back to the draft; the original F20 defect (no way back) is therefore not closed on the real stack. Drafts remain reachable via Notes to sign. Fix options: use the signed-in principal id (the schedule is already fetched with it) instead of `visit.clinicianId`, plus a test whose fixture omits clinicianId.

## Observed during the run
- `317f3d7` has the contract text for the staff documents `patientBanner` but not the code; the code (`afa2018`, HEAAA-400) was committed on the branch after this run's candidate and is not tested here or reviewed.

## Recorded limitations (unchanged)
Staff booking holds 403 (O-1), Waitlist screen, next-available (`/public/v1/clinicians/{id}/next-available`, doctor pages say no online appointments), N-1 migration (no release tag), red-flag rule content (D-12a). Not run in this round: patient portal re-run, patient merge, referrals, reporting, document upload/download, an actual alert.

## State
Gates are green on `317f3d7`; F19, F21 (list, alerts) and F22 are verified in a browser; F20 is not closed (F20-R3). Not marked Integrated and not ready for BUILD_REVIEW. Closing round: no further round started; the Orchestrator decides.
