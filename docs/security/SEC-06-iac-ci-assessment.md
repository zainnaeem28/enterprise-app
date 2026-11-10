# SEC-06 Security assessment: IaC, CI trust and release controls

Ticket HEAAA-115 (SEC-06), lane HEAAA-25, requirement NFR-15. Assessor: Cybersecurity. Date of the evidence: 2026-11-10.
Scope: static and read-only assessment. No code, workflow, infrastructure or GitHub setting was changed. Nothing was applied, deployed or contacted in AWS (the repository has no AWS credential and the agent has no AWS identity).

## 1. Revisions assessed

The artefacts under assessment are not on `main` (origin `main` is `6ea01b5`, intake documents only). They live on two ticket branches, so I assessed a scratch merge of them:

| Ticket | Branch tip | What it contributes |
| --- | --- | --- |
| DO-04 (HEAAA-87) | `1ffd306` (local branch, includes review fixes S1/S2; origin has `65d3be0`) | `infra/modules/ci-trust`, `infra/modules/secrets`, `infra/modules/identity`, `infra/approvals`, `infra/accounts/management` SCPs |
| DO-06 (HEAAA-97) | `1633b7b` (origin) | `.github/workflows/{ci,build-release,deploy-staging,deploy-production,deploy-marketing}.yml`, `.github/{CODEOWNERS,ACTIONS-ALLOWLIST.md,dependabot.yml}`, `scripts/{ci,release,deploy}` |
| Assessed tree | merge of the two, `be659d4` (scratch worktree, not committed to this branch) | Merges without conflict. DO-06 carried `65d3be0`, so DO-04's later fixes were added by the merge |
| Context only | DO-09 (HEAAA-113) `f28b637` | `infra.yml` (consumer of `gh-ci-plan` and `gh-tf-*`), read for finding F05 only, not assessed in full |

Design basis: DEVOPS-PLAN 4.1, 7 (7.1 to 7.5), 15.3 (G2 candidate revision, `design-align` `ea043d8d`).

## 2. Checks run (tool, command, result)

| # | Check | Command / method | Result |
| --- | --- | --- | --- |
| C1 | GitHub-side enforcement state, read-only | `gh api repos/zainnaeem28/enterprise-app/...` (GET only), managed token, 2026-11-10 | See section 3 |
| C2 | Workflow hygiene (SHA pins, allow-list, permissions, no swallowed failures) | `node scripts/ci/check-workflow-hygiene.mjs` on `be659d4`, Node v24.22.2 | `5 file(s) checked against 3 allowed action(s), no violations` |
| C3 | Deploy policy scan | `node scripts/deploy/policy-scan.mjs` on `be659d4` | `3 workflows and scripts/deploy checked, no violations` |
| C4 | Manual code review of `ci-trust` (`main.tf`, `locals.tf`, `policies.tf`, `variables.tf`), `infra/approvals`, management SCPs, the five workflows, `aws-login.sh` (two copies), `verify-release.mjs`, `lib/record.mjs`, `lib/manifest-check.mjs`, `run-migration.mjs`, `without-oidc.sh`, `without-cloud.sh` | Reading, against DEVOPS-PLAN 7.x and 15.3 | Findings F01 to F12 |
| C5 | Reproduction of the wrapper bypass (F01) | A bash process holding a fake `ACTIONS_ID_TOKEN_REQUEST_TOKEN` runs the repository's real `scripts/release/without-oidc.sh` around a child that reads `/proc/<ppid>/environ`; same for `without-cloud.sh` with a fake `AWS_SECRET_ACCESS_KEY` | Child's own env: token length 0 (wrapper works as designed). Parent step shell's environ: token length 21 (readable). `without-cloud.sh`: secret present in parent environ (grep count 1). Simulation on this host, not on a GitHub runner |
| C6 | `tofu test` plan tests of the modules | Not run: `tofu`, `terraform` and `tflint` are not installed in this environment and no AWS provider access exists | **Not executed.** The `plan.tftest.hcl` assertions were read, not run. Assessment of policies is from the HCL source, not from rendered JSON |

