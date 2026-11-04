# DEVOPS-PLAN — Enterprise EHR Platform (Stage 2, post-G1)

| Field | Value |
| --- | --- |
| Task | HEAAA-16 `[SDLC:devops-plan]` |
| Author | DevOps Engineer agent (`021d733c-9400-40ba-9b0e-540b71450434`) |
| Independent reviewer | Solution Architect Reviewer (`338c0bb5-1aeb-4d88-b754-4885297ae447`) |
| Version | **Draft 1** |
| Status | **Draft. Not reviewed. Not human-approved. This is not G2 and authorises no installation, provisioning, workflow file, or deployment.** |
| Baseline | ARCHITECTURE draft 4 (HEAAA-11 `architecture` rev `f2d240e4`), PRD revision 3 (`prd` rev `bba336f3`), SHARED-BOUNDARIES draft 3 (HEAAA-12 `shared-boundaries` rev `0fffc85d`), intake pack revision 2 (`6ea01b5`). G1 accepted by a human 2026-11-04 (HEAAA-11 confirmations `009ac8a9`, `cadd7751`) |

## 0. How to read this

Labels: **Constraint** (fixed by an approved source), **Recommendation** (my proposal; a human decides at G2), **Verified** (I checked it, with how and when), **Unverified** (stated from documentation or memory, or not checkable from here), **Open** (needs a person). Cost figures are planning estimates, not quotes. No cloud account exists, no vendor was contacted, nothing was installed or run except the read-only GitHub API checks in section 4.1 and two documentation lookups in section 13.

## 1. Summary for the decision-maker

1. **CI/CD provider: GitHub Actions** (Constraint, intake `[01 §7]`, `[05 §2]`), repository `zainnaeem28/enterprise-app`, deploying to AWS through OIDC federation. No long-lived cloud keys in GitHub.
2. **Verified blocker for the release lock.** On 2026-11-04 the GitHub API answered **HTTP 403 "Upgrade to GitHub Pro or make this repository public"** for branch protection and for rulesets on this private, personally owned repository. Required checks, required reviews and protected environments are the controls that the workflow and G3 rely on. They **cannot be configured on the current plan**. The repository must move to a paid plan (see 4.1 and the cost in section 13), or the plan must say plainly that these controls are unenforced.
3. **Verified second limit: the approver and the agents share one GitHub identity.** The agents act through a token for `zainnaeem28`, who is also the product owner, operations owner and the only human at every gate (PRD RK-5). A GitHub environment approval by that account cannot be told apart from an agent acting with the same token. Section 4.1 recommends a GitHub organisation with a separate agent identity and at least two human accounts. Dual control (C4, audit archiving, first-admin bootstrap) is **not achievable with one human**.
4. **Topology** is the G1 design: one AWS organisation, separate accounts for production, staging, tooling, log-archive and marketing, a US primary region and a US recovery region (section 3). No Kubernetes, no cluster, no extra deployables.
5. **One immutable artifact per commit**, promoted by digest from staging to production, never rebuilt (section 6).
6. **Release safety:** expand/contract migrations, the previous app version tested against the new schema in CI, a manual database snapshot before every production migration, rolling ECS deploy with automatic rollback, and an explicit statement that an application rollback is not a database restore (sections 8, 9).
7. **Recovery** follows ARCHITECTURE 9.4. A monthly automated restore test, and a timed region-loss rehearsal before R1 go-live and before each later release (section 10). Estimates only until rehearsed.
8. **Cost of this plan's own choices is small** (about US$50–400/month, section 13). The large risk stays where G1 put it: usage-based SMS and video. **SAR-16 is largely answered**: the Cognito replication add-on is priced per monthly active user, so a small admin pool adds almost nothing (13.3).
9. **Optional tools (section 14):** Semgrep Community Edition, gitleaks, OSV-Scanner and Trivy are selected for CI. **SonarQube, CodeRabbit and Strix are not selected** for R1, each with the condition that would change that.
10. **Decisions this plan needs from a human are in section 16.** The three that block executable work are the GitHub plan and organisation (item 2–3), a named on-call rota (D-29), and a second human for dual control.

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
| `loadtest` | `staging` (scaled up by IaC) | Synthetic at year-1 volume | NFR-6/8/9 proof at 2 × and 3 × (DEP-14) | Created for a test window, then scaled down |
| `production` | `production`, region primary; DR in recovery region of the same account | Real | Live | Persistent |
| `restore-test` | `production`-equivalent isolated VPC, same account boundary and controls as production | Restored production backups (PHI) | Monthly restore test, DR rehearsal | Created per test, destroyed after |
| `marketing-staging`, `marketing-production` | `marketing` | None (no PHI) | `www.`, `cms.` | Persistent |
| Shared services | `tooling` (IaC state, ECR, build roles), `log-archive` (audit archive, backup vault, CloudTrail) | Artifacts, logs | | Persistent |

