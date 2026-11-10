# Quality-security result, Release 1 candidate `af278307f70c626e451389bd55b86aea9e4016ce` (HEAAA-30)

**Result: FAIL (evidence incomplete). Not acceptable for ACCEPTANCE or G3 until QS-01 is closed.** No code defect was found by the tools that ran. This is an AI assessment under autonomous mode, not human approval.

Candidate tree: `af27830` (docs-only changes after it are evidence). Run on a clean detached checkout, frozen lockfile (`pnpm-lock.yaml` unchanged), Linux x86_64, Node 24.22.2, pnpm 12.16.1. Tools installed from `scripts/ci/tools.lock`, sha256 verified. Raw logs are in this folder.

## Mandatory checks that ran

| Check | Tool / version | Result | Evidence |
| --- | --- | --- | --- |
| SAST | Semgrep 1.184.0, committed ruleset | pass: 1683 files, 7 non-blocking findings, 0 blocking, 0 parse errors | `sast.log` |
| Secrets (history + tree) | gitleaks 8.30.1 | pass: no leaks | `secrets.log` |
| Dependencies | OSV-Scanner 2.7.0, 795 packages | pass by policy: 3 non-blocking (QS-02) | `deps.log`, `osv.json` |
| SBOM | Syft 1.57.0 | pass: CycloneDX 1.7, 949 components | `sbom.log` |
| IaC config scan | Trivy 0.76.2 | pass: 27 targets, no blocking misconfiguration | `container.log` |
| Workflow hygiene | check-workflow-hygiene | pass: 10 workflows | `hygiene.log` |
| Lint / format / typecheck / build | eslint, prettier, tsc, `pnpm build` | pass | `lint.log` ... `build.log` |
| Unit | `run-unit.mjs` | pass: 1441 tests, 0 skipped, 0 failed, 10 reports | `unit.log` |
| Database suites | PostgreSQL 17.11 (UTF8), `integration-db.sh` | pass: 1279 tests (db-foundation 120, kernel 23, api 1015, worker 121), 0 skipped | `integration-db.log` |

Note on the database run: my first run used a SQL_ASCII cluster and failed one API test (consent title of 200 emoji, `kernel.invalid_format`). That was my environment, not the candidate; the rerun on a UTF8 cluster passed. Only the second run is reported as evidence.

## Mandatory checks that did NOT run (each is a failure under policy)

- **QS-01 (blocking, owner DevOps):** no CI run or MR/pipeline exists for the candidate or any descendant (`gh run list --commit af27830` is empty; the only open PR is #1). `ci.yml` triggers on `pull_request` to `main` only. Not executed: container image build and Trivy image scan (this host has no Docker; `container-scan.sh` exit 127), `contract` (Schemathesis), `e2e-smoke`, Lighthouse, `check-needs` / `ci-status`, observability tofu plan, `a11y-smoke`, `cms` job. N-1 and the upgrade path did not run either (no `r*` release tag; the script says so). BUILD_REVIEW condition 1 is therefore not met. I did not open a PR or push a branch: that is a shared-repository action for DevOps.

## Findings

| ID | Severity | Blocking | Finding | Owner |
| --- | --- | --- | --- | --- |
| QS-01 | High (evidence) | yes | CI evidence and image scan missing, see above | DevOps |
| QS-02 | Medium | before G3 | `minimatch@10.2.6` (GHSA-g3hv-75wg-m249, 6.9, fix available) and `yaml@2.8.1` (GHSA-48c2-rrv3-qjmp, 4.3, fix available); `deepmerge@4.3.1` (GHSA-gcqx-w48m-w2h4, 5.3, no fix). Below the CVSS 7 policy line. BUILD_REVIEW condition 4 requires routing the two with fixes. | DevOps (dependency update) |
| QS-03 | Low | no | Residual SEC-03 items still present in code (below) | Backend Engineer / Orchestrator for disposition |
| QS-04 | Info | no | Semgrep advisories: pnpm/npm `minimumReleaseAge`, `trustPolicy`, `blockExoticSubdeps` unset; two Terraform warnings in synthetic DR rehearsal stack (documented deviations) and a placeholder `offline-plan-only` key in an offline plan example (not a real secret) | DevOps |

### SEC-03 re-verification (BUILD_REVIEW condition 2), by code review plus the passing database suites

| Item | State on `af27830` |
| --- | --- |
| F08 `identity_label` | Fixed: named columns (0704:335); `identity-label.dbtest.ts` passed in the api suite |
| F13 items 1, 3, 4 | Fixed: guard check requires enabled BEFORE row trigger; `0953` column grants and `M-5-setting-grants`; `M-5-policy-tautology` (all in `db-test.mjs`, passed) |
| F13 item 5 | **Open:** no `caller_sees` parity test found |
| F10a | **Open:** `flag_staff_select` still shows a flag to staff who see either patient (0705) |
| F10b | **Open:** `patient.get_merge_request` still returns the full row (both patient IDs and the free-text reason) to any staff caller of the organisation with `patient.merge.request` |
| F11 | **Open:** `app_worker` merge re-pointing grants and policies (0802) still need only `job_scope = patients`; not tied to the merge job. The matrix test at `rls-matrix.dbtest.ts:952` exercises the withdraw path |

I did not run dynamic probes; the F10/F11 state is from reading the migrations and function bodies, not from executing the exploit statements. Recommendation: Backend Engineer fixes F10b (restrict to requester/approver and drop the reason for others) and F11 (definer functions), or the Architect records a risk acceptance for R1; F10a/F13.5 can be accepted as Low. Orchestrator routes this.

## Not covered / limits

No penetration test or dynamic probing was done (not authorised in this task). Optional quality tools were not selected at G2 and were not run. OSV and Trivy query live databases, so results can change without a code change. CISA KEV is not evaluated. Lighthouse and the browser journeys are covered only by the INT-05 round 4 evidence, not re-run here.

## Next permitted action

DevOps opens the PR / pipeline for the candidate (or its successor) and returns the CI run with image scan, contract, e2e-smoke, Lighthouse, check-needs and tofu results; Cybersecurity then reruns this assessment on that revision. Any change to the candidate invalidates this result for the changed parts.
