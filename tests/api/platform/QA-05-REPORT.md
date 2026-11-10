# QA-05 report: automated cases (TC-TH, AU, DOC, PR, AD, BS, PP, MSG, MG, API)

Environment `ENV-INT/ci`: throwaway PostgreSQL database with the real migrations, real built API and worker, fixture IdPs, per-run TLS front. Synthetic data only.
Candidate under test: INT-04 build at `ed9902c42c3e4d8e1e46fa987d5b76c5f99f7235` (built in `/tmp/int04-r4`). Suites at branch commit `0ca2561` plus the evidence commit.
Tool: `node --test` (Node v24.22.2), `--test-concurrency=1`. Command: `node --test --test-concurrency=1 tests/api/platform/*.test.mjs tests/e2e/site/*.test.mjs` with the stack from `tests/api/platform/lib/stack-up.mjs`.
Raw report: `evidence/spec.txt`, `evidence/junit.xml`. Result: **95 tests: 56 pass, 7 fail, 32 skipped (BLOCKED / not delivered, each naming the missing piece)**.

## Failures: real product defects (findings; correction tickets via the Orchestrator)
| ID | Cases | Defect |
| --- | --- | --- |
| QA05-F01 (blocking) | TC-TH-02, 03, 05, 07, 08 | Telehealth routes (`GET /appointments/{id}/video-session` etc.) are not mounted in the API composition: 404 for the patient's own video visit. |
| QA05-F02 (blocking) | TC-PR-02 | Patient data export package ends `failed` with `privacy.contributor_missing`; the patient still sees `in_progress`. |
| QA05-F06 | TC-AD-09 | No route returns maintenance banners to any portal host (0 of 3). |

## Observations / coverage gaps (not passes)
- QA05-F07: TC-AD-04 no message-template admin route (404). TC-AU-01b no chart export/print route.
- TC-MG-07: a stale **portal** write to the merged patient answers `404 kernel.not_found`, not `409 patient.merged` (staff write is 409). Nothing is written. Deviation from the case text; the case accepts 404/409 and this is recorded here.
- TC-API-10: stack runs `EHR_MIN_CLIENT_RELEASE=1`, so "below minimum" is not expressible; steps 6-7 need staging and a human. TC-API-07 per-IP half and wait-and-retry not run.
- TC-API-04 ran on the patient record (`If-Match`), the notes route is not in this stack.

## BLOCKED (never mocked as pass)
Object store / scanner / OCR (TC-DOC-01,02,05,08; TC-PR-02b; TC-AU-07b), video vendor (TC-TH-01,04), integrations sandboxes and secret store (TC-AD-11,12,15), audit archive (TC-AU-08), retention decision (TC-AU-09), D-7 proxy rules (TC-PP-03,05), clinical journey (TC-PP-06,07; TC-MG-05,11), ordering hooks (TC-MG-08,09), on_merged registry (TC-MG-10), location flows (TC-MG-13), 10x dataset (TC-MG-14), CMS/browser/analytics sandbox (TC-BS-03,04,08), staging (TC-API-01), Schemathesis run owned by QA-02 (TC-API-09). TC-MSG-04 browser half needs the staff messaging screen.

## Limits
Local fixtures (`fixtureDocument`, ORG-2 rows, injected fault triggers) are written by the harness as database administrator and do not exercise upload paths. Nothing here is G-gate approval; independent review (Backend Reviewer, then Frontend Reviewer) is still required.
