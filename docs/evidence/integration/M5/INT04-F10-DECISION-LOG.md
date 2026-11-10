# INT04-F10 decision log: owners and closure path for the carried SEC-02 and SEC-05 High findings

Ticket HEAAA-432 · parent HEAAA-139 (INT-04) · author: Solution Architect (`7efe9f61`) · review stage: Security Reviewer (`074b2525`, HEAAA-433)
Inputs read at the HEAAA-139 tip `c042771` (candidate `8195772`): `INT-04-FINDINGS.md` (INT04-F10), `docs/security/SEC-05-alerts-audit-assessment.md` sections 3 to 5, `docs/security/SEC-02-identity-assessment.md`, ARCHITECTURE 6, 22.2 (`audit.anchor`, `notifications.staff_alert`), 25.9 (O2-4), 33 (job table), T-STAFF (section 21), migrations `0201`, `0203`, `1201`, `apps/worker/src/compose.ts`, `jobs/audit/{anchor,jobs}.ts`, `infra/modules/observability/{alarms,variables}.tf`, and the DO-02 archive module on branch HEAAA-99 (`f68d26d`, `infra/modules/archive`).
Integration round 1 of 3. Nothing here was executed: this is a decision and design record, not test evidence. It is not human approval.

## 1. Summary

| Finding | Decision | Owner task (existing or requested of the Orchestrator) | Risk acceptance |
| --- | --- | --- | --- |
| SEC02-F01 | Close by fix | HEAAA-409 (INT04-F01), reviews HEAAA-410, HEAAA-411 | None |
| SEC02-F02 | Close by fix | HEAAA-412 (INT04-F02), reviews HEAAA-413, HEAAA-414 | None |
| SEC05-F01 | Close by fix: schedule in HEAAA-412; **add** the anchor liveness metric to HEAAA-412 | HEAAA-412 (scope note R1 below) | None |
| SEC05-F02 | Close by fix: design D-2 below (append-only receipt table + archive-authoritative verification) | New: F10-A (Architect amendment and its review), F10-B (Backend), F10-C (DevOps) | None (no production deploy before G3, see 4) |
| SEC05-F03 | Close by fix: producers in HEAAA-412; **new** task for target resolver and admin-realm access to `/alerts*` | New: F10-D (Backend); HEAAA-412 producers depend on it | None |
| SEC05-F04 | Close by fix: replace the stub body | New: F10-E (Backend) | None |
| SEC-05 re-read | Cybersecurity re-reads on the first integrated candidate holding all of the above, with the named test cases executed | New: F10-F (Cybersecurity) | — |

No risk acceptance is recorded. Every High finding has an owner task and a closure path. Accepting security risk is a Cybersecurity decision (reviewed by the Security Reviewer); I do not make it. Medium findings SEC02-F03..F07 and SEC05-F05..F11 are outside this decision and stay with their owners under HEAAA-25.

## 2. Decisions

### D-1 · SEC02-F01, SEC02-F02: closure through the existing INT04-F01/F02 tasks
- **Question:** Do SEC02-F01 (fail-closed root/AAGUID configuration) and SEC02-F02 (identity admin events: enrolment notice, counter-regression alert, B2-9 audit) need their own tasks?
- **Options:** (a) separate tasks; (b) closure inside HEAAA-409 and HEAAA-412, whose descriptions already name them and whose review stages include the Security Reviewer.
- **Choice:** (b).
- **Reason:** The fixes are the same code changes (composition and worker registration). A second task on the same files would conflict (shared composition files must be serialized, WORKFLOW). Closure still needs fix, independent review (HEAAA-410/411, 413/414), integrated rerun and the SEC-05/SEC-02 re-read (F10-F).
- **Standard:** WORKFLOW "Revision, review, and findings rules" (deduplicate without deleting history; closure sequence).

