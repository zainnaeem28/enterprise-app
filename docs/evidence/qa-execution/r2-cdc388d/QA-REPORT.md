# QA-REPORT: QA execution rerun on the corrected integrated revision (HEAAA-640, round 2 of the acceptance package)

| Field | Value |
| --- | --- |
| Task | HEAAA-640 `[ACCEPTANCE correction]`, executor QA Engineer. Reviewer: independent, to be assigned. This report is not self-accepted. |
| Candidate | branch `HEAAA-640-…`, base commit `cdc388d` (= integrated `3c1dbd3` from HEAAA-638 + the four DevOps commits of HEAAA-639). The earlier QA run was on `3cb45ed` / tree `af27830`. |
| Product code | unchanged by me. QA overlays (untracked, not part of the candidate): the QA-03..07 suites from reviewed commits 00faee1, e41105c, df3699c, 8efad43, restored by file list; plus my own changes listed in section 7. |
| Environment | local Linux host, embedded PostgreSQL 17 (UTF8), real built API and worker, real vite previews, Node 24.22.2, pnpm 12.16.1, Playwright 1.64.1; Chromium 156.0.8078.4, Firefox 157.0, WebKit 27.2. No Docker, k6, tofu, ENV-INT or ENV-LOAD on this host. |
| Result | **No failed case on the integrated revision.** 164 automated tests pass in QA-03/04/05 (48 + 53 + 63) plus 4 new T7 tests, 0 fail; 47 cases not executed (blocked, listed in section 5). Human-required checks: pending, none performed. |
| Not | Human approval, G3, deployment approval. Not a replacement for the CI run. |

## 1. Regression of QA-EXEC-F01..F12 (the previous 19 failed cases)

| Finding | Cases | Previous | Now |
| --- | --- | --- | --- |
| QA-EXEC-F01 break-glass route | TC-AZ-10, TC-AZ-16 | fail | pass |
| QA-EXEC-F02 denied audit on `elevation_required` | TC-SEC-01, TC-SEC-C7-03 | fail | pass |
| QA-EXEC-F03 telehealth routes | TC-TH-02, 03, 05, 07, 08 (06 also pass) | fail | pass |
| QA-EXEC-F04 privacy export ends `failed` | TC-PR-02 (steps up to portal delivery) | fail | pass; the download step TC-PR-02b is blocked (no package store) |
| QA-EXEC-F05 room double assignment | TC-BK-17 | fail | pass |
| QA-EXEC-F06 red flag creates no durable alert | TC-SAF-01/03c (durable alert row, listed, audited), TC-SAF-01/04a | fail | pass. The old ID `TC-SAF-04b` does not exist in the suite under that name; the case that tested it is TC-SAF-01/03c. |
| QA-EXEC-F07 front desk cannot book | TC-BK-11 | fail | pass |
| QA-EXEC-F08 `.ics`, calendar webhook | TC-BK-01a, TC-CAL-05 steps 1-2 | fail | pass. TC-CAL-05 beyond steps 1-2 needs a Google tenant and stays blocked. |
| QA-EXEC-F09 maintenance banner on 3 hosts | TC-AD-09 | fail | pass |
| QA-EXEC-F10 `scope_drift`, audit-export rate limit | TC-AZ-09, TC-SEC-20 | fail | pass |
| QA-EXEC-F11 cap 2 admits 3 | TC-BK-15 as written ("exactly 2"), plus the T7 cases of the HEAAA-632 ruling | fail | pass. T7 added by QA (section 7): cap 1 gives 1, cap 0 gives 1, cap 3 gives 3, two slots with cap 2 give 2 + 2. All 4 pass, with 100 and 40 parallel patients. |
| QA-EXEC-F12 api unit tests need worker built | unit | fail | api and worker unit pass in this run (1450 tests, none skipped). The clean-checkout proof (`git clean`, then `pnpm test`) is DevOps's, HEAAA-639: api 293, worker 139. I did not repeat it. |

No finding reopens. The two "decision" and "P3" items are closed by evidence, not waived.

## 2. Checks run on `cdc388d` (this run)