Limitations: no dynamic probing, no AWS evaluation (IAM policy simulator, Access Analyzer), no rendered policy JSON, GitHub runner behaviour (for example environment variable inheritance) is inferred, not observed. Items marked **Unverified** need the staging proofs that DEVOPS-PLAN 7.5 already requires.

## 3. GitHub-side enforcement state, as found (2026-11-10)

Repository `zainnaeem28/enterprise-app`: private, owned by a **User** account, default branch `main`. Matches the 2026-11-04 findings in DEVOPS-PLAN 4.1; nothing has improved.

| Control | Found | Evidence (GET) |
| --- | --- | --- |
| Branch protection on `main` | **None possible on this plan**: 403 "Upgrade to GitHub Pro or make this repository public" | `/branches/main/protection`; the branches sampled (`/branches?per_page=3`) have `protected:false` |
| Rulesets | **403, same message** | `/rulesets` |
| Environments | **0 exist** | `/environments` -> `total_count 0`. All workflows reference `build`, `staging`, `production`, `marketing-*`, `infra-plan`, `production-infra` etc. A workflow that names an environment creates it on first run, **unprotected** |
| Environment required reviewers / prevent self-review / branch policy | Not available (no environments; paid plan, per DEVOPS-PLAN) | n/a |
| Actions policy | **All actions allowed**, SHA pinning **not required** | `/actions/permissions` -> `{"enabled":true,"allowed_actions":"all","sha_pinning_required":false}`; `/actions/permissions/selected-actions` -> 409 "All actions and workflows are allowed" |
| Default `GITHUB_TOKEN` | **Read** (good), workflows cannot approve PRs (good) | `/actions/permissions/workflow` -> `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false` |
| Fork PR approval | Not applicable to private repository | 422 |
| Collaborators | **One**: `zainnaeem28` (admin). Human approver, repository owner and the login the agents use are one identity | `/collaborators` |
| Secrets / variables | 0 repository secrets, 0 repository variables (so no deploy credential is stored in GitHub: good, and no `DEPLOY_*_ENABLED` variable is set: every deploy workflow would refuse) | `/actions/secrets`, `/actions/variables` |
| OIDC subject claim | **Default, not customised**: `use_default:true`, `use_immutable_subject:true`, prefix `repo:zainnaeem28@194086586/enterprise-app@1441032882` | `/actions/oidc/customization/sub` (see F07) |
| Code scanning / Dependabot alerts | Not enabled | 403 on both |
| CODEOWNERS | In the DO-06 branch only: one line `* @zainnaeem28`; not on `main`; unenforceable without rulesets | `.github/CODEOWNERS` |
| Workflows on the remote | 9 registered, all from `ci/*` and other feature branches (`axe-*`, `probe-*`, `site-*`, `foundation-proof`, `ci`, `build-release`). None of `.github/` exists on `main` | `/actions/workflows`; `git ls-tree origin/main` |

Consequence, stated plainly: **nothing in GitHub prevents a direct push to `main`, a merge without checks, a self-approval, or a new workflow file on any branch from running with any `permissions` it declares.** The remote already shows that last point happening (workflow files authored on `ci/*` branches ran on push). Every GitHub-side control in DEVOPS-PLAN 4.1 A1 is currently procedural. This is DEVOPS-PLAN's "Fallback B", confirmed. Under it the only control that holds is the AWS-side deny by default (approval-by-apply), which is assessed next. The G3 field "GitHub-side enforcement status" must record this table.

## 4. Assessment against the acceptance points

### 4.1 Trust policies (OIDC)

Holds, by reading `locals.tf`/`main.tf`:
- A role without its record gets a single unconditional `Deny sts:*` for `Principal AWS "*"` and no Allow (`locals.tf` `trust`). Default `records = {}` therefore leaves all 12 catalog roles unassumable. Good, and fail-closed.
- An enabled role requires `aud = sts.amazonaws.com`, a `sub` pattern with repository, environment, ref and `job_workflow_ref` of one workflow file, and `aws:CurrentTime` between `not_before` and `expires` of **its own** record. Expiry reverts to deny without action.
- `refs/heads/main` only, except `gh-ci-plan` (also `refs/pull/*/merge`, see F05).
- Session lengths are bounded (1 h to 5 h). Records have bounded windows and `precondition`s enforce the dual approvals and applier-is-not-sole-approver rule (as data, see F08).

