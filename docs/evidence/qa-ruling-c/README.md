# QA execution: cases unblocked by owner ruling C (HEAAA-805)

Task HEAAA-805, executor QA Engineer. Reviewer: independent (HEAAA-806). Not self-accepted. Not human approval, not G3.

## Candidate

| Field | Value |
| --- | --- |
| Base | `origin/dev` `b63f1a7` (Merge HEAAA-797, after the HEAAA-804 integration of the C tickets) |
| Test head | `d357128` (tests only). Every result below was produced from this tree. |
| Evidence head | the commit that adds this folder and the `docs/TEST-CASES.md` edits (documents only; no code, no test file changes). The reviewer checks the branch head SHA given in the task comment. |
| Product code | unchanged. Allowed paths only: `tests/**`, `docs/TEST-CASES.md`, `docs/evidence`. |
| Environment | local Linux server, no Docker. Embedded PostgreSQL 17 (throwaway, loopback, trust auth), real built API and worker processes, two fixture IdPs, per-run TLS front for the admin realm (the QA-05 stack, `tests/api/platform/lib/stack-up.mjs`). Node 24.22.2, pnpm 12.16.1. Synthetic data only. |
| Source of truth | owner ruling 2026-11-11 (C), `HEAAA-33` comment 56261f7e-58eb-4b31-a1d3-81c5fc2240cb. Conservative product defaults, not legal or clinical advice. † = counsel confirms before go-live. Each value is configuration; a later answer is a settings change plus a rerun of `ruling-c.test.mjs`. |

## Result

`tests/api/platform/*.test.mjs` on `d357128`: 92 tests, 66 pass, **0 fail**, 26 skipped (all skips are the earlier BLOCKED cases that need a vendor, object store or other infrastructure; unchanged by this task). Raw output: `spec.txt`, `junit.xml`.

New file `tests/api/platform/ruling-c.test.mjs`: 14 tests, 14 pass.

| Case | Result | Notes |
| --- | --- | --- |
| TC-PR-03 (2 tests) | pass | Deletion through the real routes and the real worker: account deactivated (old session 401, no new sign-in), preferences and an unaccepted upload deleted, encounter, allergy, accepted documents and audit trail kept, document under legal hold untouched, deletion record and no-PHI statement stored, audit event written. A refusal with a reason deletes nothing. A control patient is untouched. |
| TC-AU-09 (4 tests) | pass for what ran | Step 1: the 13 retention values equal the ruling, read from the product's own CLI. A bad override is reported by key name, never by value. Step 2: the real daily job purged the deletion past retention (tombstone), left a younger one and one under legal hold, wrote a report with counts only, removed no audit row older than 7 years, and the database refuses an application-role delete. Step 3: an 8-year-old audit row is found by `CMP-1` and the search is audited. |
| TC-DOC-07 (1 test) | pass | Confirmation sets `retention_until` to today + 10 years. Inside the period refused; past it deleted; past it with a hold refused; allowed after the hold is released. |
| TC-PP-03, TC-PP-04, TC-PP-05, RA-R1-20b (4 tests) | pass | See `docs/TEST-CASES.md` 9.5 for the full list of what each step proves. |
| TC-TH-06, TC-TH-07, TC-TH-08 (3 tests) | pass | Fixture states `ZA` (licensed, operating), `ZB` (operating, not licensed), `ZC` (not operating). The organisation's operating states and the clinician's licensed states are set through the admin API. |

Mapping of test titles to IDs: the test titled "TC-PP-04 invite ... (TC-PP-03)" covers TC-PP-03 and TC-PP-04; the two tests titled "RA-R1-20b ..." are the staff guardian link / age rules and the age-out, and with the "TC-PP-05" test they cover TC-PP-05 and AC-32. The retention tests are the four under "TC-AU-09"; the licensing tests are "TC-TH-06/07/08".

Superseded tests removed from the older QA-05 files (their IDs now live in `ruling-c.test.mjs`): the TC-PR-03 test that asserted the old `blocked_d8` behaviour (it failed on this candidate: 1 failure in the first baseline run), the TC-AU-09 and TC-PP-03/05 BLOCKED skips, the TC-PP-04 "refused while undecided" test, the placeholder-state TC-TH-06..08 tests and the older TC-DOC-07 test. Unused imports left by that removal were cleaned in the same files only.

## Not run, and why (never a pass)

- **E-mail provider is not configured in ci (C-10, C-11).** The worker's mail and statement ports refuse. Not run: the mailed invitation code, the 30-day age-out notice mail, the deletion statement e-mail. Where a case needs the invitation code, the test overwrites the salted hash the real worker job stored with the hash of a code it chose (the job's pending retries for that grant are removed first). The test asserts that nothing is recorded as sent.
- **Audit-trail archive** (Object Lock bucket, DO-09b) does not exist in ci: the "archive moves only older rows" half of TC-AU-09 is not run. Backup, log and flow-log retention values are DevOps keys; they were read, not exercised.
- **Clock control.** No real time passes. "Older than the retention value", "the 18th birthday has passed", "the join window is open" are produced by writing the date columns the rules read (below the triggers, as the module dbtests do). The age-out job re-derives dates from the birth date, so the clock is moved through the stored birth date.
- **Real state values and † confirmations** stay on the go-live list. Fixture states are not real operating states.
- Human-required checks: none performed, none recorded.

