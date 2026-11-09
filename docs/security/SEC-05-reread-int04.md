# SEC-05 re-read (and carried SEC-02 items) on the integrated INT-04 candidate

Task HEAAA-452 (INT04-F10-F) · author: Cybersecurity (`83cd0a46`) · reviewer stage: Security Reviewer (`074b2525`, HEAAA-453)
Decision input: HEAAA-432 `decision-log` revision `45ffc212-c3e2-4cfc-982a-21c5343e03a0` (section 5, F10-F; section 4 on risk acceptance).
Revision read: `0f730f2` on the HEAAA-139 branch (= candidate `bcaf403` + evidence-only commit). QA PASS on this revision is on HEAAA-139. Product code was not changed by this task.

## 1. Method and limits

Code reading at `0f730f2` plus **execution** of the named test cases on a fresh PostgreSQL 17.11 cluster (UTF8, loopback, synthetic data, real migrations 0001..2407, `pnpm install --frozen-lockfile`, `pnpm build`). Each dbtest file was run with `node --test` and `EHR_TEST_ADMIN_URL` set; raw spec output is in `docs/evidence/integration/M5/sec05-reread/`.
Not done: no real AWS, no real S3 or KMS, no staging, no container, no browser; I did not run the full integration-db aggregate (the Integrator's r12 run did, 1279 tests twice). "Executed" below means the named file passed here; it says nothing beyond what that test asserts.

## 2. Test cases executed

| Case | Where it runs | Result here | What it does not show |
| --- | --- | --- | --- |
| TC-AU-02 (audit failure rolls the change back) | `api audit.dbtest` (40 pass, 0 fail) | PASS | none |
| TC-AU-03 (denial path) | `api audit.dbtest` | **PARTIAL**. Fail-closed denial passes. The "alerted" half is **not met in the product**: `composition.ts:225` builds `new AuditService({ logger, queue })` with no `onDenialWriteFailure` (SEC05-F12 still open). The test supplies the hook itself. | A failed denial write is logged by class only; no alert is raised in a running API. |
| TC-AU-04 (bounded transaction, `PA001`/`42501`, positive control) | `api audit.dbtest` | PASS (on CI-style PG17; RDS `transaction_timeout` role setting remains Unverified, DEVOPS-PLAN 5.2) | RDS behaviour |
| TC-AU-05 (no role edits or deletes an audit row) | `api audit.dbtest` | PASS | the UI/API half is by absence of any route, also asserted in `admin-routes.dbtest` (21 pass) |
| TC-AU-08 (tamper is detected and alerts) | `worker audit.dbtest` (16 pass) and `worker archive.dbtest` (15 pass) | PASS: DBA row change detected; `audit_anchor_mismatch` published once per anchor and kind; archive-authoritative tamper (events changed and chain rewritten consistently as owner) gives `db_differs_from_archive`; deleted receipt gives `not_archived`; forged receipt, extra version and unreadable archive all reported, never clean | The archive is an in-process fake (versioning and `If-None-Match`). Real bucket: Unverified (see G-2). The alert row for the mismatch is created by a **test-local** handler registration (`audit.dbtest.ts:63`), not by the product's `compliance-alerts.ts` (see G-1). |
| TC-SEC-13 (kill switch) | `api privileged.dbtest` (16 pass), `alerts.dbtest` (35 pass), `guard.dbtest` (38 pass), `composition-admin.dbtest` (25 pass), `admin-event.dbtest` (4 pass) | PASS for: one transaction ends every session and elevation, disables the target, closes streams (`event: closed`); next request refused; without elevation refused; audit `session_revoke`/`kill_switch`. | The compliance alert `kill switch used`: the event `identity.kill_switch_used` is published (`identity/admin/service.ts:813`) and a handler exists, but no test runs publish -> `notifications.on_kill_switch_used` -> alert row -> compliance recipient (G-1). |
| TC-SEC-20 (admin sees metadata not PHI; BTG with reason; export rate limit alerted; config changes audited) | `admin-routes.dbtest` (21 pass), `audit.dbtest`, `reporting.dbtest` (29 pass), `privileged.dbtest` | **PARTIAL**. Steps 1 to 3 pass (audit view, no PHI, BTG with reason and second-person review, export reason and size limit, config audited). **Step 4 fails**: there is no export rate limit and no compliance alert on exports (grep of `apps/api/src` finds no per-requester export count; SEC05-F09 still open). | |
| Carried: SEC05-F04 red flag visible to in-scope staff | `alerts.dbtest` ("HEAAA-286 ... red flag targeted at a doctor is listed, streamed and acknowledged; non-target gets 404") | PASS on migration 2406 | |
| Carried: F10-D resolver and realm rule | `alerts.dbtest` ("INT04-F10-D ... admin_pool holders only, actor excluded, other realms refused") | PASS | |

## 3. Status of the four High findings

| ID | Status on `0f730f2` | Evidence |
| --- | --- | --- |
| SEC05-F01 anchors unscheduled | **Closed in code.** `AUDIT_CRONTAB` is in `WORKER_CRONTAB` (`job-registry.ts:52`); `compose` boots with it (`compose.dbtest`, 3 pass); `AuditAnchorLateSeconds` and `AuditAnchorArchiveLagSeconds` are emitted (`jobs/audit/metrics.ts`); alarms `audit-anchor-late` (300 s), `audit-anchor-archive-late`, `audit-anchor-mismatch` exist in the observability module. | alarms are IaC only, not applied |
| SEC05-F02 anchors not in the object-locked archive | **Design and logic closed, control not operational.** Receipt table (0204), `audit.archive_anchors`, archive-authoritative verification and tamper tests pass. But: (a) the worker's archive port defaults to `refusingAnchorArchive` (`compose.ts:81-87`) and no S3 adapter exists in the repo (no `client-s3` dependency); (b) `infra/modules/archive` is not instantiated by any root, and the worker task role is in neither `writer_principal_arns` nor `reader_principal_arns`; (c) the module's per-prefix grants are unapplied. Consequence today: puts fail, lag alarm fires (missing data breaches), verification fails closed ("archive unavailable"), never reads clean. | see G-2 |
| SEC05-F03 compliance alerts have no producer or recipient route | **Components closed, end-to-end delivery not demonstrated.** `createTargetResolver()` is composed (`composition.ts:352`); `/alerts*` and stream accept `admin_pool`; `COMPLIANCE_ALERT_JOBS` handlers are registered in both registries; producers publish `audit.btg_opened`, `identity.kill_switch_used`, `audit.anchor_mismatch`, plus identity admin events (`admin-event.dbtest`: enrolment notice, counter regression, subject excluded). | G-1 |
| SEC05-F04 `staff_scope_allows_patient` stub | **Closed.** Migration 2406 replaces the body with the T-STAFF template; behaviour test passes. | |

## 4. Gaps found (new IDs, for the common ledger)

| ID | Severity | Gap | Owner |
| --- | --- | --- | --- |
| SEC05RR-G1 | Medium | No test runs a real compliance event through the product's own handlers (`createComplianceAlertTasks`) to an alert row visible to a compliance principal and an open stream. `audit.dbtest` registers its own handler; `m4-registration.test` only checks registration. The alert delivery evidence this task was to attach therefore exists for the components, not for the chain. | Backend Engineer; QA |
| SEC05RR-G2 | High (production), accepted for integration only, see 5 | No S3 adapter for `AnchorArchiveStore`; archive module not instantiated with the worker principals in any root. SEC05-F02's control cannot run in any deployed environment. | Backend (adapter), DevOps (root wiring, staging proof of conditional put, prefix grants, KMS) |
| SEC05RR-G3 | Low | SEC05-F12 open: `AuditService` composed without `onDenialWriteFailure`; TC-AU-03 alerted half fails in a running API. | Backend |
| SEC05RR-G4 | Medium | SEC05-F09 open: no export rate limit or alert; TC-SEC-20 step 4 fails. Re-rated Medium (unchanged). | Backend (audit lane) |

SEC05-F05..F11 (Medium) were not re-assessed here beyond what the executed tests show; they stay with their owners.

## 5. Interim risk acceptance (decision-log section 4)

**Decision:** accept SEC05RR-G2 (SEC05-F02 control not operational) for **integration use only**. Not accepted for any production or real-patient-data environment.
- **Owner of the acceptance:** Cybersecurity (this agent), reviewed by the Security Reviewer (HEAAA-453). Business owner for the residual: Product Owner via G3.
- **Scope:** INT-05 and the R1 candidate build, ENV-INT and CI only, synthetic data. No deployment to staging with real PHI or to production.
- **Expiry:** the earlier of (i) the G3 request for any environment holding real patient data, (ii) the first staging environment that receives non-synthetic data. At expiry G-2 must be closed: adapter merged and reviewed, archive module instantiated with the worker task role, staging test of conditional put, prefix-scoped grants and KMS recorded.
- **Compensating controls in the candidate (executed or reviewed):** archive-authoritative verification fails closed when the archive is unreadable (`archive.dbtest`); tamper detection against the database chain still runs (TC-AU-08); `audit_anchor_archive_late` and `audit_anchor_late` alarms treat missing data as breaching; audit tables remain append-only for every application role (TC-AU-05); no production deploy path exists before G3.
- **What this does not accept:** SEC05-F02's residual windows in 3.7 of the decision log, nor RA-R1-11/12 acceptance. **SEC-05 acceptance of RA-R1-11/12 stays CHANGES REQUIRED** until G-2 closes, G-1 is demonstrated, and F09/F12 are fixed or separately accepted by their owners.

## 6. Result

Result: **CHANGES REQUIRED for RA-R1-11/12 acceptance; no blocker for INT-04 round 2 or INT-05 integration.** F01 and F04 closed; F02 and F03 closed at component level with the gaps above; TC-AU-02, 04, 05, 08 and TC-SEC-13 pass as far as stated; TC-AU-03 and TC-SEC-20 are partial.
Next permitted action: Security Reviewer reviews this record (HEAAA-453); Orchestrator creates owner tasks for G-1 to G-4 and records the G-2 expiry as a G3 precondition. Review rounds: 1. This is not human approval, G3 or deployment.
