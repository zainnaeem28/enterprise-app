# SEC-03 — Security assessment: RLS, scope, merge and patient-data isolation (code and SQL review)

| Field | Value |
| --- | --- |
| Ticket | SEC-03 (HEAAA-101), release R1, milestone M3. Lane parent HEAAA-25 |
| Author / owner | Cybersecurity (`83cd0a46`) |
| Independent reviewer | Security Reviewer (`074b2525`) — not yet run on this revision |
| Document revision | Round 1 (first submission). The cumulative round count is in the task document `review-ledger` |
| Assessed candidate | `eeecca6aafe053fd8889e7e978717f02030e0f0c` (head of branch `HEAAA-90-…` = BE-11). Contains BE-09 head `f2fa18b17dac199d8c0ca8bd73bb3e0bfd19cb91` as an ancestor (verified with `git merge-base --is-ancestor`), BE-08, QA-02, INT-01 base. Technical prerequisites HEAAA-88 (BE-09) and HEAAA-90 (BE-11) are `done` in Paperclip |
| Design baseline | G2 candidate revisions, DELIVERY-PLAN §2 (`design-align` rev `ea043d8d`). Sections used: SHARED-BOUNDARIES 6, 9.2; ARCHITECTURE 21 (21.2 roles, 21.3 settings, 21.4 templates, 21.6 definer inventory, 21.7), 22.16, 25.1, 25.2, 25.4; TEST-CASES 6; PRD RA-R1-17 |
| Changes made to product code | **None.** This ticket writes only this file |
| Status of facts | *Executed* = I ran it. *Verified* = I observed the result on the exact candidate. Nothing here is *integrated*, *human-approved* or *deployed* |

## 1. Verdict

**The candidate does not meet RA-R1-17 at the database layer and must not go to integration (INT) or G3 until the blocking findings are fixed, independently reviewed and retested.** One finding is critical and was reproduced:

* **SEC03-F01 (Critical).** 21 of the 27 row-level-security policies that implement the T-STAFF template are tautologies. The written-out `EXISTS` compares the `staff_scope` column with itself (`s.patient_id = s.patient_id`) because the unqualified `patient_id` binds to the sub-query alias. Any staff member whose location has at least one patient can read (11 policies), and write (10 policies), the contact, insurance, consent, preference, care-team, care-relationship, duplicate-flag, patient-link, proxy-grant, notification and receipt rows of **every** patient in the organisation. The patient root, the merge map and the booking tables are correct. Reproduced, and the one-line-per-policy fix was validated on a scratch database (section 5, F01).

Three further defects (F02, F03, F04) are failures of SHARED-BOUNDARIES 6.2 rule 3 ("a definer function checks the caller's scope itself"): a patient can cancel another patient's appointment (F02), a patient can book a doctor's time twice by setting a flag (F03), and a patient or proxy can add any clinic to the care circle (F04). All were reproduced. F05 is a deviation from the merge write guard of 9.2 that leaves an orphan row on a merged patient when a writer skips the lock. F06 is a CI gate that is red on the candidate.

What holds: FORCE RLS on all 15 patient and scheduling tables, no `BYPASSRLS`, no application DML on definer-only tables, `anonymous`, `public`, `partner`, unset-audience and no-organisation transactions read nothing from the patient tables, patient-to-patient isolation on every table, `admin_pool` reads nothing without BTG or a slice key, the merge guard on the patient tables serialises with the merge, the merge function checks (self-approval, exact job IDs, equation, coverage of every `patient_id` table) work. See section 4.

Findings: 1 Critical (F01), 2 High (F02, F04), 6 Medium (F03, F05–F09), 4 Low (F10–F13), plus 3 observations (section 7). Blocking: F01–F07. Review round for this document: 1 of 3.

## 2. Method, tools and limitations

| Item | Value |
| --- | --- |
| Read | All migrations `0001`–`0903` (432 KB), `db/roles/0001_roles.sql`, `db/tools/catalog-check.mjs` and `catalog-lists.mjs`, `scripts/ci/migration-check/*`, kernel scope code (`packages/kernel/src/scope/*`, registry), identity scope builder and guard policy, patient module (service, scope, merge service, controller, executor, participants), identity and scheduling merge participants, scheduling core service and controller, worker patient jobs, all `*.dbtest.ts` titles for patient merge, scheduling and records, `.github/workflows/ci.yml` |
| Executed | The candidate's own catalog check (`db/tools/catalog-check.mjs`) on a database migrated from empty by the candidate's `db/roles` and `db/migrations`; 14 probe scripts (SQL through `pg`) as the real roles `app_api`, `app_worker` and `postgres` (control and seed only), with settings set the way the kernel sets them (`set_config(…, true)` per transaction); one two-connection race |
| Tool versions | PostgreSQL 17.7 (npm `@embedded-postgres/linux-x64` 17.7.0-beta.15, `x86_64-pc-linux-gnu`), Node v24.22.2, `pg` 8.23.1. The platform database (`DATABASE_URL`) was **not** touched. The scratch cluster ran on `127.0.0.1:58433` with trust authentication, synthetic data only, and was stopped afterwards |
| Dynamic scope | Local scratch database only. No vendor, no real person data, no credentials beyond the throw-away cluster. Authorised by the SEC-03 ticket ("code and SQL review") |
| Not executed | The repository's own `*.dbtest.ts` suites and its CI (no `pnpm install` of the monorepo, no Nest build). Findings about what those tests contain come from reading their titles and bodies, not from running them. PostgreSQL 17.7 is not the CI image (`postgres:17@sha256:748a18…`); none of the findings depends on a patch version |
| Raw reports | Section 8 holds the raw output of the catalog check and the access matrix, and the commands to reproduce them. The probe scripts are not in the allowed write path (`docs/security/SEC-03-rls-assessment.md` only); the reproduction SQL for each finding is in section 5 |