## Ruling B jobs on the server (no hosted CI), run on `d357128` plus the documents-only evidence commit

Raw summary: `ci-summary-raw.txt`; extracts: `ci-extracts.txt` (raw logs are not committed: generated logs contain test-fixture strings that the secret scan flags).

| Job | Result |
| --- | --- |
| lint (`pnpm lint`) | pass (0 errors; 9 pre-existing warnings in files this task did not touch) |
| format (`pnpm format:check`) | **fail**: 6 files, none changed by this task (`apps/api/src/modules/telehealth/README.md`, `apps/cms/migrations/20261111_190000_site_content_npp.json`, `infra/accounts/README.md`, `infra/modules/aws-adapters/README.md`, `infra/RETENTION.md`, `scripts/ci/migration-check/README.md`). Outside allowed paths: finding QA805-F01 |
| typecheck | pass |
| build | pass |
| boundary (`pnpm test:boundary`) | pass |
| unit (`run-unit.mjs`) | suites pass (api 363, app-shell 89, cms 92, kernel 164, patient 211, site 76, staff 298, ui 175, worker 194, boundary 1; 0 failed) but the job **exits 1**: 6 skipped tests (the emulator tests for S3, KMS, Secrets Manager, SES need LocalStack/Docker), and skipped counts as failure. Not a pass |
| migration-check, seeded-violation control | pass, pass |
| integration-db (candidate) | **fail**: `db-foundation` 120/0 failed, `kernel` 23/0, `worker` 123/0, `api` 1138 tests, **1 failure**: `consent text: required, closed body, code-point limits, legacy textless draft cannot publish` (`apps/api/src/modules/organisation/admin/admin.dbtest.ts`). It reproduces in isolation on this tree. Finding QA805-F02 |
| N-1 upgrade (`r209`) | **fail**: "the previous release (r209) does not pass against the candidate schema". The same api test fails; the three db-foundation and two api failures marked "accepted pin" are the expected candidate-vs-previous differences, not passes |
| integration-db seeded-violation control | pass |
| secret scan | git range `origin/dev..HEAD`: **0 findings**. Full history: 24 findings, all in older commits (evidence files and two test files from earlier tickets; none from this branch). Working-tree scan: 154 findings in generated `reports/` (gitignored, written by the DB suites of this run) and older evidence files; none in files of this change. The scan script as run exits 1 because of the working tree and full history, so it is **not recorded as a pass** |
| dependency audit (OSV) | pass: 1 non-blocking finding (deepmerge 4.3.1, GHSA-gcqx-w48m-w2h4, no fix) |
| SAST (Semgrep 1.184.0) | **fail** (exit 1): two `PartialParsing` errors on `.github/workflows/loadtest-run.yml` (not changed by this task); no ERROR finding listed. Not recorded as a pass |
| bundle budget (gzip part) | pass: initial 97 566 / 122 880 B, largest lazy chunk 15 278 / 30 720 B, total 180 504 / 196 608 B. The Lighthouse part: not run (needs the staging-style served app) |
| a11y smoke | 4 of 8 pass, 4 fail because the test expects the API on `127.0.0.1:3000` (CI starts the API container): **not run in its valid configuration** |
| contract (Schemathesis), e2e-smoke, container scan, SBOM, workflow hygiene, admin-run, emulator, patient-e2e-a11y | not run: no hosted CI (owner ruling B); the ones that need Docker also have no Docker here |

## Findings

| ID | Severity | Statement | Owner |
| --- | --- | --- | --- |
| QA805-F01 | Low | `pnpm format:check` fails on `origin/dev` `b63f1a7` for 6 files from earlier tickets (list above). Not caused by this change; outside the allowed paths. | Developer who owns those files, via the Orchestrator |
| QA805-F02 | Medium | The api integration suite has 1 failing test on `origin/dev` `b63f1a7`: `admin.dbtest.js:719`, `POST /consent-templates` with a title of 200 emoji (200 code points) answers 400 `kernel.invalid_format` at path `/` where the test expects 200. It also makes the N-1 upgrade check fail. Reproduced in isolation with `node --test --test-name-pattern="consent text" apps/api/dist/src/modules/organisation/admin/admin.dbtest.js` on a PostgreSQL 17 server. Cause not investigated (product code is outside this task); it may depend on the host, which the developer should confirm. | Developer, via the Orchestrator |

## Reproduce

```sh
git checkout d357128 && pnpm install --frozen-lockfile && pnpm build
eval "$(scripts/ci/ephemeral-pg17.sh start)"   # use a short EPG_STATE path (unix socket path limit); the QA stack needs trust auth on loopback
bash docs/evidence/qa-execution/r2-cdc388d/harness/run-suite.sh "$PWD" qa05 tests/api/platform/lib out tests/api/platform/*.test.mjs
```
