# INT-03 integration round 4 (HEAAA-133 / HEAAA-344)

Cumulative integration rounds: **4** (r4 allowed by decision-log HEAAA-338, reviewed HEAAA-342). Candidate: `4a03369` (F09a `b4bc372` + F09b/F09b-correction, security re-review PASS HEAAA-347) on the r3 tip `88699bd`; no conflicts. Raw: `raw/r4/` (exit codes in `exit-codes.txt`).

## Executed (candidate `4a03369`)
| Check | Result |
|---|---|
| frozen install, format:check, typecheck, build, test:boundary | pass |
| `pnpm run lint` | **FAIL**: `apps/api/src/modules/scheduling/core/binding.dbtest.ts:16` `'saWrite' is defined but never used` (`no-unused-vars`) |
| unit via `scripts/ci/run-unit.mjs` | pass: 1024 tests in 8 reports, none skipped or failed |
| `integration-db.sh` (N-1 skipped) | pass: db-foundation 104/104; kernel 23/23; api 884/884; worker 79/79 |

Attempt 1 of `integration-db.sh` failed 2 worker tests (`compose.dbtest`): `bootstrap` raised `tuple concurrently updated` on `ALTER ROLE app_owner`, i.e. another session using the shared `ehr-test-db` server at the same moment (`raw/r4/integration-db-attempt1-worker-flake.log`). Rerun passed in full (`integration-db.log`). Environmental, not a code defect; not repeated further.

## New finding
**INT03-F10** (blocking, `lint` gate): F09a left an unused import `saWrite` in `binding.dbtest.ts:16` (the test now uses the referral-bound path). One-line removal; needs Backend correction and independent review. Introduced by `b4bc372`; F09a's review did not run `pnpm run lint`.

## Not demonstrated
Real UI/API/worker journeys, application screenshots, N-1 migration, SAST/dependency/secret scans: not run, since the candidate is not lint-clean and a new failure returns to Orchestrator for diagnosis (no further blind round). Red-flag rule content stays BLOCKED on D-12a. Not submitted to QA, not Integrated, no gate approved.