## 3. Acceptance criteria against evidence

| Acceptance criterion | Result |
| --- | --- |
| Policies read against the templates | Done for all 15 patient and scheduling tables and the policies the same migrations add on `identity.patient_link`, `identity.proxy_grant`, `notifications.notification`, `notifications.delivery_receipt` (section 4.1). T-PAT-OWN, T-PAT-APPT, T-ADMIN-BTG, T-SLICE(consents), T-SYS conform. **T-STAFF does not conform in 21 policies (F01).** |
| Role grants against 21.2 | Done by catalog query (section 4.2). Conforms except: `kernel.setting` table-wide grants instead of the N-3 column lists (F13), the merge re-pointing grants on `app_worker` are not tied to the merge job (F11). |
| Merge guard and lock order against 25.2 | Done (section 4.3). Patient-table guard conforms and was proven under a race. **Scheduling guard deviates (F05).** Lock order on the service paths conforms; the static check that is meant to enforce it is not run in CI (F12). |
| Negative cross-clinic and cross-patient tests reviewed for sufficiency | **Not sufficient** (F07). No test touches the child tables as a second location, which is why F01 passed review; the TC-AZ-05/06/07 matrix and the behavioural M-5 matrix of 21.3 do not exist. |

## 4. Reading results

### 4.1 Policies against the 21.4 templates

| Template | Tables | Result |
| --- | --- | --- |
| T-PAT-OWN | patient, patient_contact, insurance_coverage, consent, communication_preference, staff_scope (own) | Conforms. `NOT patient_id = ANY(proxy_patient_ids)` present. Verified: a second patient reads only their own root and scope row |
| T-PAT-APPT | slot_reservation | Conforms (proxy ids are in `patient_ids`, D-7) |
| T-STAFF | 27 policies | **21 fail (F01)**: the six that pass are the two `patient.patient` policies (compared on `id`), `merge_map_staff_select` (two branches, on `merged_id` and `final_survivor_id`) and the three `slot_reservation` policies, which qualify the column with the table name |
| T-ADMIN-BTG | patient, contact, insurance, consent, reservation | Conforms. Verified: `admin_pool` without BTG reads no patient row |
| T-SLICE(consents) | consent | Conforms (`phi_access = limited` and key in `compliance_scopes`). Verified: a principal holding only `patient_label` reads no consent |
| T-SYS | all | Conforms (`current_user = 'app_worker'`, audience, job scope, job IDs). Verified: a patients-scope job for patient B reads nothing of patient A |
| Merge map | patient_merge | Reads conform (see O-1 on the two scope-builder reads). Writes only through `complete_merge` |
| Function-owner policies | scope_owner, match_owner, booking_owner | Role-targeted, audience-restricted, organisation-pinned. They deliberately do not repeat the caller's patient scope (M-3); the functions must (F02, F04) |

### 4.2 Role grants against 21.2 and 6.2 (catalog query, section 8)

* Roles: `app_owner`, `app_api`, `app_worker`, `reporting_ro`, `audit_archiver` are `LOGIN`; the three function-owner roles are `NOLOGIN`; none is superuser or `BYPASSRLS`. No function-owner role owns a table or view. All 15 patient and scheduling tables are `ENABLE` and `FORCE`.
* No `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` for `app_api` or `app_worker` on `care_relationship`, `staff_scope`, `patient_merge`, `merge_request`, `merge_residue`, `slot_occupancy`.
* `patient.patient` column `UPDATE`: `app_api` has 13 demographic columns only; `status` and `merged_into` belong to `patient_scope_owner` only.
* `EXECUTE`: `lock_patients` to `app_api` and `app_worker`; merge request, decide and read to `app_api`; `load_merge_job`, `begin_merge`, `complete_merge`, `fail_merge`, `verify_staff_scope`, `expire_holds` to `app_worker`; `occupy` and `set_status` to both. No function of a module schema (other than the `btree_gist` support functions owned by `postgres`, which cannot be reached because `PUBLIC` has no `USAGE` on `scheduling`) is executable by `PUBLIC`. Every definer function has a fixed `search_path`.
* Deviations: F13 (`kernel.setting`), F11 (merge re-pointing grants).

### 4.3 Merge guard and lock order against 25.2 / 9.2

| Requirement | Result |
| --- | --- |
| Guard on every table with a `patient_id` | `M-5-patient-guard` passes, but it matches the **function name only** (F13). Patient-module guard reads the root `FOR KEY SHARE` and refuses (PM001): **proven under a race**, section 5 F05. Scheduling guard has no lock (**F05**) |
| `begin_merge` locks both roots `FOR UPDATE`, lower ID first, then the request row; `decide_merge` and `request_merge` take roots first | Conforms by reading. No deadlock path between merge, approval and a second merge (global ascending order) |
| Execution scope is exactly the two patients and their closures | Conforms: `begin_merge` and `complete_merge` refuse a job whose `job_patient_ids` do not hold both IDs; the executor reads the IDs from the request row, not from the requester |
| Approver is a different person | Conforms and stronger than required: compared on person **and** principal, in a `CHECK` and in the function |
| Equation found = re-pointed + resolved + kept | Checked twice (participant, executor) and again in `complete_merge` (PM013). The executor also refuses a merge when a table with a `patient_id` column has no participant (verified by reading `uncoveredTables`) |
| Other open requests naming the merged patient cancelled | Conforms (`complete_merge`) |
| Merged state last, scope recomputed | Conforms |
| `complete_merge` relies on `begin_merge` having locked the roots in the same transaction | Not asserted in the function (O-2) |
| 25.2 rule 1 on service paths (`lockPatients` before any child write and before `occupy`) | Conforms in `hold`, `confirm`, `cancel`, `reschedule`; `callScopeOwner` enforces mode and ID set at run time |
| Static lock-order check (38.2 item 4) | Exists, scans only `packages/kernel/src` in its package script, **not run by CI** (F12) |
| Required tests of 9.2 | Present: stale sessions, writer first / merge first, deadlock-free pair of merges, rollback, non-holder refused. **Absent:** a queued job with a merged ID for a `resolve` type and for a `fail` type; the kernel registry cannot even express `fail` (F07) |

