# INT-02 round 4, round 2 (r5) — combined candidate e091365

Candidate e091365 = 6091a38 (c0d8f61 + fixes A/B/C) + fix D af7c76a (HEAAA-203) + fix E 1993ca4 (HEAAA-204), merged one at a time with `--no-merge-ff`, no conflicts (merge commits only, no content of my own). Backend Reviewer PASS on D and E: HEAAA-206. Node v24.22.2, PostgreSQL 17 (`EHR_TEST_ADMIN_URL`), synthetic data, no credentials in artifacts. Raw output: `raw/r5/` (candidate-commit.txt holds the tested HEAD of the pre-evidence tree). This is round 2 of 3 of the fresh budget (human confirmation 571c2b28); round 1 was HEAAA-202 (F01/F02, now fixed).

| Check | Result |
| --- | --- |
| install (frozen lockfile), lint, prettier, typecheck, build, boundary fixture | pass (raw/r5/install, lint, format-check, typecheck, build, boundary) |
| unit (`run-unit.mjs`) | pass: 599 tests in 8 reports, none skipped or failed |
| `integration-db.sh` (db-foundation, kernel, api, worker), `INTEGRATION_SKIP_N_MINUS_1=true` | **pass**: db-foundation 40/40, kernel 23/23, api 662/662, worker 76/76 = 801 tests, 0 failures, **0 skipped** (raw/r5/integration-db-full.txt:2015-2020) |
| N-1 / upgrade path | not run (no release tag exists; unchanged limitation) |

Round 1 findings, now verified on the combined candidate:

- INT02-R4-F01: "every patient table holds a row for patient A and for patient B (no vacuous cell)" passes (integration-db-full.txt:1470). Resolved on this candidate.
- INT02-R4-F02: `patient.identity_label succeeds for the compliance caller with the key and a visible referencing record` passes (:1542); refused-caller tests pass (:1535, :1541); the gate counts 0 skipped. Resolved on this candidate.

## Scenarios (database/HTTP-route suites inside the api run)

| Scenario | Evidence (integration-db-full.txt) | Result |
| --- | --- | --- |
| 100 parallel bookings of one slot, one account / 100 different patients | TC-BK-13 (:1264), TC-BK-14 (:1268) | pass: exactly one appointment |
| Merge versus booking race | TC-MG-09 (:1026-1032), F05 guard for a writer that skipped `patient.lock_patients` (:1209-1211) | pass |
| All-participant merge counts | "INT-02 fix B" (:1054) | pass |
| Merge time bound | TC-MG-14: 50,000 notifications + 5,000 contacts in 48.4 s, bound test 72 s (:1033-1037) | pass |
| **Patient booking journey through the real patient UI** | see Blocker below | **NOT demonstrated** |

## Blocker: patient booking journey through the real UI (no screenshots exist)

Two independent reasons; the journey cannot be run and I do not claim it:

1. **Product wiring gap (candidate).** `apps/patient/src/app/App.tsx` does not mount `BookingRoutes`/`isBookingPath` and the landing page has no link to `/appointments` or `/book` (`grep -i booking apps/patient/src/app` finds nothing). `features/booking/README.md` records this as an open request to the Orchestrator (edit outside FE-04's allowed paths). The API also has no mounted catalogue routes the UI calls (`GET /services`, `/locations`; README "not mounted in apps/api yet", `catalog-lists.requested.patch` pending). So on the combined candidate a patient cannot reach a booking screen through the real app against the real API even with a browser. This needs an owner and a ticket (Orchestrator): mount booking routes + landing link in `App.tsx`, mount the catalogue routes, and an IdP-fixture-backed journey.
2. **Environment.** Playwright's Chromium headless shell was downloaded (user-level) but cannot start: shared libraries are missing (`libglib-2.0.so.0`, `libnss3`, `libX11`, `libgbm`, ... ; `ldd`), the account is non-root (uid 1000) with no sudo and apt lists are absent, so system libraries cannot be installed. The existing FE-04 browser spec (contract mock, `apps/patient/src/features/booking/e2e`) therefore failed 8/8 at browser launch (raw/r5/booking-ui-mock-e2e.txt); that is an environment failure, not a product result, and the spec is a contract mock in any case, not the real API path. DevOps/Orchestrator: provide a runner image with Chromium dependencies.

Executed instead for the UI: 106 patient-app unit tests (jsdom) pass in the unit run. They are not a browser journey and are not presented as one.

## Recorded notes

- **INT02-R4-N1** (staff-only `includeOverbook` hint, non-blocking): unchanged, accepted limitation.
- **INT02-R5-N1** (0704 `0704_patient_matching_registration.sql` edited in place by fix E c57f700): I have no access to any persistent environment and the repository records none (no release tag, no deployment evidence, no environment inventory). Every database this run touched was created from empty, so the edited 0704 applied cleanly from empty and a second run applies nothing (db-foundation passes). I therefore **cannot confirm** that no persistent environment has applied the earlier 0704. DevOps/Orchestrator must confirm; if any environment applied it, a forward migration is needed instead of the in-place edit.
- **INT02-R5-N2** (RLS-invisible referencing-record case of `patient.identity_label` not separately exercised): documented gap, not exercised on this candidate; the visible-record positive and refused-caller cases are.

## State

Executed and verified on e091365: static checks, unit, db-foundation, kernel, api (662), worker, concurrency and merge scenarios. **Not integrated yet**: the milestone BUILD_REVIEW package still needs actual application screenshots of the patient booking journey (blocked as above); I do not mark logical Integrated or freeze the candidate. Not submitted to QA. Independent reviewer of this evidence: Backend Reviewer (not the Integrator), pending. Findings: no new product defect found this round; one new blocker INT02-R5-B1 (booking UI unreachable in the real app + no runnable browser), for Orchestrator to assign. Round count: 2 of 3 used in this budget.
