# INT03-F08d root cause (blocker, no code change)

Base: 11eb194 (HEAAA-133 r2). Test: `frontdoor-flows.dbtest.ts` "TODO (BE-08/INT-02): the real accept path".

- `POST /referrals/:id/accept` (referrals.ts) calls `patient.lock_patients` / `patient.ensure_care_relationship` (db/migrations/0703_patient_scope_functions.sql).
- Both gate on `patient.caller_sees(p_id)`. For a staff caller it is true only if `patient.staff_scope` has a row for one of the caller's locations (or BTG).
- The receiving location of a referral has no care relationship yet, hence no staff_scope row, so `caller_sees` is false -> PM008 -> 404.
- This is a gap in the DB function contract (`caller_sees` has no referral case), not in frontdoor code, route registration or test setup.

Fix needs a change to `patient.caller_sees` (or a new referral-visibility rule) = a migration/SQL change in a file owned by BE-08, outside this ticket's allowed paths, and migrations are prohibited here. It is also a security-model decision (what a receiving location may see before accepting), so it needs Architect/human approval. No frontdoor-side workaround was applied: seeding staff_scope in the test is a stand-in, and bypassing caller_sees would weaken authorization.

Not run: the common checks and before/after dbtest output, since nothing was changed.