### D-2 · SEC05-F02: how anchors reach the Object Lock archive, and where the receipt lives
- **Question:** `audit.anchor` is insert-only (trigger `anchor_append_only`, no UPDATE grant to any role, `0201`/`0203`), but ARCHITECTURE 22.2 lists `archived_at` and `archive_key` on it, and nothing writes them. How does the worker copy each anchor to the log-archive bucket and record that it did, and what makes the copy a control rather than a note?
- **Options:**
  - (A) Grant `app_worker` UPDATE on `audit.anchor(archived_at, archive_key)` with a trigger that allows only a single NULL → value change. Matches the existing column list. Breaks the "no role updates an anchor" invariant that 0203 and threat 06 state, and records no object version or checksum.
  - (B) New append-only table `audit.anchor_archive_receipt` written by the worker after a successful conditional put; `audit.anchor` stays fully immutable; verification treats the **archive** as the authority and compares the database with it.
  - (C) Put the object inside the anchoring transaction and insert the anchor with `archived_at` set. Couples S3 latency and outages to the 60 s transaction bound and the per-organisation advisory lock; an S3 outage stops anchoring itself.
- **Choice:** (B), specified in section 3.
- **Reason:** It keeps the immutable table immutable (smaller trust surface; no new UPDATE path to reason about), records evidence a verifier can check (object version, SHA-256), and decouples anchoring from S3 availability. The receipt itself is bookkeeping, not the control: a principal with owner-level database access can forge a receipt in (A) or (B) alike. The control is that verification lists the archive and compares it with the database, so a rewritten database chain is detected against objects that Object Lock (compliance mode) prevents anyone from deleting or overwriting. (C) is rejected on availability.
- **Contract impact:** Adds a table, a job, a worker port and a narrow IAM grant; `archived_at`/`archive_key` on `audit.anchor` become unused (never written) and are marked deprecated, not dropped (expand-only migrations). This is a contract change: it needs the ARCHITECTURE amendment and Solution Architect Reviewer review (F10-A) **before** implementation (F10-B, F10-C) starts. The DO-02 archive module needs no new resource, only principals and a prefix-scoped policy (F10-C).
- **Standard:** ARCHITECTURE 6, threat 06, ADR-008, SAR-04, Z2→Z8 trust boundary (write-only cross-account role, Object Lock compliance mode); SEC05-F02 remediation; O2-4 (25.9).

### D-3 · SEC05-F01: who adds the liveness signal
- **Question:** SEC05-F01 asks for the schedule (in HEAAA-412) and a product-side "anchor late" signal. The observability module already defines alarm `audit-anchor-late` on metric `AuditAnchorLateSeconds` (route `security`, missing data = breaching, threshold variable "placeholder until the Solution Architect confirms"), but no code emits the metric.
- **Options:** (a) separate DevOps task; (b) the worker emits the metric as part of HEAAA-412, the alarm stays as authored.
- **Choice:** (b). I confirm the threshold **300 s** (five missed one-minute anchors; tighter than the 10 minutes SEC-05 suggested).
- **Reason:** The missing piece is an emitter in the worker composition that HEAAA-412 already changes. The alarm treats missing data as breaching, so an unemitted metric fails loud once deployed.
- **Requested scope note R1 for HEAAA-412 (via the Orchestrator):** emit gauge `AuditAnchorLateSeconds` = `now() − max(audit.anchor.to_ts)` for the organisation, once per anchor run (also when the run is skipped), through the existing telemetry exporter, IDs and numbers only; unit test that the value is produced on `anchored`, `up_to_date` and `locked` outcomes. The pinned crontab test requires both audit entries with a handler each (as SEC05-F01 states).