Gaps: F05, F07, F08, F09 (conditions identify a workflow, not an approval; with no environment protection any write-token holder can satisfy them, as DEVOPS-PLAN 7.1 states).

### 4.2 Approval-by-apply

Design is sound in the part AWS enforces: roles stay denied until a human with `platform-admin-apply` applies the record, and nothing in a `gh-*` role policy can write `/approved/*` (explicit deny in the role policy and in the boundary, `NoApprovalsRecordWrites`) or touch the approvals state bucket or key (`NoApprovalsStateOrKey`). Weak or missing parts:
- The approvals state bucket, the approvals KMS key, the SSM record KMS key and its key policy are **inputs only** (`infra/approvals/variables.tf`); no IaC in the repository creates them, and `infra/approvals-staging` does not exist. The claim "key policy limits writes to platform-admin-apply" cannot be verified (F08).
- "Two distinct approvers", "approver is not the author" and `applier` are free-text strings in a PR (F08). With one GitHub login and no rulesets the dual-control records (`audit-archive`, `bootstrap-*`) are an attestation by typing two names.
- The SCP that is supposed to back the whole design is not the approved design (F02).

### 4.3 Role denial (permission boundary, deny list, per-role policies)

Verified by reading: every `gh-*` role gets the same `deny_common` (no IAM write except service-linked roles, no `RegisterTaskDefinition`/`Deregister`/`ExecuteCommand`, no `/approved/*` writes, no approvals bucket/key, no `Get/Put/BatchGetSecretValue`, no `cognito-idp:Admin*`) in both the role policy and the boundary; `PassRole` only to named roles with `PassedToService`; migration/bootstrap/restore/audit roles can `RunTask` only on one pinned task-definition ARN with an `ecs:cluster` condition; `gh-recover-production` has no `RunTask`; an unset ARN input drops the statement (grants nothing); the 10,240-character inline limit is a precondition. These are good.

Gaps: F03 (Terraform roles can run any task), F04 (resource-policy and exposure actions), F11 (policies lack what the workflows need).

### 4.4 Workflow permissions

All five workflows declare `permissions: {}` at the top and per-job minimums; `id-token: write` appears only in jobs that name an environment (enforced by `policy-scan.mjs`); deploy workflows are `workflow_dispatch` only, gated by a `DEPLOY_*_ENABLED` variable and a `refs/heads/main` check; `ci.yml` has no `id-token`, no secrets, no cloud login; `persist-credentials: false` on every checkout; no `pull_request_target`; the three actions used are SHA-pinned and allow-listed; the observation job is read-only with `contents: read` and `id-token` only, and `scripts/deploy/lib/aws.mjs` also refuses non-read verbs when `DEPLOY_READ_ONLY=1`. Dispatch inputs reach shells only through `env:`. Gaps: F01, F06, F10.

### 4.5 Actions policy

Technical control on any plan: `check-workflow-hygiene.mjs` (SHA pin, allow-list, timeouts, no swallowed failures, no `pull_request_target`) runs in `ci.yml`, passed on the assessed tree. GitHub's own layer (allow-list, "require full-length SHA") is **not set** (section 3). Because CI itself is the only enforcer and `.github/` and `scripts/ci` have no protected path, a change that edits the checker can pass its own check (F09).

## 5. Findings

Severity: High = enables an unreviewed party to obtain production-affecting credentials or defeats a designed control; Medium = weakens a designed control or leaves a stated control unbuilt; Low = hardening or correctness. "Blocks" says what must be fixed before the stated activation, not before authored-disabled files are merged.

