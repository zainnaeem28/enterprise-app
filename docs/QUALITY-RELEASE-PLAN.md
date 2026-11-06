# QUALITY-RELEASE-PLAN — Enterprise EHR Platform, Release 1

| Field | Value |
| --- | --- |
| Task | HEAAA-18 `[SDLC:delivery-plan]` |
| Author | Delivery Planner `452babff` |
| Date | 2026-11-05 |
| Version | **Draft 3 (carries the draft 1 text except: the identity-freeze human gate HEAAA-147 in the level 3 and level 4 rows, the merge/export participant count test in the level 2 and section 3 rows; changed content needs re-review). Not human-approved. This is not G2.** |
| Subordinate plans (referenced, not repeated) | **QA plan:** `TEST-CASES.md` (HEAAA-51 `test-cases` rev `4ecc71c0`, draft 5, not clean, C-15). **DevOps plan:** `DEVOPS-PLAN.md` (HEAAA-50 `devops-plan` rev `3023afa1`, draft 6, DPR-37..40 carried, C-14). Where this plan and those plans seem to differ, those plans govern their subject and the difference is a finding. |

## 1. Purpose and position in the workflow

This plan says how quality is proven and how a release is prepared for R1, ticket by ticket and stage by stage, and what evidence each step must produce. It plans; nothing in it has been executed. Execution finished, review passed, integration passed, human approval, deployment and operational acknowledgement are separate facts and are recorded separately.

## 2. Quality gates by level

| Level | What happens | Evidence required | Independent party | Outcome |
| --- | --- | --- | --- | --- |
| 1 Ticket | Owner submits with an evidence comment; reviewer stage(s) inspect the exact revision and the raw reports | Ticket acceptance and common checks (TICKETS.md 3); required CI checks of DEVOPS-PLAN 5.1 on the branch | Independent reviewer; Security Reviewer for security-sensitive tickets | PASS or CHANGES REQUIRED recorded natively; ledger updated |
| 2 Milestone integration | Integrator merges reviewed branches in dependency order and reruns the relevant checks (INT-01..INT-05) | Combined clean frozen install; migrations from empty and from the previous tag (versions apply in native integration order; the runner rejects out-of-order versions); the milestone journey on the combined revision; relevant CI jobs; from INT-02, the ARCHITECTURE 38.2 item 11 merge count test across all registered merge participants and export contributors (found = re-pointed + resolved + kept) | QA Engineer reviews the evidence | Merged candidate is new evidence context; changed content needs affected re-review |
| 3 Security | SEC-02..SEC-08 assessments at the milestones; SEC-07 reads the candidate's raw scan reports | Findings routed with stable IDs; blockers become correction tickets; no relabelling; the identity-freeze erratum (ID-FREEZE) needs its human acceptance on gate task HEAAA-147 before identity implementation (BE-04, BE-05) starts | Security Reviewer | No open blocking security finding at BUILD_REVIEW |
| 4 BUILD_REVIEW (human) | Orchestrator packages the candidate: ticket list, verification results, run guide, **actual** application screenshots, code/PR/pipeline evidence | Everything above on the exact candidate; actual screenshots of the running candidate (not mockups) | Human Architect, UI/UX, product owner and applicable DevOps/security owners | Accept for full validation, request fixes, or hold. Not release authority |
| 5 ACCEPTANCE (human) | QA executes the approved cases (HEAAA-29, HEAAA-30), selected quality and security checks on isolated resources | TEST-CASES execution results, SAST, dependency, secret and container scans, lint/type/build, accessibility, performance, recovery evidence as planned | Client/product owner accepts business outcomes; human Architect/QA, UI/UX, security owners review evidence | Missing, skipped, empty, malformed, stale or wrong-revision reports, tool failures and blocking findings fail the gate; required failures cannot be waived |
| 6 G3 (human) | DevOps prepares the exact artifact, configuration, environment and recovery plan (HEAAA-33); Release Reviewer checks the same revision | Section 9 below | Release owner, human Architect/DevOps, business owner | Approves artifact + configuration + plan + named environment and permitted actions only |