- **No persistent `dev` cloud environment in R1.** PR checks use `ci`; developers use local containers with synthetic seed data. A shared `dev` account would add cost and a place for real-looking data. Add it only if the build team shows a need.
- **Restore tests of production backups cannot run in `staging`.** Staging is outside the PHI boundary. The restore target is built in the production account boundary with production-equivalent access, BAA coverage, logging and teardown. Staging rehearses the procedure with synthetic data.
- The marketing account holds two environments (`site`/`cms` staging and production) separated by IaC workspace and GitHub environment. No PHI, no network path or credentials to production data (TB8, ARCHITECTURE 3.1).
- AWS Organizations with service control policies denying: disabling CloudTrail/GuardDuty/Config, deleting the log-archive vault, leaving the organisation, use of regions other than the two US regions. (Recommendation.)

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

Primary: `us-east-2`; recovery: `us-west-2` (Recommendation, ARCHITECTURE 7). **Unverified:** every service named in ARCHITECTURE 9.4 (RDS PostgreSQL 17 cross-Region automated backup replication, S3 RTC, Cognito replication, ECR replication, GuardDuty malware protection, Chime SDK) is available in both regions and BAA-eligible on the day of build. Verified at build start by the foundation task, with the AWS BAA-eligible services list read on that date.

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
- **Recommendation A (needs owner approval and a cost decision):** move the repository to a **GitHub organisation** on a paid plan (Team or higher). Create: (1) at least two human accounts, one of which is an approver who does not write code; (2) a separate **agent identity** (machine account or GitHub App) with write to feature branches only and **no right to approve environments or edit protection rules**; (3) rulesets on `main` requiring a pull request, the status checks in 5.1, a CODEOWNERS review for `.github/`, `infra/`, `db/migrations/` and `docs/`, no force push, no deletion, and signed commits if the agent identity can sign; (4) environments `staging`, `production`, `bootstrap-staging`, `bootstrap-production`, `audit-archive`, each with required reviewers and **prevent self-review** on. List price recalled as about US$4 per user per month for Team (**Unverified**, confirm on the pricing page).
- **Fallback B (if the owner declines):** make no claim that the pipeline enforces review or release locks. The controls become procedural: a human checks the pipeline run before G3, and AWS-side controls carry the weight (the production deploy role's trust policy, section 7). The Release Reviewer must record "GitHub-side enforcement absent" in every RELEASE-REVIEW.md. This is weaker, and I recommend A.
- Because the human approver and the token holder are one GitHub login today, even with Recommendation A **the approver account must not be the one the agents use.** If one person holds both roles, state that in the G3 package.
- **Open:** the PRD risk RK-5 (one person holds every gate) means C4 second approver, audit-partition dual control and bootstrap cannot be satisfied in practice until a second human exists. See section 16.

### 4.2 Workflow layout (Recommendation; **no file is created before G2**)

All workflows live in `.github/workflows/`. Every third-party action is **pinned by full commit SHA** (SEC-D-15). Default `permissions: {}` at workflow level; each job grants only what it needs. Runners: GitHub-hosted Linux for build and test; no self-hosted runners in R1 (they would put a long-lived machine inside the trust boundary).

| Workflow | Trigger | Jobs | Permissions / credentials | Output |
| --- | --- | --- | --- | --- |
| `ci.yml` | `pull_request` to `main`; `push` to `main` | `lint-types`, `unit`, `integration-db` (PostgreSQL 17 service container, runs migrations, RLS tests of SHARED-BOUNDARIES 6.8), `migration-check` (5.2), `build` (reproducible, locked), `sast`, `secrets`, `deps`, `container-scan`, `sbom`, `a11y-smoke`, `bundle-budget` | `contents: read`, `pull-requests: write` only for comments. **No AWS credentials on pull requests**, including from forks | Required status checks |
| `build-release.yml` | `push` to `main` | Build once; push images to ECR in `tooling` by digest; sign; attach SBOM and provenance; build portal bundles; write the **release manifest** (6.1) | `id-token: write`, `contents: read`, `packages: none`. Assumes `gh-build` role in `tooling` | Release manifest, images, bundles |
| `deploy-staging.yml` | `workflow_run` of `build-release` success, or manual | Verify manifest and signatures; terraform plan/apply for `staging` if infra changed; migrate; roll out; smoke; e2e; ZAP baseline | Environment `staging`. Assumes `gh-deploy-staging` | Staging evidence |
| `deploy-production.yml` | **Manual `workflow_dispatch` only**, input = release manifest digest | Verify the digest equals the G3-approved digest; snapshot; migrate; roll out; smoke; observe; (recovery job only on failure and only as approved) | Environment `production`, required reviewers, concurrency group `production-release`, `cancel-in-progress: false`. Assumes `gh-deploy-production`, **which does not exist or cannot be assumed until G3** (7.2) | `DEPLOYMENT-RESULT.md` evidence |
| `infra.yml` | PR touching `infra/`; manual apply | `fmt`, `validate`, `tflint`, policy scan (Checkov or Trivy config), `plan` posted as an artifact; `apply` per environment with a protected environment | PR: read-only plan role. Apply: per-environment role | Plan artifact (hash recorded in manifest) |
| `nightly.yml` | schedule | Full e2e, dependency re-scan, base-image re-scan, staging backup-restore procedure check | Read-only; staging role | Reports |
| `restore-test.yml` | monthly schedule; manual for rehearsal | Section 10.3 | Environment `restore-test`; role limited to restore target | Restore evidence |
| `audit-archive.yml` | manual | Detach/drop a verified audit partition as `audit_archiver` (SHARED-BOUNDARIES 6.2) | Environment `audit-archive`, **second human approver required** | Manifest entry |
| `bootstrap.yml` | manual, per environment | First-admin runbook (16.2) | Environment `bootstrap-<env>`, **two reviewers** | Audit evidence |
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
| Accessibility smoke | axe on built portals (full audit is manual, DEP-17) | New serious/critical violations |
| Bundle and LCP budget | Lighthouse CI against the NFR-7 budget | Budget exceeded |
| SBOM | Syft, CycloneDX | SBOM missing |

Suppressions need a reviewer comment, an owner and an expiry date, and are listed in the release package.

### 5.2 Migration checks (BD-03, SHARED-BOUNDARIES 6.2)

On a fresh PostgreSQL 17 container, CI applies all migrations from empty and from the previous release tag, then fails if:

- a module or `kernel` table lacks RLS or `FORCE ROW LEVEL SECURITY`; any policy is `TO PUBLIC`; a view that is not on the C0/C1 list lacks `security_invoker = true`; a table with `patient_id` lacks the merge write guard; a `SECURITY DEFINER` function is not in the inventory or has no fixed `search_path` (**M-5**);
- an audit-writing login role lacks role-level `transaction_timeout` (SAR-10), or `app_owner` has INSERT on an audit table;
- a migration breaks the **expand/contract rule** (8.1): a drop, rename, type change, `NOT NULL` without a default-and-backfill plan, or non-concurrent index on a populated table in the same release as the code that stops using it;
- the **previous release's test suite does not pass against the new schema** (N-1 compatibility);
- a statement lacks a `lock_timeout` guard where it needs a strong lock.

**Unverified:** that RDS for PostgreSQL 17 exposes `transaction_timeout` as a role-level setting readable from the audit insert trigger (SHARED-BOUNDARIES 12). The build-foundation task proves it on a real RDS instance in staging before the audit design is relied on. If it does not, the architect decides the fallback; DevOps does not weaken the check.

### 5.3 Dynamic checks (staging only)

- OWASP **ZAP baseline** (passive) against staging portals after each staging deploy, with synthetic accounts. Active scanning is a separate, authorised activity (14.4).
- Synthetic smoke and journey tests (booking race, login per realm, document upload and scan, alert stream).
- **Load tests** on the `loadtest` environment before R1 and when the schema or hot paths change materially: 2 × peak for 30 min, 3 × burst for 5 min, **with RLS and audit inserts on** (ARCHITECTURE 9.2, SHARED-BOUNDARIES 6.8).

## 6. Artifact identity

### 6.1 The release manifest

Each build on `main` produces one `release-manifest.json`, hashed, stored in the tooling account (S3, versioned, Object Lock governance), and attached to the workflow run:

| Field | Content |
| --- | --- |
| `git_sha`, `git_tree_hash` | Exact commit |
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

Build once, deploy the same digests to staging then production. No rebuild per environment. Environment configuration is separate (Parameter Store values and Secrets Manager references per environment), recorded by name and version in the deployment evidence, never by value. Portal bundles are uploaded to `releases/<git_sha>/`; CloudFront origin path (or a pointer object) switches atomically at the end of the rollout. Only the entry document and manifest are invalidated. Old prefixes stay for rollback for 90 days.

Reproducibility: a frozen-lockfile install and pinned base images by digest. The build lane proves it by building twice and comparing the bundle listing hash and image layer digests, or by recording the differences. **Unverified until tried**; some image tooling embeds timestamps.

## 7. Credentials, secrets and owners

### 7.1 Principle

No deployment credential exists in GitHub secrets. AWS access uses OIDC roles whose trust policy pins the repository, the environment claim and the workflow. **Deployment credentials for an environment are withheld until that environment's G3** (framework rule).

### 7.2 Roles and owners

| Role / secret | Where | Who may use | Created when | Owner (human) |
| --- | --- | --- | --- | --- |
| `gh-ci-plan` | tooling/staging, read-only | PR workflows for `infra` plan | After G2 | DevOps, approved by DevOps Reviewer |
| `gh-build` | tooling | `build-release` on `main` only (`ref` condition) | After G2 | DevOps |
| `gh-deploy-staging` | staging | Environment `staging` | After G2 | DevOps; staging release authorisation is separate from production |
| `gh-deploy-production` | production | Environment `production`, one workflow file, manual dispatch | **Trust policy ships as a deny until G3 for that exact release.** The change enabling it is a reviewed IaC change, applied by a human with platform-admin rights, referenced in the G3 decision | Release owner approves; platform admin applies |
| `gh-tf-production` | production | `infra.yml` apply | Same rule as above | Platform admin |
| `app_owner` DB credential | Secrets Manager (production, staging) | Only the **migration task role** | After G2 / G3 | DevOps; rotated each release or 90 days |
| RDS master user | Secrets Manager, sealed | **Break-glass only**, time-boxed, alerts on use. Never used by an application component (BD M-1) | At DB creation | Platform admin and a second approver |
| `app_api`, `app_worker`, `audit_archiver`, `reporting_ro` DB credentials | Secrets Manager; IAM database authentication preferred (**Unverified** for the pooling setup) | Their task roles only | After G2 | DevOps |
| `outbound` secrets (`<env>/integration/outbound/*`) | Secrets Manager | Written by `api` task role; read by `api`, `worker` | At integration set-up | Admin-realm principal with an elevation grant |
| `inbound_verification` secrets (`<env>/integration/inbound/*`) | Secrets Manager | **Written by `worker` role only**; `api` read-only (BD-11) | At integration set-up | Dual-controlled request |
| Workspace directory read access (path B leaver backstop, if kept) | Keyless if possible; otherwise a Secrets Manager key, rotated, alert on use | `identity` | After Cybersecurity decides whether the backstop is required | Workspace super-admin grants; DevOps stores |
| KMS keys | Per environment; multi-Region where recovery needs it (ARCHITECTURE 9.4) | Key policies in IaC | At foundation | Platform admin |
| Vendor API keys (video, SMS, e-Rx, OCR) | Secrets Manager under `outbound/` | Adapters | At contract | Owner signs contract; admin enters |

**Secret handling rules:** secrets never appear in task text, documents, screenshots, logs, Terraform state in clear (state encrypted, access limited, sensitive outputs off), or committed files. gitleaks runs on every diff. Rotation: DB credentials and signing secrets on a schedule and at once on suspicion; read-through cache of at most 5 minutes so rotation takes effect (BD-11).

### 7.3 Human access

Engineers and DevOps reach AWS through IAM Identity Center with SSO and MFA, roles with no standing access to production data. Production database access is break-glass only: time-boxed, approved, alerting, logged. **Unverified:** whether the AWS organisation will use Identity Center federated to Google Workspace for engineers, or separate users. That is a separate identity from the staff sign-in; decided in the foundation task with Cybersecurity.

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

1. Verify manifest digest, signatures, G3 reference.
2. Check backup freshness: latest automated backup and replicated backup within threshold, else stop.
3. **Take a manual RDS snapshot** named with the release SHA. (Estimate: minutes on a database of this size; it does not block traffic. **Unverified until measured.**)
4. Run the migration task. Abort on non-zero exit.
5. Run the catalogue checks (5.2) against production schema (read-only).
6. Roll out (section 9).

**Riskiest data step:** a migration that holds a strong lock or rewrites a large table (the audit table reaches hundreds of GB in the hot window). Mitigation: partition-aware migrations only, no table rewrites on audit tables in an ordinary release, rehearse on a staging copy of year-1 volume (synthetic) and record the duration.

## 9. Rollout and rollback

### 9.1 Rollout (Recommendation: ECS rolling with circuit breaker)

- ECS service deployment: minimum healthy 100 %, maximum 200 %, deployment circuit breaker **with rollback on**, ALB health check on a deep readiness endpoint (database reachable, migrations at expected version; no PHI in the response). Deregistration delay long enough to drain SSE connections; clients reconnect with `Last-Event-ID` (ARCHITECTURE 5.4).
- Order: migrate → worker → api → portals (origin switch) → marketing site (separate pipeline step, no PHI) → smoke → observation.
- Why not blue/green with CodeDeploy for R1: more moving parts and no load or risk that justifies it yet. Revisit if the observation window shows slow detection. (Recommendation.)
- **Estimated duration** (not measured): rolling deploy of api and worker 8–15 minutes; with migration and smoke checks, 20–30 minutes total. Replaced by measured values after the first staging deploys.

### 9.2 Observation window and abort thresholds (proposed; the G3 package states final values)

30 minutes after the last stage for a normal release; 4 hours with enhanced watching for a release containing a migration or a change to authentication, audit, booking or prescribing. Abort and start the approved recovery when any of the following holds for 5 consecutive minutes: error rate above 1 % of requests; p95 API latency above 1 s; any failed health check after circuit breaker settles; audit write failures above zero; booking invariant violation; alert-delivery latency above the escalation window; queue age above 5 minutes. These are starting values and must be set against the staging baseline before G3.

### 9.3 Rollback (application) and recovery (data)

| Situation | Action | Notes |
| --- | --- | --- |
| Rollout fails health checks | ECS circuit breaker returns to the previous task definition | Automatic, inside the approved plan |
| Defect found during observation, no schema change | Redeploy previous digests from the previous manifest; switch portal prefix back | A pipeline job, only inside the approved recovery section of the G3 plan |
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

1. Restore the latest automated backup, and a PITR time chosen at random within the last 7 days, into a fresh instance in `restore-test`.
2. Run: schema version, catalogue/RLS checks (5.2), row-count and checksum comparison on sampled tables against the source's reported counts, **audit anchor chain verification** to the restore point (ARCHITECTURE 6), application read-only smoke through the real image pointed at the restored instance.
3. Record restore duration, data age at restore (measured RPO), and failures. Destroy the target and its snapshots. Access to the target equals production access.
4. Failures open a tracked finding; two consecutive failures stop releases until fixed.

### 10.4 Rehearsals before go-live (DEP-16)

| Rehearsal | When | Environment | Pass condition |
| --- | --- | --- | --- |
| Multi-AZ database failover | Before R1 | Production-equivalent configuration | Failover time recorded; API recovers without manual action; no lost committed transactions |
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
| Backup health | No successful backup in 26 h; cross-Region replication lag above 10 min (expect 15 min target); S3 RTC replication failures; restore test failed | Page / ticket | Backup runbook |
| Certificate / domain | Expiry < 21 days | Ticket | |
| Security | GuardDuty high findings; WAF block spikes; CloudTrail changes to logging or policies; root login; break-glass role use; Workspace super-admin / OU changes (C3) | Page security contact | Security runbook |
| Cost | Forecast above budget threshold; SMS and video spend vs plan | Ticket to owner | Section 13 |
| Deployment | Release workflow failure, migration failure | Page the releasing engineer | 9.3 |

**Paging channel (Open, owner decision D-29):** alarms go to SNS. Until a rota and paging service are chosen, delivery is SNS email to the named on-call people, and **delivery is tested** before go-live (a test alert that a named person acknowledges). A dedicated on-call service is recommended for rotation and escalation; its price is unverified and falls under the tooling line in ARCHITECTURE 10.1 (US$100–600/month). I will not select a paid service without that decision.

### 11.4 Synthetic checks

CloudWatch Synthetics canaries every minute against a shallow health endpoint and a PHI-free journey (load sign-in page, `GET /public/v1` slot lookup) for each host; certificates and DNS checked. **No canary writes data in production** (no synthetic bookings or patients) unless the owner approves a labelled synthetic tenant; write journeys run in staging.

## 12. Limits and capacity guards

| Item | Limit | Why |
| --- | --- | --- |
| `api` max tasks / pool | 8 / 20 connections each + 1 `LISTEN` | Keeps total ≈ 230 connections, below 60 % of `max_connections` (ARCHITECTURE 9.2); alarm at 70 % |
| `worker` max tasks / pool | 4 / 10 | Same |
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
| GitHub plan (organisation, Team) | 12 | 20 | 40 | 3–10 seats × about US$4 (**Unverified**, recalled list price) |
| GitHub Actions minutes beyond the plan's included minutes | 0 | 40 | 150 | About 8,000–20,000 Linux minutes/month (150 PR runs × 25 min, 100 main builds × 30 min, nightly e2e) less included minutes; per-minute price **Unverified** |
| Paging / on-call service | 0 | 40 | 150 | Per-user price of a paging product × 2–6 on-call people (**Unverified**); 0 if SNS email only (weak) |
| SAST, secrets, dependency, container scanning | 0 | 0 | 0 | Open-source tools run in CI. SonarQube is not selected (14) |
| Extra observability (log volume, canaries, traces) | 100 | 250 | 500 | Inside ARCHITECTURE "cloud infrastructure" and "tooling" lines; shown for visibility, **not additive** to the G1 total |
| **Additive to G1 total** | **12** | **~100** | **~340** | Within the G1 "Tooling" line of 100 / 300 / 600 |
| Load test day (scaled `loadtest` environment) | 100 | 150 | 250 | Derived from the G1 infrastructure figure (staging ≈ 30–40 % of production; a 1.5 × production-sized day) per test day; **Estimate** |
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
| **OWASP ZAP baseline** | **Selected** | Staging only, passive, synthetic accounts | Target is our staging; no third party | US$0 | |
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

`RELEASE-REVIEW.md` (independent Release Reviewer), `DEPLOYMENT-PLAN.md`, `ROLLBACK-RUNBOOK.md`, `OPERATIONS-HANDOFF.md`, containing: manifest hash; migration list and a statement of N-1 compatibility test result; backup freshness and the latest restore test result; load-test and pen-test status for this release (NFR-16, DEP-13); BAA register complete for every vendor that receives PHI (NFR-19); on-call rota and tested alert delivery (DEP-15); abort thresholds and observation window (9.2); named people for every action and their access; timing, expected user impact, and communication scope; unresolved findings and suppressions; GitHub-side enforcement status (4.1).

### 15.3 What the pipeline must refuse (production)

Refuse if: the manifest digest differs from the approved one; an image signature or SBOM is missing; a required check on the commit failed or is stale; the environment lock is held; the G3 reference is absent; a snapshot or backup freshness check fails; or the previous release's manifest is not available for rollback.

## 16. Decisions and actions this plan needs from people

| # | Item | Owner | Blocks |
| --- | --- | --- | --- |
| 1 | GitHub plan and organisation move (4.1); a separate human approver and agent identity | Owner | Any claim that checks, reviews or release locks are enforced |
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

Preconditions: infrastructure and the admin pool exist from IaC; identity tables migrated; **two named human custodians** (not the person being enrolled twice and not the same person; if only one human exists this runbook cannot run, see 16 item 2); two security keys per future admin purchased and stored; the GitHub environment `bootstrap-<env>` has the two custodians as required reviewers with self-review prevented.

1. Custodian A starts `bootstrap.yml` (manual, input: environment, two named persons, ticket reference). Custodian B approves in GitHub. The job's role may only call the bootstrap function, nothing else.
2. The bootstrap task (one-off ECS task, the release image digest, a dedicated role) creates two admin principals and two person records, and issues **two single-use enrolment tokens** valid for at most 30 minutes, each bound to one person. It writes the audit events through the worker path, not through a migration. Tokens are never printed to the workflow log.
3. Tokens reach the two persons **out of band** (in person or an approved secure channel chosen by the custodians; not email, chat, or task comments).
4. Each person enrols a roaming security key with user verification on the admin sign-in path. Each also enrols a second key held separately.
5. Verify: both can sign in and obtain an elevation grant; the audit trail shows creation, token issue, token use, enrolment; tokens are consumed and cannot be reused; the bootstrap role cannot be assumed any more (trust policy reverts to deny, by IaC).
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
- GitHub controls cannot be configured or tested on the current plan; environment protection on a private repository is unverified.
- Not legal advice. Retention, breach clocks and BAA coverage need counsel.
- This plan is not reviewed by the Solution Architect Reviewer and not approved at G2.

## 18. Revision manifest

| Item | Identifier |
| --- | --- |
| This document | HEAAA-16 document key `devops-plan`, draft 1; repo `docs/DEVOPS-PLAN.md` on branch `HEAAA-16-sdlc-devops-plan-plan-environments-ci-cd-backup-observability-and-recovery` |
| ARCHITECTURE | HEAAA-11 `architecture` rev `f2d240e4-2f63-45a1-aaa1-16a1f8854c32` |
| PRD | HEAAA-11 `prd` rev `bba336f3-e934-4dbb-9158-0909fda132d7` |
| SHARED-BOUNDARIES | HEAAA-12 `shared-boundaries` rev `0fffc85d-c3cd-4bad-a7f3-4f774fbbbf5a` |
| Intake pack | Revision 2, commit `6ea01b5` |
| Evidence date | 2026-11-04 |

## 19. Next permitted action

The Solution Architect Reviewer (`338c0bb5`) reviews this exact revision (review round 1 of 3). Afterwards DevOps cannot implement any pipeline: HEAAA-17 aligns the design revisions and the Delivery Planner includes this plan in the G2 package. Implementation, installs, workflow files, IaC and credentials all wait for a valid G2.
