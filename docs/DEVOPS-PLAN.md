# DEVOPS-PLAN — Enterprise EHR Platform (Stage 2, post-G1)

| Field | Value |
| --- | --- |
| Task | HEAAA-16 `[SDLC:devops-plan]`; draft 4 is produced under HEAAA-50 `[SDLC:design-align-fix]` (bounded cycle, see Version) |
| Author | DevOps Engineer agent (`021d733c-9400-40ba-9b0e-540b71450434`) |
| Independent reviewer | Solution Architect Reviewer (`338c0bb5-1aeb-4d88-b754-4885297ae447`) |
| Version | **Draft 4** (one human-granted bounded correction cycle, HEAAA-17 confirmation `a524dfdd`, 2026-11-05T13:14Z, limited to: DPR-25, DPR-26, DPR-27 from `devops-plan-review` rev `01b55b06`, and design-alignment items AL-04 (confirm), AL-05, AL-07, AL-09 from HEAAA-17 `design-align` rev `4447e3ec` section 4. Base: draft 3, HEAAA-16 `devops-plan` rev `a3b9f37f` = `docs/DEVOPS-PLAN.md` @ `b78a8b6`. Change list: 0.2. Draft 3 answered review round 2, DPR-16..DPR-24; round 1 DPR-01..DPR-15 dispositions are kept in 0.1) |
| Status | **Draft 4. Awaiting independent review of the diff against draft 3 (reviewers: DevOps Reviewer `fe9b5f91` and Solution Architect Reviewer `338c0bb5`). Cumulative ledger: 3 of 3 rounds used plus this one bounded cycle; not reset. Not human-approved. This is not G2 and authorises no installation, provisioning, account sign-up, workflow file, or deployment.** |
| Baseline | ARCHITECTURE **draft 8.1** (HEAAA-48 `architecture` rev `b276930a-20af-4433-a8f0-60843f5a3eaf` = `docs/ARCHITECTURE.md` @ `481f32a`, sha256 `1e7fe57e…08bbae`, SA Reviewer PASS on its diff, HEAAA-53 `architecture-draft81-review` rev `4ccbdafd`; G1-accepted overview was draft 4, HEAAA-11 `architecture` rev `f2d240e4`), PRD revision 3 (`prd` rev `bba336f3`), SHARED-BOUNDARIES draft 3 (HEAAA-12 `shared-boundaries` rev `0fffc85d`), intake pack revision 2 (`6ea01b5`). G1 accepted by a human 2026-11-04 (HEAAA-11 confirmations `009ac8a9`, `cadd7751`) |

## 0. How to read this

Labels: **Constraint** (fixed by an approved source), **Recommendation** (my proposal; a human decides at G2), **Verified** (I checked it, with how and when), **Unverified** (stated from documentation or memory, or not checkable from here), **Open** (needs a person). Cost figures are planning estimates, not quotes. No cloud account exists, no vendor was contacted, nothing was installed or run except the read-only GitHub API checks in section 4.1 and two documentation lookups in section 13.

### 0.1 Disposition of review rounds 1 and 2

| ID | Disposition | Where |
| --- | --- | --- |
| DPR-01 | Accepted. Recommendation split by control. GitHub environment required reviewers are **not** available on Team for private repositories. Approval control for `production`, `bootstrap`, `audit-archive`, `restore-test` becomes **approval-by-apply** (a human-applied AWS-side change), which works on any plan. Enterprise reviewers are an optional extra, cost unverified | 4.1, 4.2, 7.3, 13.1, 16, 16.2 |
| DPR-02 | Accepted. Exact trust conditions stated; plainly: under the current plan any write-token holder can satisfy them; the only effective control is the human-applied enable/disable | 4.1 (Fallback B), 7.1, 15.2 |
| DPR-03 | Accepted. **Approved-release record** defined; role table completed; revert and recovery-credential rules defined | 7.2, 7.4, 9.3, 15.3 |
| DPR-04 | Accepted. Shallow liveness for ALB/ECS; deep readiness with "schema ≥ minimum compatible" for deploy gating only | 9.1 |
| DPR-05 | Accepted. Deploy-surge arithmetic added. **Needs a Solution Architect decision** on `max_connections` and the deploy-peak budget (routed via Orchestrator) | 9.1, 12, 16 item 13 |
| DPR-06 | Accepted. `us-east-1` exemptions listed; added to the build-start verification list | 3.1, 3.3 |
| DPR-07 | Accepted. `loadtest` specified as production-equivalent; cost re-estimated | 3.4, 5.3, 13.1 |
| DPR-08 | Accepted. Rollback order fixed; two-way one-release compatibility; pointer-based portal switch with a stated mixed-version window | 6.2, 9.1, 9.3 |
| DPR-09 | Accepted. Canaries listed with frequency and cost; frequency reduced | 11.4, 13.1 |
| DPR-10 | Accepted. Token retrieval path defined; fallback approval defined | 16.2 |
| DPR-11 | Accepted. Credential reset, isolation, in-VPC execution, baseline capture, role and authorising decision specified | 10.3 |
| DPR-12 | Accepted. Marketing is its own workflow, environments, roles and release authorisation | 4.2, 9.1 |
| DPR-13 | Accepted. Checks added | 5.2 |
| DPR-14 | Accepted. Actions allow-list and SHA-pin setting as G2 configuration items, plus a CI check that works on any plan | 4.1, 5.1, 14 |
| DPR-15 | Accepted. Lag metric mechanism and snapshot timeout/abort rule defined | 8.2, 11.3 |

Round 2 (document `devops-plan-review` rev `0d9f1cc5`, reviewed draft 2 rev `6490e76b`). Round 1 items DPR-05, 06, 08 continue as DPR-20, 21, 16.

| ID | Disposition | Where |
| --- | --- | --- |
| DPR-16 | Accepted. Real mixed-version window stated (open tabs are unbounded); the API enforces a minimum supported portal release and the portal checks its own version; CI tests the rejection path. Needs an API/portal contract owner (routed) | 6.2, 16 item 17 |
| DPR-17 | Accepted. `gh-restore-test` is bound in AWS: pinned task definition and image digest created only by the human-applied approvals root, `RegisterTaskDefinition` denied, `PassRole` to one role, resource-scoped RDS actions, endpoint policies on the restore VPC, and no read path to restored data. Residual risk stated | 7.2, 7.5, 10.3 |
| DPR-18 | Accepted. New 7.5: separate approvals root and state, an organisation SCP and permission boundary that deny every `gh-*` role and the agent identity any write to the record, role trust policies, boundaries, SCPs and the approvals state, CloudTrail alerts, and a named root of trust | 7.5 |
| DPR-19 | Accepted. Task definitions are created by the human apply with the approved digests; `RegisterTaskDefinition` and `PassRole` are denied to deploy roles. ECS condition-key support is **unverified**; staging must prove it, with a stated fallback | 7.5, 9.1 |
| DPR-20 | Accepted. Explicit `max_connections` changed from 500 to **600** (peak 335 = 55.8 %, inside the 60 % rule). Rollback and recovery redeploys are covered by the same arithmetic; only the start-deferral rule has an exemption, stated | 9.1, 12, 16 item 13 |
| DPR-21 | Accepted. `cloudwatch` and `sns` added to the `us-east-1` exemptions, limited to the named alarm and topic actions | 3.1 |
| DPR-22 | Accepted. One approved-release record and one expiry per purpose; maximum session duration per role; a separate read-only `gh-observe-production` role for the observation window | 7.2, 7.4 |
| DPR-23 | Accepted. A custodian never retrieves their own token; enforced by the secret resource policy | 16.2 |
| DPR-24 | Accepted. Summary item 8 aligned with 13.1 | 1 |

### 0.2 Bounded correction cycle (draft 4): what changed and why

Scope is exactly the items below. Nothing else in draft 3 was edited except cross-references that these items require (section numbers named in the table). Findings keep their IDs; none is closed by me. The independent reviewers decide.

| ID | Source | Disposition in draft 4 | Where |
| --- | --- | --- | --- |
| DPR-25 (High) | `devops-plan-review` rev `01b55b06` | **Guard redesigned to be independent of role names.** All production, log-archive and tooling IAM (roles, policies, policy versions, boundary, OIDC provider, users and keys) is owned by the human-applied approvals root. The SCP denies every IAM principal/policy write and `ecs:RegisterTaskDefinition`/`DeregisterTaskDefinition` to every principal except `platform-admin-apply`, on any resource. Draft 3's boundary allowance for `iam:CreateRole` is withdrawn. Detection added for GitHub-OIDC trust policies, any non-exempt IAM write (including denied attempts) and external-access findings. Residual risks restated | 7.2, 7.5, 17 |
| DPR-26 (Low) | same | `ecs:RunTask` scoped to the pinned migration task-definition ARN and the production cluster; `iam:PassRole` lists the task role and the execution role, each with `PassedToService = ecs-tasks.amazonaws.com`; `gh-recover-production` has no `RunTask` and its `PassRole` list is explicit. Resource-level `RunTask` support stays **unverified**, with a stated fallback | 7.2, 7.5 |
| DPR-27 (Low, editorial) | same | The stale "Draft 3 supersedes this" sentence in 9.1 is deleted. 7.4 Enforcement (1) now names every record-enabled role | 7.4, 9.1 |
| AL-04 (confirm, DEV-1 incl. N-8) | HEAAA-17 section 4; ARCHITECTURE 28.6 and 37 DEV-1 | **Confirmed, with the differences from draft 3 stated in 6.2 and 6.1:** integer `release_number` (not the SHA `release_id`), assigned by the pipeline; `min_client_release` is the previous *released* number; refusal is `400 kernel.client_release_unsupported`, not 426; check covers every non-exempt portal-host `/api/*` route including pre-authentication calls; CloudFront forwards the header and the `clientRelease` query string on `/api/*` and forwards no cookie for `release.json`; CI tests the refusal with this code | 6.1, 6.2, 11.4, 15.3, 16 item 17 |
| AL-05 | HEAAA-17 section 4; QA 0.3 | **Environment mapping added (new 3.5).** `ENV-INT` splits into a database-role part on `ci` and a deployed-stack part on `staging`; `ENV-LOAD` = `loadtest`; `ENV-DR` = a synthetic recovery-region rehearsal stack, separate from the PHI-boundary `restore-test`; `ENV-A11Y` = `staging`. DevOps owns storing and rotating sandbox secrets and the test-domain inventory; the test Google Workspace tenant is provisioned by the owner's Workspace administrator; vendor sandbox sign-up and the e-prescribing sandbox are **out of DevOps scope** (vendors not chosen, contractual). Cost lines added | 3.5, 13.1, 16 item 19 |
| AL-07 | HEAAA-17 section 4; QA 17 | **Tools named with cost and access:** Playwright Test (browser end-to-end and scripted API cases), Schemathesis (OpenAPI contract), k6 (load), `@axe-core/playwright` (automated accessibility) plus Lighthouse CI. All US$0 licence, run in the runner or in Fargate load generators, no SaaS account or token. Real-device and screen-reader work stays with QA and the owner; not a DevOps provision | 5.1, 5.3, 14, 16 item 20 |
| AL-09 | HEAAA-17 section 4 | = DPR-25..27 above. It is a condition: no production IAM, OIDC trust or task-definition registration is configured before the fix is re-reviewed and G2 decides | 0.2, 17, 19 |

## 1. Summary for the decision-maker

1. **CI/CD provider: GitHub Actions** (Constraint, intake `[01 §7]`, `[05 §2]`), repository `zainnaeem28/enterprise-app`, deploying to AWS through OIDC federation. No long-lived cloud keys in GitHub.
2. **Verified blocker for the release lock.** On 2026-11-04 the GitHub API answered **HTTP 403 "Upgrade to GitHub Pro or make this repository public"** for branch protection and for rulesets on this private, personally owned repository. Required checks, required reviews and protected environments are the controls that the workflow and G3 rely on. They **cannot be configured on the current plan**. The repository must move to a paid plan (see 4.1 and the cost in section 13), or the plan must say plainly that these controls are unenforced.
3. **Verified second limit: the approver and the agents share one GitHub identity.** The agents act through a token for `zainnaeem28`, who is also the product owner, operations owner and the only human at every gate (PRD RK-5). A GitHub environment approval by that account cannot be told apart from an agent acting with the same token. Section 4.1 recommends a GitHub organisation with a separate agent identity and at least two human accounts. Dual control (C4, audit archiving, first-admin bootstrap) is **not achievable with one human**.
   **Correction after review (DPR-01):** GitHub environment *required reviewers* are not available for private repositories on the Team plan (GitHub Docs, verified by the reviewer 2026-11-04). The release lock therefore rests on **approval-by-apply**: the production roles are denied in AWS until a human applies a reviewed change that writes an *approved-release record* (7.4). Team still gives rulesets, required checks and CODEOWNERS.
4. **Topology** is the G1 design: one AWS organisation, separate accounts for production, staging, tooling, log-archive and marketing, a US primary region and a US recovery region (section 3). No Kubernetes, no cluster, no extra deployables.
5. **One immutable artifact per commit**, promoted by digest from staging to production, never rebuilt (section 6).
6. **Release safety:** expand/contract migrations, the previous app version tested against the new schema in CI, a manual database snapshot before every production migration, rolling ECS deploy with automatic rollback, and an explicit statement that an application rollback is not a database restore (sections 8, 9).
7. **Recovery** follows ARCHITECTURE 9.4. A monthly automated restore test, and a timed region-loss rehearsal before R1 go-live and before each later release (section 10). Estimates only until rehearsed.
8. **Cost of this plan's own choices is small:** about US$52 / 210 / 690 per month additive to the G1 total (low / expected / high; GitHub, Actions minutes, paging, and, new in draft 4, the test Google Workspace tenant and vendor sandboxes, section 13.1). The high case is about US$90 above the G1 "Tooling" line of up to US$600; the Orchestrator and Architect confirm whether the test tenant belongs in that line. Observability (canaries about US$176) sits inside existing G1 lines; the load-test and rehearsal days are one-off build costs. The large risk stays where G1 put it: usage-based SMS and video. **SAR-16 is largely answered**: the Cognito replication add-on is priced per monthly active user, so a small admin pool adds almost nothing (13.3).
9. **Tools (section 14):** Semgrep Community Edition, gitleaks, OSV-Scanner and Trivy are selected for CI. **Draft 4 adds the test tooling the QA plan needs:** Playwright Test (browser end-to-end), Schemathesis (API contract), k6 (load) and `@axe-core/playwright` (accessibility), all licence cost US$0. **SonarQube, CodeRabbit and Strix are not selected** for R1, each with the condition that would change that.
10. **Decisions this plan needs from a human are in section 16.** The ones that block executable work are the GitHub organisation, the approval-by-apply control and the connection budget (items 1 and 13 of section 16), a named on-call rota (D-29), and a second human for dual control.

## 2. Baseline in effect

| Item | Value | Source |
| --- | --- | --- |
| Hosting | AWS, US region pair, BAA. Owner has not chosen; design continues on AWS | D-30, ADR-004 |
| Region loss | In scope by default | D-26 |
| SEC-D-19 path | **Path B** (separate admin user pool) by default | D-35, SHARED-BOUNDARIES 7 |
| Availability | 99.9 % monthly, patient and doctor portals; no planned-maintenance exclusion | NFR-1 |
| RPO / RTO | 15 min / 4 h, including region loss | NFR-2, NFR-3 |
| Deploys | Zero downtime; rollback and migration plan per release | NFR-5 |
| Database | RDS for PostgreSQL **17+**, Multi-AZ, PITR | BD-03, ARCHITECTURE 7 |
| CI gates | SAST, dependency, secret and container scanning; blocking findings fail the build | NFR-15 |
| Data outside production | Synthetic only | BR-35, NFR-18, SEC-D-20 |
| Load design | 2 × peak (~900 req/s, 30 min) plus 3 × burst for 5 min | ARCHITECTURE 9.1 |
| First release | R1 in production by end of May 2027 | intake D5 |
| Run budget | US$5–15k/month; expected R1 US$13,750, high US$22,150 | ARCHITECTURE 10.1 |