## 3. Required automated checks and who builds them

| Check | Built by | Blocks on |
| --- | --- | --- |
| Format, lint, types, import boundaries | F-01, F-02 | any error |
| Unit and integration tests; empty/skipped suites fail | every ticket; F-02 | any failure |
| Authorisation and RLS tests (SHARED-BOUNDARIES 6.8; negative tests per role pair) | F-09, BE-04, BE-08, QA-03 | any failure |
| Migration check (DEVOPS-PLAN 5.2) from empty and from the previous tag; N-1 compatibility; out-of-order version rejected | F-03, F-09 | any rule violation |
| Merge participant / export contributor count test (ARCHITECTURE 38.2 item 11, found = re-pointed + resolved + kept) | F-04 (registries), BE-04..BE-19 (participants), INT-02, INT-03 | any participant missing or any count mismatch |
| SAST (Semgrep CE, pinned ruleset), dependency (OSV, Dependabot), secrets (gitleaks), containers (Trivy), SBOM (Syft) | F-02 | High/critical, any secret, SBOM missing, as DEVOPS-PLAN 5.1 |
| PHI-in-logs canary | F-04, F-02 | any synthetic identifier in logs, URLs or analytics |
| API contract (Schemathesis against the OpenAPI) | F-08, F-09 | any schema or status violation, undocumented status, 5xx |
| Browser end-to-end smoke (Playwright PR subset); accessibility smoke (axe); bundle and LCP budget (Lighthouse CI) | F-06, F-09, QA-02 | any failure; empty suite fails; new serious/critical violation |
| Workflow hygiene: actionlint, SHA pins, allow-list, declared `permissions` | F-02 | any violation (works on any GitHub plan) |

Selection of SonarQube, CodeRabbit and Strix: **not selected**; no test relies on them (DEVOPS-PLAN 14). Active dynamic assessment needs an explicitly authorised target, methods, credentials, time/rate/cost limits and cleanup; none is authorised. Schemathesis is a contract and negative test, not an authorised security assessment, and never runs against production.

Evidence reading rule: reviewers read the raw reports and artifacts. Exit code zero or a green badge is insufficient. Each result records tool and version, scope, candidate commit, configuration identity, assertion counts, limitations and finding disposition.

## 4. Test execution plan

**Environments (TEST-CASES 0.3, bound to DEVOPS-PLAN 3.5):** `ENV-INT/ci` (exists as containers after F-02/F-03), `ENV-INT/staging`, `ENV-INT/bootstrap`, `ENV-LOAD`, `ENV-DR`, `ENV-A11Y`. **Only `ENV-INT/ci` can exist under G2 as planned.** Everything bound to another environment is BLOCKED until C-01 (authorisation) and its own condition (C-10, C-13, C-17) are answered. A result is valid only for the environment and candidate it names.

**Automation tickets.** QA-01 corrects the frozen cases (document only); QA-02 builds the harness, deterministic synthetic data and test accounts; QA-03..QA-06 script the `AUTO` and the automatable part of `AUTO+H` cases by area; QA-07 (load, resilience) is held until `loadtest` exists. They are Backlog until the Orchestrator promotes them (a third writer; not in the initial two-worker batch). A case is automated only when a script can fail it for the right reason; cases that need Google, SMS, video, e-prescribing or payment pass only against that provider's real sandbox and otherwise stay BLOCKED naming it.

**Order.** `ci` suites run on every milestone integration; the full `AUTO` set runs on the release candidate on `ci`; staging, ZAP baseline, vendor cases and the full browser matrix follow only after staging is authorised; load, DR rehearsal and restore-test follow their environments; human cases are run by the named persons.

