# INT-03 integration round 3 (HEAAA-133)

Cumulative integration rounds: **3 of 3** (review-ledger). Base: r2 evidence `11eb194`. Raw: `raw/r3/`.
Merged one at a time, each tip independently reviewed PASS: `c8af1ee` F03 Part B (HEAAA-334), `3867c37` F08a (318), `4aaeb41` F08b (319), `2ad6781` F08c (320), `2f6aaa9` F08d (321), `d41e724` F06-02 (322), `7a0c75f` A-4 docs (335).

## Conflict needing re-review
Merging `2f6aaa9` conflicted with F03B in `db/tools/catalog-lists.mjs` and `db/tools/db-test.mjs`: both amendments (each called "A-4") extend `definerInventory` by two (messaging predicates; referral definers, migration 2300), each asserting 25. Resolved to keep both: 27 entries; T2 and I-10 assertions set to 27. The resolved content differs from both reviewed tips, so it needs independent re-review (INT03-F09b).

## Executed (merged tip, exit codes)
| Check | Result |
|---|---|
| frozen install, lint, format:check, typecheck, build, test:boundary | pass |
| unit via `scripts/ci/run-unit.mjs` | pass: 1024 tests in 8 reports, none skipped or failed |
| `integration-db.sh` (N-1 skipped) | db-foundation 54/54; kernel 23/23; worker 79/79; api 884: 883 pass, **1 fail** |

## Remaining failure
INT03-F09a: `apps/api/src/modules/scheduling/core/binding.dbtest.ts:312` "staff accept a referral at their own location only" calls `ensure_care_relationship(..., 'referral')` directly; with the F08d referral-bound path (2300) it now raises `no pending referral of this patient to this location`. Test fixture is stale against the F08d contract; needs Backend correction (use the referral-bound path or seed a pending referral) and independent review.

## Not demonstrated
Real UI/API/worker journeys, application screenshots, N-1 migration, scans. Red-flag rule content stays BLOCKED on D-12a. Not submitted to QA.