| ID | Sev | Title | Owner | Parent (originating ticket / lane) | Blocks |
| --- | --- | --- | --- | --- | --- |
| SEC06-F01 | High | Dependency scripts can read the OIDC request token and AWS session despite the env-stripping wrappers | DevOps | DO-05 HEAAA-89 (build-release), DO-06 HEAAA-97 (marketing) | Enabling the `ci` record for `gh-build`; enabling `marketing-*` records |
| SEC06-F02 | High | Implemented control-plane SCP is the withdrawn role-name design, not DEVOPS-PLAN 7.5 | DevOps | DO-01 HEAAA-83 | Attaching any SCP; applying any record in `production`, `tooling`, `staging` |
| SEC06-F03 | High | `gh-tf-*` and `gh-rehearsal-staging` can `RunTask`/`UpdateService` on any task definition, bypassing the pinned-task and dual-control records | DevOps | DO-04 HEAAA-87 | Applying the `infra`, `staging-infra`, `staging-rehearsal` records |
| SEC06-F09 | High | GitHub-side enforcement absent; approver, author and agent token are one identity | DevOps (G2 configuration) with Product Manager (plan and identity decision) | DO-04/DO-06; lane HEAAA-25 | G3 for any environment; applying any production-affecting record |
| SEC06-F04 | Medium | `infra`-record roles can create persistent exposure (resource policies, key policy and grants on PHI keys, snapshot sharing) | DevOps, decision by Solution Architect | DO-04 HEAAA-87 | G3 package must record accept or fix |
| SEC06-F05 | Medium | `gh-ci-plan` assumable from unreviewed PR code in all accounts, reads all workload state, and PR-controlled HCL runs with its credentials | DevOps | DO-04 HEAAA-87; consumer DO-09 HEAAA-113 | Enabling `INFRA_PLAN_ENABLED` / the `ci` record for `gh-ci-plan` |
| SEC06-F06 | Medium | Deploy-time refusals of 15.3 not implemented: signature and provenance are read from the manifest, not verified; required checks not checked | DevOps | DO-06 HEAAA-97 | Enabling `deploy-staging`/`deploy-production` |
| SEC06-F07 | Medium | OIDC `sub` claim: repository setting is the default immutable form; the trust template expects a customised form and a mutable repository name | DevOps | DO-04 HEAAA-87 | Staging proof of any role; fail-closed until then |
| SEC06-F08 | Medium | Approvals-root dependencies (state bucket/key, record key and key policy, staging instance) are not authored; approver identities are free text | DevOps | DO-04 HEAAA-87 | Applying the approvals root |
| SEC06-F10 | Low | Run bodies still interpolate `vars.*` and step outputs; policy scan checks only `inputs`/`github.event` | DevOps | DO-06 HEAAA-97 | None |
| SEC06-F11 | Low | `gh-deploy-*` policies lack the S3, CloudFront, RDS snapshot and SSM write actions the workflows call; first run fails closed and invites an unreviewed widening | DevOps | DO-04 HEAAA-87 / DO-06 HEAAA-97 | Staging proof (functional) |
| SEC06-F12 | Low | `ci` record (8,760 h, one approval) keeps `gh-build` live for a year; the KMS signature then proves "built from `main`", not "reviewed" | DevOps, Security Reviewer to confirm | DO-05 HEAAA-89 | None; informs G3 text |

No code was changed; routing is by this table. The Orchestrator should open correction tickets for the four High findings (blocking, per the ticket rules: they do not depend on SEC-06 and block it and its consumers until fixed, independently reviewed, retested and integrated) and decide whether Medium findings ride with them. See section 6 for the correction round.

### SEC06-F01 (High): the stripped-environment wrappers do not stop a dependency script from obtaining credentials

