# INT-01 integration report (M2) — candidate NOT ready for review

Integration branch `HEAAA-95-…`, merge head recorded below. Integrator: first merge round.

## Merge order and reviewed inputs (all branch tips equal the reviewed revisions)
1. BE-06 tip `49155ff` (chain already carries BE-01 `3e2d11e`, BE-03 `fa0e9c8`, BE-02 `fa5956f`, BE-04 `c274c74`, ID-FREEZE erratum) — clean merge.
2. FE-02 `1ad8b52` — one conflict, `pnpm-lock.yaml`; re-resolved with `pnpm install --lockfile-only` then `--frozen-lockfile` OK (lockfile differs from both reviewed lockfiles: re-review needed).
3. F-09 `6313e52` — clean merge.

## Checks actually executed (local, Node v24.22.2, pnpm 12.16.1, PostgreSQL 17 embedded, not Docker/CI)
| Check | Result | Raw report |
|---|---|---|
| pnpm lint / format:check | PASS | raw/lint.txt, raw/format.txt |
| pnpm build | PASS | raw/build.txt |
| pnpm typecheck on clean tree (CI lint-types order) | FAIL (worker cannot resolve @ehr/kernel before build) | raw/typecheck.txt |
| pnpm typecheck after build | PASS | raw/typecheck-after-build.txt |
| run-unit.mjs | FAIL: every suite passes its tests (boundary, api 49, staff 4, worker 42, kernel, ui) but no package writes JUnit as the job requires | raw/unit.txt |
| integration-db.sh (PG 17) | FAIL: db-foundation 29 tests/2 failures, kernel 23/0, api 228/3 failures, worker 72/0 | raw/integration-db.txt, reports/integration-db/ |
| N-1 / upgrade path | NOT RUN: no previous release tag | — |

## Findings (to be filed in the common ledger; stable IDs proposed)
- INT01-F1 (blocking): db-foundation catalog checks M-3 and M-4 fail — `catalog-lists.requested.patch` (BE-02/BE-03 condition) never applied to `db/tools`; 7 `organisation.public_*` views still seen as violations.
- INT01-F2 (blocking): BE-03 `organisation.dbtest` (2 asserts) expects exactly seven directory views and only the kernel public policy; BE-04 legitimately added `identity.public_clinician` view and `principal_directory` / `staff_profile_directory` public policies. Contract drift between BE-03 and BE-04 expectations; test and catalog lists need one agreed list.
- INT01-F3 (blocking for CI): `unit` job fails — workspace `test` scripts (api, staff, worker, app-shell, kernel, ui) do not write JUnit to `$JUNIT_DIR` as `scripts/ci/run-unit.mjs` requires.
- INT01-F4 (blocking for CI): `pnpm typecheck` fails without a prior build (CI `lint-types` job does not build).
All four are outside INT-01 allowed paths; correction tickets via Orchestrator.

## Not done
Auth-slice journey (browser -> same-origin API -> OIDC conformance IdP -> session -> scoped read -> audit event), screenshots, container build, other CI jobs (sast, secrets, deps, contract, a11y, e2e). Not attempted while integration-db is red. Real Google Workspace sign-in remains BLOCKED (C-10).

State: executed partially; not verified, not reviewed, not human-approved, not deployed.


---
# Round 2 (candidate a3732c5; F1-F4 fixes and FE-02 lockfile re-review all independently reviewed)
Local, Node v24.22.2, pnpm 12.16.1, PostgreSQL 17.11 (provided ehr-test-db), clean frozen install. Raw: raw/r2/, reports/integration-db-r2/.
| Check | Result |
|---|---|
| pnpm lint | PASS |
| pnpm format:check | FAIL: scripts/ci/run-unit.mjs not prettier-formatted (INT01-F5) |
| pnpm typecheck on clean tree | PASS (F4 resolved) |
| pnpm build | PASS |
| run-unit.mjs | PASS: 437 tests, 7 JUnit reports, 0 skipped/failed (F3 resolved) |
| integration-db.sh (N-1 skipped, no release tag) | FAIL: db-foundation 29/1 fail, kernel 23/0, api 228/1 fail, worker 72/0 |
F1 and F2 verified resolved (M-3/M-4 pass, directory-view asserts pass).
## New findings
- INT01-F5: `pnpm format:check` fails on scripts/ci/run-unit.mjs (introduced by the F3-R1 fix); CI lint-types/format job would fail.
- INT01-F6 (blocking): catalog checks M-5-patient-guard and M-5-anonymous fail. M-5-patient-guard: identity.patient_link, identity.proxy_grant, notifications.notification, notifications.delivery_receipt, notifications.in_app_read have patient_id but neither the merge write guard nor an exemption. M-5-anonymous: six identity sign-in policies (person_signin_insert, principal_signin_select/insert/update, session_lookup, session_signin_insert) can match audience anonymous but are not in the ARCHITECTURE 21.3 list in db/tools. Needs BE-04/BE-06 owners and db/tools owner to agree guard/exemption and anonymous lists (security review of anonymous policies). The api organisation dbtest repeats the same failure.
Still not done: auth-slice journey, screenshots, other CI jobs (not attempted while red). Real Google Workspace sign-in BLOCKED (C-10). Reviews: none started; cumulative rounds 0.
