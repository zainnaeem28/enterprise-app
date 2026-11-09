# INT-04 round 3 (last allowed round): result

Candidate: merge tip of branch HEAAA-139 after three reviewed merges (see `raw/int04-r3/gates/candidate-commit.txt`), checked in a clean detached checkout, frozen install.

## Merged (one at a time, reviewed revisions only, all clean)
| Finding | Commit | Review |
|---|---|---|
| INT04-F12 prettier on DO-02 README | `3526621` | HEAAA-485 PASS |
| INT04-F02/F13/F14 worker admin jobs rebased, key-shaped fixture removed | `8810123` | Backend HEAAA-487 PASS (conditional on integration-db), Security HEAAA-488 PASS |
| INT04-F03/F15 admin portal, sign-in link, axe | `a6d8a97` | Frontend HEAAA-490 PASS |
| INT04-F16 isolated PostgreSQL 17 script | `6e3a10e` | **not merged**: HEAAA-492 CHANGES REQUIRED (F16R-1, F16R-2) |

## Executed gates (raw in `raw/int04-r3/gates/`)
| Gate | Result |
|---|---|
| frozen install, `pnpm -r run build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `test:boundary` | pass |
| unit (run-unit.mjs) | 1311 tests, 0 failed, 0 skipped (staff 278, worker 139, api 266, kernel 141) |
| release + deploy tests | 43/43 |
| workflow hygiene, actionlint, semgrep | pass |
| gitleaks full history | **FAIL, 10**: see F18; the F13 finding is closed (commit `abbdd6b` is no longer in the candidate) |
| integration-db (db-foundation, kernel, api, worker; run on the CI-provided PostgreSQL 17 `ehr-test-db`, not the private server) | **FAIL**: kernel 23/23, api 1006/1006, worker 121/121 (admin worker jobs and bootstrap-admins pass), db-foundation 119/120, one failure (F17) |
| N-1 (n-minus-1.sh) | not run: no previous release tag |
| tofu / tflint | not run: tools not available (HEAAA-291) |
| real application screenshots of the admin path | **not produced**: no browser exists in this environment (no Chromium or Playwright browser installed). The screenshots committed in `apps/staff/src/app/evidence/screenshots` come from the F03 author against a contract mock, not against the integrated API and database. |

## New findings
- **INT04-F17 (Blocking, owner Backend Engineer; reviewer Backend Reviewer)**: `db/tests/referral-accept-scope.test.mjs:930` asserts `definerInventory.length === 27`. `db/tools/catalog-lists.mjs` now lists 28 (it adds `identity.bootstrap_admins`, INT04-F02b, HEAAA-466; its own comment already says 28). The test and its comment must say 28 and keep the exact-membership assertion. Failing test: `T-RA-29: catalog > owners, SECURITY DEFINER, search_path, EXECUTE lists and inventory` (28 !== 27). Introduced by `c067035`.
- **INT04-F18 (Blocking for the gitleaks gate, owner Cybersecurity; reviewer Security Reviewer)**: gitleaks `generic-api-key` reports 10 in full history. Only one is in this candidate's history: my round-2 evidence commit `f9274d7`, file `raw/int04-r2/gates/integration-db-partial-aborted.txt` lines 251 and 397 (a JSON list of migration file names flagged as a key; no credential). The other six are in QA-04 branch commits (`0de3e06`, `cfc7f66`) and the old F02 commit `abbdd6b`, none in the candidate. Fix options for the owner: a narrow, exact path and value allowlist in `gitleaks/gitleaks.toml` (the INT03-F12 pattern) or an approved rewrite of the evidence commit. I did not edit the gitleaks config (outside my allowed paths).
- **INT04-F19 (limitation, owner DevOps / Frontend; reviewer Release Reviewer)**: no browser, no tofu/tflint, no previous release tag in the integration environment. Needed for the real admin screenshots (BUILD_REVIEW package), IaC lint and N-1.
- **INT04-F16 (still open)**: `6e3a10e` is CHANGES REQUIRED. The shared CI-provided server worked this time (4m43s), so F16 no longer blocked this round; the private-server script is not part of the candidate.

## State
Integration round 3 of 3 is used. Not submitted to QA. Not integrated, not human-approved, not deployed. At three unresolved rounds the correction loop stops and escalates; only a human decision can grant a new bounded diagnosis cycle.