**Where.** `scripts/release/without-oidc.sh`, `scripts/deploy/without-cloud.sh`; used in `.github/workflows/build-release.yml` (steps "Install dependencies", "Release scripts tests", "Build packages", "Portal bundles") and `.github/workflows/deploy-marketing.yml` ("Install and build the site").
**What.** The wrappers `exec env -u ...` so the child's own environment lacks the OIDC request variables and AWS keys. The *parent* step shell still holds them in its environment (the runner injects them into every step of a job with `id-token: write`; the marketing job exports the AWS session to `$GITHUB_ENV` before building). A package install or build script runs as the same user and can read `/proc/<ppid>/environ`. Reproduced in C5: own env 0, parent environ readable. The build-release "probe" step only checks the child's own env, so it cannot detect this.
**Impact.** `build-release` on `main`: a malicious or compromised dependency (or any code run by `pnpm build`) obtains `ACTIONS_ID_TOKEN_REQUEST_TOKEN/URL`, mints an OIDC token (`aud=sts.amazonaws.com`, environment `build`, `ref=refs/heads/main`) and assumes `gh-build` while the `ci` record is live: push images, sign with the release KMS key, write the release manifest store. `deploy-marketing`: the marketing session (bucket write, cache invalidation) is readable by the build. The invariant stated in the file comments ("a dependency's install script cannot read them") does not hold.
**Fix direction.** Do not rely on environment stripping in a job that holds the capability. Split into (a) an unprivileged job (`permissions: contents: read`, no `id-token`, no environment) that installs, builds, scans and uploads the artefacts, and (b) a privileged job that downloads the artefact and runs only fixed, reviewed scripts that execute no dependency code. For marketing, assume the role after the build step and in a separate job. Replace the probe with one that proves the parent-environment case in the unprivileged job (no `id-token` permission at all).
**Retest.** Re-run C5 against the split design; confirm by workflow inspection that no step that executes dependency code is in a job with `id-token: write`.

### SEC06-F02 (High): the SCP is not the approved design

**Where.** `infra/accounts/management/main.tf`, `data.aws_iam_policy_document.control_plane`; compare DEVOPS-PLAN 7.5 "Organisation SCP" items 1, 4, 5 and the design principle DPR-25.
**What.** The plan (draft 4 onward) denies, for every principal except `platform-admin-apply`, all IAM write actions **by prefix, on any resource**; `ecs:RegisterTaskDefinition`/`Deregister`; `/approved/*` writes; approvals key and state; and, in `production` only, `/<env>/faults/*` writes. The code denies seven named IAM actions **only on `role/gh-*` and `role/bg-*`**; **does not deny `RegisterTaskDefinition`**; denies key-policy changes only on keys tagged `Purpose=approvals`; denies state writes only on buckets named `*-approvals-state`; has no faults statement. This is the draft-3 name-scoped design that DPR-25 withdrew, because a role, policy or OIDC provider under another name escapes it, and because the exemption pattern (`.../aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_platform-admin-apply_*`, account and region wildcarded) could be imitated by a created role (7.5 "Why the exemption holds" depends on IAM Create* being denied to everyone else, which is absent here). `gh-*` and `bg-*` are also the names the plan says must not be relied on.
**Impact.** Task-definition registration and most IAM writes are blocked today only by each `gh-*` role's own policy and boundary (both authored here), not by the organisation guard that the plan says holds "even if a role policy is wrong". Any principal that is not a `gh-*`/`bg-*` role and has IAM write is not constrained by the SCP. Tag- and name-conditioned statements can be defeated by removing the tag (`kms:UntagResource` is allowed to `gh-tf-*`, see F03/F04) or creating a differently named bucket. The SCP is not attached by default (`attach_scps=false`), which is consistent with a not-yet-applied state but means no guard exists at all until it is.
**Fix direction.** Implement 7.5 items 1, 4, 5 as written (prefix deny with `NotResource` for `aws-service-role/*`, exemption by `aws:PrincipalArn`, `ecs:RegisterTaskDefinition`/`Deregister`, `/approved/*`, faults statement for `production` only), attach to `staging` first, run the probe the plan names (one action per prefix, one positive and one negative exemption test), then attach to the other accounts. Bind the exemption pattern to account IDs.

### SEC06-F03 (High): Terraform roles can run any task definition

