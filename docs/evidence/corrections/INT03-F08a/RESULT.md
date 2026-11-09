# INT03-F08a — chart.dbtest "every clinical table forces RLS" (HEAAA-318)

Base: HEAAA-133 r2 evidence commit `11eb194`. Tools: see `raw/versions.txt`. Synthetic data only; no migration added.

## Change
`apps/api/src/modules/clinical/chart/chart.dbtest.ts`: the hand-kept six-name expected list is no longer the expectation. The catalog query (every `r`/`p` relation in schema `clinical`) is the set under test; the per-table assertion `[relrowsecurity, relforcerowsecurity, owner] = [true, true, 'app_owner']` is unchanged and runs for every catalog table. The chart module's own six tables must still exist; the zero-public-policy assertion is unchanged. `TABLES` is still used (unchanged) by the other loops in the file. No table is excluded.

Tables added to the verified set (present on the merged revision, absent from the old list): `consent_exception`, `encounter`, `follow_up`, `note`, `note_addendum`, `note_cosign`, `questionnaire_response`, `referral`, `referral_inbox`, `triage_assessment`. All have forced RLS owned by `app_owner` (test passes).

## Results (command: `INTEGRATION_SUITES=api INTEGRATION_SKIP_N_MINUS_1=true bash scripts/ci/migration-check/integration-db.sh`)
- Before (`raw/integration-db-before-full.txt`): the target test FAILS (diff lists the 10 tables above); api suite 884 tests, 4 failures.
- After (`raw/integration-db-after-full.txt`): target test PASSES (line 290); api suite 884 tests, 3 failures + the TODO test, all outside this ticket: reporting no-patient-data feed (F08b), rls-matrix catalogue shape (F08c), and the repository catalog-check test (not in F08a; reported, not touched). The suite as a whole is still red; this ticket does not make it green.
- Negative control (`raw/negative-control.txt`): a temporary, uncommitted `CREATE TABLE clinical.zz_negative_control` (no RLS) made the test fail with `zz_negative_control: [false,false,'postgres'] vs [true,true,'app_owner']`. Removed afterwards.
- Common checks (all exit 0, raw in `raw/`): install --frozen-lockfile, lint, format:check, typecheck, build, test:boundary.

## Limitations
Executed only; not reviewed, integrated, approved or deployed. The N-1 upgrade step was skipped (`INTEGRATION_SKIP_N_MINUS_1`). Raw logs are of the pre-commit tree on base `11eb194` (`raw/base-commit.txt`).