## 3. Environments and topology

### 3.1 Accounts and environments (Recommendation, ADR-012)

| Environment | AWS account | Data | Purpose | Lifetime |
| --- | --- | --- | --- | --- |
| `ci` | none (GitHub runner, service containers) | Synthetic, generated | PR checks: unit, integration against a containerised PostgreSQL 17, migration and catalog checks | Per run |
| `staging` | `staging` | Synthetic only | Integration, e2e, accessibility, ZAP baseline, release rehearsal, restore-procedure rehearsal | Persistent, about 30–40 % of production size (A-8) |
| `loadtest` | `staging` account, separate VPC, built by IaC to the production specification (3.4) | Synthetic at year-1 volume (3.4) | NFR-6/8/9 proof at 2 × and 3 × (DEP-14) | Created for a test window, torn down after |
| `production` | `production`, region primary; DR in recovery region of the same account | Real | Live | Persistent |
| `restore-test` | `production`-equivalent isolated VPC, same account boundary and controls as production | Restored production backups (PHI) | Monthly restore test, DR rehearsal | Created per test, destroyed after |
| `marketing-staging`, `marketing-production` | `marketing` | None (no PHI) | `www.`, `cms.` | Persistent |
| Shared services | `tooling` (IaC state, ECR, build roles), `log-archive` (audit archive, backup vault, CloudTrail) | Artifacts, logs | | Persistent |

- **No persistent `dev` cloud environment in R1.** PR checks use `ci`; developers use local containers with synthetic seed data. A shared `dev` account would add cost and a place for real-looking data. Add it only if the build team shows a need.
- **Restore tests of production backups cannot run in `staging`.** Staging is outside the PHI boundary. The restore target is built in the production account boundary with production-equivalent access, BAA coverage, logging and teardown. Staging rehearses the procedure with synthetic data.
- The marketing account holds two environments (`site`/`cms` staging and production) separated by IaC workspace and GitHub environment. No PHI, no network path or credentials to production data (TB8, ARCHITECTURE 3.1).
- AWS Organizations with service control policies denying: disabling CloudTrail/GuardDuty/Config, deleting the log-archive vault, leaving the organisation, use of regions other than the two US regions **except the named `us-east-1` exemptions below**. (Recommendation.)
- **`us-east-1` exemptions (DPR-06), by service and account:** `acm` (certificates for CloudFront viewers and any Cognito custom domain) in the accounts that terminate them; `wafv2` with CLOUDFRONT scope (managed only in `us-east-1`); `cloudfront`, `route53`, `iam`, `organizations`, `sts`, `support`, `budgets` and `ce` (global services reached through `us-east-1` endpoints); **`cloudwatch` and `sns` in `us-east-1` (DPR-21)**, limited to alarm and topic actions (`PutMetricAlarm`, `DescribeAlarms`, `DeleteAlarms`; `CreateTopic`, `SetTopicAttributes`, `Subscribe`, `Publish`, `GetTopicAttributes`) because CloudFront and CloudFront-scope WAF metrics exist only in `us-east-1`, so their alarms and alarm topics must be there; no other `us-east-1` data service is exempt. `kms` and `s3` stay in the two US regions. **Unverified:** whether the Chime SDK control plane and Cognito custom-domain behaviour need further `us-east-1` actions; the foundation task verifies the full list on the build date (3.3) before the SCP is applied. The SCP is written as a deny with `NotAction` for the global services and a `us-east-1` allow only for the named actions.

### 3.2 Runtime per environment

| Component | Production | Staging | Notes |
| --- | --- | --- | --- |
| `api` | ECS Fargate, 2 min – 8 max tasks across ≥ 2 AZs | 2 tasks | Max from the connection budget (ARCHITECTURE 9.2): 8 × 20 pool + 8 `LISTEN` |
| `worker` | ECS Fargate, 2 min – 4 max | 1–2 | Jobs are leased; scaled on queue depth and age |
| Portals (`my.`, `staff.`, `pharmacy.`) | S3 + CloudFront, `/api/*` to ALB, no caching of API | same, separate distribution | Versioned prefix per release (section 6.2) |
| `integrations.` | Same ALB, separate WAF rule groups, no cookies | same | `/public/v1/*` has its own rule group and rate limits (SHARED-BOUNDARIES 10.2) |
| Database | RDS PostgreSQL 17+, Multi-AZ, 4 vCPU / 32 GB, 1 TB autoscaling start | Smaller class, Multi-AZ off | Resize after load test |
| Documents | S3 quarantine and clean buckets, SSE-KMS | same, synthetic | CRR with RTC to recovery region in production |
| Marketing | Fargate (1–2 small tasks) + small PostgreSQL | same | Or static export plus SaaS CMS (decided on cost at G2, ARCHITECTURE 7) |

Differences from production that tests must not hide: staging is single-AZ for the database, so failover behaviour is proven by a separate Multi-AZ failover test in production-equivalent configuration (section 10.4), not by staging.

### 3.3 Region pair

Primary: `us-east-2`; recovery: `us-west-2` (Recommendation, ARCHITECTURE 7). **Unverified:** every service named in ARCHITECTURE 9.4 (RDS PostgreSQL 17 cross-Region automated backup replication, S3 RTC, Cognito replication, ECR replication, GuardDuty malware protection, Chime SDK) is available in both regions and BAA-eligible on the day of build. Verified at build start by the foundation task, with the AWS BAA-eligible services list read on that date. The same task verifies the `us-east-1` exemption list in 3.1 (ACM, CloudFront-scope WAF, global-service endpoints, Chime SDK and Cognito custom-domain requirements) before the region-deny SCP is applied.

### 3.4 `loadtest` specification (DPR-07)

The load test only proves NFR-6/8/9 if it matches production where latency is decided:

| Item | Specification |
| --- | --- |
| Database | Same engine version, instance class, storage type and size as production, **Multi-AZ on** (synchronous standby affects commit latency), same parameter group, RLS and audit triggers on |
| Compute | Production task sizes, production auto-scaling limits (api 2–8, worker 2–4), same ALB/WAF rule groups (WAF rate limits adjusted for the load generators by an allow-listed source, recorded) |
| Data | Synthetic only (BR-35). Volume: 100k patients' worth of rows at the high A-9 case, and **audit partitions at the year-1 volume of about 400 GB** (ARCHITECTURE 9.2 hot window). Generated by an in-VPC job with a fixed seed using bulk `COPY`; generation time is unknown and is measured on the first run. A snapshot of the generated data is kept (about 400+ GB of snapshot storage, roughly US$40/month at an **unverified** list price) so later tests restore it instead of regenerating |
| Load generators | Fargate tasks in the same Region, outside the app subnets; scenario scripts versioned in the repository; results uploaded as artifacts (no PHI exists) |
| Teardown | IaC destroy after the test; snapshot kept; cost checked against the budget alarm |
| Cost | Section 13.1 (re-estimated: a production-sized environment for several days, not a scaled-up staging) |

### 3.5 Binding of the QA environments to the environments above (AL-05)

The QA plan (TEST-CASES 0.3) uses four placeholder names. This is the binding DevOps proposes; QA applies it per case in its own revision. A QA result is valid only for the environment and candidate it names. Nothing below is provisioned: it is design, and no account, domain or vendor sandbox exists or has been requested.

| QA name | Bound to | Data | Provided by DevOps | Not provided / limits |
| --- | --- | --- | --- | --- |
| `ENV-INT`, database part: "real PostgreSQL 17+, real database roles, RLS" (TC-AU-*, TC-AZ-*, RLS and role cases) | **`ci`**: containerised PostgreSQL 17 with the roles created by the real migrations | Synthetic, generated | The `ci` job and its service container (5.1, 5.2) | `ci` is not RDS. A case whose assertion depends on RDS behaviour (for example role-level `transaction_timeout`, 5.2 **Unverified**) is bound to `staging` instead. QA states `ci` or `staging` for each case; "ENV-INT" alone is no longer a valid binding |
| `ENV-INT`, stack part: deployed candidate, SSE alert stream, document scan, Google test tenant, vendor sandboxes (TC-CAL-*, TC-SAF-*, TC-DOC-*, TC-API-01/09, TC-XB-*, fault-injection cases) | **`staging`** (persistent, synthetic only) | Synthetic only | The deployed candidate, seeded synthetic accounts, secret references for the sandboxes (below), fault-injection switches as environment configuration | Staging is single-AZ for the database (3.2): failover is not shown there |
| `ENV-INT`, "fresh environment" (TC-SEC-11 first-admin bootstrap) | A **bootstrap rehearsal stack** in the `staging` account, created from IaC for the rehearsal and destroyed after (16.2, synthetic persons and keys) | Synthetic | The IaC workspace and the `bootstrap-staging` role (7.2) | Needs two human custodians (16 item 2). One human means the case stays `Blocked` |
| `ENV-LOAD` | **`loadtest`** (3.4), production-equivalent | Synthetic at year-1 volume | 3.4 | Not provisioned until the owner approves its cost (13.1); the cases are `Blocked`, never run smaller |
| `ENV-DR` | A **synthetic recovery-region rehearsal stack**: IaC in `us-west-2` restoring from a cross-Region copy of the synthetic `loadtest` snapshot (3.4) and from replicated synthetic documents. This is the pre-R1 timed rehearsal of 10.4 | Synthetic | The IaC, the copied snapshot, the rehearsal day (13.1) | **The monthly restore test and later-release rehearsals of production backups run in `restore-test` (PHI boundary, 10.3) and are not `ENV-DR`.** They report PHI-free counts, hashes and timings to `OPERATIONS-HANDOFF.md`; they are not QA evidence and QA does not receive their data. The snapshot copy size and cross-Region copy time are **unverified** |
| `ENV-A11Y` | **`staging`**, same build as the stack part of `ENV-INT` | Synthetic | The deployed candidate and seeded accounts | **Out of DevOps scope:** real devices, browsers beyond the CI browsers (14), screen readers (NVDA, JAWS, VoiceOver) and the people who run them. Owned by QA and the owner (UX-O-08: no accessibility specialist is named) |

**Test domain and sandbox accounts (the part of `ENV-INT` that has no DevOps equivalent in draft 3).**

