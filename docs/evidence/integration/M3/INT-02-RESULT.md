# INT-02 integration result (M3) — FAILED, not submittable

Candidate: merge tip 52fd4cd (see raw/candidate-commit.txt). PostgreSQL 17 integration-db run: raw/integration-db.txt.

| Check | Result |
| --- | --- |
| install, typecheck (clean tree), unit (578 pass), build | pass |
| lint | FAIL (7 errors: patient/me 242 no-useless-assignment; scheduling/core imports reach into patient internals x5 (boundaries); unused `_requestId`) |
| format:check | FAIL (10 files, incl. scheduling/core/*, patient/testkit.ts, patient playwright-report.json) |
| db-foundation suite | FAIL: M-4-views (scheduling.public_clinician_location lacks security_invoker / not on owner-rights list); M-4 owner-rights view test; M-5-patient-guard (documents.* and notifications.staff_alert* tables lack merge guard); SEC03 negative-control restore |
| kernel suite | pass (23/23) |
| api/worker: documents (BE-10) | FAIL: 38.2 item 11 (scanning doc at merge), merge participant counts for documents |
| calendar Google push route | FAIL: test 1,2,7 (wrong HMAC / expired / bogus state) |
| organisation (BE-03) directory views | FAIL: seven-views, M-5 public policies, repository catalog check |
| Booking journey, 100-parallel race, merge-vs-booking race, merge across all participants | NOT demonstrated on combined revision (db suite red; scheduling db tests not shown passing) |

These are integration failures to be filed as findings via Orchestrator; no merge-conflict content was changed by the Integrator.