**Where.** `infra/modules/ci-trust/policies.tf`: `tf_actions` contains `ecs:*` on `Resource "*"`; used by `gh-tf-staging`, `gh-tf-production`, `gh-rehearsal-staging` (`tf_statements`).
**What.** `ecs:RunTask` and `ecs:UpdateService` are therefore allowed on **every** task definition and service in the account. `deny_common` and the boundary deny only `RegisterTaskDefinition`, `DeregisterTaskDefinition`, `ExecuteCommand`. `RunTask` of an existing task definition needs no `PassRole`. The plan's task-definition pinning (7.5, DPR-19/26/28) assumes only the deploy, restore, audit and bootstrap roles can start the migration, restore, archive and bootstrap tasks, each under its own record (bootstrap and audit-archive need two approvals and expire within 24 h).
**Impact.** With one unexpired `infra` (or `staging-infra`) record, one approver, a tampered `infra.yml` on `main` (F09) can start the bootstrap task (first-admin creation), the audit-archive task, the restore task or the migration task (as `app_owner`), or point any service at any registered revision. This defeats the dual-control records and the migration pin. The migration launcher in 7.5 (28-a) limits what the migration task can do, but not the other three.
**Fix direction.** Replace `ecs:*` in `tf_actions` with the service-management actions Terraform needs, and add an explicit `Deny ecs:RunTask`/`ecs:StartTask` (and `UpdateService` on services outside the workload root, if distinguishable by tag) for `gh-tf-*` and `gh-rehearsal-staging`, mirroring how `gh-recover-production` is tested. Add a plan test asserting no Allow of `ecs:RunTask` outside the pinned-task statements, as already done for `gh-recover-production` and `gh-deploy-production`.

### SEC06-F09 (High): GitHub-side enforcement is absent and approver, author and agent are one identity

**Evidence.** Section 3. **Impact.** The control chain in 4.1 A2 relies on a CODEOWNERS review by a human who is not the author and a human apply. Today the same GitHub login is repository owner, sole CODEOWNER, sole admin and the identity the agents push with; no ruleset, branch protection or protected environment can be created on the current plan. A write-token holder can push to `main`, edit `.github/`, `scripts/ci`, `infra/approvals` and the hygiene checker, and run any workflow. The AWS-side deny holds only for as long as no human applies a record on the basis of a PR that was not independently approved.
**Required before any production-affecting record is applied.** (1) Move to an organisation on a plan with rulesets (Team at minimum) and enable rulesets on `main` requiring PR, the 5.1 checks, a human CODEOWNERS review for `.github/`, `scripts/ci`, `scripts/deploy`, `infra/` and `docs/`, no force push, no deletion; (2) a separate agent identity (machine account or GitHub App) with write to feature branches only and no admin; (3) create environments with deployment-branch policy `main`; (4) set Actions to an explicit allow-list and require full-SHA pinning; (5) a second human, or an explicit risk acceptance in the G3 package that approver, author and applier are one person (RK-5). The `.github/CODEOWNERS` file currently contains a note and one catch-all line; replace with per-path owners once (1) exists. Add `.github/**`, `scripts/ci/**`, `scripts/deploy/**` to a path that needs the human review, because CI cannot be the only check on the code that checks CI.
**Note.** This is a configuration and plan decision (DEVOPS-PLAN 16), not a code defect; under the company's autonomous-decision rule it is decided by the Product Manager with Solution Architect review and recorded in the `decision-log`, and the exact settings found are copied into the G3 field.

### SEC06-F04 (Medium): persistent exposure under an `infra` record

