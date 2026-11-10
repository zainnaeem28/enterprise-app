# Quality-security result R2, Release 1 candidate `cdc388d2a348388a23ecef00305ecf0e34fa0aa4` (HEAAA-641)

**Result: PASS for the scoped mandatory checks, with open non-blocking residuals (QS-02 low, QS-03 low, QS-04 info) and stated limits.** QS-01 is closed on this revision by CI evidence. This is an AI assessment under autonomous mode, not human approval. It supersedes R1 (`af27830`) for every part of the tree that changed (83 files in db, api, contracts, CI, infra).

Revision: `cdc388d` = integrated `3c1dbd3` (HEAAA-638) + 4 DevOps commits (HEAAA-639, DevOps Reviewer PASS round 1). Local checks ran on a clean detached checkout, frozen lockfile (unchanged), Linux x86_64, Node 24.22.2. Tools from `scripts/ci/tools.lock`, sha256 verified. Raw logs: `docs/quality-security/R2/`.

## Checks run by me on `cdc388d`
| Check | Result |
| --- | --- |
| SAST Semgrep 1.184.0 | pass: 1695 files, 7 findings, 0 blocking (same 7 as R1: pnpm `minimumReleaseAge`/`trustPolicy`/`blockExoticSubdeps` unset, 2 TF warnings in DR stack, 1 placeholder key) |
| Secrets gitleaks 8.30.1, history reachable from `cdc388d` + tree | pass: no leaks (`SECRETS_RANGE=cdc388d`) |
| Dependencies OSV-Scanner 2.7.0 (796 pkgs) | pass by policy: 1 non-blocking (`deepmerge`); `pnpm audit`: 1 low, 0 moderate/high/critical |
| SBOM Syft 1.57.0 | pass: CycloneDX 1.7, 950 components |
| IaC config scan Trivy 0.76.2 | pass: 27 targets, none blocking |
| Workflow hygiene | pass: 10 workflows |
| lint, typecheck, build | pass |
| Unit (`run-unit.mjs`) | pass: 1450 tests, 0 skipped, 0 failed, 10 reports (R1: 1441) |

## Checks I did NOT run locally (no Docker, Postgres, k6, tofu on this host); evidence is CI only
CI run [42822981701](https://github.com/zainnaeem28/enterprise-app/actions/runs/42822981701), headSha `cdc388d2…`, conclusion success, read with `gh run view` (not rerun by me): 19 jobs success, including container-scan (image build + Trivy HIGH/CRITICAL), integration-db (db-foundation 120, kernel 23, api 1041, worker 122; 0 failed, 0 skipped), migration-check, contract (Schemathesis), e2e-smoke, a11y-smoke, bundle-budget (Lighthouse), patient-e2e-a11y, admin-run, cms, sast, secrets, deps, sbom, ci-status (check-needs). I rely on the job conclusions and the test counts in the log; I did not inspect each job's raw artifacts.

## Findings (cumulative IDs from R1)
| ID | Sev | State on `cdc388d` | Owner |
| --- | --- | --- | --- |
| QS-01 | was High (evidence), blocking | **Closed for CI evidence**: CI run on the exact revision, all required jobs green. Still open elsewhere (not mine, from HEAAA-639): `infra` plan jobs (5) fail by design, INFRA_PLAN_ENABLED unset, no credentials; N-1 upgrade never exercised (no `r<N>` tag); ENV-INT/ENV-LOAD, k6 not provisioned. These remain G3/acceptance evidence gaps. | DevOps / Orchestrator |
| QS-02 | Medium, before G3 | **Closed for minimatch and yaml** (overrides, lock updated, audit clean). `deepmerge@4.3.1` GHSA-gcqx-w48m-w2h4 low, no fix: disposition in `docs/security/QS-02-dependency-dispositions.md`. Residual: reachability not analysed; it is reached only via `payload` in `apps/cms` (11 paths), advisory is `mergeObject()` prototype poisoning. Accepted as Low for R1 provided the CMS does not pass request-controlled objects into payload's merge; re-check when payload updates. | DevOps |
| QS-03 | Low | Residual SEC-03 items, db migrations 0705/0802/0803 unchanged since `af27830` (only 0905, 2500 added): **F10a open** (`flag_staff_select`); **F10b open** (`patient.get_merge_request` does `SELECT *`, so returns both patient IDs and the free-text reason to any staff caller with the permission, contradicting its own comment "nothing about either patient is returned"); **F11 open** (worker merge grants need `job_scope = patients` only, not the merge job); **F13.5 open** (no `caller_sees` parity test for the patient-scope functions). F08 and F13.1/3/4 stay fixed. Read from migrations, no dynamic probe. Recommendation: Backend fixes F10b (restrict to requester/approver, drop reason for others) and F11, or Architect records risk acceptance for R1; F10a and F13.5 acceptable as Low. | Backend Engineer / Architect via Orchestrator |
| QS-04 | Info | unchanged (pnpm supply-chain settings unset; DR stack TF warnings) | DevOps |
| QS-05 | Info (new) | Full-history gitleaks over all local refs reports 94 generic-api-key hits, all in two commits on the evidence branches HEAAA-29 and HEAAA-30 (test logs and `tests/api/platform/admin.test.mjs` fixture lines). None is reachable from `cdc388d`; ancestry and tree scans are clean. Not a candidate defect; keep those branches out of the release and confirm the strings are synthetic test values. | DevOps |

Also checked: QA-EXEC-F02 control present in code (`guard-policy.ts` writes a `denied` audit on `identity.elevation_required`; `guard.dbtest.ts:449`), covered by the passing CI database suite.

## Not covered / limits
No penetration test or dynamic probing (not authorised). Optional tools not selected at G2. OSV/Trivy query live databases, so results can change without code change. CISA KEV not evaluated. Container image scan, contract, e2e, Lighthouse, DB suites seen via CI only. Any change to the candidate invalidates this result for the changed parts.

## Next permitted action
Independent Security Reviewer reviews this R2 on `cdc388d`. Orchestrator routes QS-03 (F10b/F11 fix or Architect acceptance) and the DevOps blockers above (infra plan credentials, N-1 tag, ENV-INT/LOAD) before ACCEPTANCE/G3. The Integrator still has to carry `cdc388d` into the integrated revision the acceptance package names; if the integrated tree differs, rerun on that tree.
