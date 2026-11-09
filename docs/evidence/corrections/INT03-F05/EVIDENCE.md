# INT03-F05 evidence (HEAAA-313)

Implements the Architect ruling HEAAA-311 `ruling` revision 2 (`b5999c82`). Base: HEAAA-133 evidence commit `1cd3cbc`. Synthetic data only.
Tools: node v24.22.2, pnpm 12.16.1, PostgreSQL 17 at `ehr-test-db` (EHR_TEST_ADMIN_URL). Raw output: `raw/`.

## Changes
- `db/tools/catalog-lists.mjs`: `reporting_ro` in `policyRoles`; the four `reporting.ops_*` in `reportingViews` (ruling 4.1; hand-applied, `catalog-lists.requested.patch` not applied).
- `db/migrations/2102_reporting_alert_type_format.sql` (CHECK NOT VALID) and `2103_..._validate.sql` (VALIDATE) per ruling 4.2.
- `reporting.dbtest.ts`: T-5, T-6, T-7, T-8, T-9 (extended refused list), T-10 (own test); `testkit.ts` re-exports `repoRoot`.
- Not changed: `catalog-check.mjs`, organisation test, `db-test.mjs`, `2100`/`2101`, README, the `.patch`.

## Results
| Check | Result | Raw |
| --- | --- | --- |
| T-1 `catalog-check.mjs` on a migrate-from-empty DB | M-3 pass, M-4-reporting pass, M-4-views pass; no violation names `reporting.`. Remaining fails: M-5-patient-guard (19), M-5-definer (8) = INT03-F03 | `raw/catalog-check.json` |
| `check-migrations.mjs` | ok: 87 migrations (2102, 2103 clean) | `raw/check-migrations.txt` |
| T-2, T-5..T-10 `reporting.dbtest.js` | 29 tests, 28 pass, 1 fail: "the feed carries no patient data" fails with `patient not found` (PM008) = INT03-F08, found as-is (ruling section 5 note). T-5, T-6, T-7, T-8, T-9, T-10 pass | `raw/reporting-dbtest.txt` |
| T-3 db-foundation "catalog checks M-1..M-5" | fails; set is only M-5-patient-guard, M-5-definer (no M-3, no M-4-reporting) | `raw/integration-db-run.txt` |
| T-3 api, organisation "repository catalog check passes" | fails; actual `['M-5-patient-guard','M-5-definer']` (F03) | same |
| integration-db.sh db-foundation + api (N-1 skipped) | db-foundation 37 pass / 3 fail; api 825 pass / 48 fail (same totals as INT-03 r1 scratch-patched run); failures not in reporting except F08 above | same |
| `pnpm run lint`, `test:boundary`, `install --frozen-lockfile` | pass | `raw/lint.txt`, `raw/boundary.txt` |
| `pnpm run format:check` | fails on 5 pre-existing `apps/staff/**/evidence/*` files, outside my paths and untouched | `raw/format.txt` |
| `pnpm run typecheck` / `build` | fail in `apps/api` on pre-existing `composition.ts(187)` and `identity-label.dbtest.ts(63)` (the INT-03 r1 `local-compile-fixes.patch` items, not in my paths); no error in files I touched | `raw/build.txt` |

## Limitations
- T-4 (full pass) needs HEAAA-312 (F03) merged: INT-03 round 2.
- T-10 puts the canary in `resource_id` with `patient_id` NULL, because the canary patient cannot be inserted while F08 persists; the original test is left as found.
- Execution finished is not review passed, integrated or approved.