`tf_actions` allows `kms:Put*`, `kms:Create*` (including `CreateGrant`), `s3:*Bucket*`, `rds:*` (includes `ModifyDBSnapshotAttribute`, `ModifyDBInstance` with master password or public accessibility), `ec2:*` (security groups, `ModifySnapshotAttribute`), `ecr:*` (repository policy), `cognito-idp:*` except `Admin*` (for example `CreateUserPoolClient`). The explicit denies protect only the record, state, signing, restore and secrets keys and the state, manifest and audit buckets (`protected_key_arns`, `protected_bucket_arns`). PHI keys, PHI buckets, database snapshots and the ECR repositories are not in the list. DEVOPS-PLAN 7.5 lists this as stated residual risk and a G2 decision (detection plus plan review). The authored detection (EventBridge rules in the plan) is DO-07's (HEAAA-103) and was not assessed here. Recommendation: add the cheap denials now (`rds:ModifyDBSnapshotAttribute`/`ModifyDBClusterSnapshotAttribute` adding `restore` attributes, `ec2:ModifySnapshotAttribute`, `kms:PutKeyPolicy`/`CreateGrant` on every key tagged as PHI, `s3:PutBucketPolicy`/`PutBucketAcl`/`PutPublicAccessBlock` on PHI buckets) and record the decision on whether policy ownership moves to the approvals root.

### SEC06-F05 (Medium): plan role reachable from unreviewed PR code

`gh-ci-plan` is created in `production`, `tooling` and `marketing` (`infra/approvals/main.tf`), trusts `refs/pull/*/merge` with environment `infra-plan`, and reads **all** objects in the workload state bucket (`StateRead`) plus IAM/KMS/Secrets/SSM metadata (`iam:Get*`, `kms:GetKeyPolicy`, `secretsmanager:GetResourcePolicy`, `ssm:DescribeParameters`). The DO-09 `infra.yml` plan job then runs OpenTofu on the **PR's** HCL with those credentials. Plan evaluation executes PR-controlled configuration (providers, modules, `external` data sources), so a PR author obtains the plan role without any approval; the `ci.yml` rule "no cloud credentials on pull requests" does not apply to this workflow. State often holds sensitive attribute values. Same-repository PRs only (`head.repo.full_name == github.repository`) helps for forks, which do not exist on a private repo anyway. Recommendation: scope state read per environment and exclude production state from the PR plan role (plan production only on `main` or after approval), instantiate `gh-ci-plan` in `tooling` only, run plan in a job where PR code cannot read the credentials (the same separation as F01), and require the `ci` record to carry a short window.

### SEC06-F06 (Medium): 15.3 refusals not implemented in the deploy path

`checkManifestBytes` accepts a manifest when `images.<name>.signed === true` and `attestations` contains `sbom` and `provenance`; these are JSON fields in the manifest, not verified. No `cosign verify` or attestation check exists in `scripts/deploy` or the deploy workflows (cosign is installed only in `build-release`). Also absent: the check that the required status checks passed on the commit and are not stale, and an environment lock beyond the workflow `concurrency` group. 15.3 lists all of these as pipeline refusals. The record's `manifest_hash` still pins the exact manifest, so a different manifest is refused; the gap is that a manifest cannot be shown to be what `build-release` produced, and that G3 evidence "image signed" rests on text. Recommendation: verify the signature and attestations against the release key (`cosign verify --key awskms://...`) and compare digests with the registered task definitions in the first job; query check runs for `git_sha`; or remove the claim from the G3 text.

### SEC06-F07 (Medium): OIDC subject claim mismatch (fail-closed today)

The repository's subject setting is the default with the immutable form (`repo:zainnaeem28@194086586/enterprise-app@1441032882`). The module renders `repo:<owner/name>:environment:<env>:ref:<ref>:job_workflow_ref:<file>@<ref>` (`variable.sub_claim_template`, marked Unverified in the code). No role can be assumed until the claim is customised and the template matches what GitHub emits, so this is safe now and a blocker for the staging proof. When fixing: (a) prefer an immutable repository identity (repository ID or owner ID) over the mutable name, so a renamed, deleted and re-created repository name cannot inherit trust; (b) include `environment` only once environments are protected, otherwise it is attacker-chosen text (F09); (c) test the rendered `StringLike` against real tokens from a dry-run, including that `*` in `refs/pull/*/merge` matches only the intended ref.

### SEC06-F08 (Medium): approvals-root dependencies not authored; approvals are text

