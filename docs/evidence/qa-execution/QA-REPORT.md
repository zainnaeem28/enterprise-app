# QA execution report (HEAAA-29)

Candidate under test: `3cb45ed` (product tree identical to INT-05 `af27830`; this branch adds only QA files under `tests/` and `docs/evidence/qa-execution/`).
Executor: QA Engineer. Date: 2026-11-10. This is an execution report, not a G2/G3 acceptance and not human approval.

## Environment actually used (`ENV-INT/ci`-equivalent, local)

- Host: Linux 6.8, uid `node` (non-root), Node v24.22.2, pnpm 12.16.1 (frozen lockfile install).
- Database: PostgreSQL 17.11 (embedded-postgres binary from `/tmp/epg`), `initdb -E UTF8 --locale=C.UTF-8`, throwaway cluster on 127.0.0.1:58291, trust auth, one throwaway database per run, synthetic data only.
- API and worker: the real built processes (`pnpm build`), fixture IdPs and the per-run admin WebAuthn fixture. No mocks of the API in the API suites.
- Browser: Chromium 156.0.8078.4 (Playwright 1.64.1 headless shell), installed with `scripts/ci/install-browser.sh`. Firefox and WebKit were **not** run (their system libraries are not present on this host).
- Not available: Docker daemon, k6, `ENV-INT/staging`, `ENV-LOAD`, Google/Workspace test tenant, object store, scanner, video vendor, CMS, analytics sandbox. Everything that needs them is Blocked below. Nothing was mocked into a pass.
- QA suites (QA-03..QA-07) were written against INT-04 and live on their ticket branches, not on this candidate. I overlaid their `tests/**` from the reviewed commits (00faee1, e41105c, df3699c, 8efad43) onto `3cb45ed`. Two harness fixes were needed because the suites predate migration 2403 / the admin realm (details under "Harness changes").

## Results by suite (raw output in this folder)

| Suite | Command / scope | Result |
| --- | --- | --- |
| Boundary, typecheck, lint | `pnpm test:boundary`, `pnpm typecheck`, `pnpm lint` | pass (no errors) |
| Unit | kernel 141, api 289, worker 139, ui 172, app-shell 87, patient 186, staff 282, site 56, cms 88 | **all pass, 0 skipped.** First api run failed (see QA-EXEC-F12) |
| integration-db (`scripts/ci/migration-check/integration-db.sh`) | db-foundation 120, kernel 23, api 1015, worker 121 = 1279 tests, migrations from empty | **pass, 0 fail, 0 skipped.** Upgrade path / N-1 **did not run**: no previous release tag |
| db-test and referral scope | `db/tools/db-test.mjs` 70, `db/tests` 50 | pass |
| Browser accessibility (QA-06, Chromium only) | TC-A11Y-01 axe at 1280 and 360 px on 58 pages, TC-A11Y-04/05/06 and TC-XB-01 automated parts | **125 passed, 0 failed** (Chromium). Firefox/WebKit not run |
| Admin real-stack browser journey (`scripts/ci/admin-stack.mjs`) | enrol, WebAuthn sign-in, create service and reload, audit viewer, break-the-glass review, with screenshots | **7 of 7 steps ok** |
| QA-03 identity/authorization/security | 63 tests | 42 pass, **6 fail**, 15 skipped (Blocked) |
| QA-04 booking, calendar, notifications, pre-consultation, safety, clinical | 53 tests | 46 pass, **7 fail** (one passes on rerun with the correct log path, see below), 0 skipped |
| QA-05 platform and site (telehealth, audit, documents, privacy, admin, brand site, messaging, merge, API conventions) | 95 tests | 54 pass, **9 fail**, 32 skipped (Blocked). Two of the 9 are a harness log-path assumption: rerun of `api.test` + `audit.test` with the expected `reports/qa05/logs` gives 17 pass, 0 fail, 7 skipped. **Net: 7 real failures** |

Net real test failures on this candidate: **QA-03 6 + QA-04 6 + QA-05 7 = 19 failing cases, mapping to the findings below.** (QA-04: TC-NT-05 passes when logs are at `reports/qa04/logs`; rerun 7/7.)

## Findings (stable IDs, reproduced on `3cb45ed`)