## 5. Findings

Severity: Critical (patient data crosses a boundary now), High (a stated invariant fails against a bypassing caller or a boundary function), Medium (control gap, wrong gate, insufficient evidence), Low (hardening, accepted by design but not yet closed). All findings are against the exact candidate `eeecca6`. IDs are stable across rounds.

**Routing summary** (owner is the owning engineer; Backend Engineer `19109d44` unless stated; parent is the lane HEAAA-25; each is a candidate for a correction ticket that does not depend on SEC-03)

| ID | Severity | Blocking | Title | Owner | Introduced by | Acceptance impact |
| --- | --- | --- | --- | --- | --- | --- |
| SEC03-F01 | Critical | yes | T-STAFF policies are tautologies (21 policies) | Backend Engineer | BE-08 0702 (also the policies it adds for identity and notifications); copied unchanged | RA-R1-17, BR-32, AC-34, TC-AZ-01..04 at table level; INT-01, G3 |
| SEC03-F02 | High | yes | `scheduling.set_status` is not bound to the caller's reservation | Backend Engineer | BE-11 0903 | RA-R1-17, AC-35, TC-BK-11; rule 3 of 6.2 |
| SEC03-F03 | Medium | yes (with BE-12) | `scheduling.occupy` trusts caller-supplied `overbook` flag and cap | Backend Engineer (BE-12 for the template tie) | BE-11 0903 | RA-R1-03 (no double booking), TC-BK-14..15 |
| SEC03-F04 | High | yes | `patient.ensure_care_relationship` lets a patient or proxy grant any clinic access | Backend Engineer | BE-08 0703 | BR-32, D-7, SBR-02 (care relationship only through a real event) |
| SEC03-F05 | Medium | yes | Scheduling merge guard takes no lock (deviation D1) | Backend Engineer; Orchestrator for the grant | BE-11 0901 | SBR-12, 9.2 "holds for every writer", TC-MG-09 |
| SEC03-F06 | Medium | yes (gate is red) | Seven merge functions and four scheduling functions are outside the approved definer inventory and the catalog lists | Backend Engineer; Architect for the document revision | BE-09, BE-11 | M-5, 21.6, 6.2 "adding one needs a revision" |
| SEC03-F07 | Medium | yes | Negative-test sufficiency | QA Engineer (QA-03) with Backend Engineer | BE-08, BE-09, BE-11, QA-02 | RA-R1-17, TC-AZ-05/06/07/08, AN-1 |
| SEC03-F08 | Medium | no | `patient.identity_label` can never succeed; the database does not check the referencing record | Backend Engineer | BE-08 0704 | RA-R1-26/J-21 compliance label, TC-AZ-08 |
| SEC03-F09 | Medium | no | `slot_occupancy` exposes `created_by` and reservation IDs to every patient and staff session | Backend Engineer | BE-11 0902 | 6.5 ("no patient identifier"), RA-R1-17 |
| SEC03-F10 | Low | no | Cross-scope identifiers and free text in `duplicate_flag` and `get_merge_request` | Backend Engineer | BE-08, BE-09 | 6.6 "opaque ID", BQ-3 |
| SEC03-F11 | Low | no | Worker merge-re-pointing grants are not tied to the merge job | Backend Engineer | BE-09 0802, BE-11 0902 | SBR-03, 6.2 |
| SEC03-F12 | Low | no | Static lock-order and sign-in call-site checks are not run in CI | DevOps Engineer with Backend Engineer | F-02, BE-03 | 38.2 item 4, 21.3 SI-4 |
| SEC03-F13 | Low | no | Catalog checks and grants weaker than the text they claim to enforce | Backend Engineer, DevOps Engineer | F-03, BE-08, BE-02 | M-5, N-3, DF-7 |

### SEC03-F01 — T-STAFF policies are tautologies (Critical, blocking)

**What.** `db/migrations/0702_patient_rls_and_grants.sql` writes the staff predicate as
`EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (…))`.
In SQL an unqualified name binds to the innermost scope that has the column. `staff_scope` has `patient_id`, so the stored predicate is `s.patient_id = s.patient_id`. It is true for any staff member who has at least one `staff_scope` row at a location they hold. The `patient.patient` policies use `s.patient_id = id` (no `id` in `staff_scope`) and the booking policies qualify (`slot_reservation.patient_id`), so those work. ARCHITECTURE 21.4 and the 21.4 spike text both say the expression must be "generated from one migration template"; here the template was copied, the defect with it.

**Affected (verified in `pg_policies`; 21):** `patient_contact` (select, insert, update, delete), `consent` (select, insert, update), `insurance_coverage` (select, update), `communication_preference` (select), `care_relationship` (select), `care_team_member` (select, insert, update), `duplicate_flag` (select, update), `identity.patient_link` (select), `identity.proxy_grant` (select), `notifications.notification` (select, staff cancel), `notifications.delivery_receipt` (select).