| Check | Result | Evidence (`raw/`) |
| --- | --- | --- |
| Module boundary fixture | pass (upward import rejected, downward accepted) | boundary.txt |
| Typecheck, build (all 10 workspace projects) | pass | typecheck.txt, build.txt |
| Unit | pass: 1450 tests in 10 reports, 0 skipped, 0 failed | unit.txt, unit-reports/ |
| integration-db | pass: kernel 23, api 1041, worker 122, db suites 4 (1306 tests); 0 failed, 0 skipped. "No previous release tag": upgrade path and N-1 did NOT run. | integration-db.txt |
| QA-03 identity, authorization, security | 63 tests: 48 pass, 0 fail, 15 blocked | qa03/ |
| QA-04 booking, calendar, notifications, pre-consultation, safety, concurrency | 53 tests: 53 pass, 0 fail, 0 skipped | qa04/ |
| QA-04 re-run of concurrency + new T7 cases | TC-BK-13..16 pass (including the 62 s hold-expiry race); 4 new cases pass | qa04b/, qa04c/ |
| QA-05 platform, clinical, messaging, documents, merge, privacy, telehealth, admin | 95 tests: 63 pass, 0 fail, 32 blocked | qa05/ |
| Accessibility and cross-browser automated parts (axe at 1280 and 360 px on 58 pages plus TC-A11Y-04/05/06 automated parts, TC-XB-01) | **Chromium + Firefox: 250 of 250 pass. WebKit 27.2: 125 of 125 pass.** The previous run was Chromium only (125). | a11y-cf.run.txt, a11y-wk.run.txt |
| Admin real-stack journey (`admin-stack`) | 7 of 7 steps, 10 screenshots | admin-run/ |
| Lint and prettier | **fail, but only on QA suite files** (83 lint errors, 68 files prettier). No tracked product file is listed. See QA640-N1. | lint.txt, format.txt |

Not re-run by me, cited only: CI run 42822981701 (workflow `ci`, headSha `cdc388d`), 19 jobs success including container-scan, contract (Schemathesis), e2e-smoke, Lighthouse, integration-db, SAST, secrets, deps, SBOM (HEAAA-639; DevOps Reviewer PASS). That covers TC-API-01/09 and the image scan at the CI level; I did not run them locally (no Docker).

## 3. Screenshots beyond the administrator path

`screens-<browser>/` holds real-browser sign-in through the local IdP (the real `/api/v1/auth/sign-in` flow, not a mocked session), then the page:

* Chromium 156 and Firefox 157: 27 of 27 checks pass each, 23 screenshots each: doctor (schedule, patient list, alerts, notes to sign, availability, tasks), front desk (arrivals, waitlist, patients, forms, triage queue), patient (home, booking start, profile, privacy, messages, appointments, pre-visit), public site (home, services, doctors, locations), patient home at 360 px. Each page asserts expected seeded text (e.g. "Casey Synthetic", "Confirmed"), absence of error text, and no page errors.
* WebKit 27.2: **17 of 27, 10 fail, and the 17 include sign-in pages**. Sign-in in WebKit returns 401 on the session probe for all three roles, so no authenticated page was captured; only the public site (4) and the unauthenticated patient home are real captures. See QA640-L1.
* Admin path: `admin-run/` (10 screenshots, 7 steps pass).

## 4. Human-required checks (pending, performed by no one)

TC-A11Y-02/03/07/08 and the human parts of TC-A11Y-04/05/06, TC-XB-02, TC-XB-03, TC-ID-03b, TC-ID-07 (Workspace policy export, ops + human), and every case marked human-required in TEST-CASES. A written case is not evidence. No human check was performed on this candidate.

## 5. Cases not executed (never counted as passed)