| ID | Sev | Cases | Defect | Prior ID |
| --- | --- | --- | --- | --- |
| QA-EXEC-F01 | blocking | TC-AZ-10, TC-AZ-16 | `POST /patients/{id}/break-glass` still answers 404. Break-the-glass cannot be opened through the API; reason boundaries and compliance alert untestable | QA03-F02 |
| QA-EXEC-F02 | blocking | TC-SEC-01, TC-SEC-C7-03 | A refusal for a missing/stale elevation (`403 identity.elevation_required`) writes no `denied` audit event | QA03-F01 |
| QA-EXEC-F03 | blocking | TC-TH-02, 03, 05, 07, 08 | Telehealth routes (`GET /appointments/{id}/video-session` etc.) are not mounted: 404 for the patient's own video visit | QA05-F01 |
| QA-EXEC-F04 | blocking | TC-PR-02 | Patient data export package ends `failed` (`privacy.contributor_missing`); the patient still sees `in_progress` | QA05-F02 |
| QA-EXEC-F05 | P0 | TC-BK-17 | Three parallel assignments of the same room all return 200 (room collision not prevented) | QA04-F02 |
| QA-EXEC-F06 | P0 | TC-SAF-01/04b | A red flag raised through the questionnaire path creates no durable alert (0 rows). The triage path (TC-SAF-01/03c) now passes, so QA04-F01 is **partly fixed** by migration 2406 | QA04-F01 (partial) |
| QA-EXEC-F07 | P1 | TC-BK-11 | Front desk cannot book for a patient (`POST /holds` 403) | QA04-F03 |
| QA-EXEC-F08 | P1 | TC-BK-01a, TC-CAL-05 | `.ics` download not served (404); calendar webhook and `/calendar-link` not mounted (404 instead of 401) | QA04-F04, F05 |
| QA-EXEC-F09 | P1 | TC-AD-09 | Maintenance banner is returned on 0 of 3 portal hosts | QA05-F06 |
| QA-EXEC-F10 | P2 | TC-AZ-09, TC-SEC-20 | Staff-scope drift job raises no `scope_drift` alert; audit-export rate limit not enforced (30 accepted) | QA03-F03, F04 |
| QA-EXEC-F11 | decision | TC-BK-15 | Cap 2 admits 3: spec conflict (2 vs 1+cap), no decision-log entry. Reported failed, not passed | QA04-F07 |
| QA-EXEC-F12 | P3 | unit tests | `apps/api` unit tests fail on a clean checkout when run before the worker is built (`crosscheck.test.js` imports `apps/worker/dist`). Passes once the worker is built; CI order hides it | new |

F01..F09 plus F11 match defects that QA-03/04/05 reported on INT-04; INT-05 fixed only part of F06. I did not diagnose root causes beyond the evidence in the raw files. Correction tickets must go through the Orchestrator. All of F01..F04 are blocking by the blocker policy until fixed or formally waived by an independent decision.

## Blocked (not executed, never counted as passed)

- Requires missing environments: all TC-PERF and TC-REC load/recovery cases (no k6, no `ENV-LOAD`), TC-API-01 / TC-API-09 (deployed stack, Schemathesis contract run), container image scan and `e2e-smoke` (no Docker), TC-DOC-01/02/05/08 (store, scanner), TC-AD-11/12/15 (integration sandboxes, secret store), TC-TH-01/04 (video vendor), TC-BS-03/04/08 (CMS, analytics, browser consent), TC-AU-08/09, TC-MG-05/08..11/13/14, TC-PP-03/05/06/07, TC-ID-01..07, TC-SEC-06/11/15..19/24/25 (as listed in `qa03-identity-authz-security/spec.txt` and `qa05-platform-site/spec.txt` with each reason).
- Firefox and WebKit axe/XB runs: not run here (Chromium only).
- Upgrade path and N-1 compatibility: no previous release tag.
- Browser screenshots of the doctor, front-desk, site, CMS and telehealth journeys: only the admin journey was driven in a real browser on the real stack; the others have API-level coverage only.

## Pending-human (not performed by anyone)

TC-A11Y-02/03/07/08 and the human parts of 04/05/06 (screen readers, zoom, real devices), TC-XB-02, TC-XB-03, and every case marked human-required in TEST-CASES. They stay pending until the actual person performs them.

## Harness changes (test code only, no product file changed)

- `tests/e2e/journeys/lib/seed.mjs`, `world.mjs`: role grants now go through the two-person request states (`ensureGrantors`/`grantRole`, copied from the QA-05 harness) because `role_assignment.granted_via_request_id` is a validated FK since migration 2403.
- `tests/e2e/journeys/lib/stack-up.mjs`: adds the admin attestation fixture variables the API now requires, waits for the IdP JSON by polling, and honours `QA_PORT_OFFSET` (default 0) to avoid fixed-port clashes on a shared host.
- QA-03/05 suites unchanged. Two suites read logs from a fixed `reports/qa0N/logs` path; I ran those files with that output directory.

## Reproduction

`export EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:<port>/postgres` (UTF8 cluster; a SQL_ASCII cluster makes `char_length` count bytes and fails one admin test, which I hit and fixed in my setup, not in the product), `pnpm install --frozen-lockfile && pnpm build`, then `scripts/ci/migration-check/integration-db.sh`; `tests/api/identity/run.sh <out>` (QA-03); the QA-05 and QA-04 stacks via `tests/api/platform/lib/stack-up.mjs` and `tests/e2e/journeys/lib/stack-up.mjs` (as `docs/evidence/qa-execution/*/spec.txt` headers and the per-ticket READMEs show); Playwright a11y with `QA_BROWSERS=chromium`; `node scripts/ci/admin-stack.mjs`.

## Limits

Single local run, Chromium only, no staging, no load. A green result here is not a statement about those. Independent review of this report is required; nothing here is acceptance.
