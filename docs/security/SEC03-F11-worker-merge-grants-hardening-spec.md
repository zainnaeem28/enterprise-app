# SEC03-F11 follow-up: least-privilege worker merge grants (specification)

Status: **specified, not implemented** (task HEAAA-662, ACC-R2-03). Condition set by HEAAA-650 when it accepted F11 (QS-03, Low).
Owner of the implementation: Backend Engineer. Reviewers: Solution Architect Reviewer (design), Security Reviewer (grants and probes), Backend Reviewer (code and dbtests).

## G3 due point

**Implemented, independently reviewed and merged to `main` before the G3 package is assembled, and in any case before the first production deployment.** The G3 package must carry (a) the merged revision, (b) the db test output named in section 5 and (c) the Security Reviewer's PASS on the grant catalog. If it is not done by then, the G3 package must list F11 as an open Low risk with an Architect risk acceptance (decision-log entry) naming the compensating control in section 2. Staging/ENV-INT use is not blocked by this item.

## 1. Defect (SEC03-F11, `docs/security/SEC-03-rls-assessment.md` section F11)

`app_worker` holds merge re-pointing grants in `db/migrations/0802_patient_merge_rls_and_grants.sql` (lines 60-65: `UPDATE (patient_id)` on `patient_contact`, `insurance_coverage`, `communication_preference`; `UPDATE (patient_id, status, reason)` on `consent`; `DELETE` on `communication_preference`; `UPDATE (patient_id, to_date, end_reason)` on `care_team_member`; `UPDATE (patient_id, candidate_patient_id, status, resolved_reason)` on `duplicate_flag`), plus the matching policies (lines 66-114) and the scheduling `slot_reservation` update policy in 0902. All policies require only `audience = system`, `job_scope = patients` and the job's patient IDs. Any patients-scope job (reminder, export, waitlist) therefore holds the rights. SEC-03 executed proof P7: a patients-scope job withdrew a signed consent (`status = 'withdrawn'`) and committed.

## 2. Current compensating controls (why this is Low)

Job scope is set by the kernel worker wrapper, not by a caller; patients-scope jobs are limited to the job's exact patient IDs and organisation; `begin_merge`/`complete_merge` check the exact request; consent signing is blocked by `consent_signed_shape`. These do not stop a non-merge patients-scope job from changing the columns above for its own patients.

## 3. Design (do not reintroduce a job-class setting; 21.7 removed `app.job_class`)

Chosen: **move the re-pointing into `patient_scope_owner` SECURITY DEFINER functions** that the executor calls, so `app_worker` needs no table grants for them.

1. New migration (next free number after 2502, forward-only, with down-note): one function per participant table, e.g. `patient.merge_repoint_<table>(p_request uuid, ...)`, each `SET search_path = pg_catalog`, owner `patient_scope_owner`, `EXECUTE` to `app_worker` only (revoked from PUBLIC).
2. Each function re-checks what `begin_merge` checks: audience `system`, scope `patients`, organisation, the request exists with `status = 'executing'` for this job, and both `survivor_id`/`merged_id` are in `app.job_patient_ids`. It only moves rows from `merged_id` to `survivor_id`; the consent function may only set the status values the merge writes (the agreed set from `participants.ts`), never `signed -> withdrawn` on a row that is not being moved.
3. Update `apps/api/src/modules/patient/merge/participants.ts` (and the other module participants if they use the same grants: scheduling, documents, notifications, clinical) to call the functions instead of direct `UPDATE`/`DELETE`.
4. Same migration revokes the 0802 column grants and `DROP POLICY` for the worker policies listed in section 1 (leave `SELECT` policies the executor needs for counting). For `slot_reservation` do the same via `scheduling_booking_owner` or pin the policy to the executing merge request.
5. Fallback if a function per table is too large for the budget: keep the grants but make each worker policy `USING`/`WITH CHECK` require an `executing` merge request row naming the row's patient (`EXISTS` on `patient.merge_request` through a definer helper), and pin `consent` `WITH CHECK` to the merge status values. Requires Architect sign-off recorded in the decision log.

## 4. Acceptance criteria

* AC-1 A patients-scope job that is not the executing merge cannot `UPDATE` or `DELETE` any table in section 1 (permission denied or 0 rows, as appropriate), including withdrawing a signed consent (SEC-03 P7 now fails).
* AC-2 The full merge still passes unchanged (`merge.dbtest.ts`, `concurrency.dbtest.ts`) and the equation found = re-pointed + resolved + kept (PM013) still holds.
* AC-3 `app_worker` holds no `UPDATE`/`DELETE` privilege on the section 1 tables/columns in the catalog (`information_schema.column_privileges` / `pg_policies` assertion).
* AC-4 The new functions have a fixed `search_path`, are not executable by PUBLIC, `app_api` or `app_api`'s roles, and refuse a call outside an executing merge for the named patients.

## 5. Required db tests (to be written by the implementer; none exist yet)

1. P7 regression: patients-scope worker session withdraws a signed consent -> refused.
2. Same session attempts each section 1 write on its own patient's rows -> refused for every table.
3. Wrong-patient call: executing merge A->B, function called with a request naming other patients -> refused (42501/PM-code).
4. Merge not in `executing` state (`approved`, `completed`, `failed`) -> function refuses.
5. Catalog test per AC-3/AC-4.
6. Existing merge and concurrency dbtests green.
Evidence is to be run on a real PostgreSQL with the repository's db test runner and the output attached to the task.

## 6. Dependencies and risks

Shares migration numbering and the merge participants with other merge work; serialise with any open change to 0802/0803/`participants.ts`. A schema or grant-model change returns to Solution Architect for the contract; Security Reviewer reviews the grant catalog diff.