**Reproduction (executed).** Seed: patient A cared for at location A only, patient B at location B only; staff member at location B only. As `app_api` with `app.audience='staff'`, `app.realm='google'`, `app.location_ids=<B>`:

```sql
SELECT id, status FROM patient.consent WHERE patient_id = :A;                 -- returns A's consent
SELECT payer_name, member_id FROM patient.insurance_coverage WHERE patient_id = :A;  -- PayerA / MEMBER-A-123
UPDATE patient.consent SET status = 'withdrawn' WHERE id = :A_consent RETURNING status;  -- 'withdrawn' (committed)
```

Result on the candidate: consent rows 1, insurance rows 1, care relationships of A visible 1, withdrawal succeeded. Full-table matrix (section 8.2): staff of location B sees the A-patient rows in `identity.patient_link`, `care_relationship`, `care_team_member`, `communication_preference`, `consent`, `duplicate_flag`, `insurance_coverage` and `patient_contact`.

**Why the tests did not catch it.** Every cross-clinic test goes through the API guard, whose `patientInScope` probe reads `staff_scope` correctly and answers 404 first, or reads `patient.patient`, whose policy is correct. No test selects a child table directly as a second location (F07).

**Impact.** RA-R1-17 ("a user in Clinic A cannot find a patient registered only in Clinic B") and BR-32 are not enforced in the database for the child tables; the API guard is the only barrier. Any list endpoint or query that is not keyed on a guarded patient ID exposes insurance, contacts, consent state, care teams and portal links across clinics. Writes cross clinics as well (consent withdrawal, contact delete, care-team insert, notification cancel).

**Remediation (validated).** Qualify the column with the table name in every written-out T-STAFF predicate (`s.patient_id = patient_contact.patient_id`, and so on), generated from one template function in the migration so it cannot drift again (21.4). On a scratch copy I rewrote the 21 policies by replacing `(s.patient_id = s.patient_id)` with `(s.patient_id = <table>.patient_id)`: staff of location B then read 0 consent, 0 insurance and 0 foreign care relationships of A, and staff of location A still read their own (section 8.2, FIXED). Because the migration chain already exists, the fix is a new migration (policies are `ALTER`ed), not an edit of 0702. Add the checks in F07 and F13 so a tautology cannot pass again.

**Retest required:** the section 8.2 matrix and the three SQL statements above, as a CI database test, plus the catalog check proposed in F13 item 4.

### SEC03-F02 — `scheduling.set_status` is not bound to the caller's reservation (High, blocking)

**What.** `set_status(p_id, p_from, p_to)` checks the audience, the allowed transition set and the status, nothing else. The occupancy twin carries no patient by design (6.5), and the function never looks at the caller's `patient_ids` or `location_ids`. SHARED-BOUNDARIES 6.2 rule 3 requires the function to check the caller's scope itself; the text of `0903` says the API has already read the reservation under the caller's RLS. That holds only for callers that go through the service.

