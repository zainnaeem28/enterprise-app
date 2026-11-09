# INT-04 result, round 10 (F31 + F32 + F33 merge)

Candidate = r9 tip `5abb480` + `52eddaf` (HEAAA-558: F31 driver locator `ffac9e9`, F32 audit default To `52eddaf`; Frontend HEAAA-560 PASS, Release HEAAA-561 PASS) + `5b48400` (HEAAA-559: F33 gitleaks allowlist, 2 commits; Security HEAAA-562 PASS). Merge commits `fa0ae7c` and `3ff800d` (frozen candidate **3ff800d**), branch `HEAAA-139-int04-r10`. Both merges were conflict-free; no content was written by the Integrator beyond the merges and this evidence. Nothing from r9 results was reused.

Not found: a DevOps Reviewer PASS on `5b48400` (HEAAA-562's comment says it is still required before merge). Only the Security PASS was seen by the Integrator. Orchestrator should confirm it exists before the candidate is submitted to QA.

## Environment (clean frozen checkout, `/tmp/int04r10/repo`)
PostgreSQL 17.11 (embedded-postgres binaries, trust auth, loopback 55410), cluster **UTF8 / C.UTF-8**, Node 24.22.2, pnpm 12.16.1 `--frozen-lockfile`, Chromium 156 headless shell, gitleaks 8.30.1, semgrep 1.184.0. Ports API/staff/TLS 3020/4186/4456. Synthetic data only.

## Executed
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile`, `pnpm build` | pass |
| `pnpm lint`, `format:check`, `test:boundary`, `typecheck` | pass |
| unit (`run-unit.mjs`) | pass (app-shell 87, staff 172 in the last suites shown; 0 failed) |
| semgrep (`sast.sh`) | pass: 1588 files, 5 non-blocking findings (as r9) |
| **`secrets.sh` full history + working tree** | **pass**: no leaks (F33 closed) |
| integration-db run 1 (`INTEGRATION_SKIP_N_MINUS_1=true`) | **FAIL**: 1279 tests, 1 failure (api): `admin.dbtest` "concurrent writes of one flag leave exactly one row and a consistent audit trail" - `each audited "before" is the previous audited "after"` (INT04-F34) |
| integration-db run 2 (identical, from scratch) | pass: 1279 tests (db-foundation 120, kernel 23, api 1015, worker 121), 0 failed |
| that test file alone, 5 consecutive runs | pass 22/22 each time |
| `admin-run.mjs --selftest`, `admin-stack.mjs --selftest` | pass |
| `prepare-db.sh ehr` (migrations to 2407) | pass |
| `admin-stack.mjs` (CI=true EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1) | **pass, exit 0, 7/7 steps** |
| F31: create a service, saved, persisted after reload | **CLOSED** (steps 3 and 4 ok) |
| F32: audit viewer last 24 h shows entries | **CLOSED** (step 5 ok; screenshot `06`: 8 entries, To 09:11 PM, rows at 9:11 PM) |
| enrolment, WebAuthn sign-in, break-the-glass decision + persistence | pass |

Not run: `deps.sh` (lock file unchanged), actionlint/deploy policy (no change to those paths), N-1 compatibility (skipped as in r9; no previous release tag), container scan.

Run-order notes (not product defects): admin-stack attempts 1-3 failed for environment reasons before attempt 4 passed from a freshly dropped and re-migrated `ehr` database: (1) missing `CI=true`, (2) Chromium shared libraries not on `LD_LIBRARY_PATH` (set to `/tmp/ci-tools/root/...`), (3) the seed is not idempotent, so a second run on a used database fails with `principal_realm_subject_uq`. Logs: `r10/gates/`, `admin-stack-attempt*`. The passing run is the last one; it used a fresh database.

## New findings
**INT04-F34** (intermittent test, `apps/api/src/modules/organisation/admin/admin.dbtest.ts` ~L438-, "feature flags: concurrent writes of one flag ..."): failed once in 2 full integration-db runs with `each audited "before" is the previous audited "after"`, passed in the second full run and in 5/5 isolated runs. The F31-F33 diff touches no API code, so this is not caused by the candidate; it is either a timing-dependent test or a real race in how concurrent flag writes record the audited "before" value (possible audit-trail inconsistency under concurrent writes). Needs an API/Backend owner to decide (test flake vs product race). Not patched. Severity for the Orchestrator: medium until classified, because the assertion is about audit integrity.

**INT04-F35** (informational, `scripts/ci/admin-stack.mjs` / seed): the stack start is not re-runnable on a used database (`duplicate key ... principal_realm_subject_uq`). CI uses a fresh database per job, so no CI impact. Not patched.

## Result
F31, F32 and F33 are closed on the combined candidate `3ff800d`. All gates pass; the admin-stack passes 7/7 (first time), with actual-application screenshots. One intermittent API test failure (F34) was seen once and did not reproduce; it needs classification before INT-04 is submitted to QA. This is not QA, G3 or deployment approval.

## Raw output
`docs/evidence/integration/M5/r10/`: `admin-stack.txt`, `summary.json`, `api.log`, `worker.log`, `tls-front.log`, `staff-preview.log`, `prepare-db.txt`, screenshots `01`-`10`, `gates/` (lint, format-check, test-boundary, typecheck, unit, sast, secrets, integration-db run 1 and 2 (migration-name lines filtered from logs), exit-codes).
