# VERIFICATION-RESULTS — Release 1 combined candidate

| Field | Value |
| --- | --- |
| Candidate | `af278307f70c626e451389bd55b86aea9e4016ce`; evidence commit `3cb45ed6a64c9bac74e9f720bbad86760626a02a` |
| Branch | `HEAAA-141-sdlc-ticket-int-05-integrate-r1-release-candidate-and-run-the-complete-combined-check-set` (local only; commits reachable on `origin` via `HEAAA-27-sdlc-build-package-prepare-milestone-build-evidence-and-real-screenshots`, head `83f3bdb` at review) |
| `pnpm-lock.yaml` sha256 | `9688c96f669208aa1c8329cfdb5a04334b7c85348c495d8356d654e2916442d2` |
| Run by | Integrator, INT-05 round 4 (HEAAA-141), 2026-11-10; reviewed from raw reports by QA (HEAAA-26 PASS) |
| This task | Orchestrator compiled this file from the committed raw reports under `docs/evidence/integration/R1/round4/gates/`. **I did not re-execute the checks.** Executed ≠ verified by me; QA verified the roll-up against raw reports. |
| Environment | `CI=true`; PostgreSQL 17.11 (embedded binaries, trust auth like CI); Node 24.22.2; pnpm 12.16.1; tools pinned by `scripts/ci/tools.lock`; Chromium 156.0.8078.4; synthetic data; **no Docker daemon; nothing deployed** |
| MR / pipeline | **None exists for this candidate.** No pull request was opened for `HEAAA-141`, and GitHub Actions did not run on it (`gh run list` for the branch is empty). The only PR open is #1 (F-02 CI, HEAAA-68); #2..#7 are closed seeded-failure PRs. All results below are local runs of the same CI entry-point scripts. Branch protection and rulesets are not enforceable on this GitHub plan (`scripts/ci/README.md`), so required checks are procedural. |

## 1. Executed and passing (exit code 0, raw report committed)

| Check (CI job) | Result | Raw report |
| --- | --- | --- |
| frozen install, lint, format, typecheck, boundary, build | pass | `install lint format typecheck boundary build` |
| workflow-hygiene (actionlint 1.7.12, SHA pins, fixture isolation) | pass | `actionlint hygiene fixture-isolation` |
| unit | pass: **1441 tests, 0 failed, 0 skipped**, 10 reports (api 289, app-shell 87, cms 88, kernel 141, patient 186, site 56, staff 282, ui 172, worker 139, boundary 1) | `unit` |
| sast (Semgrep, 1683 files) | pass; 7 non-blocking findings (below) | `sast` |
| secrets (gitleaks, 478 commits + working tree) | pass, no leaks; re-run after generated output removed | `secrets secrets-HEAD secrets-final-rerun` |
| deps (OSV) | pass; 3 non-blocking (below) | `deps` |
| sbom (Syft, CycloneDX) | pass | `sbom` |
| migration-check (PostgreSQL 17.11) | pass | `migration-check` |
| migration-check seeded controls | pass: 19 of 19 caught for the stated reason | `migration-seed` |
| integration-db (`INTEGRATION_SKIP_N_MINUS_1=true`) | pass: db-foundation 120, kernel 23, api 1015, worker 121 = **1279 tests, 0 failed, 0 skipped** (full log not committed: test names trip gitleaks) | `integration-db-summary` |
| a11y-smoke (axe, desktop 1280 and phone 360) | pass 8 of 8; empty-suite guard and seeded controls pass | `a11y-smoke a11y-guard a11y-seeded` |
| staff bundle budget (gzip) | pass: initial 96887 / 122880, largest lazy 15203 / 30720, total 175073 / 196608 | `staff-bundle-gzip` |
| patient unit, bundle, Playwright journey with axe | pass 3 of 3 | `patient-unit patient-bundle patient-e2e patient-guard` |
| admin-run (real API, worker, built staff app, WebAuthn fixture) | pass 7 of 7 steps, 10 screenshots | `admin-selftest prepare-db admin-stack`, `shots/` |
| cms: typecheck, `test:db` (junit guard), `next build` | pass (local; CI job `cms` not run) | `cms-*` |
| `tofu fmt -check -recursive infra` | pass | `tofu-fmt` |

