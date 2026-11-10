# QA-03 report: identity, authorization and security (TC-ID, TC-AZ, TC-SEC, TC-SEC-C7)

Environment `ENV-INT/ci`: throwaway PostgreSQL database, real migrations, real built API and worker, fixture IdPs, run's software authenticator (CI attestation fixture). Synthetic data only.
Candidate: branch merge `3fb06bd` (INT-04 merged); suites in `tests/api/{identity,authorization,security}`. Tool: `node --test` (Node in `evidence/tool-versions.txt`), `--test-concurrency=1`.
Command: `EHR_TEST_ADMIN_URL=… tests/api/identity/run.sh <outDir>`. Raw: `evidence/spec.txt`, `evidence/junit.xml`.
Result: **63 tests: 42 pass, 6 fail, 15 skipped** (BLOCKED / Pending-human / OPS / not applicable, each naming why; none mocked as pass).

## Failures: product defects (findings; correction tickets via the Orchestrator)
| ID | Cases | Defect (evidence) |
| --- | --- | --- |
| QA03-F01 (blocking) | TC-SEC-01, TC-SEC-C7-03 | A refusal for a missing/stale elevation (`403 identity.elevation_required`) writes no `denied` audit event: `guard-policy.ts` throws `ForbiddenError('identity.elevation_required')` without calling `audit()`/`deny()`. The refusals themselves are correct. |
| QA03-F02 (blocking) | TC-AZ-10, TC-AZ-16 | `POST /patients/{id}/break-glass` is not mounted (404); BTG cannot be opened, so reason boundaries and the compliance alert are untestable. |
| QA03-F03 | TC-AZ-09 | The staff-scope drift job repairs missing/extra rows and writes its summary audit row, but raises no `scope_drift` staff alert. |
| QA03-F04 | TC-SEC-20 | Audit-export rate limit not enforced: 30 consecutive exports accepted, no 429/Retry-After. |

## Not scripted
BLOCKED: TC-ID-01, 02, 05 (managed pool / Workspace tenant), TC-SEC-15 (staging egress). Pending-human: TC-ID-03/03b, TC-SEC-11, 16, 24. OPS: TC-ID-07, TC-SEC-17, 19, 25. Not applicable on path B: TC-SEC-06, 18.

## Limits
Software authenticator is not a physical key. Nothing here is gate approval; Backend Reviewer review of this exact revision is required.
