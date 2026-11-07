# INT-02 round 3 — combined candidate eabc24d (FAILED)

Base fbef9a1 plus F06 487731d, F07 2d55116, F08 42de469, F09 89cc90f (all reviewed PASS, merged clean). PostgreSQL 17. Raw: raw/r3/.

| Check | Result |
| --- | --- |
| install, lint, prettier, typecheck, build, boundary fixture, unit | pass (round 2 lint failure fixed) |
| db-foundation, kernel suites | see raw/r3/db-foundation.txt, kernel.txt (completed, no failures marked) |
| api suite | FAIL; run did not finish (no output after 09:11, stopped manually) |

api suite failures (raw/r3/api.txt, search-dbtest-alone.txt):
1. scheduling/availability search.dbtest and availability.dbtest: ~25 tests fail; also in isolation. `permission denied for table slot_occupancy` (42501) raised from AvailabilitySearch.conflicts; leave/blocked-time routes (TC-DR-02) return 403 auth.forbidden where 200 is expected. New on the combined revision; not previously seen (round 2 api run stopped before reaching these files).
2. patient/merge concurrency TC-MG-14 "exceeds the transaction bound": fails in the full run, passes alone (7/7); order/load dependent.
3. Run stalls after the HTTP routes suite of scheduling/core.
4. Open risk from F08 reviews: real notifications merge participant does not wire ALERT_MERGE_TABLES/repointAlertRows and scheduling/telehealth/documents participants are not registered at the composition root, so production merges still fail patient.merge_participant_missing.

Not demonstrated: booking journey, 100-parallel race, merge-versus-booking race, all-participant merge counts. Not submitted for QA. Round 3 of 3: escalate.