| Case | Suite | Reason (from the suite output) |
| --- | --- | --- |
| TC-ID-01 | QA-03 | BLOCKED: sign-up and the OTP are the managed patient pool (hosted page); no pool and no e-mail/SMS sandbox in ENV-INT/ci (TEST-CASES 0.3, DEVOPS-PLAN 3.5). Needs ENV-INT/ |
| TC-ID-02 | QA-03 | BLOCKED: the OTP is checked by the managed pool, not by this API. The API-side limit on failed callbacks is asserted in TC-ID-11 step 1. OTP wording and rate limit need E |
| TC-ID-03 | QA-03 | Pending-human (AUTO+H): the second factor is a passkey ceremony on a real device in the managed pool. The script half (the API accepts only a session minted from a comple |
| TC-ID-03b | QA-03 | PENDING-HUMAN: stays pending until a real person runs it after the staging apply (TEST-CASES TC-ID-03b); a written case is not evidence. |
| TC-ID-05 | QA-03 | BLOCKED (AUTO+H): refusal comes from the Workspace 2SV enforcement policy only; `hd` / `email_verified` cannot detect it, so a local claim check would be false evidence.  |
| TC-ID-07 | QA-03 | OPS + HUMAN: evidence is the owner/DevOps policy export dated within 30 days; QA reads it. Not a script. Pending-human. |
| TC-SEC-06 | QA-03 | NOT APPLICABLE on the built path: D-35 path B (separate admin_pool realm) is built; there is no Google admin identity. The path B equivalent (WebAuthn assertion is the on |
| TC-SEC-11 | QA-03 | PENDING-HUMAN (HUMAN): ENV-INT/bootstrap needs two real custodians (TEST-CASES 5.2). QA reviews the evidence; no result is recorded here. |
| TC-SEC-15 | QA-03 | BLOCKED (ENV-INT/staging): needs the egress block to the managed pool on the staging account. In ci the admin realm has no external IdP at all (sessions live only in our  |
| TC-SEC-16 | QA-03 | PENDING-HUMAN (HUMAN + OPS): a measured elapsed time from a real runbook run; QA never records it. |
| TC-SEC-17 | QA-03 | OPS + HUMAN (path A): the owner/DevOps policy export; not a script. Pending-human. |
| TC-SEC-18 | QA-03 | NOT APPLICABLE on the built path B and BLOCKED for path A: needs the Workspace test tenant; the hourly reconciliation job is not built (identity README: person_link/direc |
| TC-SEC-19 | QA-03 | OPS + HUMAN (path A): inventory and quarterly access review evidence; not a script. Pending-human. |
| TC-SEC-24 | QA-03 | PENDING-HUMAN (Cybersecurity review of the spike report P-1..P-7). The rerun of TC-SEC-03, 21, 23 is part of this suite; the human half is not recorded here. |
| TC-SEC-25 | QA-03 | OPS (ENV-DR): result of the DR drill, TC-REC-03 owns it. Not a script. |
| TC-AD-04 | QA-05 | NOT DELIVERED: the API has no message-template admin route (probed /admin/message-templates: 404; README BE-23 N-BE23-4 lists message templates as not built). Coverage ga |
| TC-AD-11 | QA-05 | BLOCKED: no Google, e-mail, SMS, push or analytics sandbox in ENV-INT/ci (C-10); health depends on a real vendor probe |
| TC-AD-12 | QA-05 | BLOCKED: no secret store (OutboundSecretStore) in ENV-INT/ci (INT-N8); the write cannot complete without it. Needs ENV-INT/staging |
| TC-AD-15 | QA-05 | BLOCKED: needs a working e-mail integration and booking confirmation against a sandbox (C-10) |
| TC-API-01 | QA-05 | BLOCKED: needs ENV-INT/staging with the fault-injection endpoint and every R1 module routable; see TC-API-02/10 for the ci-level body checks |
| TC-API-09 | QA-05 | BLOCKED in this suite: run by tests/api/harness/schemathesis-run.mjs (QA-02) against the published documents, not by tests/api/platform |
| TC-AU-01b | QA-05 | NOT TESTABLE: the API has no chart export or print route in R1 (probed chart-export, chart-print, export: 404); the view and search half is TC-AU-01. Recorded as a covera |
| TC-AU-07b | QA-05 | BLOCKED: the audit export sink (object store, infrastructure) is not provisioned in ENV-INT/ci; the worker's sink is a refusing port, so the job ends failed. Needs the st |
| TC-AU-08 | QA-05 | BLOCKED: audit.verify_anchors treats the Object Lock archive as the authority (INT04-F10 D-2); the archive store is infrastructure that does not exist in ENV-INT/ci |
| TC-AU-09 | QA-05 | BLOCKED: audit/clinical retention period not decided at G2 (open decision); type OPS: DevOps evidence |
| TC-AU-10 | QA-05 | n/a: owned by TC-PERF-04 (ENV-LOAD, not provisioned) |
| TC-DOC-01 | QA-05 | BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket  |
| TC-DOC-02 | QA-05 | BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket  |
| TC-DOC-05 | QA-05 | BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket  |
| TC-DOC-08 | QA-05 | BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket  |
| TC-MG-05 | QA-05 | BLOCKED: needs a signed clinical note authored under the merged patient; the note authoring/sign flow is not driven by the platform harness (QA-04 owns clinical journeys) |
| TC-MG-08 | QA-05 | BLOCKED: needs controllable test hooks to order the hold and merge transactions; the product exposes none in ENV-INT/ci |
| TC-MG-09 | QA-05 | BLOCKED: needs controllable test hooks to order transactions; none exposed |
| TC-MG-10 | QA-05 | BLOCKED: needs the job-type on_merged registry check from CI; no runner for it in tests/api/platform |
| TC-MG-11 | QA-05 | BLOCKED: depends on the signed-note flow (see TC-MG-05) |
| TC-MG-13 | QA-05 | BLOCKED: needs location care-relationship end and new-location booking flows not driven by this harness |
| TC-MG-14 | QA-05 | BLOCKED: needs the 10x ARCH 35.3 chart dataset generator; not in scope of this ticket's harness |
| TC-PP-03 | QA-05 | BLOCKED: needs a verified proxy grant, which cannot be created while D-7 is open; the isolation side is TC-AZ-14 (QA-02) |
| TC-PP-05 | QA-05 | BLOCKED: rule values do not exist yet (D-7 / G-07); case written when decided |
| TC-PP-06 | QA-05 | BLOCKED: the pre-visit request/questionnaire/e-sign journey is the QA-04 clinical suite and insurance-card upload needs the object store (C-01) |
| TC-PP-07 | QA-05 | BLOCKED: same flow as TC-PP-06 (QA-04) |
| TC-PR-02b | QA-05 | BLOCKED: no package store or presigner in ENV-INT/ci (C-01); the API composition has the refusing presigner. Needs ENV-INT/staging |
| TC-TH-01 | QA-05 | BLOCKED: no video vendor selected (C-11) and no vendor sandbox (C-10); nothing here proves a real vendor |
| TC-TH-04 | QA-05 | BLOCKED: no video vendor selected (C-11) and no vendor sandbox (C-10); nothing here proves a real vendor |
| TC-BS-03 | QA-05 | BLOCKED: needs the CMS with a marketing login (C-19 decides the content source; apps/cms is not a deployed service in ENV-INT/ci) and a human for the editing journey |
| TC-BS-04 | QA-05 | BLOCKED: needs Chrome network capture and an analytics sandbox; none is provisioned in ENV-INT/ci (ANALYTICS_SRC unset, so the site loads no analytics at all) |
| TC-BS-08 | QA-05 | BLOCKED: needs a browser session; the consent unit tests (apps/site/src/consent.test.ts) cover the logic only and are not a substitute |

Also not executed anywhere: all TC-PERF and TC-REC load and recovery cases (no k6, no ENV-LOAD; DevOps HEAAA-639 confirms nothing was provisioned), upgrade path and N-1 (no `r<N>` tag), the infra plan jobs (credentials), and the sandbox-dependent cases above (object store, scanner, video vendor, CMS, analytics, Google tenant, managed patient pool). Which of these the acceptance gate treats as blocking is the gate's decision under the blocker policy; QA does not waive them.

## 6. Findings (stable IDs; QA-EXEC-F01..F12 are closed, see section 1)

| ID | Sev | Status | Summary |
| --- | --- | --- | --- |
| QA640-N1 | P3 | open | The QA-03..07 suites carried in the overlay fail the repository's `pnpm lint` (83 errors, e.g. unused imports/variables, k6 globals undefined) and `prettier --check` (68 files). They are not in the candidate, so the candidate's CI is unaffected, but they cannot be merged into CI as they are. Owner: whoever lands the QA suites (QA, with a lint-clean commit). |
| QA640-L1 | limitation | open | WebKit could not be driven through sign-in on this host: `/auth/session` answers 401 after the local-IdP sign-in on plain-HTTP origins, in WebKit only (Chromium and Firefox pass the same script). Probable cause is the session cookie being `Secure`/`__Host-` on an http origin, which WebKit rejects; this is a host limitation (no TLS front end), **not isolated and not shown to be a product defect**. Needs an https test origin (ENV-INT) to close. WebKit automated a11y/cross-browser cases (125) are not affected. |
| QA640-H1 | harness drift | closed | The committed QA-04 harness (e41105c) seeds staff with a random `granted_via_request_id`, which the candidate's FK now rejects (`role_assignment_granted_via_request_fk`). I adopted the version of `seed.mjs`, `world.mjs`, `stack-up.mjs` that uses `ensureGrantors/grantRole` (copies in `harness/`). Test setup only; no product file changed. |

## 7. What I changed (QA files only)

* `tests/api/booking/overbook-cap.test.mjs` (new): T7 cases of the HEAAA-632 ruling.
* `tests/api/booking/concurrency.test.mjs`: TC-BK-15 title no longer says "reported FAILED / QA04-F07"; the assertion is unchanged ("exactly 2").
* `tests/e2e/journeys/lib/{seed,world,stack-up}.mjs`: see QA640-H1.
* Copies of all of the above, run scripts and `screens.mjs` are in `harness/`. Raw outputs are in `raw/`; no logs, tokens or keys are included (the data is synthetic).

## 8. Limitations of this evidence

* Everything ran against a local stack on one host: no TLS, no CDN/WAF, no managed identity pool, no object store, no email/SMS/video sandbox.
* The totals use the reporter counts (spec.txt); `case-results.csv` lists 163 passing case rows because one test covers two case IDs. Per-case rows in `case-results.csv` come from the node test reporter output of QA-03/04/05; the JUnit files are in `raw/qa0x/`.
* An earlier part of this run was interrupted when the disk filled and the execution workspace was reset (HEAAA-653). Everything reported here was run after that, on a rebuilt tree. The QA-03/04/05 runs, unit, integration-db, lint and format ran at 13:37-13:48 (before the reset) on the same commit `cdc388d`; a11y, screenshots and T7 after it.
