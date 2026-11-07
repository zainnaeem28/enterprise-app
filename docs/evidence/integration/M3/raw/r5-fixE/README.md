# INT-02 fix E (HEAAA-204) raw output

- rls-matrix-dbtest.txt: 64 tests, 63 pass, 1 fail (INT02-R4-F01 "no vacuous cell", tracked as HEAAA-203), 0 skipped, 0 todo.
- identity-label-dbtest.txt: 5 tests, 5 pass (API-layer `POST /admin/patient-labels`).
- TC-AZ-08 step 3 negative case ("refused without a visible referencing record") moved from the DB sub-case of SEC03-F08 to
  apps/api/src/modules/patient/identity-label.dbtest.ts (Architect decision, HEAAA-205: O-5 keeps the check in the API layer).
- Gaps: "exists but invisible under caller RLS" is not separately exercised (no seeded role has patient.label.read without the
  referencing table's slice); same 404 as "does not exist".
