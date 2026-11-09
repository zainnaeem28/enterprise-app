# INT04-F02b decision log: how `identity.bootstrap_admins` creates the first two admin principals

| Field | Value |
| --- | --- |
| Task | HEAAA-460 `[SDLC:fix:INT04-F02b]` (split from HEAAA-412, INT04-F02; finding SEC02-F02) |
| Owner | Solution Architect (`7efe9f61`) |
| Base | Branch `HEAAA-412-sdlc-fix-int04-f02-register-admin-worker-handlers-and-crontab` @ `6534771` |
| Sources read | ARCHITECTURE 21.2, 26.3, 33.1; DEVOPS-PLAN 4.1 A2, 16.2 (DPR-10, DPR-23); TICKETS DO-10; migrations `0500`, `2400`, `2401`, `2402`; `db/roles/0001_roles.sql`; `apps/api/src/modules/identity/admin/service.ts` (enrolment token request/approve); `packages/kernel/src/queue/harden.sql`; `0203_audit_rls_and_grants.sql`; `0904` (SHARED-BOUNDARIES 6.2 rule 3) |
| Status | Decided by the owner of technical decisions. Needs independent review: Solution Architect Reviewer (design) and Security Reviewer (roles, grants, token path). Not human-approved |
| ARCHITECTURE change | Amendment A-6 (section 40.14) written in the same commit; 21.2, 26.3 and 33.1 changed |

## 1. Facts that drive the decision (verified in the code at the base commit)

1. `app_worker` has no INSERT on `identity.person`, `identity.principal`, `identity.role_assignment`, `identity.role_change_request` or `identity.enrolment_token`. It has SELECT and a few UPDATE grants under audience `system` (2402 lines 124-177, 340-372). The INSERT policies (`person_admin_insert`, `principal_admin_insert`, `role_assignment_admin_insert`, `enrolment_token_admin_insert`) are `TO app_api` and need an `admin_pool` staff session.
2. `identity.guard_enrolment_token` (2401): an insert starts `requested` with no hash; `requested → approved` needs `approved_by_person_id = app.person_id`. CHECK: approver ≠ requester. The principal must be `admin_pool`.
3. `identity.guard_role_change_request` (2401): an insert needs `requester_person_id = app.person_id`; approval needs `approver_person_id = app.person_id` and approver ≠ the subject's person; `approved → applied` is free. `role_assignment.granted_via_request_id` is NOT NULL with a foreign key to `role_change_request`.
4. The API rule (`approveEnrolmentToken`): the approver may be neither the requester nor the subject. **The requester may be the subject.** So the issue's premise "two admins cannot approve each other's tokens" holds only when the requester is one of the two admins. With a requester who is not the approver, a crossed pairing satisfies every rule (section 3).
5. DEVOPS-PLAN 16.2 already fixes the human control: two named custodians, the `gh-bootstrap-<env>` AWS role enabled only by approval-by-apply with two human approvals, a one-off ECS task with a dedicated role that "may only call the bootstrap function", tokens written to per-person Secrets Manager secrets that only the other custodian can read (DPR-10, DPR-23), and "expired token → repeat from step 1". DO-10 (HEAAA-138, DevOps) owns `bootstrap.yml` and `scripts/bootstrap/**`.
6. Graphile `queue.add_job` and `queue_api.enqueue` are executable by `app_worker` and `app_api` only (`harden.sql`). The `audit.event` insert policy accepts function-owner roles under a user audience and `app_worker` under `system` (0203).

## 2. D-1: SECURITY DEFINER function or new `app_worker` INSERT grants

**Question.** How does the bootstrap write rows that `app_worker` may not write?