`gates/exit-codes.txt` lists every exit code including repeated attempts. Harness-only repeats (PATH, auth mode, fonts, a stale database, an inherited `DATABASE_URL` that the CMS production guard correctly refused) are explained in `INT-05-RESULT-r4.md`; none changed product code.

## 2. Non-blocking findings carried (not hidden)

* SAST (7): npm/pnpm minimum-release-age and exotic-sub-dependency/trust-policy settings (`.npmrc`, `pnpm-workspace.yaml`); `infra/modules/dr/rehearsal/main.tf` RDS logging and backup retention (rehearsal stack); static credentials in `infra/modules/observability/examples/plan/main.tf` (example plan file).
* OSV (3): `deepmerge@4.3.1` GHSA-gcqx-w48m-w2h4 (5.3, no fix); `minimatch@10.2.6` GHSA-g3hv-75wg-m249 (6.9, fix available); `yaml@2.8.1` GHSA-48c2-rrv3-qjmp (4.3, fix available). The gate blocks only CVSS >= 7 with a fix; these are below that. Disposition for the fixable two: dependency update ticket before G3 (Orchestrator to route; not a build blocker).
* SEC-03 Low/Medium items F08, F10..F13 were routed (HEAAA-181, Architect ruling HEAAA-205, later corrections); Cybersecurity's note that F08/F10/F11 outcomes and F13 item 5 were not re-verified remains **open as a verification item** for the integrated revision.

## 3. NOT run (pending, not waived). These remain blocking for acceptance and G3

| Check | Why not run | Where it must run |
| --- | --- | --- |
| Container image build and Trivy image scan | no Docker daemon | CI on the candidate or its successor |
| `contract` (Schemathesis against the running API) | no Docker (job needs the compose stack) | CI |
| `e2e-smoke` (compose stack) | no Docker | CI |
| Lighthouse (site) | not run | CI or QA |
| N-1 upgrade check and integration-db N-1 control | no release tag exists | first tagged release |
| Observability tofu validate/test | `infra/` unchanged this round; not executed | CI `infra` workflow |
| CI-side `check-needs.mjs` (ci-status) | needs a GitHub run | CI |
| Security re-validation on the integrated candidate | Cybersecurity assessments are per ticket revision, static; no active probing and no authorized target | Quality-security (HEAAA-30) |
| Full acceptance cases and end-to-end journeys across doctor, front-desk, patient, telehealth | not in build scope | QA execution (HEAAA-29) |

## 4. Blocker state

No open blocker from INT-05. All finding IDs INT05-F01..F15, INT04-F01..F11 and earlier integration rounds are closed (fix → independent re-review → rerun → recorded). No Critical or High finding is open. Security blockers were not relabeled optional. The section 3 items are unexecuted checks, not waived findings.

## 5. Review-round ledger (cumulative; not reset by native workflow state)

| Scope | Rounds used | State |
| --- | --- | --- |
| INT-05 R1 candidate | **4** (round 1 F01..F10, round 2 F11..F14, round 3 F15, round 4 clean). The third unresolved round triggered escalation; decision **D1 (HEAAA-621)** granted the bounded 4th round, recorded and reviewed | closed, no open findings |
| INT-01..INT-04 | see each integration task and `docs/evidence/integration/M2..M5`; INT-04 findings F01..F11 closed | closed |
| SEC-03 remediation | F01..F07 done; F08..F13 routed, verification pending as noted | see section 2 |
| Individual tickets | counts recorded on each ticket, not re-audited here; all 83 tickets and 53 corrections are `done`, no escalation task is open | closed, per-ticket counts unverified by this task |
| This package (HEAAA-27 documents) | round 0 of 3; independent review of these five documents is requested via the gate | open |

I could not machine-verify every ticket's round count within this task; the per-ticket counts live on each ticket. The ledger above is complete for integration and is by reference for tickets.