**Human-required work (stays `Pending-human` until the person does it; QA never records a result for them):** owner (D-12a safety reviewer, BAA evidence, NFR exceptions, Workspace policy export), licensed clinician, accessibility tester with assistive technology, device testers, two named people for dual control, DevOps/operations owner (restore, DR drill, policy exports, alert test), Security Reviewer/Cybersecurity (ASVS checklist, spike review), independent penetration tester, marketing user, compliance officer, UI/UX or owner (legibility, prompt wording). Full register: TEST-CASES 12.

**Known defects in the frozen TEST-CASES (C-15), not to be planned from as written:** TC-AU-04 step 2 (expects acceptance of a value that the trigger accepts; the case must use `transaction_timeout = 61s` and expect refusal); duplicate ID `TC-API-10` (two different cases; the release-gate case becomes `TC-API-11`); POR-02..04 (TC-PC-16 roles, traceability, BTG expectation); SA-TC-07..10. QA-01 fixes them in a bounded erratum revision that reopens the human QA approval; tickets F-03 and F-05 name the corrected forms.

**Blocked cases are not skipped and not waived** (TEST-CASES 13): D-12a, D-7, D-8, D-2, D-35 path tags, BQ-3, retention, UMLS, QA-AL-01 (until ID-FREEZE), sandboxes and the load environment.

## 5. Findings and defect routing

One shared ledger (DELIVERY-PLAN section 11). Severity policy: P0 cases (safety, security, privacy, data loss) cannot be waived by client acceptance (PRD RA-R1-18, 8.3); every legal requirement and NFR-12..NFR-19 cannot be waived. A permitted exception (non-security, non-privacy, non-safety, non-compliance NFR) is granted by the product owner in writing with the NFR, reason, compensating control, expiry and the independent reviewer's acknowledgement; if none exists it is reported as **self-granted by the owner**. Fixes return to the same ledger; a changed candidate reruns the affected checks.

## 6. Requirement coverage: PRD release rows RA-R1-01..32

Every row has a planned build owner, QA ticket and test cases. "Evidence" is what will count; none exists yet. Case groups are from TEST-CASES 15.1 (rev `4ecc71c0`).