| Item | Owner of the account / contract | What DevOps owns | Cost (planning estimate, **unverified**) | Status |
| --- | --- | --- | --- | --- |
| Google Workspace **test tenant**: its own domain (not the production domain, not a subdomain of it), its own Workspace organisation, an admin OU, a few synthetic staff users, Directory API access for the cases that need it | Owner's Workspace administrator creates the tenant and holds the super-admin credentials. They never enter task text, documents or agent hands | The inventory (domain, OU, users, which cases use them), secret references `staging/integration/sandbox/google/*` in Secrets Manager (a service-account key only if a case needs one; keyless where possible), rotation and teardown, and the rule that no production service account, domain-wide delegation or real staff address is shared with it | About US$40 / 60 / 150 per month: 4–10 users at a recalled per-user list price plus the domain registration. **Price and trial terms not checked** | **Open:** needs the owner's decision and a domain (16 item 19) |
| Email and SMS sandbox accounts; video (Chime SDK sandbox or the chosen vendor's) | The owner signs vendor terms (7.2 "Vendor API keys"). **Vendors are not chosen** | Secret references `staging/integration/sandbox/<vendor>/*`, the allow-list of sandbox endpoints in the staging egress rules, and a per-vendor monthly usage cap alarm | About US$0 / 50 / 200 per month of sandbox usage. **Unverified** | **Out of DevOps scope until a vendor is chosen.** The cases that need a sandbox are `Blocked` |
| E-prescribing sandbox | The owner and the e-prescribing vendor (onboarding and certification are contractual and may carry fees and lead time) | Secret reference only, once an account exists | Not estimated: no vendor, no public price known to me | **Declared out of scope for DevOps provisioning.** QA keeps these cases `Blocked` until an owner-supplied sandbox exists |
| Malware-scan test objects, analytics sandbox (TC-BS-04) | No external account: the EICAR test string generated in the test, and a synthetic receiver in `staging` | The receiver and the allow-list | US$0 | In scope |

## 4. CI/CD provider and pipeline layout

### 4.1 Provider and what the repository can enforce today

**Provider: GitHub Actions** (Constraint). Environments use GitHub Deployments with OIDC to AWS.

Read-only checks run 2026-11-04 against `zainnaeem28/enterprise-app` with the managed token (no changes made):

| Check | Result |
| --- | --- |
| Repository | Private, owned by a **User** account, default branch `main` |
| Actions enabled; allowed actions | Enabled; **all actions allowed**; SHA pinning **not required** |
| Branch protection on `main` (`/branches/main/protection`) | **403: Upgrade to GitHub Pro or make this repository public** |
| Repository rulesets (`/rulesets`) | **403: same message** |
| Environments (`/environments`) | Listing works, **0 environments** exist. Creating an environment with required reviewers on a private repository is documented to need a paid plan. **Unverified until tried after the plan change** |
| Code scanning | **Not enabled** (private repositories need GitHub's paid code-security product; price not verified) |
| Dependabot alerts | **Disabled** (can be enabled by the owner) |
| Secret scanning | API answered 403 "Resource not accessible by integration": the token lacks the right, or the feature is off. **Unverified** |

Consequences, stated plainly:

- With the current plan, **nothing technically prevents a direct push to `main`, a merge without checks, or a self-approved deployment.** The framework already warns that agent instructions are not a sandbox (WORKFLOW "Tools, credentials, and actual enforcement limits").
- **Recommendation A, split by control (DPR-01).** What each GitHub plan gives for a **private** repository, per GitHub Docs (checked by the reviewer 2026-11-04):

  | Control | Free | Team | Higher plan (likely Enterprise; **Unverified**, name and price to confirm) |
  | --- | --- | --- | --- |
  | Rulesets and branch protection on `main`, required status checks, required PR review, CODEOWNERS | No (the 403 above) | Yes | Yes |
  | Deployment branch/tag policies for environments | No | Yes | Yes |
  | Environment **required reviewers**, **prevent self-review**, wait timers | No | **No** | Yes (unverified) |
  | Organisation Actions allow-list and SHA-pinning policy | Verify | Verify | Verify |

  **Recommendation A1 (needed regardless):** move the repository to a GitHub **organisation** on **Team**. Create: (1) at least two human accounts, one an approver who does not write code; (2) a separate **agent identity** (machine account or GitHub App) with write to feature branches only and **no right to approve or edit protection rules**; (3) rulesets on `main` requiring a pull request, the 5.1 status checks, a CODEOWNERS review by a human for `.github/`, `infra/`, `db/migrations/`, `docs/` and `infra/approvals/`, no force push, no deletion; (4) environments `staging`, `production`, `audit-archive`, `bootstrap-<env>`, `restore-test` with a **deployment branch policy limiting them to `main`**. Cost: about US$4 per user per month (**Unverified**, recalled list price).

  **Recommendation A2 (approval control that does not depend on GitHub reviewers):** **approval-by-apply**. The AWS roles behind `production`, `audit-archive`, `bootstrap-<env>` and `restore-test` are **denied by default**. They are enabled only by an IaC change under `infra/approvals/` that (a) is a pull request needing the CODEOWNERS approval of a human who is not the author (enforceable on Team through rulesets) and (b) is **applied by a human with platform-admin rights, not by the agent identity**. The change writes the *approved-release record* (7.4) with an expiry. For dual-control actions (audit archiving, bootstrap) the pull request needs **two** distinct human approvals and the applier is a third role or one of the two, recorded. Under RK-5 with one human this is not dual control; section 16 item 2 stays open.

  **Option A3 (not recommended for R1 unless the owner wants a GitHub-side second gate):** a higher GitHub plan that provides environment required reviewers and prevent-self-review. Cost: **Unverified**; I will not assume a price. It adds a reviewer click in front of the same deny-by-default roles; it does not replace A2.
- **Fallback B (owner stays on a personal repository or declines A1).** Plainly: with no rulesets and no environment protection, **any holder of a write token can push to any branch, including `main`, and run any workflow**, and the agents hold such a token through the same login as the approver. A workflow can declare `environment: production` and obtain the matching OIDC claim. The conditions the AWS trust policy can check are, with the OIDC `sub` claim customised to carry them: repository, `environment`, `ref` (`refs/heads/main`) and `job_workflow_ref` (the single file `.github/workflows/deploy-production.yml@refs/heads/main`). **Under the current plan these conditions can be satisfied by any holder of a write token**, so they prove which workflow ran, not that a human approved it. **The only effective control under Fallback B is the human-applied enable/disable of the role (A2)**, because no token holder can change the AWS-side deny. Everything else (review, checks, release lock) is procedural. The Release Reviewer records "GitHub-side enforcement absent" and the exact settings found in the 15.2 field.
- **Actions policy (DPR-14, G2-time configuration item; owner: repository owner, executed with the DevOps Reviewer present):** set the organisation/repository allowed-actions policy to an explicit allow-list (GitHub-owned actions plus the named third-party actions in `.github/ACTIONS-ALLOWLIST.md`); enable the setting that requires actions to be **pinned to a full-length commit SHA** if the chosen plan offers it (**verify at G2**); set the default `GITHUB_TOKEN` to read-only. A CI check enforces SHA pins on any plan (5.1).
- Because the human approver and the token holder are one GitHub login today, even with Recommendation A **the approver account must not be the one the agents use.** If one person holds both roles, state that in the G3 package.
- **Open:** the PRD risk RK-5 (one person holds every gate) means C4 second approver, audit-partition dual control and bootstrap cannot be satisfied in practice until a second human exists. See section 16.

### 4.2 Workflow layout (Recommendation; **no file is created before G2**)

All workflows live in `.github/workflows/`. Every third-party action is **pinned by full commit SHA** (SEC-D-15). Default `permissions: {}` at workflow level; each job grants only what it needs. Runners: GitHub-hosted Linux for build and test; no self-hosted runners in R1 (they would put a long-lived machine inside the trust boundary).

| Workflow | Trigger | Jobs | Permissions / credentials | Output |
| --- | --- | --- | --- | --- |
| `ci.yml` | `pull_request` to `main`; `push` to `main` | `lint-types`, `unit`, `integration-db` (PostgreSQL 17 service container, runs migrations, RLS tests of SHARED-BOUNDARIES 6.8), `migration-check` (5.2), `build` (reproducible, locked), `sast`, `secrets`, `deps`, `container-scan`, `sbom`, `a11y-smoke`, `bundle-budget` | `contents: read`, `pull-requests: write` only for comments. **No AWS credentials on pull requests**, including from forks | Required status checks |
| `build-release.yml` | `push` to `main` | Build once; push images to ECR in `tooling` by digest; sign; attach SBOM and provenance; build portal bundles; write the **release manifest** (6.1) | `id-token: write`, `contents: read`, `packages: none`. Assumes `gh-build` role in `tooling` | Release manifest, images, bundles |
| `deploy-staging.yml` | `workflow_run` of `build-release` success, or manual | Verify manifest and signatures; terraform plan/apply for `staging` if infra changed; migrate; roll out; smoke; e2e; ZAP baseline | Environment `staging`. Assumes `gh-deploy-staging` | Staging evidence |
| `deploy-production.yml` | **Manual `workflow_dispatch` only**, input = release manifest digest | Verify the digest equals the manifest hash in the **approved-release record read from the production account** (7.4), not merely the dispatch input; snapshot; migrate; roll out; smoke; observe (read-only job under `gh-observe-production`); (recovery job only on failure and only as approved) | Environment `production` (deployment branch policy `main`; reviewers only on a higher plan), concurrency group `production-release`, `cancel-in-progress: false`. Assumes `gh-deploy-production`, **denied until the approved-release record is applied** (7.2, 7.4) | `DEPLOYMENT-RESULT.md` evidence |
| `infra.yml` | PR touching `infra/`; manual apply | `fmt`, `validate`, `tflint`, policy scan (Checkov or Trivy config), `plan` posted as an artifact; `apply` per environment with a protected environment | PR: read-only plan role. Apply: per-environment role | Plan artifact (hash recorded in manifest) |
| `nightly.yml` | schedule | Full e2e, dependency re-scan, base-image re-scan, staging backup-restore procedure check | Read-only; staging role | Reports |
| `restore-test.yml` | monthly schedule; manual for rehearsal | Section 10.3 | Environment `restore-test`; role `gh-restore-test` limited to the restore target (10.3, 7.2) | Restore evidence |
| `audit-archive.yml` | manual | Detach/drop a verified audit partition as `audit_archiver` (SHARED-BOUNDARIES 6.2) | Environment `audit-archive`; role `gh-audit-archive` enabled by approval-by-apply with **two distinct human approvals** (4.1 A2) | Manifest entry |
| `bootstrap.yml` | manual, per environment | First-admin runbook (16.2) | Environment `bootstrap-<env>`; role `gh-bootstrap-<env>` enabled by approval-by-apply with two custodian approvals (16.2) | Audit evidence |
| `deploy-marketing.yml` | Manual `workflow_dispatch` (staging may be automatic) | Build and publish `www.`/`cms.` for `marketing-staging` or `marketing-production`. **Separate from the production release sequence (DPR-12)**: own workflow, own environments, own roles `gh-deploy-marketing-<env>` in the `marketing` account, own release authorisation (9.1) | Environment `marketing-<env>`, concurrency group `marketing-release` | Marketing evidence |
| `dependabot.yml` | config | Weekly updates for npm, Docker, GitHub Actions (SHA pins), Terraform providers | n/a | PRs |

Common rules: every job fails the workflow on a non-zero exit (no `continue-on-error` on a required check, no `|| true`); results are uploaded as artifacts and read by the reviewer, not only the badge; `concurrency` groups serialise deploys per environment; a job timeout is set on every job.

### 4.3 Repository layout the pipelines assume (for the build lane to confirm)

`apps/{api,worker,site,cms,patient,staff,pharmacy}`, `packages/*` (shared UI, contracts), `db/migrations/`, `infra/` (Terraform/OpenTofu modules and one root per account), `.github/`, `docs/`. One lockfile at the root. **Unverified:** the package manager and build tool are chosen by the build-foundation task (HEAAA-20); this plan states requirements (lockfile committed, `--frozen-lockfile` install, deterministic build), not a tool.

## 5. Quality and security gates

### 5.1 Required checks on every pull request (all must pass; blocking findings fail the build, NFR-15)

| Gate | Tool (selected in section 14) | Blocks on |
| --- | --- | --- |
| Formatting, lint, types | Project linters, `tsc` | Any error. Import-boundary rule between modules (ARCHITECTURE 4) |
| Unit and integration tests | Project test runner; PostgreSQL 17 service | Any failure; empty or skipped suites count as failure (WORKFLOW Stage 4) |
| Authorization tests | RLS and role tests (SHARED-BOUNDARIES 6.8), negative tests per role pair (RA-R1-17) | Any failure |
| Migration check | 5.2 | Any failure |
| SAST | Semgrep CE with a pinned ruleset | High/critical, or any finding in the authentication, authorization and prescribing paths unless a reviewed suppression exists |
| Dependency scan | OSV-Scanner on the lockfile; Dependabot | Known exploited or critical/high with a fix available |
| Secret scan | gitleaks on the diff and, on `main`, the full history | Any finding |
| Container scan | Trivy on each image, plus Trivy config scan on Dockerfiles and Terraform | Critical/high with a fix available; root user; missing health check |
| PHI-in-logs check | Log-scan test over test-run output and a synthetic-PHI canary (NFR-18) | Any synthetic identifier found in logs, URLs or analytics payloads |
| Accessibility smoke | `@axe-core/playwright` on built portals (14; full audit is manual, DEP-17) | New serious/critical violations |
| API contract (AL-07) | Schemathesis against the OpenAPI documents of the R1 modules (TEST-CASES TC-API-09), run on `ci` against the API container and PostgreSQL 17, synthetic accounts | Any response that violates its documented schema or status; an undocumented status; a 5xx |
| Browser end-to-end smoke (AL-07) | Playwright Test (14), the PR subset of the `AUTO` journeys, on `ci` against the built portals and API container | Any failure; an empty or skipped suite counts as failure |
| Bundle and LCP budget | Lighthouse CI against the NFR-7 budget | Budget exceeded |
| SBOM | Syft, CycloneDX | SBOM missing |
| Workflow hygiene (DPR-14) | actionlint plus a script that fails if any `uses:` is not a full 40-character commit SHA or is not in the Actions allow-list; `permissions` must be declared | Any violation. Works on any GitHub plan |

Suppressions need a reviewer comment, an owner and an expiry date, and are listed in the release package.

### 5.2 Migration checks (BD-03, SHARED-BOUNDARIES 6.2)

On a fresh PostgreSQL 17 container, CI applies all migrations from empty and from the previous release tag, then fails if:

- a module or `kernel` table lacks RLS or `FORCE ROW LEVEL SECURITY`; any policy is `TO PUBLIC`; a view that is not on the C0/C1 list lacks `security_invoker = true`; a table with `patient_id` lacks the merge write guard; a `SECURITY DEFINER` function is not in the inventory or has no fixed `search_path` (**M-5**);
- an audit-writing login role lacks role-level `transaction_timeout` (SAR-10), or `app_owner` has INSERT on an audit table;
- a migration breaks the **expand/contract rule** (8.1): a drop, rename, type change, `NOT NULL` without a default-and-backfill plan, or non-concurrent index on a populated table in the same release as the code that stops using it;
- the **previous release's test suite does not pass against the new schema** (N-1 compatibility);
- a statement lacks a `lock_timeout` guard where it needs a strong lock;
- (DPR-13) a function-owner role (owner of a `SECURITY DEFINER` function) can log in (must be `NOLOGIN`); `reporting_ro` holds a grant on any object not on the C0/C1 list (M-4); any application role has `BYPASSRLS` or owns a table; the RDS master user owns objects or appears in any application connection string or role mapping (M-1; checked by listing role memberships and by a secret-reference lint over task definitions).

**Unverified:** that RDS for PostgreSQL 17 exposes `transaction_timeout` as a role-level setting readable from the audit insert trigger (SHARED-BOUNDARIES 12). The build-foundation task proves it on a real RDS instance in staging before the audit design is relied on. If it does not, the architect decides the fallback; DevOps does not weaken the check.

### 5.3 Dynamic checks (staging only)

- OWASP **ZAP baseline** (passive) against staging portals after each staging deploy, with synthetic accounts. Active scanning is a separate, authorised activity (14.4).
- Synthetic smoke and journey tests (booking race, login per realm, document upload and scan, alert stream).
- **Full browser end-to-end and scripted API suites (AL-07):** Playwright Test, all `AUTO` journeys and API cases of the QA plan, against `staging` after each staging deploy, with synthetic accounts and the sandboxes of 3.5. Results (JUnit XML and trace archives, no PHI exists) are uploaded as artifacts with tool version, candidate commit and environment.
- **Full automated accessibility scan (AL-07):** `@axe-core/playwright` on every key page of each portal and the brand site in `staging` (TC-A11Y-01), plus Lighthouse CI accessibility category as a supplement. Automated checks find only part of the issues; the manual runs on `ENV-A11Y` remain required (3.5).
- **API contract and negative tests against `staging` (AL-07):** Schemathesis with synthetic accounts and a request-rate cap. It is a contract and negative test, **not** an authorised active security assessment; it never runs against production.
- **Load tests** on the `loadtest` environment (production-equivalent, 3.4) before R1 and when the schema or hot paths change materially: 2 × peak for 30 min, 3 × burst for 5 min, **with RLS and audit inserts on** (ARCHITECTURE 9.2, SHARED-BOUNDARIES 6.8). The generator is **k6** (14): scenarios are JavaScript files in the repository, thresholds on p95 latency and error rate make the run exit non-zero, and the summary and raw output are artifacts together with the k6 version, script revision, candidate commit and sizing (TEST-CASES 11.2).

## 6. Artifact identity

### 6.1 The release manifest

Each build on `main` produces one `release-manifest.json`, hashed, stored in the tooling account (S3, versioned, Object Lock governance), and attached to the workflow run:

| Field | Content |
| --- | --- |
| `git_sha`, `git_tree_hash` | Exact commit |
| `release_number` (AL-04) | The positive integer the portals send in `X-Client-Release` and the API compares (6.2). Assigned once per build of `main` as `git rev-list --first-parent --count <git_sha>` on a full clone; the build fails if it is not greater than the previous manifest's number. The same build keeps the same number in every environment. **Unverified until tried** (needs `fetch-depth: 0`; history rewriting on `main` must stay impossible, which the rulesets of 4.1 provide only on the Team plan) |
| `images` | `api`, `worker`, `site`, `cms` as `repository@sha256:digest` |
| `bundles` | `patient`, `staff`, `pharmacy`: S3 prefix `releases/<git_sha>/` and a sha256 of a sorted file listing |
| `migrations` | Ordered list of migration file names with sha256, and one combined hash |
| `iac` | Hash of each approved Terraform plan file applied for this release (if any) |
| `locks` | sha256 of each lockfile and of the base-image digests |
| `tools` | Versions of Node, compiler, Semgrep, Trivy, gitleaks, OSV, Syft, cosign, Terraform/OpenTofu |
| `checks` | Workflow run ID and the artifact IDs of the scan and test reports |
| `signatures` | cosign (keyless, GitHub OIDC) signature and SLSA-style provenance reference per image |

Tags are conveniences. **Deployments reference digests.** ECR tag immutability is on. The G3 package names the manifest hash; the production workflow refuses any other.

### 6.2 Promotion

Build once, deploy the same digests to staging then production. No rebuild per environment. Environment configuration is separate (Parameter Store values and Secrets Manager references per environment), recorded by name and version in the deployment evidence, never by value.

**Portal switch (DPR-08).** A CloudFront origin-path change is not atomic: distribution updates propagate to edge locations over minutes (**Unverified**, AWS documents propagation without a fixed time), so edges can briefly serve different versions. The plan therefore does not rely on it. Portal assets are content-hashed and uploaded to a shared immutable `assets/` prefix (kept 90 days); each release also uploads `releases/<git_sha>/` (entry document and release manifest). The release step copies that release's entry document to the live path and invalidates only the entry document and `release.json`. The entry document has a short cache TTL (60 s). **Stated mixed-version window: up to about 5 minutes** in which a user can load the old or new entry document; assets of both stay available, so neither breaks. This is safe only because of the **two-way compatibility rule**: portal N must work against API N-1, and API N must work against portal N-1 (one release each way). CI enforces it: a contract test runs the new portal bundle against the previous release's API image, and the new API image against the previous portal bundle (5.1, as part of the integration job).

**Open tabs and the real window (DPR-16).** The 5-minute figure covers only a user who loads a page. A browser tab that stays open keeps running its old bundle with no limit, so after back-to-back releases a tab on portal N-2 could call API N, outside the one-release compatibility rule. The plan does not claim a bound for open tabs. Instead the version is enforced on both sides. **The contract is ARCHITECTURE 28.6 (draft 8.1); this section is DevOps's confirmation of the producer side (DEV-1, AL-04), with four deliberate differences from draft 3.**

- **Producer.** The release pipeline assigns the integer `release_number` (6.1) and embeds `r<release_number>.<git_sha12>` in every portal bundle, and `{"release_number": n, "git_sha12": "...", "built_at": "..."}` in `release.json` of each portal. The API compares the integer only; the SHA is informative. Draft 3's SHA-valued `release_id` is replaced, because a SHA has no order and cannot be compared (N-8 difference 1).
- **Client check (portal).** The bundle sends `X-Client-Release: r<n>.<sha12>` on every `/api/*` call (and the SSE stream as query parameter `clientRelease`), and polls `release.json` (no-cache) every 5 minutes and on tab focus. A newer release gives a non-blocking prompt, `400 kernel.client_release_unsupported` a blocking one. The prompt wording and the save-or-warn behaviour are UX's (HEAAA-49), to ARCHITECTURE 28.6 constraints.
- **`min_client_release`.** An integer in the API's environment configuration (Parameter Store value, recorded by name and version in the deployment evidence). The deploy step sets it to the `release_number` of the **previous released manifest**, which is the manifest named as `previous_manifest_hash` in the approved-release record (7.4), so portal N-1 keeps working against API N. It is **not** the previous commit on `main`: builds that were never released do not count. For the first production release it equals that release's own number. The pipeline refuses a value above the previous released number (it would lock out the portal in the field) or below it by a hand edit (15.3). A rollback or recovery redeploy restores the value that release was deployed with. A portal newer than the API is accepted (the two-way rule covers portal N against API N-1).
- **Server enforcement and scope.** Refusal is **`400 kernel.client_release_unsupported`**, not 426 (draft 3 gave 426 only as an example; ARCHITECTURE 28.6 explains why 426 is wrong). It applies to **every non-exempt `/api/*` route on a portal host, including pre-authentication calls** (draft 3 said "authenticated browser routes", N-8 difference 2): `my.`, `staff.` including `/api/v1/admin/*`, and `partner.` from R2. Exempt only: the four browser navigations, `/healthz` and `/readyz`, and the whole `integrations.` host (`/public/v1/*`, `/webhooks/*`, `/partner/v1/*`). Machine clients keep the versioned contract (SHARED-BOUNDARIES 10.2). The ALB health check and the canaries of 11.4 are accounted for in the exemptions and 11.4.
- **CloudFront and WAF behaviour (new, confirmed).** The `/api/*` behaviour has caching disabled and an origin request policy that **forwards the `X-Client-Release` header and all query strings** (so `clientRelease` reaches the API), and no WAF rule blocks or rewrites them. No CORS configuration exists on any portal host: each portal calls `/api/*` on its own origin (ADR-005), so the custom header causes no preflight. The `release.json` behaviour is separate, served from the portal S3 bucket, with `Cache-Control: no-cache`, **forwards no cookie and no query string**, and is never routed to the ALB. It is therefore not an API route and cannot extend a session.
- **Stated windows:** an active, online tab is moved to the new bundle within about 5 to 10 minutes (poll interval, 60 s entry-document TTL, invalidation time). A suspended or offline tab is unbounded, and is blocked from acting on the API as soon as it makes its first request after N+1 stops supporting it. No unsupported pair reaches business logic.
- **Unsaved input.** The save-or-warn rule is specified in ARCHITECTURE 28.6 and implemented by the build lane and UX; this plan only requires that the pipeline test it exists (QA owns the case).
- **CI.** The integration job tests (1) the two compatible pairs, (2) the refusal path: an old, a missing and a malformed `X-Client-Release` against the new API on a portal-host route, expecting `400` with `code = kernel.client_release_unsupported`, no `Set-Cookie`, no session change, and (3) that each exempt route is **not** refused without the header. It also runs this against one pre-authentication route.

Reproducibility: a frozen-lockfile install and pinned base images by digest. The build lane proves it by building twice and comparing the bundle listing hash and image layer digests, or by recording the differences. **Unverified until tried**; some image tooling embeds timestamps.

## 7. Credentials, secrets and owners

### 7.1 Principle

No deployment credential exists in GitHub secrets. AWS access uses OIDC roles. The OIDC `sub` claim is customised (repository-level setting) so the token carries repository, `environment`, `ref` and `job_workflow_ref`, and each trust policy requires: the exact repository, the environment value, `refs/heads/main`, and the single workflow file for that role (**Unverified:** whether AWS evaluates `job_workflow_ref` directly as a condition key or only through the customised `sub`; the foundation task proves the chosen form in staging). **These conditions identify which workflow ran, not who approved it. On the current plan any write-token holder can satisfy them (4.1 Fallback B).** The control that does hold is that every production-affecting role is **denied until a human applies the approved-release record (7.4)** and **reverts to deny at its expiry**. **Deployment credentials for an environment are withheld until that environment's G3** (framework rule): until then the roles exist only as denied trust policies or do not exist.

### 7.2 Roles and owners

| Role / secret | Where | Who may use | Created when | Owner (human) |
| --- | --- | --- | --- | --- |
| `gh-ci-plan` | tooling/staging, read-only | PR workflows for `infra` plan | After G2 | DevOps, approved by DevOps Reviewer |
| `gh-build` | tooling | `build-release` on `main` only (`ref` + workflow conditions) | After G2 | DevOps |
| `gh-deploy-staging` | staging | Environment `staging`; also `nightly.yml` uses `gh-nightly-staging` (read-only plus restore-procedure check) | After G2 | DevOps; staging authorisation separate from production |
| `gh-deploy-production` | production | `deploy-production.yml` only. Max session 2 h. Cannot register task definitions (denied to every principal by the SCP, not by this role's policy, 7.5). **`ecs:RunTask` only on the pinned migration task-definition ARN** with condition `ecs:cluster` = the production cluster; `ecs:UpdateService` only on the named services; **`iam:PassRole` only to the migration task role and the migration task execution role** (the `api` and `worker` task and execution roles are added only if staging shows that `UpdateService` needs them), each with `iam:PassedToService = ecs-tasks.amazonaws.com` (DPR-26). Its policy is written by the approvals root | Trust policy ships as **deny**. Enabled by the `release` record (7.4) for one manifest hash, one environment, listed actions, with an `aws:CurrentTime` expiry in the trust condition. Reverts to deny at expiry or on human revoke | Release owner approves; platform admin applies |
| `gh-observe-production` (DPR-22) | production | Observation-window job: CloudWatch, ECS and ALB **read-only**. Max session 5 h | Same `release` record, expiry = last stage + observation window + margin | Same |
| `gh-recover-production` | production | `deploy-production.yml` recovery job and the approved rollback redeploy (previous digests, portal pointer revert). Max session 2 h per assumption. `ecs:UpdateService` on the named services only; **no `ecs:RunTask`** (a rollback never runs a migration, 8.1); `iam:PassRole` only to the roles named in the `recover` record's previous manifest (task roles and execution roles listed explicitly, each with `PassedToService = ecs-tasks.amazonaws.com`); policy written by the approvals root for that record (DPR-26) | Its **own** `recover` record (7.4): the actions it lists and the previous manifest hash named in it, with its own expiry (observation window plus a margin the G3 package states in hours) | Same |
| `gh-tf-production` | production | `infra.yml` apply for the **workload roots only**. It has a permission boundary and **no IAM write of any kind and no `ecs:RegisterTaskDefinition`**: the SCP of 7.5 denies both, and every other IAM write listed there, to every principal except `platform-admin-apply`. Workload roots therefore only *reference* roles and policies that the approvals root already created (DPR-25). It cannot touch the approvals root, the record, trust policies, boundaries or SCPs. `iam:PassRole` only to an explicit list of existing workload roles, each with the `iam:PassedToService` value of the service it is passed to. Max session 2 h. **Unverified:** that the workload roots apply without IAM writes (17); staging proves it | Its own `infra` record (7.4); infrastructure changes are part of a release or their own named-environment G3 | Platform admin |
| `gh-tf-recovery-region` | production (recovery Region) | Region-loss IaC apply | **Not used by GitHub in the first minutes of a region loss**, because that depends on GitHub and the incident. Region-loss execution uses the human break-glass roles below; the role may be enabled by the incident commander through the break-glass procedure | Platform admin; incident commander |
| `gh-restore-test` | production boundary, `restore-test` VPC only | `restore-test.yml`. Max session 2 h (the long work runs in the in-VPC task, 10.3) | **Bound in AWS, not by the workflow (DPR-17).** Standing authority from OPERATIONS_RECEIPT for a monthly test; its own `restore-test` record (7.4), renewed yearly, expiry enforced in the trust policy. Permissions, all resource-scoped: `ecs:RunTask` only on the **pinned restore task definition** (created by the human apply with a digest from the `release` manifest; `RegisterTaskDefinition` denied); `iam:PassRole` only to the restore task role, `iam:PassedToService = ecs-tasks.amazonaws.com`; RDS restore and delete only into the pinned subnet group, security group and KMS key and only for instances carrying `purpose=restore-test` (request-tag condition); read the backup vault; nothing else. It has **no** read of the restored data, no S3 data access, and cannot edit security groups, route tables or endpoint policies. Detail in 7.5 and 10.3 | Operations owner authorises; platform admin applies |
| `gh-audit-archive` | production | `audit-archive.yml` as `audit_archiver`. Max session 1 h | Per run: its own `audit-archive` record, approval-by-apply with **two distinct human approvals** (4.1 A2) and a short expiry | Two humans |
| `gh-bootstrap-<env>` | per environment | `bootstrap.yml`. Max session 1 h | Per run: its own `bootstrap-<env>` record, two custodian approvals; disabled after step 5 of 16.2 | Two custodians |
| `gh-deploy-marketing-<env>` | `marketing` account | `deploy-marketing.yml` | `marketing-staging` after G2; `marketing-production` per its own release authorisation (9.1) | DevOps; owner |
| **Break-glass recovery roles** (`bg-platform-recovery`, `bg-database-recovery`) | production, both Regions | Named humans via IAM Identity Center with MFA; **not** GitHub | Created at foundation as denied; session-limited (1–4 h); every assumption alerts the security contact and opens a review ticket; used for region loss (10.5), restore decisions (9.3) and when GitHub is unavailable | Platform admin and a second approver |
| `app_owner` DB credential | Secrets Manager (production, staging) | Only the **migration task role** | After G2 / G3 | DevOps; rotated each release or 90 days |
| RDS master user | Secrets Manager, sealed | **Break-glass only**, time-boxed, alerts on use. Never used by an application component (BD M-1); CI checks this (5.2) | At DB creation | Platform admin and a second approver |
| `app_api`, `app_worker`, `audit_archiver`, `reporting_ro` DB credentials | Secrets Manager; IAM database authentication preferred (**Unverified** for the pooling setup) | Their task roles only | After G2 | DevOps |
| `outbound` secrets (`<env>/integration/outbound/*`) | Secrets Manager | Written by `api` task role; read by `api`, `worker` | At integration set-up | Admin-realm principal with an elevation grant |
| `inbound_verification` secrets (`<env>/integration/inbound/*`) | Secrets Manager | **Written by `worker` role only**; `api` read-only (BD-11) | At integration set-up | Dual-controlled request |
| Workspace directory read access (path B leaver backstop, if kept) | Keyless if possible; otherwise a Secrets Manager key, rotated, alert on use | `identity` | After Cybersecurity decides whether the backstop is required | Workspace super-admin grants; DevOps stores |
| KMS keys | Per environment; multi-Region where recovery needs it (ARCHITECTURE 9.4) | Key policies in IaC | At foundation | Platform admin |
| Vendor API keys (video, SMS, e-Rx, OCR) | Secrets Manager under `outbound/` | Adapters | At contract | Owner signs contract; admin enters |

**Secret handling rules:** secrets never appear in task text, documents, screenshots, logs, Terraform state in clear (state encrypted, access limited, sensitive outputs off), or committed files. gitleaks runs on every diff. Rotation: DB credentials and signing secrets on a schedule and at once on suspicion; read-through cache of at most 5 minutes so rotation takes effect (BD-11).

### 7.3 Human access

Engineers and DevOps reach AWS through IAM Identity Center with SSO and MFA, roles with no standing access to production data. Production database access is break-glass only: time-boxed, approved, alerting, logged. **Unverified:** whether the AWS organisation will use Identity Center federated to Google Workspace for engineers, or separate users. That is a separate identity from the staff sign-in; decided in the foundation task with Cybersecurity.

### 7.4 The approved-release records (DPR-03, DPR-22)

One authoritative record **per purpose**, so the workflow compares against something other than its own input and one approval never covers a different kind of action:

- **Where:** SSM parameters in the `production` account (type SecureString, KMS key policy limiting writes): `/approved/release`, `/approved/recover`, `/approved/infra`, `/approved/restore-test`, `/approved/audit-archive`, `/approved/bootstrap-<env>`. Each has its **own** content, expiry and role trust condition; a `release` record does not enable `gh-restore-test`, and the reverse. They are created and changed **only by the human-applied IaC change** described in 4.1 A2, from the separate approvals root (7.5). The agent identity and every `gh-*` role have **no write** to them and no right to change role trust policies (guarded in AWS, 7.5).
- **Contents:** `environment`, `manifest_hash`, `previous_manifest_hash` (the rollback target), `permitted_actions` (for example `migrate`, `rollout`, `smoke`, `rollback-redeploy`; recovery beyond these needs a new record or the break-glass roles), `g3_reference` (decision ID and revision), `not_before`, `expires`. `expires` is at most the observation window plus margin for `release` and `recover`, 1 day for `audit-archive` and `bootstrap-<env>`, and 1 year for `restore-test`. Each role also has a **maximum session duration** (7.2), so a session started just before expiry still ends.
- **Enforcement:** (1) the trust policy of **every role in 7.2 that a record enables** (`gh-deploy-production`, `gh-observe-production`, `gh-recover-production`, `gh-tf-production`, `gh-restore-test`, `gh-audit-archive`, `gh-bootstrap-<env>`) carries an `aws:CurrentTime` less-than-expiry condition for **its own record** and is enabled only by the same change, so expiry reverts it to deny without anyone acting; (2) the workflow's first job reads the record and refuses on any mismatch of manifest hash, environment, action or time (15.3). The role itself cannot check the hash, so the second check is in the workflow; a tampered workflow could skip it, which is why reviewing `.github/` changes by CODEOWNERS and the role-level expiry both matter. I state this limit instead of claiming the role verifies the hash.
- **Revert:** at `expires`, or sooner by a human revoke (apply with the record emptied). After a failed release the records stay for the evidence; the roles are denied.
- **Recovery after the window:** rollback redeploy (previous digests) is in the `recover` record's `permitted_actions` and its role is valid for that record's expiry. Data recovery (point-in-time restore into a new instance, 9.3) and region loss are human decisions executed through the break-glass roles, not through GitHub.

### 7.5 Control-plane protection: who cannot enable themselves (DPR-17, DPR-18, DPR-19, DPR-25, DPR-26)

The approval-by-apply design fails if any identity that the agents or a workflow can reach is able to write the record, edit a role trust policy, or loosen the guard. The plan therefore names the root of trust and the AWS-side guards. All of this is design; none is built or tested (G2 configuration, proven in staging first).

**Root of trust.** The `platform-admin-apply` permission set in IAM Identity Center (human, MFA with security key, named people, no OIDC trust, no access key). It is the only principal that can apply the approvals root. It is not available to the agent identity, which has **no AWS identity at all**; the agents act only in GitHub and the Paperclip tooling. Where only one platform admin exists, the CODEOWNERS approver must still be another person (16 item 2).

**Design principle (DPR-25).** The guard must not depend on the name of a role. Draft 3 scoped it to `gh-*`/`bg-*`, so a role created under another name escaped it, and it let `gh-tf-production` create roles. Draft 4 removes that dependence: **no principal except `platform-admin-apply` can create or change any IAM principal or policy in the accounts that hold PHI, state or images**, whatever it is called. Everything else in this section follows from that.

**Separation in IaC.**
- `infra/approvals/` is its own Terraform root with its **own state bucket and KMS key in the `tooling` account**. Only `platform-admin-apply` can read or write that state; every `gh-*` role is denied by bucket and key policy. `gh-tf-production` applies only the workload roots.
- **The approvals root owns all IAM in `production`, `log-archive` and `tooling`** (DPR-25 (a)): every role (task, execution, service, `gh-*`, `bg-*`, `audit_archiver` and any other), every IAM policy and policy version (including the permission boundary and the permission policies attached to `gh-*` roles), instance profiles, the GitHub OIDC provider, the `/approved/*` parameters, and the pinned task definitions (below). Workload roots only reference those roles by ARN. The cost is that a new role or policy change, for example a new module that needs a new task permission, needs a reviewed approvals-root change applied by a platform admin. That is intended.
- SCPs live in the management account (next paragraph), not in this root.

**Organisation SCP (management account, applied by humans, one-off at foundation; DPR-25 (a), (b)).** Attached to `production`, `log-archive` and `tooling`. It denies the actions below **on any resource, for every principal except the `platform-admin-apply` role** (`aws:PrincipalArn` condition on that role's ARN pattern):

1. IAM roles and policies: `iam:CreateRole`, `DeleteRole`, `UpdateRole`, `UpdateAssumeRolePolicy`, `PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePermissionsBoundary`, `DeleteRolePermissionsBoundary`, `CreatePolicy`, `DeletePolicy`, `CreatePolicyVersion`, `SetDefaultPolicyVersion`, `DeletePolicyVersion`, `CreateInstanceProfile`, `AddRoleToInstanceProfile`.
2. Other IAM identities that would outlive a record: `iam:CreateUser`, `CreateAccessKey`, `CreateLoginProfile`, `UpdateLoginProfile`, `PutUserPolicy`, `AttachUserPolicy`, `CreateGroup`, `PutGroupPolicy`, `AttachGroupPolicy`, `AddUserToGroup`.
3. Federation: `iam:CreateOpenIDConnectProvider`, `UpdateOpenIDConnectProviderThumbprint`, `AddClientIDToOpenIDConnectProvider`, `RemoveClientIDFromOpenIDConnectProvider`, `DeleteOpenIDConnectProvider`, `CreateSAMLProvider`, `UpdateSAMLProvider`.
4. **Task definitions (mechanism for DPR-19 and DPR-17):** `ecs:RegisterTaskDefinition` and `ecs:DeregisterTaskDefinition`. The denial is in the SCP, not in any role's policy and not by role name, so a role created in any other way is covered.
5. The approvals data: `ssm:PutParameter`, `DeleteParameter`, `LabelParameterVersion` on `/approved/*`; `kms:PutKeyPolicy` and `kms:ScheduleKeyDeletion` on the approvals key; `s3:PutObject` and `DeleteObject` on the approvals state bucket. `organizations` policy operations are denied outside the management account's own admins by the management account's IAM, because SCPs do not apply to it (below).

`iam:CreateServiceLinkedRole` is **not** denied: a service-linked role trusts an AWS service principal and cannot be assumed through the GitHub OIDC provider. **Unverified:** that AWS Identity Center keeps provisioning its permission-set roles under this SCP (AWS states that SCPs do not affect service-linked roles; the foundation task proves it before the SCP is attached to `production`).

*Why the exemption holds.* Because `CreateRole`, `UpdateAssumeRolePolicy` and the policy actions are denied to everyone else, no other principal can create or retarget a role whose ARN matches the exemption pattern. In draft 3 the exemption pattern was one more thing a created role could imitate. **Unverified:** that the `aws:PrincipalArn` pattern for the Identity Center role (`arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_platform-admin-apply_*`) matches as intended; staging proves it with a positive and a negative test.

SCPs do not apply to the management account, so it holds **no workload, no OIDC provider and no GitHub-assumable role**, and its policy changes alert (below).

**Permission boundary on every `gh-*` role (defence in depth, DPR-25).** It repeats the denials above for the case of an SCP error, grants **no `iam:CreateRole` and no other IAM write** (draft 3 allowed `CreateRole` with the same boundary attached; withdrawn), and limits `iam:PassRole` to the named roles with `iam:PassedToService` set to the service the role is passed to. The boundary is itself an IAM policy owned by the approvals root; policy-version actions on it are denied to every other principal by item 1 (DPR-25 (2)), so a boundary or a `gh-*` role's policy cannot be edited by changing a policy version either.

**Detection (DPR-25 (c)).** EventBridge rules on CloudTrail send a security page, unsuppressed, on: any write to `/approved/*`; any `CreateRole` or `UpdateAssumeRolePolicy` whose trust policy references the GitHub OIDC provider (`token.actions.githubusercontent.com`); **any IAM write or `ecs:RegisterTaskDefinition` by a non-exempt principal, including attempts that the SCP denied** (a denied attempt by a `gh-*` role is a sign of a tampered workflow); any trust-policy or boundary change on `gh-*`/`bg-*`; any `organizations` policy change; any change to the approvals key or state bucket; any IAM Access Analyzer external-access finding in the three accounts (organisation zone of trust: a bucket, key, secret, role or ECR policy that grants access outside the organisation; **Unverified:** the analyzer's cost and finding latency); and any `AssumeRoleWithWebIdentity` into a production role without a matching unexpired record. Alerts name the principal, so a write by anyone but `platform-admin-apply` is a security incident, not a routine event.

**Task-definition pinning (DPR-19, DPR-26).** ECS task definitions for `api`, `worker`, the migration task, the bootstrap task and the restore task are **registered by the human-applied approvals root** with the exact image digests of the approved manifest (and the previous digests for rollback). `ecs:RegisterTaskDefinition` is denied by the SCP (item 4). `gh-deploy-production` can call `ecs:UpdateService` on the named services and `ecs:RunTask` **only on the migration task-definition ARN and the production cluster**; since no other revisions exist than the ones the human registered, a modified workflow cannot start a different image as `app_owner`. `iam:PassRole` is limited to the migration task role **and its execution role** (7.2). `gh-recover-production` has no `RunTask`.
- **Unverified (DPR-26):** whether `ecs:RunTask` supports resource-level permissions by task-definition ARN and the `ecs:cluster` condition as assumed. Staging proves it with the DPR-19 tests. **Fallback if it does not:** the migration task is started by the human-applied approvals root or by a human-run step for the release, not by the workflow; slower, and a G2 decision. The plan does not widen `RunTask`.
- **Unverified:** whether IAM can restrict `ecs:UpdateService` by the target task-definition revision (ECS does not document a condition key for this). The pinning therefore relies on the SCP denial plus the small set of registered revisions. If an old registered revision still exists, a modified workflow could roll the service to that older revision; the record lists the only permitted `previous_manifest_hash`, and old revisions are deregistered at the next apply, so the exposure is one older approved image. Staging proves both the denial and the behaviour. If it cannot be shown to work, the fallback is to have the rollout step itself be the human-applied approvals-root change (a task-definition update), with the workflow only running the migration task and smoke checks; this is slower and is a G2 decision.
- The workflow still checks the digests (15.3), as a second control, not the only one.

**What this still does not protect (stated residual risk, DPR-25 (d)).**
- A compromised `platform-admin-apply` human, or the management account, is outside the design (limited by MFA, named people, alerts, the second approver of 4.1 A2).
- A tampered workflow can still run any action the unexpired record permits, and can start the pinned restore task at any time while `restore-test` is valid.
- **Resource policies are not IAM.** `gh-tf-production` applies workload roots that normally create buckets, keys and secrets, so under an unexpired `infra` record a tampered workflow could write a bucket, key, secret or ECR resource policy that grants access to an outside principal and **outlives the record**. The SCP does not close this. The plan relies on detection (the external-access finding above) and on the human review of each plan, not on prevention. If the owner wants prevention, the approvals root takes ownership of the policies of the PHI buckets, PHI keys and database secrets, at the cost of more human applies; that is a G2 decision.
- A workload role created by the approvals root and passed to a compute service by `gh-tf-production` (for example to a function) runs with that role's permissions. The `PassRole` list for `gh-tf-production` is explicit and each entry has a `PassedToService`; the list is part of what the DevOps Reviewer checks at build.
- **Unverified:** that the workload roots (ECS services, RDS, CloudFront, S3, KMS, Cognito) apply with no IAM write. If staging shows an IAM write is unavoidable for some resource, **that role or policy moves into the approvals root**; the SCP is never loosened and no `gh-*` role is given IAM writes.

## 8. Database migration plan

### 8.1 Rules (NFR-5)

1. **Expand → migrate → contract.** Release N adds nullable columns, new tables, new indexes (`CONCURRENTLY`) and writes both shapes if needed. Release N+1 (or later) removes old shapes after N has been live and stable. Destructive contraction needs its own change and approval; it is never part of a release that also changes behaviour.
2. The deployed app version N-1 must run against schema N (checked in CI, 5.2). This is what makes an application rollback safe.
3. Migrations run **before** the rollout, as `app_owner`, from a **one-off ECS task using the same image digest** as the release. They never run from a developer laptop or from inside a serving task.
4. Migrations never write audit rows (BD, 8.1). The pipeline records the migration through the worker path.
5. Long data backfills are separate, chunked, idempotent, resumable jobs, not migrations. They respect the audit `transaction_timeout` bound.
6. Every migration sets `lock_timeout` and `statement_timeout` and is idempotent where possible. A failed migration leaves the schema inspectable: the pipeline records `schema_migrations` state and the catalogue diff before and after.
7. **Data migration into the system: none in R1–R3** (intake `[04 §5]`). If that changes, it is a new scoped change.

### 8.2 Production sequence

1. Read the approved-release record (7.4) and verify manifest digest, signatures, environment, permitted action and expiry against it.
2. Check backup freshness: latest automated backup and replicated backup within threshold, else stop.
3. Record the current **latest restorable time** from RDS (this PITR timestamp is the named pre-migration restore point; it costs nothing and is immediate). **If the release contains a migration:** also start a **manual RDS snapshot** named with the release SHA and wait for `available` with a **timeout** (proposed 45 minutes for an incremental snapshot, set from measurement). The first snapshot of the database is a **full copy** and can take far longer than minutes (**Unverified**, 1 TB start size): it is taken and timed at the pre-R1 rehearsal, not for the first time during a release. Snapshot not `available` by the timeout → **abort before migration**, no migration runs without it, report the timing. Releases without a migration skip the snapshot (PITR covers them).
4. Run the migration task. Abort on non-zero exit.
5. Run the catalogue checks (5.2) against production schema (read-only).
6. Roll out (section 9).

**Riskiest data step:** a migration that holds a strong lock or rewrites a large table (the audit table reaches hundreds of GB in the hot window). Mitigation: partition-aware migrations only, no table rewrites on audit tables in an ordinary release, rehearse on a staging copy of year-1 volume (synthetic) and record the duration.

## 9. Rollout and rollback

### 9.1 Rollout (Recommendation: ECS rolling with circuit breaker)

- ECS service deployment: minimum healthy 100 %, maximum **150 %** (see the connection arithmetic below), deployment circuit breaker **with rollback on**. Deregistration delay long enough to drain SSE connections; clients reconnect with `Last-Event-ID` (ARCHITECTURE 5.4).
- **Two health endpoints (DPR-04).** (1) **Liveness**, `/healthz`: shallow, no database or external call; this is the only check used by the ALB target group and ECS task health. (2) **Readiness**, `/readyz`: deep (database reachable, schema version **≥ the minimum compatible version** that this build declares, no PHI in the response); used only for deploy gating, smoke tests, canaries and alarms, never for task replacement. Each build declares `schema_min` (the oldest schema it supports) and tolerates any later schema produced under the expand-only rule. Because the migration runs first and N-1 tasks keep `schema ≥ schema_min(N-1)`, they stay healthy, and a circuit-breaker rollback to N-1 works against schema N. A Multi-AZ failover (about 1–2 minutes, ARCHITECTURE 9.2) is ridden out without task replacement: liveness is unaffected, requests that need the database fail or retry while the pool reconnects, and the minutes lost are counted against the error budget. The failover rehearsal (10.4) measures this; it passes only if no tasks were replaced because of it.
- **Connection arithmetic during a deploy (DPR-05).** Per-task budget: `api` 20 + 1 `LISTEN` = 21, `worker` 10. Steady maximum: 8 × 21 + 4 × 10 = **208**, plus migration/admin tasks ≈ 230 (ARCHITECTURE 9.2).

  | Case | api tasks | worker tasks | Connections |
  | --- | --- | --- | --- |
  | Steady, max scale | 8 | 4 | 208 (+ ≈ 22 other = ≈ 230) |
  | Rolling at 200 % from max (draft 1) | 16 | 8 | 336 + 80 = **416** + other |
  | Rolling at 150 % from max (this plan) | 12 | 6 | 252 + 60 = **312** + other ≈ **335** |
  | Release started with ≤ 6 api and ≤ 3 worker tasks, 150 % | 9 | 5 | 189 + 50 = 239 + other ≈ **260** |

  **Rule:** the pipeline refuses to start a rollout while `api` desired count is above 6 or `worker` above 3 (a release at peak load is deferred), and auto-scaling is held at its current count during the rollout. **Unverified and needs the Solution Architect:** the parameter-group `max_connections` is not stated in ARCHITECTURE. "230 below 60 %" implies roughly 380–400. A value of 500 would put the 150 % peak of ≈ 335 at 67 %, above the 60 % limit (DPR-20), so 500 is withdrawn. Draft 3 proposes **explicitly 600**: ≈ 335 / 600 = 55.8 %, and 230 steady = 38 %. Any value ≥ 560 satisfies ARCHITECTURE 9.2 without changing its rule; 600 is chosen for margin. Memory per idle connection on the 32 GB class is **unverified**; the load test confirms it (the managed default for that class is far higher, so 600 is a deliberate lower cap). The connection alarm becomes: warn at 70 % of the **steady** budget (160), page at 70 % of `max_connections` (420, above the 335 deploy peak, so **no suppression is needed**). ARCHITECTURE 9.2 gives the rule but not the value, so no contract change is needed; I still ask the Solution Architect to record the value 600 (16 item 13), and to decide only if a value below 560 is wanted.

  **Rollback and recovery redeploys (DPR-20).** The start rule (api ≤ 6, worker ≤ 3) defers a *normal release*. It is **not** applied to the circuit-breaker rollback, to the rollback redeploy of 9.3 or to a recovery redeploy, because those must not wait. They use the same 150 % ceiling, so their worst case is the same ≈ 335 (56 %), inside the rule. Auto-scaling is held during them as well.
- Order for a release: **migrate → worker → api → portals (pointer switch, 6.2) → smoke → observation**. The marketing site is **not** part of this sequence (DPR-12): `deploy-marketing.yml` is its own workflow, environment and role. Marketing production is an environment mutation in its own account, so it needs its **own named release authorisation (G3 for `marketing-production`)**; a lighter package is acceptable because there is no PHI (no migration, no PHI boundary), but this plan does not waive it. Marketing staging follows G2.
- Why not blue/green with CodeDeploy for R1: more moving parts and no load or risk that justifies it yet. Revisit if the observation window shows slow detection. (Recommendation.)
- **Estimated duration** (not measured): rolling deploy of api and worker 8–15 minutes; with migration and smoke checks, 20–30 minutes total. Replaced by measured values after the first staging deploys.

### 9.2 Observation window and abort thresholds (proposed; the G3 package states final values)

30 minutes after the last stage for a normal release; 4 hours with enhanced watching for a release containing a migration or a change to authentication, audit, booking or prescribing. Abort and start the approved recovery when any of the following holds for 5 consecutive minutes: error rate above 1 % of requests; p95 API latency above 1 s; any failed health check after circuit breaker settles; audit write failures above zero; booking invariant violation; alert-delivery latency above the escalation window; queue age above 5 minutes. These are starting values and must be set against the staging baseline before G3.

### 9.3 Rollback (application) and recovery (data)

| Situation | Action | Notes |
| --- | --- | --- |
| Rollout fails health checks | ECS circuit breaker returns to the previous task definition | Automatic, inside the approved plan |
| Defect found during observation, no schema change | **Order (DPR-08): portals first** (rewrite the entry document from the previous release, invalidate it), **then** `api` and `worker` redeploy of the previous digests | A pipeline job under `gh-recover-production`, only for the actions and previous manifest hash in the approved-release record (7.4). Portal N-1 against API N is covered by the two-way compatibility rule (6.2); the mixed-version window of about 5 minutes applies on rollback too |
| Defect after an expand migration | Roll the app back; **leave the schema in place** (N-1 compatibility) | Normal case |
| Data corruption or a migration that cannot be forward-fixed | **Forward repair first.** Only if the named human decision-makers choose it: point-in-time restore into a **new** instance, validate, then cut over. **Never restore over live data.** | Data written after the restore point is lost unless reconciled; the decision records that loss (RPO ≤ 15 min target) |
| Whole-region loss | Region-loss runbook (10.5) | Needs the incident declaration |

**An application rollback is not proof that the database is restored.** A rollback job's success is reported separately from schema state. A failed recovery stays failed and is escalated; no automatic redeploy.

## 10. Backup, restore and disaster recovery

### 10.1 Backup design (from ARCHITECTURE 9.4; each † item exists because of D-26)

| Data | Protection | Frequency / retention (Recommendation) |
| --- | --- | --- |
| RDS PostgreSQL | Automated backups with PITR; **cross-Region automated backup replication** † ; AWS Backup copy to a vault-locked vault in `log-archive` † | PITR retention 35 days (service maximum, **Unverified** for replicated copy); daily AWS Backup copy retained 35 days; monthly retained 12 months. Longer retention for legal holds is a counsel decision. Pre-release manual snapshots kept 30 days |
| S3 clean documents | Versioning; CRR with Replication Time Control † | Noncurrent versions 90 days; legal hold per policy |
| Audit archive and anchors | Object Lock compliance mode, replicated with lock † | Retention = longest legal minimum (Open: NFR-13, counsel) |
| IaC state | Versioned bucket, replicated † | Versions kept 1 year |
| Images | ECR cross-Region replication † ; lifecycle keeps all images referenced by a released manifest | Released images kept 1 year |
| Secrets, KMS | Replication / multi-Region keys † | n/a |
| CMS database | Backups copied to the recovery region (SAR-11 proposal) | 35 days |
| Identity pools | Multi-Region replica † (no TOTP in replica). Pool configuration in IaC | n/a |

Backup access: deletion denied to production roles; vault lock; separate account.

### 10.2 Targets and honest status

RPO 15 min and RTO 4 h (NFR-2/3) are targets. **No backup, replication lag or restore time has been measured**, because nothing exists. The first measured values come from the staging rehearsal and the pre-R1 rehearsal (10.4). Until then these are claims about design, not evidence.

### 10.3 Monthly restore test (automated, from first production backup)

1. **Authorisation basis:** the monthly job touches production PHI, so it runs under the standing operations authority recorded in OPERATIONS_RECEIPT (7.2, `gh-restore-test`), renewed yearly, and the restore-test environment has production-level access controls and BAA coverage. Restore the latest automated backup, and a PITR time chosen at random within the last 7 days, into a fresh instance in `restore-test`.
2. **Isolation and credentials (DPR-11, DPR-17):** the restore VPC has no peering, transit route, internet gateway or NAT, and no security-group path to the production application or database; egress only through VPC endpoints whose **endpoint policies** allow just the restore bucket, the restore secrets, the backup vault read and the `log-archive` result prefix. Subnet group, security groups, KMS key, task definition (pinned digest) and endpoint policies are created by the human-applied approvals root; `gh-restore-test` can use them but not change them (7.2, 7.5). Restored instances are non-public by subnet construction. Even a tampered workflow can only start the pinned task and a restore of a backup into that network; it has no network path to, and no read right on, the restored data. It could still trigger extra restores (cost, and PHI copies that exist until teardown); CloudTrail alerts on any restore outside the monthly window and a teardown job destroys targets older than 24 h. Immediately after restore, before any check, a restore-task role **resets the master and every application-role password** (the restored instance carries the production credentials, which must not be usable) and disables IAM database authentication mappings for production roles. Secrets for the restore target are new and live only in `restore-test`.
3. **In-VPC execution and PHI-free output:** the checks run in a one-off ECS task inside the `restore-test` VPC, not on a GitHub runner. The task emits only counts, hashes, pass/fail and timings; the workflow log and artifacts contain no row data. Checks: schema version, catalogue/RLS checks (5.2), row-count and checksum comparison on sampled tables, **audit anchor chain verification** to the restore point (ARCHITECTURE 6), application read-only smoke through the real image pointed at the restored instance.
4. **Comparison baseline:** for exact comparison the source's counts and checksums are captured **as of the restore point**. For a PITR time T, the source side is computed by a read-only query on a read-only transaction at the source for the immutable tables (append-only audit, documents metadata) and by comparing against a restore of the same snapshot for mutable tables; for mutable tables the check is a bounded-drift check, not equality, and the plan says so. **Unverified until rehearsed**; the Architect agrees the table list.
5. Record restore duration, data age at restore (measured RPO), and failures. Destroy the target and its snapshots. Access to the target equals production access.
6. Failures open a tracked finding; two consecutive failures stop releases until fixed.

### 10.4 Rehearsals before go-live (DEP-16)

| Rehearsal | When | Environment | Pass condition |
| --- | --- | --- | --- |
| Multi-AZ database failover | Before R1 | Production-equivalent configuration | Failover time recorded; API recovers without manual action; no lost committed transactions; **no task replaced because of the failover** (9.1) |
| Procedure rehearsal with synthetic data | After staging exists | Staging | Runbook steps work and are timed |
| **Timed region-loss rehearsal** | Before R1 go-live and before each later release (NFR-3) | Recovery region | Total ≤ 4 h; measured RPO for each † component; identity-replica sign-in with passkey checked (P-7) and TOTP-only users handled (ARCHITECTURE 9.4); audit anchors verified; DNS switch and smoke tests pass; **failures stay recorded as failures** |
| Rollback rehearsal | Every release in staging | Staging | Previous digests redeployed against the new schema; smoke passes |
| Restore of a pre-release snapshot | Before R1 | `restore-test` | Section 10.3 passes |

**Estimated cost of one region-loss rehearsal:** about US$100–300 for the day (recovery-region compute and a restored database for several hours, derived from ARCHITECTURE 10.1 figures; estimate).

### 10.5 Region-loss runbook (summary; full text in ROLLBACK-RUNBOOK.md for the first release)

Declare incident → activate identity replicas → apply IaC in the recovery region from the replicated state backend (fallback path for the case where the primary state region is down) → restore database from replicated backup to the latest point → verify audit anchor chain → deploy the same image digests → switch CloudFront origins / Route 53 → smoke → reopen. Decision rights: the incident commander (named on-call lead) declares; the operations owner is informed immediately.

**Admin elevation during failover (the question SHARED-BOUNDARIES 7.4 hands to this plan):** without fallback F-1, admins may be unable to sign in or elevate in the replica. I recommend **accepting this for the 4-hour RTO**: restoring service uses AWS-level break-glass roles, not application admin screens; clinical and patient functions are unaffected; configuration changes wait. The human Architect and operations owner confirm this at G2. If the P-7 spike shows security keys work in the replica, the acceptance is not needed.

## 11. Observability, SLOs and alerting

### 11.1 Telemetry

OpenTelemetry (ADOT collector as a sidecar) → CloudWatch Logs, Metrics and traces. Structured JSON logs with an **allowlist of fields**; request IDs correlate API, worker and outbox. A CloudWatch Logs data-protection policy is a second line of defence against PHI patterns; it does not replace the logger allowlist (NFR-18, SEC-D-07). No analytics or error SDKs on PHI origins. Log retention (Recommendation): application logs 90 days hot, then 13 months in the log-archive account; CloudTrail and security logs retained at least 6 years (HIPAA documentation) in Object Lock. **Open:** final periods need counsel (same open item as audit retention).

### 11.2 SLIs and SLOs (from approved targets; none lowered)

| SLO | Target | Window | Source | Notes |
| --- | --- | --- | --- | --- |
| Availability of `my.` and `staff.` | 99.9 % of valid requests succeed (non-5xx at the ALB, and a synthetic check) | Calendar month | NFR-1 | Error budget ≈ 43.2 min/month. Third-party outages excluded but BR-33 behaviour is measured |
| API latency | p95 < 500 ms for normal reads/writes | 5-minute windows, monthly attainment | NFR-6 | |
| Slot search | p95 < 1 s | same | NFR-8 | |
| LCP | < 2.5 s on 4G | Lab per release; field via RUM on the brand site only (PHI origins have no analytics) | NFR-7 | |
| Alert delivery | Staff alert (red flag, BTG) delivered to a connected browser within the configured window and unacknowledged alerts escalate in time | Continuous | J-07, J-17 | Window value is D-11 |
| Recovery | RPO ≤ 15 min, RTO ≤ 4 h | Per rehearsal | NFR-2/3 | |
| `www.`/`cms.` | **Proposal (SAR-11):** NFR-1..3 do not apply; best-effort from CDN cache, CMS DB backup copied to recovery region | n/a | PM to confirm | Not lowering a target; the PRD names the patient and doctor portals |

**The 99.9 % target is not claimed as met until a named on-call rota exists (D-29).**

### 11.3 Alerts (every alert has an owner, impact, first diagnostic step and a runbook)

| Alert | Condition | Severity | First step (runbook) |
| --- | --- | --- | --- |
| Error-budget burn | Fast: 14.4 × over 1 h and 5 min; slow: 6 × over 6 h and 30 min | Page | Check last deploy; consider rollback (9.3) |
| ALB 5xx, target unhealthy | > 1 % for 5 min; any unhealthy target > 5 min | Page | Service health, task logs |
| p95 latency | > 500 ms API for 10 min; slot search > 1 s | Page / ticket | DB load, RLS cost, connections |
| Database | CPU > 80 % 10 min; free storage < 20 %; connections > 70 % of budget (ARCHITECTURE 9.2); replication/standby problems; failover event | Page | Runbook DB |
| Queue | Oldest job age > 5 min; dead-letter growth | Page | Worker logs, integration status |
| Outbox backlog | Unsent events older than threshold | Page | Worker |
| Integration failures | Circuit open, failure rate above threshold (BR-33) | Ticket / page by vendor criticality | Vendor status, retry state |
| Audit pipeline | Anchor job late; **anchor verification mismatch**; audit insert errors; late-committed rows flagged (ARCHITECTURE 6) | Page (security) | Security runbook; do not alter data |
| Staff-scope drift | `patient.verify_staff_scope` reports drift (SHARED-BOUNDARIES 6.6) | Page (security + clinical safety) | Recompute through the function; file finding |
| Backup health | No successful backup in 26 h; cross-Region replication lag above 10 min (expect 15 min target) from the custom metric `BackupReplicaLagSeconds` (below); S3 RTC replication failures; restore test failed | Page / ticket | Backup runbook |
| Certificate / domain | Expiry < 21 days | Ticket | |
| Security | GuardDuty high findings; WAF block spikes; CloudTrail changes to logging or policies; root login; break-glass role use; Workspace super-admin / OU changes (C3) | Page security contact | Security runbook |
| Cost | Forecast above budget threshold; SMS and video spend vs plan | Ticket to owner | Section 13 |
| Deployment | Release workflow failure, migration failure | Page the releasing engineer | 9.3 |

**Backup-lag metric mechanism (DPR-15).** RDS publishes no native CloudWatch metric for the lag of replicated automated backups. A scheduled Lambda (EventBridge, every 5 minutes, role limited to `rds:DescribeDBInstanceAutomatedBackups` and `cloudwatch:PutMetricData`) reads the **latest restorable time** of the replicated backup in the recovery Region and publishes `BackupReplicaLagSeconds = now - latestRestorableTime`, with a second metric for "lookup failed". The alarm fires on lag > 600 s or on missing data. **Unverified:** that the API returns a latest restorable time for replicated automated backups; the staging rehearsal proves it, and if not, a documented alternative (a scheduled test restore point or snapshot copy timing) replaces it before the alert is relied on. The **first** cross-Region snapshot/backup copy of a large database is slow: the alarm is inactive until the first replica reports, and the pre-R1 rehearsal records the time of that first copy with a defined timeout.

**Paging channel (Open, owner decision D-29):** alarms go to SNS. Until a rota and paging service are chosen, delivery is SNS email to the named on-call people, and **delivery is tested** before go-live (a test alert that a named person acknowledges). A dedicated on-call service is recommended for rotation and escalation; its price is unverified and falls under the tooling line in ARCHITECTURE 10.1 (US$100–600/month). I will not select a paid service without that decision.

### 11.4 Synthetic checks

CloudWatch Synthetics canaries, priced at **US$0.0012 per canary run** (verified by the reviewer 2026-11-04, US East basis; Lambda and S3 artifact costs extra and unverified). A 1-minute canary is 43,200 runs ≈ **US$51.84/month**; a 5-minute canary ≈ US$10.37; a 15-minute canary ≈ US$3.46. Real-traffic SLIs (ALB 5xx and latency, 11.2) carry the SLO; canaries confirm external reachability, certificates and DNS. List (production unless noted):

| Canary | Frequency | What | US$/month |
| --- | --- | --- | --- |
| `my.` shallow | 1 min | `/healthz` through CloudFront and ALB path, TLS expiry | 51.84 |
| `staff.` shallow | 1 min | same | 51.84 |
| `my.` journey | 5 min | Sign-in page loads, `GET /public/v1` slot lookup (PHI-free) | 10.37 |
| `staff.` journey | 5 min | Sign-in page loads | 10.37 |
| `integrations.` | 5 min | `/public/v1` health | 10.37 |
| `pharmacy.` | 5 min | Sign-in page loads | 10.37 |
| `www.` / `cms.` | 5 min each | Page loads (best effort per SAR-11) | 20.74 |
| Staging (`my.`, `staff.`, `integrations.`) | 15 min | Shallow | 10.38 |
| **Total** | | | **≈ 176** plus Lambda/S3 (unverified, small) |

Draft 1's two canaries per host at 1-minute intervals would have cost about US$415–620 a month. **Canaries and the release contract (AL-04):** a canary that calls a portal-host `/api/*` route sends `X-Client-Release` with the value it reads from that portal's `release.json`, so a release does not make it page on `kernel.client_release_unsupported`. The `GET /public/v1` slot lookup is made against the `integrations.` host, which is exempt (ARCHITECTURE 28.6); the `my.` journey canary does not call a portal-host API route before sign-in. **No canary writes data in production** (no synthetic bookings or patients) unless the owner approves a labelled synthetic tenant; write journeys run in staging.

## 12. Limits and capacity guards

| Item | Limit | Why |
| --- | --- | --- |
| `api` max tasks / pool | 8 / 20 connections each + 1 `LISTEN`; deploy `maximumPercent` 150 % | Steady ≈ 230. Deploy peak ≈ 335 (9.1). `max_connections` explicit, proposed **600** (peak 55.8 %, inside the 60 % rule); the Solution Architect records the value (ARCHITECTURE 9.2 does not state it) |
| `worker` max tasks / pool | 4 / 10; rollout refused above 3 running | Same |
| DB role limits | `transaction_timeout` 60 s on audit-writing roles; `statement_timeout` and `idle_in_transaction_session_timeout` set per role | SAR-10, audit watermark |
| WAF | Rate limits per IP and per path group (`/api/v1/auth*`, public forms, `/public/v1/*`); bot control on public forms (NFR-17) | CN-11 |
| ALB / CloudFront | SSE heartbeat 15 s against 30 s / 60 s timeouts | ARCHITECTURE 5.4 |
| Upload | Size and count caps at the pre-signed URL; quarantine bucket lifecycle 7 days | SEC-D-08 |
| Auto-scaling | Target tracking on CPU and request count, floor 2 tasks, ceiling as above; scale-down cooldown to protect SSE streams | |
| Account quotas | Fargate task, ALB, NAT and KMS request quotas checked before the load test and before go-live | **Unverified** |
| Budget alarms | AWS Budgets per account with alert at 50/80/100 % of the monthly plan | Cost guard |
| GitHub Actions concurrency | One production release at a time (`production-release`); one staging deploy at a time | Release lock |

## 13. Costs

All figures are US$/month at list prices, planning estimates, not quotes.

### 13.1 What this plan adds to ARCHITECTURE 10.1

| Item | Low | Expected | High | Basis |
| --- | --- | --- | --- | --- |
| GitHub plan (organisation, Team: rulesets, checks, CODEOWNERS, branch policies) | 12 | 20 | 40 | 3–10 seats × about US$4 (**Unverified**, recalled list price). **Does not include environment required reviewers**, which are not on Team for private repositories; the plan uses approval-by-apply instead (4.1 A2). Option A3 (higher plan with reviewers): price **Unverified**, not budgeted; shown as a decision, not added |
| GitHub Actions minutes beyond the plan's included minutes | 0 | 40 | 150 | About 8,000–20,000 Linux minutes/month (150 PR runs × 25 min, 100 main builds × 30 min, nightly e2e) less included minutes; per-minute price **Unverified** |
| Paging / on-call service | 0 | 40 | 150 | Per-user price of a paging product × 2–6 on-call people (**Unverified**); 0 if SNS email only (weak) |
| SAST, secrets, dependency, container scanning | 0 | 0 | 0 | Open-source tools run in CI. SonarQube is not selected (14) |
| Extra observability (log volume, traces, **canaries ≈ 176**, 11.4) | 200 | 300 | 550 | Canaries alone are about US$176 (listed, 11.4); the low value rises accordingly. Inside ARCHITECTURE "cloud infrastructure" and "tooling" lines; shown for visibility, **not additive** to the G1 total |
| Test Google Workspace tenant and domain (3.5, AL-05) | 40 | 60 | 150 | 4–10 users at a recalled per-user list price plus domain registration. **Unverified**; price, trial and edition not checked. Needs the owner's decision (16 item 19) |
| Vendor sandbox usage: email, SMS, video (3.5, AL-05) | 0 | 50 | 200 | **Unverified**; vendors not chosen. E-prescribing sandbox **not estimated** (out of scope) |
| Test tooling (14, AL-07): Playwright, Schemathesis, k6, axe-core, Lighthouse CI | 0 | 0 | 0 | Open-source licences; run in GitHub-hosted runners (minutes are in the Actions row) and in the `loadtest` Fargate generators (inside the load-test window row) |
| **Additive to G1 total** (GitHub, minutes, paging, test tenant, sandboxes; the observability row is inside G1 lines) | **52** | **~210** | **~690** | Draft 3's 12 / ~100 / ~340 plus the two new rows. Low and expected are within the G1 "Tooling" line of 100 / 300 / 600 (the low case is below it); **the high case, about US$690, is about US$90 above that line**. Whether the test tenant and sandboxes belong in that line is for the Orchestrator and Architect |
| Load test window (production-equivalent `loadtest`, 3.4: generate data, run, tear down) | 250 | 450 | 900 | Re-estimated (DPR-07): a production-sized, Multi-AZ environment for about 3 days (about 1 day of data generation, 1 of tests, 1 buffer/teardown) at the production infrastructure run-rate share per day (**Estimate**, ARCHITECTURE 10.1 infrastructure line ÷ 30 × days, not recalculated here because the line is the Architect's), plus about US$40/month snapshot storage for the generated data. Replaces draft 1's US$100–250 per day |
| Region-loss rehearsal day | 100 | 200 | 300 | Section 10.4; **Estimate** |

One-time assurance costs (penetration test, accessibility audit, clinician review) stay outside the run budget (ARCHITECTURE 10.3; D-28). The load-test and rehearsal days are build-budget items.

### 13.2 What remains the main run-cost risk

Unchanged from G1: SMS (US$2,800–6,450), video (US$1,600–5,400) and, from R2, e-prescribing per-prescriber fees. DevOps has no lever on those other than the alarms in 11.3. **The expected R1 run cost remains US$13,750; the G1 high scenario (US$22,150) exceeds the US$15,000 top of the budget.** This plan does not change that.

### 13.3 SAR-16 and the Cognito replication add-on (G2 cost check)

On 2026-11-04 I read AWS's announcement for Cognito multi-Region replication ([AWS News Blog](https://aws.amazon.com/blogs/aws/improve-your-application-resilience-with-amazon-cognito-multi-region-replication/)). It states the add-on costs **US$0.0045 per monthly active user per replica Region on the Essentials tier** (US$0.006 on Plus), and 30 % on top of M2M token pricing. The page does **not** say whether it is charged per user pool and mentions no minimum. I did not open the Cognito pricing page or get a quote.

Applying that rate to the ARCHITECTURE A-9 range of 30k / 60k / 100k active patients:

| Pool | Monthly active users | Replication add-on (US$/month) |
| --- | --- | --- |
| Patient | 30k / 60k / 100k | 135 / 270 / 450 |
| Partner pharmacy | tens to low hundreds | < 5 |
| Admin (path B) | a few dozen (A-14: 10–30 plus 2) | < 1 |

Consequences, **if the per-user pricing holds and no per-pool minimum exists**:

- The G1 allowance (A-12: 200 / 400 / 1,000) covers the patient pool at low and expected volume and **overstates the high case** by about US$550. The allowance is not understated.
- **Path B adds essentially nothing to the replication fee** (under US$5). The worry that path B could add up to US$1,000 a month (SHARED-BOUNDARIES 1, 7.4) does not apply under per-user pricing. The remaining path B cost is the engineering effort (2–4 engineer-weeks, plus about 1 if fallback F-1 is needed) and the base pool fees, which are also per user.
- **What this does not settle:** the base Essentials per-user price, any minimum charge, and whether the SMS/OTP charges for pool-sent messages apply. A quote or the pricing page must close this at G2. I list SAR-16 as **partly answered, not closed**.

### 13.4 Workspace edition (SAR-16 second half)

The question: which Google Workspace edition lets the owner enforce **security-key-only 2-Step Verification** for staff and export the policy as evidence (C2). Under the default path B this concerns staff 2SV only (SEC-D-04, RA-R1-01), because admin and compliance roles no longer rely on Google.

What I found on 2026-11-04 by web search (no tenant access, so **no tenant fact is verified**): Google's Help Center describes an admin setting "Only security key" under allowed 2SV methods, applied per organisational unit. A 2018 Workspace Updates post lists security-key management as available to all editions at that time ([Google Workspace Updates, March 2018](https://workspaceupdates.googleblog.com/2018/03/manage-security-keys.html?hl=fil); [July 2017](https://workspaceupdates.googleblog.com/2017/07/making-two-step-verification-deployment-easier.html)). I did not find a current edition matrix, and I found nothing on exporting the policy. These sources are old; **treat them as a lead, not a confirmation.**

**Open, needs a Workspace administrator:** (1) the current edition; (2) whether "Only security key" can be selected for the staff organisational units; (3) what evidence can be produced for C2/RA-R1-01. Candidate evidence: a dated screenshot of the 2SV enforcement page per OU (policy configuration), the Admin console security-settings audit events, and a sample of the 2SV enrolment report. If no policy export exists, the evidence is screenshots and audit-log entries captured by the admin, reviewed quarterly. I cannot produce any of these from here.

## 14. Optional tools: selection, scope, access, budget

| Tool | Decision | Exact scope | Access and data flow | Budget | Revisit when |
| --- | --- | --- | --- | --- | --- |
| **Semgrep Community Edition** (SAST) | **Selected** | CI job on every PR and `main`; pinned ruleset (OWASP Top Ten, TypeScript, Node, secrets, Terraform and Dockerfile rules) plus custom rules for audit-write and `SET LOCAL` scope patterns | Runs in the GitHub runner; no code leaves it; no SaaS account or token | US$0 | If the rules prove too weak against the Security Reviewer's checklist |
| **gitleaks** (secrets) | **Selected** | Diff on PR; full history on `main` weekly | Runner only | US$0 | |
| **OSV-Scanner** + Dependabot | **Selected** | Lockfiles, GitHub Actions pins, Terraform providers | Reads public advisories; Dependabot alerts must be enabled by the repo owner (currently **disabled**, 4.1) | US$0 | |
| **Trivy** (images, Dockerfile, Terraform) | **Selected** | Each image digest; IaC config scan | Runner only | US$0 | |
| **Syft/cosign** (SBOM, signatures) | **Selected** | Images and bundles | cosign keyless via GitHub OIDC | US$0 | |
| **actionlint** (workflow lint) and the SHA-pin script | **Selected** | Workflow files on every PR | Runner only | US$0 | |
| **OWASP ZAP baseline** | **Selected** | Staging only, passive, synthetic accounts | Target is our staging; no third party | US$0 | |
| **Playwright Test** (AL-07: browser end-to-end and scripted API cases) | **Selected** (Recommendation; version pinned at build) | PR subset on `ci`; full `AUTO` suite on `staging` (5.1, 5.3). Chromium, Firefox and WebKit builds shipped with the tool; **real devices (iOS Safari, Android Chrome, tablets) are not covered** and stay with QA (TC-XB-02) | Runner only; synthetic accounts; secrets by reference | US$0 (Apache-2.0 licence, **recalled, verify at selection**) | If QA needs a real-device cloud: price and data flow unverified, not budgeted |
| **Schemathesis** (AL-07: API/contract) | **Selected** (Recommendation) | OpenAPI conformance and negative testing on `ci` and `staging` (TC-API-09). Never production. Not an authorised active assessment | Runner only, from a pinned container image digest; synthetic accounts; rate cap | US$0 (MIT licence, **recalled**) | If the Architect does not publish OpenAPI documents for every R1 module: then QA's contract cases are `Blocked` |
| **k6** (AL-07: load generator) | **Selected** (Recommendation) | `loadtest` only (3.4, 5.3): scenarios in the repository, thresholds as exit status, in-VPC Fargate generators. **Unverified:** whether k6 can drive the SSE alert stream (ARCHITECTURE 32.2) without a custom extension; if not, that scenario needs a small custom client and QA is told | In-VPC; results are artifacts; no PHI exists | US$0 for the tool (AGPL-3.0, **recalled; used unmodified as a test tool; the owner and counsel confirm the licence is acceptable**); generator compute is in the load-test row | Grafana Cloud k6 or another hosted generator is not selected: it would leave the VPC and has a price **unverified** |
| **axe-core via `@axe-core/playwright`** and **Lighthouse CI** (AL-07: accessibility) | **Selected** | PR smoke and full key-page scan in `staging` (5.1, 5.3). Automated rules find only part of WCAG issues | Runner only | US$0 (MPL-2.0 and Apache-2.0, **recalled**) | Manual runs with NVDA, JAWS and VoiceOver on real devices are **not a DevOps provision**: QA and the owner (3.5). JAWS licence price **unverified**, not budgeted |
| **CodeQL** | Not selected | n/a | Private-repository code scanning needs GitHub's paid code-security offering (**price unverified**) | Not budgeted | If the owner wants GitHub-native alerts and approves the licence |
| **SonarQube** | **Not selected for R1** | n/a | A server in the tooling account (Community Build) or the hosted service would add a service to run or buy, plus a token with read access to the code. Current edition capabilities (branch and PR analysis) and pricing are **unverified** | Not budgeted (the G1 tooling line of up to US$600 would cover a hosted or small self-run option) | If Semgrep results are judged inadequate, or the owner wants quality-gate dashboards. Decision needs: edition, hosting, token owner, retention, cost |
| **CodeRabbit** | **Not selected** (optional) | n/a | Would send pull-request diffs to a third party and requires a GitHub app with read/write on pull requests. It is not a substitute for the independent reviewer roles and gives no Claude-facing MCP server | Per-seat price **unverified**, not budgeted | Only if the owner wants it, with a data-handling check; diffs never contain PHI by policy, but secrets and design must not be exposed |
| **Strix** (active dynamic assessment) | **Not selected** | n/a | Active testing needs an explicitly authorised target, methods, credentials, time/rate/cost limits and cleanup (WORKFLOW). Staging only, synthetic data, never production | Not budgeted | Before the pen test, if the owner and Security Reviewer authorise a scoped run. Required: target URL list, accounts, rate cap, window, cost cap, kill switch, teardown |

**Ordinary tests and scans remain mandatory regardless of optional tools.** The independent penetration test before each production release with new external surface (NFR-16) is not replaced by any of these.

## 15. Release gates

### 15.1 Gates before any environment mutation

| Gate | Evidence |
| --- | --- |
| G2 for any workflow, IaC or runtime configuration | Human decision on the exact `DEVOPS-PLAN.md` revision |
| DevOps Reviewer review of the implemented configuration | Review of the exact revision |
| Staging authorisation | Separate from production. Staging release is an approved activity only after G2 and a working pipeline |
| Acceptance (Stage 4) | Tested candidate accepted |
| **G3 for the named environment** | Release owner, human Architect/DevOps and business owner on the exact artifact manifest hash, configuration, plan and environment |

### 15.2 The release package for G3 (contents defined now)

`RELEASE-REVIEW.md` (independent Release Reviewer), `DEPLOYMENT-PLAN.md`, `ROLLBACK-RUNBOOK.md`, `OPERATIONS-HANDOFF.md`, containing: manifest hash; migration list and a statement of N-1 compatibility test result; backup freshness and the latest restore test result; load-test and pen-test status for this release (NFR-16, DEP-13); BAA register complete for every vendor that receives PHI (NFR-19); on-call rota and tested alert delivery (DEP-15); abort thresholds and observation window (9.2); named people for every action and their access; timing, expected user impact, and communication scope; unresolved findings and suppressions; **GitHub-side enforcement status**: the exact settings found (plan, rulesets, required checks, environment protection, Actions policy), and whether the approved-release record (7.4) is the only effective control (DPR-02); the approved-release record contents and expiry.

### 15.3 What the pipeline must refuse (production)

Refuse if: the manifest digest differs from the `manifest_hash` in the approved-release record read from the production account (7.4), or the record is missing, expired or for another environment or action; an image signature or SBOM is missing; a required check on the commit failed or is stale; the environment lock is held; the record's `g3_reference` is absent; a snapshot or backup freshness check fails; or the previous release's manifest is not available for rollback; or `min_client_release` differs from the `release_number` of the manifest named as `previous_manifest_hash` (6.2).

## 16. Decisions and actions this plan needs from people

| # | Item | Owner | Blocks |
| --- | --- | --- | --- |
| 1 | GitHub organisation on Team (rulesets, checks, CODEOWNERS, branch policies); a separate human approver and agent identity; **choose approval-by-apply (A2)** as the production approval control, or additionally a higher plan with environment reviewers (A3, price unverified) | Owner | Any claim that checks, reviews or release locks are enforced |
| 2 | A **second human** for dual control (C4 approver, audit archiving, bootstrap, break-glass approval) | Owner (RK-5) | Bootstrap, audit archiving, privileged role changes in operation |
| 3 | Named on-call rota with response times (D-29); paging service choice and cost | Owner | The 99.9 % claim; go-live |
| 4 | Workspace edition and 2SV evidence (13.4) | Workspace administrator | RA-R1-01 evidence; SEC-D-04 |
| 5 | Cognito pricing page or quote (13.3) | DevOps/Owner | Closing SAR-16 |
| 6 | Hosting choice AWS vs Google Cloud (D-30) | Owner | Everything below the plan's AWS-specific lines |
| 7 | Audit, log and backup retention periods | Counsel | Storage cost, vault configuration |
| 8 | Whether the Workspace directory leaver backstop is required (SHARED-BOUNDARIES 7.2.8) | Cybersecurity | Directory credential and role |
| 9 | Accept admin elevation limitation during failover (10.5) | Human Architect, operations owner | Region-loss runbook |
| 10 | Confirm `www.`/`cms.` outside NFR-1..3 (SAR-11) | PM | SLO table |
| 11 | CMS runtime vs static export + SaaS CMS | Owner, on cost | Marketing pipeline |
| 12 | Whether canaries may write a labelled synthetic tenant in production (11.4) | Owner, compliance | Synthetic coverage |
| 13 | **Connection budget:** explicit `max_connections` 600 (any value ≥ 560 fits ARCHITECTURE 9.2; the Solution Architect decides only for a lower value), deploy `maximumPercent` 150 %, alarm thresholds (9.1). Route: Orchestrator to Solution Architect to record | Solution Architect | Production sizing |
| 14 | Who applies approved-release changes (platform admin) and the roles' owners, session limits and expiry margin (7.2, 7.4) | Owner, human Architect | Any production deployment |
| 15 | Confirm the A3 option, the `us-east-1` exemption list (3.1) and the GitHub Actions policy settings available on the chosen plan (4.1) | Owner, DevOps at G2 | Foundation tasks |
| 16 | Release authorisation required for `marketing-production` (9.1) | Owner | Marketing publication |
| 17 | **Portal/API version contract (DPR-16):** the contract is ARCHITECTURE 28.6 (draft 8.1) and DevOps's producer side is **confirmed in 6.2 (draft 4, DEV-1)**. Still open: UX prompt wording and save-or-warn behaviour (HEAAA-49), and the QA case. Route: Orchestrator to UX and QA | UX, QA | Portal and API build contract |
| 18 | **Platform-admin-apply root of trust (7.5):** who the named platform admins are, the management-account SCP owner, and whether the `us-east-1` `cloudwatch`/`sns` exemption (3.1) is accepted | Owner, human Architect | Any production deployment |
| 19 | **Test tenant and sandboxes (AL-05):** whether the owner provides a separate Google Workspace test tenant and domain (cost in 13.1), who holds its super-admin credentials, and which vendors the email, SMS, video and e-prescribing sandboxes come from. Until then the `ENV-INT` cases that need them are `Blocked` | Owner, Workspace administrator | `ENV-INT` stack cases that need the tenant or a sandbox |
| 20 | **Test tooling and licences (AL-07):** accept Playwright, Schemathesis, k6, axe-core and Lighthouse CI as in 14, in particular the k6 AGPL licence for use as an unmodified test tool | Owner, human Architect (counsel for the licence) | Build foundation: CI and `loadtest` |

### 16.1 Items from the Orchestrator routing and G1 carry-forward

| Item | Where handled |
| --- | --- |
| C2/C3 evidence (security-key-only 2SV, policy evidence, exactly two named super-admins, sealed break-glass account, quarterly review) | 13.4 and 16.3. Under default path B they apply to **staff** 2SV and to the Workspace super-admin as a tier-0 principal; they would guard admin roles only if the owner switches to path A |
| First-admin bootstrap runbook | 16.2 |
| Workspace edition for security-key-only 2SV and policy export | 13.4, **unconfirmed** |
| SAR-16 | 13.3 and 13.4, **partly answered** |
| SAR-10 | 5.2 and 12, role-level `transaction_timeout` checks |
| SAR-11 | 10.1, 11.2, 16 |
| RDS 17 availability | 3.3, **unverified** |

### 16.2 First-admin bootstrap runbook (control requirements; the executable steps are fixed after the identity ERD freeze)

Purpose: create the first two admin principals in each environment without any existing admin (C4 bootstrap; SHARED-BOUNDARIES 7.2.7, 7.5 P-4). Runs once per environment.

Preconditions: infrastructure and the admin pool exist from IaC; identity tables migrated; **two named human custodians** (not the person being enrolled twice and not the same person; if only one human exists this runbook cannot run, see 16 item 2); two security keys per future admin purchased and stored; the role `gh-bootstrap-<env>` is enabled by approval-by-apply (4.1 A2): a reviewed change under `infra/approvals/` approved by **both** custodians (two distinct human approvals; neither is the author) and applied by a platform admin. If the owner also buys the higher GitHub plan (A3), the `bootstrap-<env>` environment additionally has the two custodians as required reviewers with self-review prevented; the runbook does not depend on it.

1. Custodian A starts `bootstrap.yml` (manual, input: environment, two named persons, ticket reference) after the enabling change is applied (custodian B has approved it). The job's role may only call the bootstrap function, nothing else.
2. The bootstrap task (one-off ECS task, the release image digest, a dedicated role) creates two admin principals and two person records, and issues **two single-use enrolment tokens** valid for at most 30 minutes, each bound to one person. It writes the audit events through the worker path, not through a migration. Tokens are never printed to the workflow log.
3. **Token retrieval path (DPR-10).** The bootstrap task writes each token to its own Secrets Manager secret `bootstrap/<env>/token/<person>` with a resource policy that allows `GetSecretValue` only to the **named custodian's IAM Identity Center role** (custodian A for one enrollee, custodian B for the other, so neither custodian can read both). **A custodian never retrieves their own token (DPR-23):** the resource policy of each secret names the permitted custodian and carries an explicit deny for the enrollee's own identity, and if the two custodians are also the two enrollees, A retrieves B's token and B retrieves A's. Where possible the custodians are not the enrollees. MFA is required, plus a session limit. Every read raises a CloudTrail alert to the security contact. The token expires after 30 minutes server-side and the secret is deleted on use or at expiry; deletion and the read events are evidence. The custodian hands the token to the enrollee **in person or by an approved secure channel they choose** (not email, chat, or task comments); custodians never paste it into GitHub. No production data access is needed to retrieve it. If a custodian's Identity Center role is not available, the runbook stops (it does not fall back to a shared account).
4. Each person enrols a roaming security key with user verification on the admin sign-in path. Each also enrols a second key held separately.
5. Verify: both can sign in and obtain an elevation grant; the audit trail shows creation, token issue, token read, token use, enrolment; tokens are consumed and cannot be reused; the token secrets are deleted; the bootstrap role cannot be assumed any more (trust policy reverts to deny by its expiry or a revoke change, by IaC).
6. From here the in-app rule applies: every further admin change needs a request and a different approver with an active elevation (C4). Record the evidence (job run ID, audit event IDs, key serials by label not secret) in the operations handoff.
7. Failure handling: expired token → repeat from step 1 with a new ticket; lost key → the dual-controlled enrolment runbook (P-4), never self-service. A partial run is inspected in the database before retry.

Staging and `restore-test` bootstrap use synthetic persons and different keys.

### 16.3 Workspace super-admin and organisational-unit evidence (C2/C3; **relevant to staff under path B**, to admins only under path A)

Evidence captured at go-live and each quarter by a Workspace administrator and reviewed by someone who is not a super-admin: exactly two named super-admins; no shared accounts; super-admins on security keys only; sealed break-glass account whose use alerts; alerts on super-admin and OU or 2SV policy changes sent to the security contact (11.3); 2SV enforcement setting per staff OU; list of staff accounts without a registered security key (if keys are required); deprovisioning proof within one business day (C6). Not producible by the agents. Recorded in `OPERATIONS-HANDOFF.md`.

## 17. Limitations

- Everything above is a plan. **Nothing is configured, executed, verified, integrated, deployed or acknowledged.** The only things I ran were read-only GitHub API calls (4.1) and two documentation lookups (13).
- All prices except the Cognito per-user rate are unverified estimates. The Cognito rate comes from AWS's announcement, not the pricing page, and does not say whether it applies per pool.
- Timings (deploy duration, snapshot duration, restore duration, RPO lag) are estimates until measured by rehearsal.
- AWS service availability, BAA eligibility, RDS 17 behaviour and Cognito replica behaviour are documentation-based and unproven.
- The Workspace edition and policy export are unconfirmed and cannot be checked from here.
- GitHub controls cannot be configured or tested on the current plan. Environment required reviewers are not on Team for private repositories (reviewer-verified from GitHub Docs); the plan that provides them, and its price, are unverified. The approved-release record is a design: no part of it has been built or tested, and its workflow-side hash check is a control a tampered workflow could skip.
- Connection numbers in 9.1 are arithmetic from ARCHITECTURE 9.2; `max_connections` is a proposal awaiting the Solution Architect.
- Not legal advice. Retention, breach clocks and BAA coverage need counsel.
- The control-plane guards in 7.5 (SCP, permission boundaries, task-definition pinning, detection rules) are a design. Whether IAM can restrict `ecs:UpdateService` by task-definition revision, how AWS evaluates `job_workflow_ref`, and whether the SCP exemption by `aws:PrincipalArn` works with Identity Center role names are **unverified** and must be proven in staging. The portal/API version check (6.2) is a requirement for the build lane, not an implemented behaviour.
- **Draft 4 additions.** Nothing in draft 4 was executed: no AWS account, SCP, role, test tenant, sandbox, domain, tool installation or pipeline exists, and I made no external lookup. Every price, licence name and tool behaviour added in draft 4 is from memory and marked **unverified**. Unverified IAM behaviour that decides whether DPR-25 holds: that the Identity Center role ARN pattern works as the SCP exemption; that Identity Center provisioning is unaffected by the SCP; that `ecs:RunTask` is scoped by task-definition ARN; that the workload roots apply with no IAM write; the cost and latency of Access Analyzer findings. Resource-policy persistence remains a stated residual risk (7.5). `release_number` derivation by first-parent commit count is untried.
- This draft 4 is not reviewed and not approved at G2. The reviews of draft 3 (round 3 of 3 CHANGES REQUIRED: DPR-25 High, DPR-26, DPR-27 open) remain the last independent verdict until the draft 4 review is recorded.

## 18. Revision manifest

| Item | Identifier |
| --- | --- |
| This document | **Draft 4**: HEAAA-50 document key `devops-plan` (revision ID in the HEAAA-50 submission comment) = `docs/DEVOPS-PLAN.md` on branch `HEAAA-50-sdlc-design-align-fix-devops-al-04-confirm-al-05-al-07-al-09-dpr-25-27` (commit in the submission comment). **Base: draft 3**, HEAAA-16 document key `devops-plan` rev `a3b9f37f-df4e-4673-b437-9e3620984f52` = `docs/DEVOPS-PLAN.md` @ `b78a8b6`, sha256 of the file `a9984f38…4250f` (the HEAAA-50 branch commit `77ca58f` imports it unchanged as the diff base) |
| ARCHITECTURE | **Draft 8.1**: HEAAA-48 `architecture` rev `b276930a-20af-4433-a8f0-60843f5a3eaf` = `docs/ARCHITECTURE.md` @ `481f32a`, sha256 `1e7fe57ed94d4412b836e2d0d7be201685fba18d7d94c07baad432ee1808bbae` (read from the commit; sections 28.6, 37 DEV-1, 40.7, 40.8). Independently reviewed: HEAAA-52 and HEAAA-53 (PASS on the erratum). G1-accepted overview: HEAAA-11 `architecture` rev `f2d240e4-2f63-45a1-aaa1-16a1f8854c32` |
| PRD | HEAAA-11 `prd` rev `bba336f3-e934-4dbb-9158-0909fda132d7` |
| SHARED-BOUNDARIES | HEAAA-12 `shared-boundaries` rev `0fffc85d-c3cd-4bad-a7f3-4f774fbbbf5a` |
| Intake pack | Revision 2, commit `6ea01b5` |
| Review round 1 | `devops-plan-review` rev `9215b96a-5a70-42e5-98d1-e19e311b1fc8` (reviewed draft 1 rev `f7536818`) |
| Review round 2 | `devops-plan-review` rev `0d9f1cc5-5615-4bc7-b637-8dbacd56b546` (reviewed draft 2 rev `6490e76b`) |
| Review round 3 | `devops-plan-review` rev `01b55b06-0f66-489c-8df0-06e14eec2db7` (reviewed draft 3 rev `a3b9f37f`): CHANGES REQUIRED, DPR-25 High, DPR-26, DPR-27. Native stage closed on a human decision (read as option b); not a PASS |
| Authority for this cycle | HEAAA-17 confirmation `a524dfdd` (2026-11-05T13:14Z): one bounded correction cycle. Gap source: HEAAA-17 `design-align` rev `4447e3ec-616c-4100-ac5c-d433f8786365` section 4 (AL-04, AL-05, AL-07, AL-09) |
| QA inputs read for AL-05/AL-07 | HEAAA-15 `test-cases` rev `9d3f1ec1` = `docs/TEST-CASES.md` @ `39d881a` sections 0.3, 11.2, 17 |
| Evidence date | 2026-11-04 for the GitHub checks (4.1). Draft 4 (2026-11-05): no new checks of any kind, no external lookup; everything added is design or recalled and marked unverified |
| Review ledger | DEVOPS-PLAN: 3 of 3 rounds used, plus this one bounded cycle (`a524dfdd`). Not reset |

## 19. Next permitted action

Independent review of this exact revision, limited to its diff against draft 3 (0.2): the DevOps Reviewer (`fe9b5f91`) for configuration, tooling, cost and environment mapping, and the Solution Architect Reviewer (`338c0bb5`) for DPR-25..27 and the AL-04 confirmation against ARCHITECTURE 28.6. Findings keep their IDs; DPR-25..27 are closed only by the reviewers. This is the last correction in this cycle: unresolved findings return to the Orchestrator for a human decision. Afterwards the Orchestrator re-joins the design revisions (HEAAA-17); QA re-binds `ENV-*` names last using 3.5 and the tools in 14. Items 19 and 20 of section 16 are owner decisions. The Delivery Planner includes this plan in the G2 package. Implementation, installs, workflow files, IaC, account or domain sign-up, vendor sandboxes and credentials all wait for a valid G2; production IAM, OIDC trust and task-definition registration additionally wait for the DPR-25..27 re-review. Review PASS is not human approval.
