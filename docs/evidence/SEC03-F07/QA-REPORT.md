# SEC03-F07 (HEAAA-180): negative-test gaps closed — QA report

Candidate: `eeecca6aafe053fd8889e7e978717f02030e0f0c` (BE-11 tip, assessed by SEC-03). Work branch: `HEAAA-180-…` (based on that commit). Author: QA Engineer. **Independent review: pending (not self-reviewable).**

## What was added

| Item | File | Mandatory in CI |
| --- | --- | --- |
| AN-1 behavioural matrix, one row per RLS table (62 tables, from the catalogue), 20 callers incl. second location (A2), second clinic (B1), second patient, other organisation, proxy, admin_pool (plain / limited), partner, public, anonymous, unset, no-org, worker (patients scope A / B) | `apps/api/test/security/rls-matrix.dbtest.ts` | Yes: `integration-db` runs every `*.dbtest.js` under `apps/api/dist` (`scripts/ci/migration-check/lib.sh`) |
| Vacuity guard: every patient-keyed table (17) must hold a row for patient A and for patient B; positive control: staff A1 / B1 read their own rows in the 12 T-STAFF tables | same | Yes |
| Direct-SQL writes as staff of the second clinic (F01 statements: update insurance/contact/duplicate flag/notification, delete contact, inserts) + valid control | same | Yes |
| TC-AZ-05 (`reporting_ro` refused on every PHI table and view; audiences public / limited see nothing), TC-AZ-06 (`SET ROLE` each of 7 function-owner/read roles; FORCE RLS on every table), TC-AZ-07 (17 definer functions × every caller that must not hold them) | same | Yes |
| F02 / F04 / F08 negative cases (`set_status` as another patient / clinic; `ensure_care_relationship` by a patient for a clinic of their choice; `identity_label` positive path) | same, tagged `todo` via `OPEN_FINDINGS` | **No, by design** (see below) |
| 9.2 job tests: `resolve` and `fail` type with a merged ID after a real merge, undeclared = fail | `apps/api/test/security/merged-id-jobs.dbtest.ts` | Yes |
| Registry support for `on_merged = fail`; `applyOnMerged` job-start rule (`patient.merged` dead-letter code) | `packages/kernel/src/queue/enqueue.ts`, `on-merged.ts` (+ unit tests) | Yes (`unit`) |

## Results (executed; PostgreSQL 17 test server `ehr-test-db`, real migrations 0001–0903, Node 24.22.2, node:test)

| Run | tests | pass | fail | todo | Evidence |
| --- | --- | --- | --- | --- | --- |
| Candidate `eeecca6` + these tests | 68 | 56 | **8** | 4 | `run-candidate-eeecca6.txt`, `matrix-candidate-eeecca6.json` |
| Candidate + scratch F01 fix (`f01-scratch-fix.sql`: the 21 policies re-qualified, applied as an uncommitted migration 0904, then removed) | 68 | 64 | **0** | 4 | `run-candidate-plus-f01-scratch-fix.txt`, `matrix-candidate-plus-f01-fix.json` |

The 8 failures on the candidate are exactly F01: staff of A1 reads patient B's rows and staff of B1 reads patient A's rows in 9–11 tables (`identity.patient_link`, `identity.proxy_grant`, `notifications.notification`, `patient.care_relationship`, `care_team_member`, `communication_preference`, `consent`, `duplicate_flag`, `insurance_coverage`, `patient_contact`), and 6 direct-SQL writes by the other clinic change or insert rows of patient A. With the F01 fix all 8 pass. **Acceptance "fails without F01, passes with it": met** (the fix used is a scratch validation, not the Backend Engineer's migration; it must be re-run on the real F01 fix).

Todo cases (run, report, do not fail the suite) — they fail on the candidate because their findings are still open: F02 (`set_status` accepted from patient B and from staff of B1 on patient A's reservation), F04 (patient A adds care relationship for A at clinic B1), F08 (`identity_label` fails `42501` for a correctly authorised caller). To make each mandatory, delete its key from `OPEN_FINDINGS` in `rls-matrix.dbtest.ts` in the ticket that fixes it. The F08 refusal case passes today for the wrong reason (the function cannot succeed); its positive twin keeps it honest.

## Limitations and new observations

1. **Job-start resolution is not wired into the worker runner.** `applyOnMerged` is tested against a real merge and the real queue, but nothing calls it when a job starts (9.2). New finding **SEC03-F07-R1 (Medium)**: Backend Engineer to call it in the runner / `wrapTask` and dead-letter on `JobPatientMergedError`, then add the end-to-end test.
2. The matrix proves "no row of a patient outside the caller's scope" and the closed pre-authentication list; non-patient tables without seed data (see JSON, cells `all: 0`) are 0 trivially. Seeding one row for every non-patient table (AN-1 full text) remains open: **SEC03-F07-R2 (Low)**.
3. `partner` audience reads `identity.permission/role/role_permission`, `kernel.reference_data_version`, `organisation.jurisdiction/location/operating_state` (organisation-wide catalogue data). Not asserted as a defect; flagged for the SEC reviewer (observation).
4. `scheduling_booking_owner` reads `patient.patient` (the merge guard needs it); recorded as allowed in TC-AZ-06.
5. Tests use `app_api` / `app_worker` / `reporting_ro` connections with trust auth on a throwaway DB and synthetic data only. Not run: a browser, a real IdP, any live system.
6. The G3 / human gates are untouched. Review PASS here is not human approval.

## Reproduce
`pnpm install --frozen-lockfile && pnpm --filter @ehr/kernel --filter @ehr/contracts run build && pnpm --filter @ehr/api --filter @ehr/worker run build && cd apps/api && EHR_TEST_ADMIN_URL=postgres://postgres@HOST:5432/postgres node --test dist/test/security/rls-matrix.dbtest.js dist/test/security/merged-id-jobs.dbtest.js` (optional `EHR_MATRIX_REPORT=file.json`).