| Row | Build tickets (owner) | Cases | QA ticket | Evidence | Blocked / human / note |
| --- | --- | --- | --- | --- | --- |
| RA-R1-01 | BE-04, FE-03, FE-08 | TC-ID-01..12 | QA-03 | integration-db; Workspace policy export (owner, OPS) | TC-ID-01/05 need the test tenant (C-10); TC-ID-03..05, TC-ID-07 human/OPS; PP-02/PP-04 (OTP, passkey, MFA) are hosted-page properties configured in DO-04 and evidenced by TC-ID-03 on a real pool; FE-03 covers only the handoff, callback landing and error states (HEAAA-172); PP-03 ID check deferred pending SA-FE03-01 |
| RA-R1-02 | BE-11, BE-12, FE-04 | TC-BK-01..12 | QA-04 | integration-db; Playwright PR subset | values [G2 setting] (C-23) |
| RA-R1-03 | BE-11 | TC-BK-13..18, TC-PERF-07 | QA-04, QA-07 | two-connection concurrency tests on `ci`; load run on `loadtest` | TC-PERF-07 BLOCKED (C-17) |
| RA-R1-04 | BE-14, FE-11 | TC-CAL-01..06 | QA-04 | contract tests on `ci` | real Google evidence BLOCKED (C-10); step 8 of TC-CAL-05 waits for ID-FREEZE |
| RA-R1-05 | BE-06, BE-03, FE-04 | TC-NT-01..08 | QA-04 | render-every-template test | TC-NT-03 human (three calendar clients); providers C-10/C-11 |
| RA-R1-06 | BE-13, BE-18, FE-09 | TC-PC-01..09, 13..15 | QA-04 | integration-db; Playwright | queue ordering by category not asserted (PM-confirm-2) |
| RA-R1-07 | BE-07, BE-18, FE-09, FE-10 | TC-SAF-01..04, TC-PC-16 | QA-04 | mechanics tests only | **BLOCKED until D-12a (C-03)** |
| RA-R1-08 | BE-18, FE-07 | TC-SAF-05..08 | QA-04 | mechanics tests only | **BLOCKED until D-12a (C-03)**; TC-SAF-07 human |
| RA-R1-09 | BE-16, BE-17, FE-10 | TC-CL-01..07 | QA-04 | integration-db; Playwright | real terminology C-09 |
| RA-R1-10 | BE-15, FE-07, FE-10 | TC-TH-01..05, TC-PERF-06 | QA-05, QA-07 | vendor sandbox; load | BLOCKED: video sandbox (C-10, C-11), load env (C-17) |
| RA-R1-11 | BE-01, BE-16, BE-24, FE-13 | TC-AU-01..04, TC-AZ-10, 11, 16 | QA-05 | integration-db; TC-AU-04 corrected | TC-AU-04 step 2 per SA-TC-06 residual (C-15) |
| RA-R1-12 | BE-01, BE-24, FE-13 | TC-AU-05..09 | QA-05 | integration-db; export job | retention (C-20) |
| RA-R1-13 | BE-10, FE-06 | TC-DOC-01..08 | QA-05 | integration-db | real scanner behaviour Unverified (C-01, C-10) |
| RA-R1-14 | BE-20, FE-05, FE-13 | TC-PR-01..05 | QA-05 | integration-db | **deletion meaning BLOCKED (C-05)**; TC-PR-05 human (compliance) |
| RA-R1-15 | BE-03, BE-23, FE-14 | TC-AD-01..07 | QA-05 | integration-db; Playwright | D-3 default (C-07) |
| RA-R1-16 | FE-15, FE-16, BE-22 | TC-BS-01..07 | QA-05 | Lighthouse CI; axe | TC-BS-03 human (marketing user); CMS C-19 |
| RA-R1-17 | BE-04, BE-08, BE-16, BE-11 | TC-AZ-01..15, TC-SEC-C7-01..07 | QA-03 | RLS suite on `ci` | SEC-confirm-1 (C-08) |
| RA-R1-18 | F-02, F-09, DO-07, DO-08, DO-11, FE-01, SEC-07 | TC-PERF-01..08, TC-A11Y-01..08, TC-XB-01..03, TC-REC-01..09, TC-NFR-01..13, TC-PEN-01 | QA-06, QA-07 | CI reports; load; recovery rehearsals; independent penetration test | load env (C-17); TC-PEN-01 and assistive-technology runs are human; NFR-12..19 cannot be waived |
| RA-R1-19 | BE-08, FE-05 | TC-PP-01..02 | QA-05 | integration-db; Playwright |  |
| RA-R1-20a | BE-08, FE-05 | TC-PP-03, TC-AZ-14 | QA-05 | integration-db |  |
| RA-R1-20b | BE-08, FE-05 | TC-PP-04, 05 | QA-05 | (none until decided) | **BLOCKED on D-7 (C-04)** |
| RA-R1-21 | BE-18, FE-07 | TC-PP-06..07 | QA-05 | integration-db; Playwright | send time [G2 setting] |
| RA-R1-22 | BE-13, FE-04 | TC-BK-19..22 | QA-04 | integration-db |  |
| RA-R1-23 | BE-12, FE-11 | TC-DR-01..03 | QA-04 | integration-db |  |
| RA-R1-24 | BE-16, FE-10 | TC-CL-08..10, TC-PC-07, 13..15 | QA-04 | integration-db; Playwright | TC-CL-10 mechanism only (D-12a); TC-PC-15 legibility human |
| RA-R1-25 | BE-19, FE-12 | TC-MSG-01..04 | QA-05 | integration-db | D-5 (C-07) |
| RA-R1-26 | BE-23, FE-14, FE-15 | TC-AD-08..10, TC-BS-08 | QA-05 | integration-db; Playwright |  |
| RA-R1-27 | BE-08, BE-09, FE-09 | TC-MG-01..14 | QA-05 | two-connection concurrency tests | BQ-3 roles (C-08) |
| RA-R1-28 | BE-15, FE-07 | TC-TH-06..08 | QA-05 | integration-db | real states (C-06) |
| RA-R1-29 | BE-18, FE-09 | TC-PC-10 | QA-04 | integration-db |  |
| RA-R1-30 | BE-18, FE-09 | TC-PC-11..12 | QA-04 | integration-db | lab sample booking not built (D-4 default) |
| RA-R1-31 | BE-02, BE-24, FE-14 | TC-AD-11..15 | QA-05 | integration-db | sandboxes (C-10) |
| RA-R1-32 | BE-05, BE-24, FE-13, FE-17, DO-04, DO-10, SEC-02 | TC-SEC-01..25, TC-SEC-C7-01..07, TC-AD-05, 10 | QA-03 | tests on the combined revision (C1, C4, C6); evidence for C2, C3, C5, C7 from DevOps/QA plans | TC-SEC-03/05/11/16/23 need two humans (C-13); path tags (C-02) |

