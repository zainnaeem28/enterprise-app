# INT-02 round 2 — combined candidate fbef9a1 (FAILED)

Candidate: fbef9a10064aa70218c873fd6e9a50872cc22812 (F01, F02+F03, F05, F04 merged on top of 52fd4cd). PostgreSQL 17. Raw: raw/r2/.

| Check | Result |
| --- | --- |
| install, typecheck, unit (578), build, boundary fixture | pass |
| prettier | pass (round 1 failures fixed) |
| lint | FAIL: packages/kernel/src/db/migrate/rules.ts:109:86 no-useless-escape (introduced by F02, f1d4ee4) |
| db-foundation suite | pass 40/40 (round 1 catalog failures fixed) |
| kernel suite | pass 23/23 |
| api suite | FAIL; run did not finish (timeout at the merge concurrency test) |

api suite failures (raw/r2/api-suite-run.txt):
1. notifications/alerts (BE-07): 12 of 32 fail, `PM008 patient not found` from patient.guard_open_patient() on staff_alert inserts. Tests raise alerts with patient IDs that are not registered; the patient guard added to notifications.staff_alert* (M-5 fix) now refuses them. Likely test fixture defect in BE-07 tests (raw/r2/alerts-dbtest.txt); not yet triaged against the service.
2. patient/merge/concurrency.dbtest (TC-MG-09 writer first): merge fails `patient.merge_participant_missing`, then the file hangs past 400 s (raw/r2/merge-concurrency-dbtest.txt). Blocks the merge-versus-booking race acceptance.
3. documents TC-DOC-05 fails in the full api run but passes when documents.dbtest runs alone (21/21): order or shared-state dependence (raw/r2/documents-dbtest-alone.txt).

Not demonstrated: booking journey, 100-parallel confirmation race, merge-versus-booking race, all-participant merge counts. Not submitted for QA review.