### D-4 · SEC05-F03: split of producers versus recipient access
- **Question:** HEAAA-412 names "compliance alert producers" only. SEC05-F03 also needs (b) a real `TargetResolver` in `apps/api/src/composition.ts` (today `new AlertService({ queue, audit })` has none, so `compliance_permission` targets throw 422) and (c) `/alerts`, `/alerts/open-ids`, `/alerts/{id}/acknowledge` and the stream accepting realm `admin_pool` as well as `google` (ARCHITECTURE 32.2 point 1).
- **Options:** (a) widen HEAAA-412; (b) new task F10-D for (b) and (c), serialized after HEAAA-409 (same composition file), with HEAAA-412's producers depending on it.
- **Choice:** (b).
- **Reason:** HEAAA-412 is already large and is worker-side; (b)/(c) are API-side and touch the files HEAAA-409 is changing now. Producers cannot pass their acceptance (alert row, `created` event, stream delivery to a compliance session) without the resolver and the realm rule, so F10-D is a real prerequisite of HEAAA-412, not of HEAAA-139 directly.
- **Contract:** No change. Targets per 22.2/25.5: active principals of realm `admin_pool` holding the permission, excluding the actor; `audit.btg.review` for `btg_opened` and `audit_anchor_mismatch`; kill-switch and privileged-change recipients per 25.5. Admin-realm alerts never carry `patient_id`.

### D-5 · SEC05-F04: replace the `staff_scope_allows_patient` stub
- **Question:** Who replaces the fail-closed stub (`1201`, `SELECT false`), and is it a contract change?
- **Options:** (a) Backend migration replacing the body with the T-STAFF predicate; (b) policy rewrite.
- **Choice:** (a), one `CREATE OR REPLACE FUNCTION` in a new migration, no policy change.
- **Reason:** The predicate is already the approved T-STAFF template (ARCHITECTURE 21: realm `google` and (`EXISTS patient.staff_scope` at `app.location_ids` or `patient_id = ANY(app.btg_patient_ids)`)). Re-implementing it differently is forbidden by DF-7's "generated from the policy template" rule, so the body must use the same template text as the patient policies. No contract change.

## 3. Design D-2 (normative for F10-A, F10-B, F10-C)

**3.1 Archive object.** One object per anchor in the DO-02 archive bucket (`<prefix>-audit-archive`, log-archive account, Object Lock compliance mode, versioning on, SSE-KMS with the log-archive key, CRR to the recovery-Region replica).
- Key: `anchors/<organisation_id>/<yyyy>/<mm>/<dd>/<to_ts as UTC ISO, microseconds>_<anchor id>.json`. Exported partitions use `partitions/` (DO-10); the two prefixes are disjoint so grants can be scoped.
- Body: canonical JSON (keys sorted, no whitespace, UTF-8), `{"schema":1,"id":"…","organisation_id":"…","from_ts":"…","to_ts":"…","row_count":"…","merkle_root":"<hex>","prev_hash":"<hex>","hash":"<hex>","late_rows":n}`. Numbers that are `bigint` are strings. No PHI exists in an anchor (C1).
- Put: `PutObject` with `If-None-Match: *` (refuse overwrite), `x-amz-checksum-sha256`, SSE-KMS header (the bucket policy denies unencrypted writes). Object Lock default retention applies; the worker never sets retention or legal hold.

**3.2 Receipt table** (new migration, audit range, expand-only):