## 7. Non-functional coverage

| NFR | Build tickets | Verification | Note |
| --- | --- | --- | --- |
| NFR-1..3 availability, RPO, RTO | DO-02, DO-03, DO-07, DO-08 | QA-07 (TC-REC) | Targets, not claims; region-loss rehearsal and restore-test evidence; on-call rota C-18 |
| NFR-4, NFR-5 recovery tests, zero-downtime deploys | DO-06, DO-08, F-09 (migration-check) | TC-NFR-*, TC-REC-* | expand/contract and N-1 compatibility on `ci`; rollout on staging only after C-01 |
| NFR-6..9 latency, slot search, concurrency | F-05, BE-12, DO-11 | QA-07 (TC-PERF-*) | `loadtest` BLOCKED (C-17); planning budgets in ARCHITECTURE 35 are not measurements |
| NFR-10 accessibility WCAG 2.2 AA | FE-01 and every FE ticket | QA-06 (TC-A11Y-*) | automated axe in CI; assistive-technology runs are Pending-human (UX-O-08) |
| NFR-11 browsers and devices | every FE ticket | QA-06 (TC-XB-*) | real devices Pending-human |
| NFR-12..14 encryption, audit, application security | F-03, F-04, BE-01, BE-04, BE-05, SEC-01..SEC-08 | QA-03 | cannot be waived (RA-R1-18) |
| NFR-15 CI gates | F-02, F-09 | CI reports read by reviewers | enforced only to the extent the GitHub plan allows (C-13) |
| NFR-16 penetration test | SEC-07 (scope) | TC-PEN-01 human | independent tester required before R1 production (DEP-13); not an agent task |
| NFR-17 public-form protection | BE-22, DO-03 | TC-NFR-* | WAF rules authored in DO-03; behaviour verified on staging (C-01) |
| NFR-18 data handling, synthetic only outside production | F-04 (PHI canary), QA-02 (generators), every ticket | TC-NFR-* | PHI-in-logs check in CI |
| NFR-19 hosting and BAA register | DO-01..DO-04 | TC-NFR-11 (owner evidence) | human/owner evidence; vendors C-11 |
| NFR-20..22 monitoring, integration failures, time zones | DO-07, BE-02, BE-21 | TC-NFR-* | alerts delivered to a named rota C-18 |

## 8. Security and scans

