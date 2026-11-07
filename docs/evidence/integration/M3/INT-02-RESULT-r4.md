# INT-02 round 4 — combined candidate 7130a3a (FAILED, 2 findings)

Candidate 7130a3a = c0d8f61 + fixes A/B/C (326d8ca, 0add7df, 7130a3a; HEAAA-198/199/200, Backend Reviewer PASS HEAAA-201). Node v24.22.2, PostgreSQL 17 (`EHR_TEST_ADMIN_URL`), synthetic data. Raw: `raw/r4/`. First round of a fresh 3-round budget (human confirmation 571c2b28); r1-r3 history on HEAAA-124/197.

| Check | Result |
| --- | --- |
| install (frozen lockfile), lint, prettier, typecheck, build, boundary fixture | pass (raw/r4/install, lint, format-check, typecheck, build, boundary) |
| unit (`run-unit.mjs`) | pass: 599 tests in 8 reports, none skipped or failed |
| db-foundation | pass 40/40 |
| kernel | pass 23/23 |
| worker | pass 76/76 |
| api full dbtest run | **FAIL**: 656 tests, 2 failures, 4 skipped(todo). The run completed (no stall, no `permission denied for slot_occupancy`, no TC-MG-14 timeout) |
| N-1 / upgrade path | not run (`INTEGRATION_SKIP_N_MINUS_1=true`; no release tag exists) |

Previously failing items now passing in the full api run: scheduling availability/search (round 3 failure 1), TC-MG-14 (50,000 notifications + 5,000 contacts merged in 47.6 s, bound test 72 s), run no longer stalls, merge participants registered at the composition root (`INT-02 fix B` test passes: all participants run, counts reported for all tables, alert rows re-pointed).

## Scenarios (executed as database/HTTP-route suites in the api run)

| Scenario | Evidence | Result |
| --- | --- | --- |
| 100 parallel bookings of one slot, one account / 100 different patients | TC-BK-13, TC-BK-14 | pass: exactly one appointment |
| 100 parallel confirmations of one held slot; overbook cap 2 under 100 parallel | concurrency.dbtest | pass (exactly 2) |
| Hold-lapse and room races | TC-BK-16, 17 | pass |
| Merge versus booking race | TC-MG-09 (merge against writers holding the patients), F05 guard for a writer that skipped `patient.lock_patients`, TC-MG-07 | pass |
| All-participant merge counts | "INT-02 fix B", TC-MG-06, count-mismatch and missing-participant tests, per-module participants (documents, identity, scheduling, flow, alerts) | pass |
| Booking over HTTP (taken slot 409 with alternatives, create/cancel) | scheduling core "HTTP routes" suite | pass |
| **Patient booking journey through the real patient UI** | not executed in this round: no browser/screenshot run; only API-level HTTP routes and 106 patient-app unit tests ran | **not demonstrated** |

No actual-application screenshots exist for this round.

## Findings (cumulative round 1 of 3 of the new cycle)

- **INT02-R4-F01 (high-visibility, test/fixture)**: `apps/api/test/security/rls-matrix.dbtest.ts` "catalogue has the expected shape and every patient table holds a row for patient A and B (no vacuous cell)" fails. 14 M3 tables are not seeded for both patients (A=0, B=0): documents.{deletion_request,document,document_version,legal_hold}, notifications.{staff_alert,staff_alert_event}, scheduling.{check_in,queue_entry,waitlist_entry,waitlist_offer}, telehealth.{join_token,location_confirmation,participant,video_session}. The AN-1 behavioural RLS matrix therefore proves nothing for those tables on the combined candidate. Fix: extend the matrix seed (SEC-03 F07 owner) so each table has a row for A and B, then rerun. raw/r4/api.txt:1296.
- **INT02-R4-F02 (product + test markers)**: `SEC03-F08 patient.identity_label succeeds for the compliance caller ... (TC-AZ-08 step 3 positive)` fails with `42501 permission denied for table patient` (the function still cannot succeed; BE-08). Separately SEC03-F02 and SEC03-F04 tests are still marked `todo` although they now pass, so the integration gate counts 4 skipped tests (a skipped test fails the gate). Fix: BE-08 grants/function for identity_label, remove the stale todo markers. raw/r4/api.txt:1285, api-junit.xml.

Known limitation INT02-R4-N1 (staff-only includeOverbook hint): non-blocking, unchanged.

## State

Configured and executed: checks above. Verified: static checks, unit, db-foundation, kernel, worker, concurrency and merge scenarios. Not integrated/approved: gate `integration-db` fails on api. Not submitted to QA. Independent reviewer of this evidence: Backend Reviewer (not yet reviewed). Corrections to be assigned by Orchestrator; I do not fix product code.
