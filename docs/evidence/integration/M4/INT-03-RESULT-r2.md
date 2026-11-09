# INT-03 integration round 2 (HEAAA-133)

Cumulative integration rounds: **2 of 3**. Base: r1 evidence `1cd3cbc` (candidate `c48db50`).
Merged one at a time, no textual conflicts, in dependency order (each tip independently reviewed PASS):
`4c9b638` F02 (HEAAA-307), `9a5b5ee` F01 (HEAAA-308), `32aee50` F04 (HEAAA-309), `f055fcd` F03 Part A (HEAAA-312), `abf860d` F05 (HEAAA-313), `724c25c` F06 review (HEAAA-314), `1b65a56` F07 (HEAAA-315). Tip: see `git log` (merge `b2cbb14`).
Raw: `raw/r2/`.

## Executed
| Check | Result |
|---|---|
| frozen install, lint, format:check, typecheck, build, test:boundary | all pass (exit 0) |
| `integration-db.sh` (N-1 skipped) | db-foundation 43/42 pass 1 fail; kernel 23/23; worker 79/79; api 884: 879 pass, 4 fail |
| `pnpm -r test` (not the CI unit command; kernel needs DB, ui SIGKILL) | not valid evidence; unit suite to be rerun with the CI command |

r1 -> r2: api failures 53 -> 4, db-foundation 3 -> 1; F01, F02, F04, F07 closed in execution; F06 reviewed PASS (two findings open in its review doc).

## Remaining failures
1. db-foundation / organisation: catalog `M-5-definer` lists `messaging.is_participant/is_owner/is_creator`. INT03-F03 Part B (2203/2204) waits on human decision A-4 (ruling HEAAA-310). Not closed.
2. `chart.dbtest` "every clinical table forces RLS": expected list stale after merge (INT03-F08a, test fixture owned by BE-16/Backend).
3. `reporting.dbtest` ops feed no-patient-data test: inserts alert with a patient not registered; merge write guard raises `patient not found` (INT03-F08b). A comment in the test already notes the NULL-patient workaround elsewhere.
4. `rls-matrix.dbtest` catalogue shape: every patient table needs rows for patients A and B (INT03-F08c; new M4 tables lack seed).
5. `frontdoor-flows` accept path 404 (TODO-marked test, INT03-F08d, caller_sees location).

## Not demonstrated
Real UI/API/worker journeys, application screenshots, N-1, scans, unit suite on CI command. Red-flag rule content stays BLOCKED on D-12a. Not submitted to QA.
