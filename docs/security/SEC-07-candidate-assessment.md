# SEC-07 Pre-candidate security assessment: scan results, residual risk and penetration-test scope

Ticket HEAAA-142 (SEC-07) · release R1 · milestone M6 · author: Cybersecurity (`83cd0a46`) · reviewer stage: Security Reviewer (`074b2525`)
Requirements: NFR-15, NFR-16 · DEVOPS-PLAN 5, 14.4 · PRD DEP-13 · TEST-CASES TC-NFR-07, TC-PEN-01 · Decision D-599-1 (HEAAA-599)
Date of reading: 2026-11-10 · Document revision: round 1 (cumulative round count is in the task's `review-ledger`)

## 1. Revision and method

**Assessed candidate.** `af278307f70c626e451389bd55b86aea9e4016ce` on branch `HEAAA-141-sdlc-ticket-int-05-...` (INT-05 round 4). Its evidence commit is `3cb45ed`, which touches only `docs/evidence/integration/R1/round4/` since `af27830`. Product tree and evidence were read from a `git archive` of `3cb45ed`. The INT-05 ledger reports 4 rounds and no unresolved finding; QA reviewed this revision (PASS, scoped).

**What I did.** Read the raw reports in `gates/` (`sast.txt`, `deps.txt`, `sbom.txt`, `secrets*.txt`, `exit-codes.txt`) and the manifest. Read the tree for the D-599-1 conditions, the Dockerfiles, CI workflows and the OpenAPI external surface. Read my earlier assessments SEC-02..SEC-06 and SEC-08 and the SEC-05 re-read for carried items.

**What I did not do.** I ran no scanner. Semgrep, OSV-Scanner, gitleaks, syft and Trivy are not installed in this environment, and the INT-05 run already produced the reports. I did not re-execute any test. I did no dynamic probing, made no network call, and changed no product code. The only file written is this document.

**Tools and versions (from `manifest` and `scripts/ci/tools.lock`, not independently verified here):** semgrep 1.184.0, osv-scanner 2.7.0, gitleaks 8.30.1, syft 1.57.0, trivy 0.76.2 (pinned, not run for images), CI=true, 1683 files, 795 npm packages, lockfile sha256 `9688c96f…442d2`.

## 2. Verdict

**CHANGES REQUIRED before G3. No finding blocks the penetration test planning, and none is a Critical or High.** The runnable scans are clean of blocking results. The assessment is limited: the container image scan, the `contract` and `e2e-smoke` jobs, and Lighthouse could not run, so the NFR-15 gate set is not evidenced as a whole. Two Medium findings are open (SEC07-F01, F02). This is not G3, human approval or deployment approval.

## 3. Raw reports read and classified

| Scan | Raw report | Result | Classification |
| --- | --- | --- | --- |
| SAST (semgrep) | `gates/sast.txt` | 1683 files, 7 findings, 0 blocking | 7 triaged below: 4 package-manager hardening (F03), 3 Terraform (F05) |
| Dependencies (OSV) | `gates/deps.txt` | 795 packages, 3 vulnerabilities, 0 blocking | Triaged below (F04) |
| Secrets (gitleaks) | `gates/secrets.txt`, `secrets-HEAD.txt`, `secrets-final-rerun.txt` | Full history 479 commits, working tree: no leaks | **Clean.** The first run preceded the `next build` output; the rerun after removing it also passed |
| SBOM (syft) | `gates/sbom.txt` | CycloneDX 1.7, 949 components (795 npm) | Count only. The SBOM file is not in the evidence set (F06) |
| Container image (trivy) | none | **Not run** (no Docker daemon) | Gap (F01) |

### 3.1 SAST triage (7 findings)

| Rule and location | Disposition | Reason |
| --- | --- | --- |
| `npm-missing-minimum-release-age` at `.npmrc:1` | Valid, Low (F03) | No cool-down on newly published packages |
| `pnpm-block-exotic-sub-dependencies` at `pnpm-workspace.yaml:1` | Valid, Low (F03) | The setting is absent |
| `pnpm-minimum-release-age` at `pnpm-workspace.yaml:1` | Valid, Low (F03) | Same as the first |
| `pnpm-trust-policy` at `pnpm-workspace.yaml:1` | Valid, Low (F03) | No trust policy for downgraded publish provenance |
| `aws-db-instance-no-logging` at `infra/modules/dr/rehearsal/main.tf:105` | Accepted deviation with a condition (F05) | Documented in the file: synthetic, short-lived restore rehearsal |
| `aws-rds-backup-no-retention` at `infra/modules/dr/rehearsal/main.tf:105` | Same as above | `backup_retention_period = 0`, `skip_final_snapshot = true`, destroyed after the rehearsal |
| `aws-provider-static-credentials` at `infra/modules/observability/examples/plan/main.tf:22` | **False positive** | Literal `offline-plan-only` values with `skip_credentials_validation`: an offline `plan` example. No real key, and gitleaks found none |

The false-positive disposition rests on the file content I read (lines 15-30 of the example). The Security Reviewer should confirm it.

### 3.2 Dependency triage (3 vulnerabilities)

| Package | Advisory | Where it comes from | Disposition |
| --- | --- | --- | --- |
| `deepmerge@4.3.1` | GHSA-gcqx-w48m-w2h4, 5.3, no fix | Runtime dependency of the CMS (`payload`, `pnpm-lock.yaml:7122`) | Valid, Low (F04). Prototype poisoning needs attacker-controlled input to `mergeObject()`; the CMS merges its own configuration. Needs the CMS reachability check and an expiry |
| `minimatch@10.2.6` | GHSA-g3hv-75wg-m249, 6.9, fix available | Lint and type tooling (`eslint`, `typescript-estree`, `@eslint/config-array`) | Valid, Low (F04). Build time only, not in the API or worker image path. Update when convenient |
| `yaml@2.8.1` | GHSA-48c2-rrv3-qjmp, 4.3, fix available | `packages/contracts` devDependency (contract generation) | Valid, Low (F04). Dev only, trusted input |

I did not check reachability by running anything. The runtime-versus-dev split is from `pnpm-lock.yaml` and `package.json`.

## 4. D-599-1 conditions (exclude `sharp` and `@img/sharp-libvips-linux-x64`)

My position on the decision (CONFIRM, comment on HEAAA-142 of 2026-11-10) stands. Checking the four conditions I set, on `af27830`:

| # | Condition | Result | Evidence |
| --- | --- | --- | --- |
| 1 | No `sharp` or `@img/*` in the lockfile or the image | **Met for the lockfile.** Not shown for the image SBOM | `grep -n "sharp\|@img" pnpm-lock.yaml` returns only the `ignoredOptionalDependencies` entry (line 4150); `pnpm-workspace.yaml` lists `sharp` under `ignoredOptionalDependencies`. No SBOM file is committed (F06) |
| 2 | `/_next/image` not served; no `remotePatterns` or `domains` | **Partly met** | `apps/cms/next.config.mjs` has `images: { unoptimized: true }` and no `remotePatterns` or `domains` (grep of `apps/cms`). A request to `/_next/image` in a built container was not made (no Docker) |
| 3 | No user-controlled image URL fetched server-side by the CMS | **Met on reading** | No `fetch(`, `sharp`, `imageSize`, `resizeOptions` or `upload:` collection in `apps/cms/src` (non-test files). Static reading only |
| 4 | Licence gate on the CI SBOM step | **Not met** | No licence check in `scripts/ci/`, `.github/workflows/ci.yml` or `scripts/contracts/lint.mjs`. DEVOPS-PLAN names licences only for tool selection. See F02 |

## 5. Findings (stable IDs, cumulative; this ticket changes no code)

| ID | Severity | Finding | Owner | Parent | Blocks |
| --- | --- | --- | --- | --- | --- |
| SEC07-F01 | Medium | No container image scan has ever run on this candidate. `docker/Dockerfile.api` and `Dockerfile.worker` exist; CI (`ci.yml:249`) and `nightly.yml:67` are the only places it would run. NFR-15's image-scan gate is unevidenced | DevOps Engineer | HEAAA-25 | G3; the image the pen test targets |
| SEC07-F02 | Medium | The licence gate from D-599-1 (fail on LGPL/GPL runtime dependencies unless allowlisted by a recorded decision) does not exist. The sharp exclusion fixed one case; a new LGPL transitive would pass CI silently | DevOps Engineer | HEAAA-25 | G3 |
| SEC07-F03 | Low | Supply-chain hardening absent: no `minimumReleaseAge`, no `blockExoticSubdeps`, no trust policy (4 semgrep findings) | DevOps Engineer | HEAAA-25 | None |
| SEC07-F04 | Low | Three OSV findings, none blocking. `deepmerge` has no fix and is a CMS runtime transitive; `minimatch` and `yaml` have fixes and are dev only. Record the `deepmerge` risk with an expiry and re-scan nightly | DevOps Engineer (update), Solution Architect (accept `deepmerge`) | HEAAA-25 | None |
| SEC07-F05 | Low | The DR rehearsal RDS instance has no backups, deletion protection or logging by design. This is acceptable only while it restores synthetic data. A restore of a snapshot containing real PHI would break NFR-12/NFR-18 expectations | DevOps Engineer | HEAAA-25 | Any rehearsal that uses non-synthetic data |
| SEC07-F06 | Low | The evidence set holds summaries, not the raw tool output: no SARIF/JSON from semgrep and OSV, and no SBOM file. A reviewer cannot re-check a finding or the licence list from the repository | DevOps Engineer, Integrator | HEAAA-25 | Independent re-reading at G3 |

Not filed as findings: the 4 semgrep package-manager findings are grouped under F03; the `aws-provider-static-credentials` false positive needs no action.

## 6. Residual risk carried from earlier assessments

These were filed against earlier revisions. This ticket did **not** re-verify them on `af27830`; their owners' closure state is in the ledgers of SEC-02..SEC-06 and SEC-08, and it must be read there.

| Area | Open item | Why it matters for the pen test or G3 |
| --- | --- | --- |
| Audit archive (SEC-05 G-2) | No S3 adapter in the repo; `infra/modules/archive` not instantiated; the worker role has no writer or reader grant. Anchor puts fail closed | The tamper-evidence control cannot be tested live until closed. G3 precondition recorded in the SEC-05 re-read |
| Compliance alerts (SEC-05 G-1) | Components exist; end-to-end publish → alert → recipient not demonstrated | Break-the-glass and kill-switch alerting would be untestable by a tester |
| Identity and CI trust (SEC-02, SEC-06) | SEC06-F01 (OIDC token readable by dependency scripts), F02, F03, F09 (GitHub enforcement absent; approver, author and agent token are one identity) | Release-path and deployment controls cannot be called effective; G3 text must state this |
| Public booking and intake | Public forms depend on rate limits, bot protection and upload scanning (TC-NFR-12, TC-BS-06, TC-DOC-03). `e2e-smoke` and `contract` did not run | Part of the pen-test surface; automated evidence incomplete |

## 7. Scope of the independent penetration test (TC-PEN-01, NFR-16, DEP-13)

**This section is a proposal. The test is a human-required item.** It needs an independent tester who is not the build team and not the owner, and an authorisation that does not exist. I have not contacted a vendor, spent money or probed anything. Absence of a tester is recorded, not waived (RA-R1-18).

**Preconditions (all missing today):**
1. Owner decision on budget and tester (D-28, DEP-13): named company or person, and the amount.
2. A deployed staging environment running the frozen release candidate from a signed build. None exists; INT-05 was local with no Docker.
3. Synthetic data only. No real patient data and no production target, ever.
4. A written authorisation with window, source addresses, rate and cost limits, contacts and stop conditions.
5. SEC07-F01 and F02 and the SEC-05 G-1/G-2 items closed or explicitly accepted, so the tester is not paid to find known gaps.

**In scope (external surface of the candidate, staging only):**

| Surface | Items |
| --- | --- |
| Public API | `/public/v1/{clinicians, clinicians/{id}/next-available, locations, services}`; the unauthenticated booking request and intake form routes under `/api`; rate limit, bot protection, enumeration, input handling |
| Inbound webhooks | `/webhooks/google/calendar`, `/webhooks/messaging/{vendor}`, `/webhooks/video/{vendor}`: signature and replay checks, vendor-secret handling |
| Authenticated API | About 390 `/api` paths across identity, patient, scheduling, clinical, documents, messaging, notifications, audit, privacy, organisation, integration-core, calendar-sync and telehealth. Focus: object-level and tenant/location scope (row-level security), role escalation, patient-proxy and care-relationship rules |
| Identity | Patient sign-in, staff sign-in, admin realm, WebAuthn enrolment and recovery, session fixation and revocation, step-up elevation, second approver, kill switch |
| Clinical safety paths | Break-the-glass grants and review, banner allergies, red-flag alert path, alert acknowledgement, the SSE alert stream authorisation |
| Documents | Upload, scan states, quarantine and clean object keys, presigned URL handling, download authorisation, PHI in output |
| Web apps | Patient app, staff app, admin portal, marketing site (`apps/site`), CMS (`apps/cms`, Payload admin): XSS, CSRF, headers, CSP, clickjacking, open redirect, stored content |
| Edge and cloud | TLS, WAF and CloudFront behaviour, response headers, error pages, exposed storage or admin endpoints |

**Test accounts and roles.** Synthetic patient, proxy, front-desk, nurse, doctor, admin, compliance admin, second approver, and a cross-location staff member, plus one unauthenticated visitor. Credentials are issued by the secret store at the window start and revoked at the end. They never appear in task text, artifacts or screenshots.

**Out of scope:** production and any account with real data; denial-of-service and load beyond agreed rates; social engineering and physical access; third-party vendors' systems (Google, messaging and video providers); the build team's laptops; source-code review beyond what the tester asks for (code access is optional and helps).

**Rules of engagement.** Stop and call on any of: real personal data seen, a service-impacting action, a Critical finding, or leaving the agreed addresses. All data created is synthetic and deleted at the close. Report within an agreed time of a Critical or High.

**Deliverables and exit.** A report with method, evidence, reproduction, severity (CVSS plus business impact), and fix advice. Every Critical or High is fixed, independently reviewed, retested by the tester and integrated, with no open High or Critical at R1 production (DEP-13). Medium and below get owners or a recorded acceptance with expiry. Timing: DEP-13 states before end of May 2027 for R1, and again before R2 EPCS and before the R3 webhook release.

## 8. Limits and next permitted action

- Facts here are **read** from INT-05 reports and the tree. Nothing was executed by this ticket. Tools in section 1 ran in INT-05, not here.
- Not verified: container image contents, `/_next/image` at runtime, image SBOM, Lighthouse, N-1 upgrade, CI-side `check-needs`.
- No finding was relabelled optional to continue. F01 and F02 stay open until DevOps delivers and an independent reviewer retests.
- Next: Security Reviewer reads this exact revision. The Orchestrator then routes F01..F06 to DevOps, and requests the owner's D-28 and tester decision for the pen test (human item). This is not G3, human approval or deployment.