| Option | For | Against |
| --- | --- | --- |
| A. New `app_worker` INSERT grants and `system` policies on person, principal, role_change_request, role_assignment, enrolment_token | Few objects | Every worker job, for the life of the system, could create admin principals and grant `org_admin`. The "refuses if any admin exists" rule would live only in application code. Breaks the C4 premise that no single compromised tier can mint an admin |
| B. A definer function owned by a new `NOLOGIN` owner role, `EXECUTE` granted to `app_worker` | The latch and the C4 steps are in the database, in one call | A compromised worker could call it in any environment where the bootstrap has not run yet. RK-5 means this window is real: with one human, TC-SEC-11 stays Blocked and staging can stay un-bootstrapped for months |
| **C. A definer function owned by a new `NOLOGIN` owner role, `EXECUTE` granted only to a new dedicated login role `app_bootstrap`** whose database credential only the bootstrap task can read | The latch and the C4 steps are in the database. No running service can call it; reaching it needs the dual-controlled `gh-bootstrap-<env>` role (16.2). Matches 16.2 step 1 ("the job's role may only call the bootstrap function") | One more login role, one more secret, one more owner role |

**Choice: C.** Reason: the first admins are the root of trust of the admin realm. A permanent write path (A) or one reachable from the always-running worker (B) is a standing privilege-escalation route for a once-per-environment action. C costs two roles and one secret, all reversible. It keeps the existing C4 triggers in force (the function sets `app.person_id` per step instead of bypassing them) and follows SHARED-BOUNDARIES 6.2 rule 3: the definer checks its caller itself. Standards: least privilege; C4; SHARED-BOUNDARIES 6.2; DEVOPS-PLAN 16.2 step 1.

### 2.1 Contract (normative for the implementing ticket)

**Roles** (`db/roles/0001_roles.sql`, idempotent as now):
- `identity_bootstrap_owner`: `NOLOGIN NOSUPERUSER NOBYPASSRLS`. Its only member is `app_owner`, with `INHERIT FALSE, SET TRUE` (21.2 point 1 pattern). It owns exactly one function, `identity.bootstrap_admins`.
- `app_bootstrap`: `LOGIN NOSUPERUSER NOBYPASSRLS`, member of nothing. `CONNECT` on the database; `USAGE` on schema `identity`; `EXECUTE` on `identity.bootstrap_admins`. Nothing else: no table privilege anywhere. Role settings as `app_worker` (`transaction_timeout = '60s'`, `statement_timeout = '50s'`, `idle_in_transaction_session_timeout = '30s'`, `lock_timeout = '5s'`). The password lives in the secret store as `<env>/db/app-bootstrap`, readable only by the bootstrap task role (DO-10). No service task definition references it.

**Grants and policies to `identity_bootstrap_owner`** (migration in the 2400-2499 identity band, next free number; every policy `TO identity_bootstrap_owner` and gated on `current_user = 'identity_bootstrap_owner' AND app.audience = 'system' AND organisation_id = app.org_id`):
- Column INSERT on `identity.person`, `identity.principal` (`admin_pool` rows only: `subject` not null, `email` null), `identity.role_change_request`, `identity.role_assignment`, `identity.enrolment_token`, `identity.bootstrap_run` (below), each limited to the columns the API's insert uses plus `created_by_job`.
- Column UPDATE: `role_change_request (status, approver_person_id, decided_at)`; `enrolment_token (token_hash, approved_by_person_id, expires_at, status)`.
- SELECT on the rows it must read: `principal` (latch, trigger lookups), `admin_credential (principal_id)`, `role (id, key)` and `enrolment_token` and `role_change_request` (state checks), `bootstrap_run`.
- `audit.event`: INSERT, and a new branch in policy `event_insert`: `current_user = 'identity_bootstrap_owner' AND app.audience = 'system'`. No SELECT on `audit.event`.
- `EXECUTE` on `queue_api.enqueue` (added in `harden.sql` next to `app_api`, `app_worker`) and `USAGE` on schema `queue_api`. `identity.admin_event` must accept this caller; if `queue_api.enqueue` restricts callers by `current_user`, the restriction is widened to this role for `identity.admin_event` only.
- `EXECUTE` on the trigger functions `identity.guard_role_change_request`, `identity.guard_enrolment_token` and `kernel.bump_row_version`. No DELETE anywhere. No right on `admin_credential` except the SELECT above. No right on `session`, `elevation_grant`, `webauthn_challenge`.