**Reproduction (executed).** A confirmed appointment of patient A at location A is committed. As patient B (`patient_ids = {B}`):
`SELECT … FROM scheduling.slot_occupancy` returns A's row (id, location, clinician, status) because the occupancy policy is organisation-wide; `SELECT scheduling.set_status(<that id>, 'confirmed', 'cancelled_patient')` returns `ok` and the row is `cancelled_patient`. As staff of location B only: `set_status(<A's id>, 'confirmed', 'cancelled_clinic')` returns `ok`. The reservation row, which B cannot read, is left as it was, so the twin now disagrees and the slot is free for others.

**Impact.** Any patient or staff session, or a route that passes an unvalidated ID, can cancel, confirm or release another patient's or another clinic's appointment. IDs are enumerable through F09.

**Remediation.** Make the function prove the caller's right to the reservation in the database. Options: (a) an invoker wrapper `scheduling.set_status_checked` that first `SELECT 1 FROM scheduling.slot_reservation WHERE id = p_id` under the caller's RLS and raises PM008 otherwise, then calls the definer; revoke `EXECUTE` on the definer from the application roles and grant it to the wrapper's owner; or (b) give `scheduling_booking_owner` `SELECT (id, patient_id, location_id)` on `slot_reservation` with a policy `TO scheduling_booking_owner` that reuses the T-PAT-APPT/T-STAFF predicate, and test `patient.caller_sees`-style inside the function. For staff, also require `occupancy.location_id = ANY(app.location_ids)`; that needs no new grant.
**Retest:** patient B and staff of another location cannot move another reservation's occupancy; the same calls on the caller's own reservation still work; add to the TC-BK-11 and TC-AZ-07 suites.

### SEC03-F03 — `scheduling.occupy` trusts the caller's `overbook` flag and cap (Medium, blocking until BE-12 ties it to a template)

**What.** Overbook rows are excluded from the doctor and room exclusion constraints, and `p_overbook`, `p_session_key` and `p_overbook_cap` (0..100) come from the caller. The function does not check that the slot's session is overbookable.

**Reproduction (executed).** Patient A holds a doctor's 30 minutes (normal hold, committed). Patient B with `overbook=false` is refused (`23P01 slot_occupancy_doctor_excl`). Patient B with `overbook=true`, `session_key='made-up-session'`, `cap=100` for the same doctor and time **commits**. Two active rows now cover the same doctor and period (query in section 8.3).

**Impact.** RA-R1-03 ("no double booking") is guaranteed by the API's choice of arguments, not by the database. The service passes `avail.overbook?.sessionKey`; today the `availability` port is BE-12's and without it no hold is possible (index.ts note), so the live path is safe.

**Remediation.** When BE-12's tables exist, `occupy` reads the overbookable flag and the cap from the stored template/policy (`organisation.booking_policy`, availability template) instead of arguments, and refuses an overbook row for a slot that is not in an overbookable session. Until then keep the route-level protection and add a test that a patient-audience caller cannot reach `occupy` with `overbook = true`. **Retest:** the section 8.3 sequence must end with B refused.

### SEC03-F04 — `patient.ensure_care_relationship` lets a patient or proxy add any clinic (High, blocking)

**What.** For audience `patient` the function requires only `caller_sees(p_patient)`. It does not require a confirmed reservation of that patient at that location, and `p_reason` may be `referral`. SHARED-BOUNDARIES 6.6: a patient enters a location's staff scope "only through a care relationship" created by a real event (booking confirmed, referral accepted).

**Reproduction (executed).** Patient A has a relationship at location A only. Staff of location B read 0 rows of A. As patient A: `SELECT patient.ensure_care_relationship(gen_random_uuid(), :A, :locB, 'referral')` returns an ID; staff of location B now read A's patient row (name, date of birth).

**Impact.** A compromised or buggy patient-audience request, or a **proxy** (whose scope is appointments only, D-7; proxy IDs are in `app.patient_ids`), can make the full chart of the patient visible to staff of a clinic of their choice. The API path only calls it after a confirmed booking.

**Remediation.** Inside the function: for `booking`, require an occupancy/reservation of that patient at that location in status `confirmed` (read through a `patient_scope_owner` policy on `scheduling.slot_reservation` columns `patient_id, location_id, id`) created in this transaction; for `referral`, accept only audience `staff` (and later the clinical module's check). Refuse `referral` to a patient audience. **Retest:** the sequence above must raise 42501 / PM008; a confirm of a real booking still creates the relationship.

### SEC03-F05 — Scheduling merge guard takes no lock (Medium, blocking)

**What.** SHARED-BOUNDARIES 9.2 and ARCHITECTURE 21.5: the guard reads the root `FOR KEY SHARE`, so a writer racing a merge waits and is then refused. `scheduling.guard_open_patient` (0901, "deviation D1") reads the status with a plain `SELECT` because `scheduling_booking_owner` has no `UPDATE` right on the root. The comment says the booking transaction already holds the lock through `lock_patients`.

**Reproduction (executed, two connections).** A merge transaction (superuser, same statements as `begin_merge` and the last write of `complete_merge`) holds the root `FOR UPDATE` and has written `status = 'merged'`, uncommitted. A patient-audience writer, which does **not** call `lock_patients`, calls `scheduling.occupy` and inserts a `slot_reservation` for that patient; it blocks on the foreign key. The merge commits. Result on the candidate: **the writer committed a reservation on the merged patient** (one orphan row on a merged ID). The same race against `patient.communication_preference`, whose guard locks, ended with `PM001 patient.merged` and zero rows.

**Impact.** Every current service path calls `lockPatients` first, so no orphan arises today. The guard no longer holds "for every writer, whatever its scope settings say", for a path that forgets rule 1 or a SQL path outside the service. The orphan is an R row on a merged ID that no participant will re-point.

**Remediation.** Preferred: grant `EXECUTE` on `patient.guard_open_patient()` to `app_owner` (the request already recorded as D1 to the Orchestrator), then attach the original trigger and drop `scheduling.guard_open_patient`. Alternative inside the module: give `scheduling_booking_owner` a narrow definer helper owned by `patient_scope_owner` that does the `FOR KEY SHARE` read. **Retest:** the race above ends with `PM001`; `M-5-patient-guard` must then also check the function's schema (F13).

### SEC03-F06 — Definer functions outside the approved inventory; the catalog gate is red (Medium, blocking)

**What.** SHARED-BOUNDARIES 6.2: "Adding one, or widening what one reads or returns, needs a revision of this document", and ARCHITECTURE 21.6 lists conditions DF-1..DF-9 for each. The approved inventory has `begin_merge` and `complete_merge` only. BE-09 added `request_merge`, `get_merge_request`, `decide_merge`, `load_merge_job`, `fail_merge` (five functions the design handled as invoker statements under RLS, 25.4) and did not list any of its seven functions in `catalog-lists.mjs` or in a requested patch. BE-11's requested patch lists four scheduling functions (including the guard copy).

**Evidence (executed).** The candidate's `db/tools/catalog-check.mjs` on a migrated database, as is: all checks pass except `M-5-definer`, which fails with 7 `patient.*` merge functions and the scheduling functions `in_inventory = false` (section 8.1). The gate fails closed, which is the intended behaviour; the defect is that the change was never designed in.

**Remediation.** Architect revises 6.2 and 21.6 (or rejects the five new functions and returns to invoker statements); this review accepts the five on the following conditions, which are all met by the code as written except where noted: `REVOKE … FROM PUBLIC` (met), fixed `search_path` (met), narrow `EXECUTE` (met), settings checked inside (met), no PHI returned (**not met by `get_merge_request`, F10**), audit row (met for request and decision, job writes the merge row). Then a ticket with permission to edit `db/tools/catalog-lists.mjs` applies both patches. **Retest:** `catalog-check.mjs` shows `M-5-definer` pass with exactly the approved list.

### SEC03-F07 — Negative-test sufficiency (Medium, blocking)

Reviewed for sufficiency against TC-AZ-01..16, 6.8 and 9.2. Gaps:

1. **No direct-SQL cross-location or cross-patient test on any child table** (consent, insurance, contacts, care team, preferences, flags, patient link, proxy grant, notification, receipt). TC-AZ-05/06/07 ("connect directly as the named role") are not implemented; none of the repository's `dbtest` files mention `TC-AZ-05..07`. This is why F01 passed.
2. **The behavioural M-5 matrix (21.3 AN-1) does not exist.** CI's `M-5-anonymous` and `M-5-public` read policy text for the audience literal. A tautology or a missing audience condition inside a larger predicate is invisible to it. My matrix (section 8.2) is what it must contain: one row per table, run as every audience and realm.
3. **`scheduling.set_status` and `ensure_care_relationship` have no test as a different patient or clinic**; the test "an application role cannot write the occupancy table; only the two definer functions can" passes while any caller can drive the functions (F02, F04).
4. **`patient.identity_label` has no test** and cannot succeed (F08); TC-AZ-08 steps 1 and 3 are untested.
5. **The 9.2 test "a queued job with a merged ID for one `resolve` and one `fail` type" is absent**, and the kernel registry refuses any patient-carrying type that does not declare `resolve` (`enqueue.ts`), so `fail`, and the "undeclared = fail" default, cannot be expressed or tested. The job-start resolution described in 9.2 is not in the worker runner; the notifications job resolves ad hoc.
6. The occupancy column assertion in `booking.dbtest.ts` ("who sees what") lists `patient_id, service_id, reason, booked_by_principal_id, mode` and omits `created_by`, which carries the same principal (F09).
7. Staff booking, cancel and reschedule routes are not mounted (README O-1), so the staff-realm cross-location behaviour is tested at service level only.

**Remediation (QA-03 with the owners).** Implement TC-AZ-05/06/07 and the AN-1 matrix as a mandatory CI database test over every table with RLS; add the set_status/ensure_care_relationship/identity_label negative cases; add the two job-type tests and make the registry able to declare `fail`. **Retest:** the new matrix must fail on the candidate (it would have failed on F01) and pass after F01–F05.

### SEC03-F08 — `patient.identity_label` can never succeed (Medium, not blocking)

`identity_label` declares `p patient.patient; SELECT * INTO p …` but `patient_match_owner` has column-level `SELECT` only (0702). `SELECT *` needs every column. Executed: as `patient_match_owner` with audience `staff`, `SELECT * FROM patient.patient` fails `42501 permission denied for table patient`; the identity-column list succeeds; the function therefore raises `42501` for a correctly authorised `admin_pool` caller with the `patient_label` key. Fail-closed, but the compliance label path (6.7, J-21) is broken and untested. Second point: the function trusts `p_ref_type` and `p_ref_id`; only the API (`referenceVisible`, O-5) verifies the referencing record, whereas TC-AZ-08 expects the refusal "without a visible referencing record" — hold it in the database too (the function can read `audit.event` or the consent through a match-owner policy and column grant), and rate-limit per principal (the design says planning value 60 per hour; none exists in the database or tests). **Fix:** select the named columns; add the test. **Retest:** TC-AZ-08.

### SEC03-F09 — `slot_occupancy` exposes `created_by` and reservation IDs (Medium, not blocking)

`GRANT SELECT ON scheduling.slot_occupancy TO app_api` is table-wide and the policy is organisation-wide for patient and staff. Every patient session can read, for every appointment of the organisation: the reservation ID (the occupancy ID equals it), location, clinician, room, period, status, `session_key` and **`created_by`, the booking principal's ID**. Executed: patient B read A's row including `created_by`. The design (6.5) lists the twin's columns and says "no patient identifier"; a stable principal ID per booking lets any patient correlate which time slots one person booked and with which clinicians (inferable specialty). It also supplies the IDs F02 needs. **Fix:** replace the table grant with column grants (`id, organisation_id, location_id, clinician_principal_id, room_id, period, status, expires_at, overbook`), and restrict the staff columns the same way, or move `created_by` out of the twin. **Retest:** `SELECT created_by` as a patient is refused.

### SEC03-F10 — Cross-scope identifiers and free text (Low)

(a) `duplicate_flag` select policies show a flag to staff who see **either** patient, so staff of the registering location read the UUID of the out-of-scope candidate (executed: the flag row lists patient A for staff B and patient B for staff A). The design says out-of-scope candidates are opaque (6.6). The root remains invisible. Keep the UUID out of the API response (check the controller) or store an opaque reference and resolve it in the definer. (b) `get_merge_request` returns both patient IDs and the free-text reason to any caller with the permission, in any location, by request ID (executed: staff with no location read both IDs and "…John Doe, HIV clinic" from a request they had no part in). The reason is free text typed by staff and may carry identifiers. Restrict the read to requester, approvers of the organisation with `patient.merge.approve`, and strip the reason for non-requesters unless intended; tell users in the form not to enter identifiers.

### SEC03-F11 — Worker merge-re-pointing grants are not tied to the merge job (Low)

`app_worker` has `UPDATE (patient_id[, status, reason])` on contact, insurance, consent, preference, care team, flag and reservation, `DELETE` on preference, and policies that need only `audience = system`, `job_scope = patients` and a job ID. Any patients-scope job (reminder, export, waitlist) therefore holds these rights for its patients. Executed: a patients-scope job for patient A withdrew a signed consent (`status = 'withdrawn'`, committed). Pending-to-signed is blocked by the shape check (no signer column grant). The merge job's own exactness check (`begin_merge`) is in the functions, not in these policies. **Fix:** do not reintroduce a job-class setting (21.7 removed `app.job_class`). Perform the re-pointing in `patient_scope_owner` definer functions that the executor calls (the participants then need no worker grant), or at least pin each grant and `WITH CHECK` to the statuses and columns the participants write.

### SEC03-F12 — Static checks not run in CI (Low)

`check:static` (lock order, sign-in setter call sites) exists only as a package script of `packages/kernel` that scans `packages/kernel/src`; no CI job, root script or workflow calls it (`grep` over `ci.yml`, `scripts/ci`, `package.json`). The scheduling README runs it by hand over `apps/api/src/modules/scheduling`. The list `PATIENT_SCOPE_OWNER_FUNCTIONS` omits `request_merge`, `decide_merge`, `load_merge_job`, `fail_merge`, `match_candidates`, `identity_label` and the `scheduling_booking_owner` functions. No check flags a direct `set_config('app.…')` or `SET LOCAL ROLE` outside the kernel (21.3 asks for it). **Fix:** run it over `apps/api/src` and `apps/worker/src` in the `ci` job, extend the lists, add the `set_config` rule, and make the job required.

### SEC03-F13 — Catalog checks and grants weaker than their text (Low)

1. `M-5-patient-guard` matches `proname = 'guard_open_patient'` in any schema: the trigger could be disabled (`tgenabled`), `AFTER`, `INSERT`-only, or the copy without the lock (F05) and still pass. Require `tgtype` BEFORE INSERT OR UPDATE ROW, `tgenabled = 'O'`, and the function's schema and owner.
2. `M-5-anonymous` and `M-5-public` are text matches (see F07 item 2).
3. `kernel.setting`: 21.2 N-3 requires column grants (`INSERT` six columns, `UPDATE (value)` only) and a catalog test of exactly those lists. 0003 grants `SELECT, INSERT, UPDATE, DELETE` on the whole table to `app_api` and `app_worker` (executed: every column has insert and update). `pre_auth` is still protected by the policy `NOT pre_auth` in `USING` and `WITH CHECK`, so no `pre_auth` row can be written by the admin API; `created_by`, `row_version` and the others are writable.
4. No check detects a policy predicate that does not mention a column of the protected table (a tautology). Add: for every policy on a table with `patient_id`, the stored predicate must contain `<table>.patient_id` or `patient_id = ANY(...)` outside a sub-query — or simply the behavioural matrix of F07.
5. `patient.caller_sees` re-implements the policy predicate by hand; DF-7 asks for the same predicate generated from the template. A parity test (every audience and role: `caller_sees(id)` equals "the row is visible under RLS") closes the drift risk and would have exposed F01.

## 6. Merge flow summary (what passed)

* Request needs both patients visible (resolver under RLS, then `caller_sees` in the function); a missing and an invisible ID raise the same error. Approval by a different person and principal, unique open request per merged patient, transition table, K states immutable.
* The execute job runs under `system`, `job_scope = patients`, `job_patient_ids` = both patients and every ID already merged into either, read from the request row. Failure rolls the whole transaction back; `fail_merge` records the code in a separate transaction.
* Two merges that share a patient lock roots in ascending order and cannot deadlock; a stale request is cancelled by `complete_merge`.
* Merged IDs are readable (scope contributor, `staff_scope` closure) and not writable (guard, root trigger).

## 7. Observations and residual risks (not defects of the candidate; need an owner decision)

* **O-1 (PM, Architect).** A wrong merge (two different people) is irreversible in R1 (`merged` is terminal, unmerge is not built, BQ-6). After the merge the portal user of the survivor reads the other person's immutable history (closure). Dual approval is the only control. Decide whether R1 ships without an unmerge procedure or with an operational runbook and a privacy-incident path for a wrong merge.
* **O-2 (Backend Engineer).** `complete_merge` trusts that `begin_merge` ran in the same transaction (roots locked `FOR UPDATE`). It checks `status = executing` but not the lock. A caller that commits after `begin_merge` and calls `complete_merge` later would lose the serialisation. Add `SELECT … FOR UPDATE` on both roots to `complete_merge` (idempotent) so the invariant is local. The counts are caller-supplied; the executor's coverage check and the participants' own post-conditions (`no R row left`) are the control and are tested.
* **O-3 (Backend Engineer).** The kernel `Tx.query` is an unrestricted handle: any module can issue `set_config('app.audience', 'system', true)` inside a scope. The model (21.3) says the settings protect against code-path mistakes, not against a compromised API process. F12 item "no `set_config` check" and code review are the controls; state this limit in the threat model.
* Two reads of the merge map (patient and staff policies) depend on `identity.patient_link`, `proxy_grant` and `audit.btg_grant` RLS of the caller; they are correct as tested by TC-MG-13 but should join the F07 matrix.

## 8. Raw evidence

### 8.1 Catalog check on the candidate (`db/tools/catalog-check.mjs`, PostgreSQL 17.7, migrated from empty by `db/roles/0001_roles.sql` and `db/migrations/*.sql` in order)

```
pass ENV-pg17 R-roles R-attributes R-no-owned-tables R-memberships R-timeouts R-app-owner-no-audit-insert
pass M-1 M-1-kernel M-2 M-3 M-4-views M-4-reporting M-5-patient-guard M-5-interim-exempt
FAIL M-5-definer
     patient.get_merge_request(uuid)            in_inventory=false  fixed_search_path=true  owner=patient_scope_owner
     patient.request_merge(uuid,uuid,uuid,text) in_inventory=false  …
     patient.decide_merge(uuid,uuid,text)       in_inventory=false  …
     patient.load_merge_job(uuid)               in_inventory=false  …
     patient.begin_merge(uuid)                  in_inventory=false  …
     patient.complete_merge(uuid,jsonb,jsonb)   in_inventory=false  …
     patient.fail_merge(uuid,text)              in_inventory=false  …
     scheduling.occupy / set_status / expire_holds / guard_open_patient  in_inventory=false (BE-11 patch not applied)
pass M-5-anonymous M-5-public M-5-directory
exit 1
```
(`catalog-report.json` sha256 `e2b1d62c9483a12679104b116f058198724b1f89cdc4b062fbbff7a7e140e313`.)

### 8.2 Row-visibility matrix (rows returned by `SELECT count(*)` per table; tables with 0 rows or denied are omitted; `app_api` unless stated)

Seed: patient A cared for at location A, patient B at location B; one row for A in contact (not seeded in this run), consent, insurance, preference, care team, duplicate flag (A→B), match check, patient link. Settings set with `set_config(name, value, true)`.

Shipped policies (PHI, scheduling, notification and link tables only):

```
CONTROL staff of location A            patient_link 1, care_relationship 2, care_team_member 1, communication_preference 1, consent 1, duplicate_flag 1, insurance_coverage 1, match_check 1, patient 1, patient_contact 1, staff_scope 1
patient B (no link to A)               patient 1 (own), staff_scope 1 (own)
staff of location B only               patient_link 1, care_relationship 2, care_team_member 1, communication_preference 1, consent 1, duplicate_flag 1, insurance_coverage 1, patient 1, patient_contact 1, staff_scope 1   <- all of A's child rows (F01)
admin_pool, no BTG, no slice           (none)
admin_pool, phi_access=limited[patient_label]   (none)
anonymous | public | partner | audience unset | no organisation   (none)
app_worker, system, job_scope=patients, job_patient_ids={B}   care_relationship 1, duplicate_flag 1 (candidate side), patient 1, staff_scope 1
```

After the scratch fix of the 21 policies (same seed, same probes; policies altered in the scratch database only):

```
staff of location B only               care_relationship 1 (own), duplicate_flag 1 (A→B flag, candidate side, F10a), patient 1 (own), staff_scope 1 (own)
CONTROL staff of location A            unchanged
all other callers                      unchanged
```
(`matrix-shipped.json` sha256 `257ac00c4c89319d80328fc46d911860109dc28820c5469a83fd6a076b109994`, `matrix-fixed.json` `dc6aeb1e715ddc1647280861587fc4ecdcba13659b6099e27d1437e5036ffb8f`.)

Policy predicate as stored (`pg_policies.qual`, `patient.consent` staff select): `EXISTS (SELECT 1 FROM patient.staff_scope s WHERE (s.patient_id = s.patient_id) AND s.location_id = ANY (kernel.uuids('app.location_ids')))`. Policies with that tautology: 21 (list in F01). Policies that reference `staff_scope` and are correct: 6.

### 8.3 Probe results (executed on the candidate, abbreviated)

| Probe | Result |
| --- | --- |
| P1a patient B selects `slot_occupancy` | 1 row of patient A's appointment incl. `created_by` = A's principal |
| P1b patient B selects `slot_reservation` | 0 rows |
| P1c patient B `set_status(A_id,'confirmed','cancelled_patient')` | `ok`; row `cancelled_patient` (F02) |
| P1d staff of location B `set_status(A_id,'confirmed','cancelled_clinic')` | `ok`; row `cancelled_clinic` (F02) |
| P2 hold A normal / hold B normal / hold B `overbook=true, key='made-up-session', cap=100` | committed / `23P01` / **committed**; two active rows for one doctor and period (F03) |
| P3 merge uncommitted + writer without `lock_patients` | patient table: `PM001`, 0 rows; scheduling: **committed**, 1 orphan row (F05) |
| P4 patient A `ensure_care_relationship(A, locB, 'referral')` | returns ID; staff of B then read A's patient row (F04) |
| P5 `identity_label` as `admin_pool`, `limited`, `patient_label` | `42501 permission denied for table patient` (F08) |
| P6 `get_merge_request` as staff with no location | both patient IDs and the free-text reason returned (F10b) |
| P7 patients-scope worker withdraws a signed consent | succeeds (F11); sign pending consent: refused by `consent_signed_shape` |
| P8 duplicate flag A→B, staff of A and staff of B | each sees the flag naming the other patient (F10a) |
| P9 `PUBLIC` execute on module functions; DML on definer-only tables; owners; FORCE | none; none; none; all 15 tables forced (section 4.2) |

### 8.4 Reproduction

```
# scratch cluster (PostgreSQL 17, any), then as the superuser:
psql -f db/roles/0001_roles.sql ehr
# as app_owner, in order: db/migrations/0001 … 0903
EHR_DB_ADMIN_URL=postgres://postgres@127.0.0.1:<port>/ehr node db/tools/catalog-check.mjs
# F01: seed two patients at two locations, then as app_api inside a transaction:
SELECT set_config('app.audience','staff',true), set_config('app.realm','google',true),
       set_config('app.org_id',:org,true), set_config('app.location_ids',:locB,true);
SELECT id FROM patient.consent WHERE patient_id = :A;      -- must be 0 rows
```

## 9. Next permitted action

1. Independent Security Reviewer reads this exact revision (`SEC-03-rls-assessment.md` as committed on the SEC-03 branch).
2. Routing done by Cybersecurity (children of HEAAA-25, none depends on SEC-03): HEAAA-177 = F01 (Backend Engineer), HEAAA-178 = F02–F05 (Backend Engineer), HEAAA-179 = F06 (Solution Architect), HEAAA-180 = F07 (QA Engineer), HEAAA-181 = F08–F13 (Backend Engineer, low priority). Orchestrator: make HEAAA-177..180 block INT-01 and the G3 consumers of BE-08/09/11 (Cybersecurity did not edit other tickets' links), and keep SEC-03 consumers waiting for the fixes' independent review and retest.
3. No code is changed by this ticket. Human gates are not touched: BUILD_REVIEW, ACCEPTANCE, G3 and OPERATIONS_RECEIPT remain human decisions.