| Column | Type | Rule |
| --- | --- | --- |
| `anchor_id` | `bigint` PK | FK → `audit.anchor(id)` |
| `organisation_id` | `uuid` NOT NULL | equals the anchor's |
| `archive_key` | `text` NOT NULL, ≤ 500 | the 3.1 key |
| `version_id` | `text` NOT NULL, ≤ 1024 | S3 version returned by the put (or by the read in 3.3 step 3) |
| `body_sha256` | `bytea` NOT NULL, 32 bytes | SHA-256 of the canonical body |
| `archived_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

Triggers `audit.refuse_change()` for UPDATE, DELETE and TRUNCATE, as on `audit.anchor`. RLS enabled and forced: INSERT and SELECT under T-SYS only; SELECT T-SLICE(`audit_events`) for the viewer. Grants: `INSERT, SELECT` to `app_worker`; `SELECT` to `app_api`; nothing to `PUBLIC` or `app_owner`. Class C1. `audit.anchor.archived_at`/`archive_key`: comment "deprecated, never written; see anchor_archive_receipt".

**3.3 Job `audit.archive_anchors`** (every minute, key = minute, T-SYS, org-scoped, advisory lock `audit.archive_anchors:<org>` so one writer):
1. Select up to 100 anchors with no receipt, in `id` order.
2. For each: build the canonical body; put with `If-None-Match: *`.
3. If S3 answers 412 (object exists, for example after a crash between put and insert): read the existing object (earliest version), compare its bytes with the canonical body. Equal → insert the receipt with that version. Different → do **not** insert; publish `audit.anchor_mismatch` (resource = anchor id, reason `archive_differs`) and continue with the next anchor.
4. On success insert the receipt in its own short transaction. S3 errors other than 412 leave the anchor unreceipted for the next run; the lag metric shows it.
5. Emit gauge `AuditAnchorArchiveLagSeconds` = age of the oldest anchor without a receipt (0 when none), every run.
The job never updates `audit.anchor` and never deletes an object.

**3.4 Verification (`audit.verify_anchors`, extended).** For the verification window (the existing daily window, plus the whole chain in the bounded, paged form SEC05-F11 asks for):
1. **Archive → database.** List object versions under `anchors/<org>/<day>/` for each day in the window. For each key take the **earliest** version (Object Lock keeps every version; a later version is itself a finding). Every archived anchor must exist in `audit.anchor` with byte-identical canonical content. A missing or different database anchor → `audit.anchor_mismatch` (reason `db_differs_from_archive`), unless it lies after a point-in-time restore point (ARCHITECTURE 33 "Restore point and anchors": record "after restore point", not tampering).
2. **Database → archive.** Every anchor older than the archive grace (15 min) must have a receipt whose `archive_key`/`version_id` resolves to that object. Missing → mismatch (reason `not_archived`).
3. **Chain and roots** as today (prev_hash chain, recomputed Merkle roots over the events), now checked against the archived chain, not only the database chain. A rewritten database chain that is internally consistent fails step 1.
4. Emit `AuditAnchorVerificationMismatch` (the existing alarm's metric) and publish `audit.anchor_mismatch` for the F03 producer.

**3.5 O2-4 (25.9).** "Archived anchor" means: an anchor with a receipt **and** an object that the verification job has confirmed (step 1) on or after the receipt. The tx-sign worker checks the receipt in the database; the daily verification is what makes forging a receipt detectable. The amendment (F10-A) states this; SEC02-F04 closure depends on F10-B.

**3.6 Access (F10-C).** In the approvals root (all production IAM, DEVOPS-PLAN 7.5): the worker task role gets `s3:PutObject` on `arn:aws:s3:::<archive>/anchors/*` only, and `s3:GetObject`, `s3:GetObjectVersion`, `s3:ListBucketVersions` (prefix condition `anchors/*`) for verification; `kms:GenerateDataKey`/`kms:Decrypt` on the log-archive key through its key policy. In the archive module call: the worker role ARN is added to `writer_principal_arns` and `reader_principal_arns`, and the writer statement is narrowed so a writer's `PutObject` resource is its own prefix (worker → `anchors/*`; `audit_archiver` → `partitions/*`). No `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, `s3:DeleteObject*` or `s3:BypassGovernanceRetention` for the worker (the bucket policy already denies delete and retention changes). Alarm `audit-anchor-archive-late` on `AuditAnchorArchiveLagSeconds` (route `security`, threshold 900 s, missing = breaching), catalogue entry and runbook line.

**3.7 Residual risk (stated, not accepted by me).** (a) Between an anchor's insert and its archive copy (normally ≤ 2 min, alarmed at 15 min) an owner-level database attacker can rewrite that anchor and its events undetected. (b) Events younger than the 2-minute watermark are not yet anchored. (c) An attacker who also stops the worker is caught by the missing-data-breaching alarms, not by verification. These are inherent to batch anchoring (ADR-008) and are for Cybersecurity to record in the SEC-05 re-read.

**3.8 Tests required of F10-B.** (1) Unit: canonical body is stable and round-trips; 412 with equal body inserts a receipt; 412 with different body publishes the mismatch and inserts nothing. (2) dbtest on unmodified migrations: receipt table refuses UPDATE/DELETE/TRUNCATE for every application role; `app_worker` cannot UPDATE `audit.anchor`. (3) Integration with an in-process object-store fake that implements versioning and `If-None-Match` (no real AWS in CI): **tamper test**, change an event row and rewrite the anchor chain in the database as owner, run verification, expect `db_differs_from_archive` and an alert; delete a receipt, expect `not_archived`. (4) Extend TC-AU-08 with the archive case. Real-bucket behaviour (conditional put, prefix grants, KMS) is verified by DevOps in staging (F10-C) and recorded as Unverified until then.

## 4. Why no interim risk acceptance

SEC-05 marks F01 to F04 as blocking acceptance of RA-R1-11/12, not as blocking integration work. No production deployment can happen before G3, and INT-05 (the R1 candidate) depends on INT-04. All four have owner tasks above, so an acceptance would only be needed if a fix cannot land before INT-05. That decision belongs to Cybersecurity (reviewed by the Security Reviewer) with owner, expiry and compensating control; F10-F's brief tells them to make it then if needed.

## 5. Follow-up tasks requested of the Orchestrator

Parent HEAAA-139 for all (they block INT-04's round 2), except F10-A, whose output is an architecture amendment. Each fix task branches from the HEAAA-139 tip and submits a candidate commit with actual lint, prettier, typecheck and test results.

| Ref | Title | Assignee | Reviewer task(s) | Direct blockers |
| --- | --- | --- | --- | --- |
| F10-A | `[SDLC:design:INT04-F10-A]` ARCHITECTURE amendment for D-2: 22.2 receipt row and `audit.anchor` column note, 33 job row `audit.archive_anchors` and extended `audit.verify_anchors`, section 6 sentence, 25.9 O2-4 wording, Z2→Z8 grant; manifest update | Solution Architect | Solution Architect Reviewer; Security Reviewer | — |
| F10-B | `[SDLC:fix:SEC05-F02]` Anchor archive: receipt migration, `audit.archive_anchors` job, object-store port, archive-authoritative verification, lag metric, tests 3.8 | Backend Engineer | Backend Reviewer; Security Reviewer | F10-A review PASS; HEAAA-412 (same worker registration files) |
| F10-C | `[SDLC:fix:SEC05-F02-infra]` Worker archive grants (prefix-scoped), narrowed writer statement, `audit-anchor-archive-late` alarm, staging verification of conditional put | DevOps Engineer | DevOps Reviewer; Security Reviewer | F10-A review PASS |
| F10-D | `[SDLC:fix:SEC05-F03-access]` `TargetResolver` in API composition; `/alerts*` and stream accept `google` and `admin_pool`, negative tests for other realms and patient sessions | Backend Engineer | Backend Reviewer; Security Reviewer | HEAAA-409 |
| F10-E | `[SDLC:fix:SEC05-F04]` Replace `staff_scope_allows_patient` with the T-STAFF template; catalogue check against a literal `false` body; dbtest on unmodified migrations (in-scope doctor sees and acknowledges a red flag, out-of-scope doctor does not) | Backend Engineer | Backend Reviewer; Security Reviewer | — |
| F10-F | `[SDLC:security:SEC-05-reread]` SEC-05 (and SEC-02 carried items) re-read on the first integrated INT-04 candidate holding HEAAA-409, HEAAA-412, F10-B..E; execute TC-AU-02..05, TC-AU-08, TC-SEC-13, TC-SEC-20 and attach alert delivery evidence; record any interim risk acceptance per section 4 | Cybersecurity | Security Reviewer | Integrator's round-2 candidate of HEAAA-139 (which itself waits for the fix reviews) |

Changes to existing tasks: HEAAA-412 gains scope note R1 (D-3) and the blocker F10-D (D-4). HEAAA-139 gains blockers F10-B, F10-C, F10-D, F10-E. F10-F blocks the SEC-05 acceptance of RA-R1-11/12, not HEAAA-139's round-2 integration.

## 6. Status of this record

Authored at the HEAAA-139 tip `c042771`. Independent review: HEAAA-433 (Security Reviewer). The D-2 contract change also needs the Solution Architect Reviewer (F10-A) before implementation. Next permitted action: the Orchestrator creates F10-A..F and applies the changes in section 5.