`infra/approvals` takes `approvals_state_bucket_arn`, `approvals_kms_key_arn`, `*_ssm_kms_key_arn` and three apply role ARNs as variables, and the backend is a partial configuration; no module in the repository creates these buckets and keys or their policies, and `infra/approvals-staging` is absent (the catalog already lists the staging roles). The security properties 7.5 attributes to them (only `platform-admin-apply` can read/write approvals state; record key policy limits writes) are therefore design only. `records[].approvals` and `.applier` are strings checked only for count and distinctness. Recommendation: author the approvals state bucket/key and the record key (key policy: administer and encrypt only `platform-admin-apply`, decrypt additionally the specific record-reading roles by ARN, the CloudTrail event on key use), add `approvals-staging`, and have the apply procedure compare `approvals` to the PR's recorded CODEOWNERS approvals and the Identity Center identity of the applier (evidence file, not text only).

### SEC06-F10 (Low): untrusted-looking interpolation checks cover too little

`policy-scan.mjs` rejects `inputs.`, `github.event` and `github.head_ref` inside `run:` bodies, which the workflows respect. They still interpolate `${{ vars.* }}` (about 26 places) and `${{ steps.*.outputs.* }}` into shell. `vars` are written by repository admins and step outputs here come from a verified manifest, so this is not exploitable today; any later change that feeds unverified text into an output, or a loosely scoped variable editor, makes it exploitable. Recommendation: pass them through `env:` and extend the scan to `vars.` and `steps.`.

### SEC06-F11 (Low): deploy role policies do not match the workflow's calls

`gh-deploy-staging`/`gh-deploy-production` (`deploy_statements`) allow `ecs`, `elasticloadbalancing` reads, `logs` reads, `PassRole`, and record read. The workflows also call `s3 sync/cp` to the portal bucket, `cloudfront create-invalidation`, `rds create-db-snapshot`/`describe-db-snapshots` (`backup-gate.mjs`), and `ssm put-parameter` (`set-release-config.mjs`). Run today, those steps fail (closed). The risk is the usual one: the fix will be a quick widening. Required shape: bucket-prefix, distribution, snapshot-name-pattern and parameter-name-scoped statements, each with a plan test, reviewed by the Security Reviewer.

### SEC06-F12 (Low): one-year `ci` record

`record_kinds.ci = {max_hours = 8760, min_approvals = 1}` enables `gh-build`, `gh-nightly-staging` and `gh-ci-plan` for a year on one approval. With no protection on `main` (F09) the release signature proves a workflow on `main` built the artefact, nothing about review. Not a defect by itself; state it in the G3 package and shorten the window if the plan allows (for example 90 days).

## 6. What was checked and holds (so it is not re-opened)

Deny-by-default trust (single `Deny` for roles without a record); per-record windows enforced in the trust policy; no secret or deploy credential in GitHub; `permissions: {}` and `contents: read` discipline; id-token only with an environment; manual dispatch only for deploys and an `enabled` gate that refuses by default; checkout without persisted credentials; SHA-pinned allow-listed actions; no `pull_request_target`; record, manifest, previous-manifest and action checks in `verify-release.mjs` run before any mutating step (enforced by `policy-scan.mjs`); migration run uses a pinned task-definition ARN with a regex check and no `--overrides`; `register-task-definition`, `execute-command`, IAM calls are refused by `lib/aws.mjs`; observation role and job are read-only; the PassRole boundary has a safe empty-list behaviour; the SCP's region and guardrail statements are not part of this ticket.

## 7. Review and next permitted action

Independent review stage: Security Reviewer (`074b2525`) reads the exact revision of this document and the commit named in the evidence comment. Findings above keep their IDs across rounds; the cumulative round count is kept in the ticket's `review-ledger` document (round 1 at submission, no round has been decided).

Next permitted action: Security Reviewer review of this document. In parallel the Orchestrator routes F01, F02, F03, F09 as blocking correction tickets and F04 to F08, F10 to F12 as non-blocking, to the owners in section 5. After fixes, this assessor re-validates each fix on the exact fixed revision (fix validation is a separate round, not part of this submission).