**New table `identity.bootstrap_run`** (C1, insert-only, RLS forced): `id`, `organisation_id`, `run_ref` (CI run ID, text ≤ 100), `ticket_ref` (text ≤ 100), `mode` (`create` | `reissue`), `principal_ids uuid[]` (the two bootstrap principals), `custodian_person_ids uuid[]`, `created_at`. SELECT for `app_api` under the admin realm's T-CONF read (it is evidence for the privileged-access review). No UPDATE or DELETE grant to anyone. It is how a re-run recognises the two bootstrap principals (D-1.3).

**Function** `identity.bootstrap_admins(p_run_ref text, p_ticket_ref text, p_enrollees jsonb, p_custodians jsonb, p_token_hashes bytea[]) RETURNS jsonb`, `SECURITY DEFINER`, `SET search_path = pg_catalog`, schema-qualified names only, owner `identity_bootstrap_owner`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO app_bootstrap`.
- `p_enrollees`: two objects `{handle, display_name}`. Handles follow the existing `admin_pool` subject rule and are distinct.
- `p_custodians`: two objects. Each is either `{display_name}` (a custodian who is not an enrollee) or `{enrollee: 1|2}` (a custodian who is that enrollee). Custodian `i` retrieves the token of enrollee `i` (D-2). Refused if custodian `i` is enrollee `i`, or if the two custodians are the same.
- `p_token_hashes`: two SHA-256 values (32 bytes each, distinct), hash `i` for enrollee `i`. The function never sees a plain token.

**Caller binding (6.2 rule 3).** First statements: refuse unless `session_user = 'app_bootstrap'`, `app.org_id` is set, and the organisation exists. Then set, transaction-local, `app.audience = 'system'` and `app.job_scope = 'org'`. Restore `app.person_id` to its previous value before returning.

**Concurrency.** `pg_advisory_xact_lock` on `identity.bootstrap_admins:<org_id>` before the latch read, so two runs serialise and the second sees the first's rows.

**D-1.3 Latch and modes (refines ARCHITECTURE 26.3 "refuses if any `admin_pool` principal exists").**
- **create**: no `admin_pool` principal exists in the organisation, in any status. Creates everything in section 3.
- **reissue**: exactly one `bootstrap_run` exists; the only `admin_pool` principals in the organisation are its two `principal_ids`; the handles given equal theirs; and at least one of them has **never** had an `admin_credential` row (revoked rows count). For each such principal only: open tokens (`requested` or `approved`) are set `expired`, and one new token is created as in section 3 with the new run's custodians. A principal that has a credential gets nothing. Roles are not touched. A new `bootstrap_run` row records the run.
- **refuse** in every other case, with `PS001` and the message `bootstrap refused`, and no write. This includes: any other `admin_pool` principal; both bootstrap principals have a credential; mismatched handles; a missing `org_admin` role (reference data not applied).

Reason for reissue: 16.2 step 7 says an expired token is fixed by repeating the run. Under the literal 26.3 rule the first run's principals would close the latch, so one missed 30-minute window would leave an environment with no admin and no repair path short of superuser surgery. Reissue is bounded: it needs the same dual-controlled pipeline, cannot create a new principal, cannot touch an enrolled principal, and closes forever once both have enrolled a key. It also covers the case where one enrollee enrolled and the other did not; one admin alone cannot issue a token (C4).

## 3. D-2: who requests and who approves the first two tokens and role grants

**Question.** Each token and each role grant needs a requester and an approver who are persons (`identity.person`), with approver ≠ requester and approver ≠ subject.

| Option | Against |
| --- | --- |
| A. Each enrollee approves the other's token | The enrollees did not act; the audit would name approvers who approved nothing. Fails when the enrollees are the custodians (requester and approver collide) |
| B. A synthetic "system" person requests and approves | A system person cannot be both (CHECK). Two synthetic persons hide the humans who actually approved, against TC-SEC-11 ("both people recorded in the audit") |
| **C. The two custodians, crossed** | — |

**Choice: C.** For enrollee `i`, with custodian `i` the one who will read that token (16.2 step 3) and custodian `j` the other:

| Row | Requester | Approver |
| --- | --- | --- |
| `role_change_request` granting `org_admin` (no location) to enrollee `i` | custodian `j` | custodian `i` |
| `enrolment_token` for enrollee `i` | custodian `j` | custodian `i` |

This follows ARCHITECTURE 26.3 ("shown once to the approver, who hands it over out of band") and DPR-23. Every rule holds in all cases: the approver is never the requester (`i ≠ j`); the approver is never the subject (custodian `i` ≠ enrollee `i` is refused at input). When the custodians are the enrollees (16.2 allows it, crossed), custodian `i` is enrollee `j`: the approver of enrollee `i`'s rows is enrollee `j` and the requester is enrollee `i` itself. The requester may be the subject (API rule, fact 4), and the approver is neither. Each custodian appears once as requester and once as approver, which mirrors the two human approvals of the approval-by-apply change. A custodian who is not an enrollee is created as a `person` with no principal (cannot sign in). A custodian who is an enrollee reuses the enrollee's person.

**Steps inside the one call (create mode), triggers enforced throughout:**
1. Insert the enrollee persons, any non-enrollee custodian persons, and two `admin_pool` principals (`subject` = handle, status `active`). `created_by_job` = the `bootstrap_run.id`.
2. Per enrollee `i`: set `app.person_id` = custodian `j`; insert the role change request (`change` = `{"add":[{"role":"org_admin","location_id":null}]}`, `before` = `[]`, `request_hash` = SHA-256 of the canonical change, `expires_at` = now + 30 min) and the enrolment token (`requested`, `expires_at` = now + `enrolment_token_minutes`, capped at 30). Set `app.person_id` = custodian `i`; approve the request; insert the `role_assignment` (`granted_via_request_id` = the request); set the request `applied`; approve the token with hash `i`.
3. Insert the `bootstrap_run` row and one `audit.event` per created resource (action `create` for persons, principals, requests, tokens and the assignment; `update` for each approval and apply), actor = the person of the step, `request_id` = `p_run_ref`.
4. Enqueue `identity.admin_event` for each enrollee: `enrolment_token_requested`, `enrolment_token_approved`, `role_change_decided`, with job keys `<kind>:<row id>`. The existing handler (HEAAA-412) then raises the compliance alert and the PHI-free notice to the security contact (B2-9). With no compliance officer assigned yet, the notice to the security contact mailbox is the detection layer; the alert has no recipient until a compliance role is granted. This is a known limit of a fresh environment, not a defect.
5. Return `{mode, run_id, principal_ids, token_ids, expires_at}`. No hash and no token in the return value.

The bootstrapped admins hold `org_admin` only. Every later role, including `compliance_officer`, goes through C4 in the app. Elevation then works as for any admin (two keys, 26.3 B2-8).

## 4. D-3: how the plain tokens reach the custodians without entering logs or artifacts

**Choice:** DEVOPS-PLAN 16.2 step 3 as written, with the process contract below. No alternative was needed; the open point was only where the plain token is created and in what order.

**The run-once command** (`apps/worker`, entry `bootstrap-admins`, same release image; runs as a one-off ECS task under the `gh-bootstrap-<env>` path; not a queue job and never registered in the worker's job registry or crontab):
1. Reads its inputs (enrollee handles and display names, custodian entries and their IAM Identity Center role ARNs, enrollee identity ARNs for the explicit deny, ticket reference) **from the approved record `/approved/bootstrap-<env>`**, not from workflow inputs. The agent identity cannot write that record (DEVOPS-PLAN 7.4), so it cannot redirect a token to itself. The run reference is the CI run ID.
2. Generates two tokens in memory: `randomBytes(32)`, base64url, the same format the API's approve path uses (`service.ts`); computes their SHA-256.
3. **Before the database call**, creates the two secrets `bootstrap/<env>/token/<enrollee-label>` with the customer-managed key and a resource policy: `GetSecretValue` only for custodian `i`'s Identity Center role, an explicit deny for enrollee `i`'s identity, and a deny for every other principal including the bootstrap task role after creation. If this fails, it stops; nothing is in the database.
4. Calls `identity.bootstrap_admins` in one transaction as `app_bootstrap`. If the call fails or is refused, it force-deletes both secrets and exits non-zero. So a committed bootstrap always has its secrets. If the secret deletion itself fails, it exits non-zero naming the secret ARNs, and the runbook deletes them.
5. Overwrites the token buffers. Writes to stdout only: mode, run ID, principal IDs, token IDs, expiry and secret ARNs. The logger is created with no token in scope; a unit test asserts that no output line contains either token or its hash.
6. `bootstrap.yml` (DO-10) ends with a step that waits until the returned expiry and force-deletes both secrets, then checks they are gone. That covers "deleted on use or at expiry": the token is useless after use (status `used`) and after expiry, so deletion at expiry bounds the secret's life to 30 minutes either way. CloudTrail alerts on every `GetSecretValue` (16.2).

The token never enters the database (only its hash), the workflow log, a CI artifact, a task comment or a chat. The custodian reads it with MFA through their own Identity Center role and hands it over in person or through a secure channel of their choice (16.2).

## 5. Work this decision creates

| Ticket | Owner | Scope | Starts after |
| --- | --- | --- | --- |
| INT04-F02b-impl | Backend Engineer | Roles in `db/roles/0001_roles.sql`; one identity migration (owner role grants and policies, `bootstrap_run`, the function, `audit.event` policy branch); `harden.sql` `queue_api.enqueue` grant; the `bootstrap-admins` run-once command in `apps/worker` with the AWS secret port behind an interface (fake in tests); catalog check updates (role lists, owner checks); real-database tests below | This decision passes Solution Architect Reviewer and Security Reviewer |
| DO-10 (HEAAA-138, existing) | DevOps Engineer | `bootstrap.yml` calls the command; `<env>/db/app-bootstrap` secret and its policy; bootstrap task role (create and force-delete `bootstrap/<env>/token/*`, nothing else; read `/approved/bootstrap-<env>`); the record fields of section 4 step 1; the expiry deletion step | Already ticketed; this decision supplies its interface |

**Required real-database tests (the acceptance of INT04-F02b-impl):**
1. Create mode creates exactly two `admin_pool` principals, two enrollee persons (plus custodian persons where distinct), two applied role change requests, two `org_admin` assignments, two `approved` tokens whose `token_hash` equals the given hashes, approved by the crossed custodian, expiring in ≤ 30 minutes; the audit rows and the six `identity.admin_event` jobs exist; one `bootstrap_run` row.
2. A second create-mode call refuses with no write. A call when any non-bootstrap `admin_pool` principal exists (any status) refuses with no write.
3. Reissue: with no credential, a second run expires the open tokens and issues new ones for both; after one principal has a credential it reissues only for the other; after both have one it refuses. Different handles refuse.
4. Custodian `i` = enrollee `i`, two identical custodians, duplicate handles or hashes, and a missing `org_admin` role each refuse with no write.
5. Two concurrent calls: exactly one succeeds.
6. Caller binding: `app_worker` and `app_api` get `permission denied` on `EXECUTE`; `app_bootstrap` gets `permission denied` on a direct INSERT or SELECT on every identity table and on `audit.event`; a call from a session whose `session_user` is not `app_bootstrap` refuses.
7. The token issued by the function is accepted by the existing enrolment lookup policy (`enrolment_token_lookup`) for its hash, i.e. the first admin can start the enrolment path.
8. The run-once command (unit): secrets created before the call; deleted when the call fails; output contains neither token nor hash; inputs come from the approved-record port only.
9. Catalog: `identity_bootstrap_owner` owns exactly one function; `app_bootstrap` has no table privilege; membership rows as in 2.1; the M-5 behavioural check is extended with `app_bootstrap` and sees no rows.

## 6. Risks and limits

- **RK-5.** With one human there are not two custodians, so no environment can run this for real (DEVOPS-PLAN 16 item 2, TC-SEC-11 Blocked). The code and the tests can be built and reviewed; the rehearsal stays Blocked. This decision does not weaken that.
- A database superuser can still create admins directly. That is outside the application's trust boundary (21.2) and is visible in the audit gap and CloudTrail.
- Reissue adds a state the original 26.3 sentence did not name. It is narrower than the alternative (manual database repair).
- Reversible: the roles, function, table and grants are additive and can be dropped by a contract migration.