- Design: SEC-01 (identity, trust boundaries, secrets), then ID-FREEZE. Implementation: SEC-02 (identity/admin realm/secrets), SEC-03 (RLS, scope, merge), SEC-04 (documents, notifications, PHI in output), SEC-08 (clinical access, banner allergies, BTG, red-flag path), SEC-05 (alerts, audit, BTG, stream), SEC-06 (IaC, CI trust, release controls), SEC-07 (candidate scan results, residual risk, pen-test scope).
- Assessments are documents with routed findings; they change no code. Each is read by the Security Reviewer. Mandatory scans of section 3 apply regardless of the specialist lane.
- Independent penetration test before R1 production with no open high or critical finding (DEP-13, TC-PEN-01): a human-required item, not an agent task; its tester, scope, credentials and window need an explicit authorisation that does not exist.
- Security controls enforced by GitHub depend on the plan (C-13). The release evidence states the exact settings found.

## 9. Release preparation (after ACCEPTANCE; Stage 5)

Planned by DevOps (HEAAA-33 `release-plan`, HEAAA-35 `deploy`, HEAAA-36 `operations-package`), independently checked by the Release Reviewer. This section lists inputs the build must make available and the contents DEVOPS-PLAN 15.2 already defines:

| G3 input | Source |
| --- | --- |
| Exact artifact | DO-05 release manifest (image digests, bundle hashes, lockfile hash, migrations, `releaseNumber`); candidate manifest from INT-05 |
| Configuration and named environment | DO-03/04/06 code; environment named in G3; production, staging, hosted demo and marketing each need their own authorisation (C-01) |
| Migrations, backup, restore | DO-02, DO-08; N-1 compatibility result from `ci`; latest restore-test result; backup freshness |
| Load and penetration status | DO-11/QA-07 (C-17); independent pen test (human) |
| BAA register | Every vendor that receives PHI (NFR-19); vendors undecided (C-11) |
| On-call and alert delivery | Named rota and a tested alert (C-18) |
| Observation window and abort thresholds; recovery | DEVOPS-PLAN 9.2; ROLLBACK-RUNBOOK; application rollback may not reverse database changes |
| Named people and access | Platform admin, custodians, approvers; one person holding every role is stated in the package (RK-5) |
| GitHub-side enforcement status | The exact settings found; whether approval-by-apply is the only effective control (DPR-02) |
| Unresolved findings and suppressions | From the shared ledger; suppressions have owner and expiry |

Deployment credentials are not provided to execution agents until a valid G3 for that environment. Staging, hosted demos and production are authorised separately. After approval, migration, rollout, smoke checks and observation are serialised through the approved CI/CD provider under an environment release lock; failures follow only the approved recovery procedure and a failed recovery stays failed. OPERATIONS_RECEIPT follows `DEPLOYMENT-RESULT.md` and final `OPERATIONS-HANDOFF.md`. `www.`/`cms.` marketing release is separate from the application release (DEVOPS-PLAN DPR-12).

## 10. Entry and exit criteria

| Stage | Criteria |
| --- | --- |
| Build starts | A real human G2 decision on these exact revisions; HEAAA-21 dispatch complete; ticket Ready check recorded |
| Foundation exit (M1) | MS table in DELIVERY-PLAN section 5 |
| BUILD_REVIEW package | INT-05 PASS; SEC-07 filed; no open blocking finding; actual screenshots of the running candidate; run guide; ticket list with final states; open blocked/pending items listed with condition IDs |
| ACCEPTANCE package | Executed results for every non-blocked non-human case with raw reports; blocked and pending-human cases listed, not hidden; scans read; screenshots match the candidate |
| G3 package | Section 9 complete for the named environment |

## 11. Limitations and next permitted action

Nothing was executed; every row above is a plan. The frozen TEST-CASES and DEVOPS-PLAN are not clean and the human declined further cycles. The coverage table was generated from the PRD row list and the QA matrix; I checked that every row is present and that every named ticket exists, not that each case actually exercises its requirement (QA reviews did that for the cases). Next: independent review of this revision by the Orchestrator and the Solution Architect, then the G2 gate package. No release action is authorised by this document.
