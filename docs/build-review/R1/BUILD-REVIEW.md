# BUILD-REVIEW — Release 1 milestone build, candidate decision package

| Field | Value |
| --- | --- |
| Gate | BUILD_REVIEW, Paperclip HEAAA-28 (the task text calls it "INV-27"; the live gate task is HEAAA-28) |
| Prepared by | Orchestrator, task HEAAA-27 `[SDLC:build-package]`, 2026-11-10 |
| Exact combined revision | product tree `af278307f70c626e451389bd55b86aea9e4016ce`; evidence commit `3cb45ed6a64c9bac74e9f720bbad86760626a02a`; built on local branch `HEAAA-141-sdlc-ticket-int-05-integrate-r1-release-candidate-and-run-the-complete-combined-check-set` (local only, not pushed); the commits are reachable on `origin` through `HEAAA-27-sdlc-build-package-prepare-milestone-build-evidence-and-real-screenshots` (head `83f3bdb` at review) |
| Lockfile | `pnpm-lock.yaml` sha256 `9688c96f669208aa1c8329cfdb5a04334b7c85348c495d8356d654e2916442d2` |
| Scope | G2-approved Release 1 (83 tickets, milestones M0..M5) as in `docs/TICKETS.md`. No scope added. |
| Package documents | `COMPLETED-TICKETS.md`, `VERIFICATION-RESULTS.md`, `RUN-GUIDE.md`, `APP-SCREENSHOTS.md`, this file; all at `docs/build-review/R1/` and as documents on HEAAA-28 |
| Status | **AWAITING_GATE_DECISION.** Autonomous mode: no human confirmations exist; the BUILD_REVIEW decision belongs to Product Owner Reviewer on HEAAA-28 after the Solution Architect Reviewer's document review. This package is not that decision, QA acceptance, G3 or deployment approval, QA acceptance, G3 or deployment approval. |

## 1. What is being decided

Whether the gate owner (Product Owner Reviewer) accepts candidate `af27830` as the build to carry into quality/security execution, acceptance and release planning. Accepting it authorizes those next phases only. It does not authorize release to any environment (G3, named per environment).

## 2. Summary of the build

* 83 of 83 approved tickets `done` with independent reviews; 53 correction tasks `done`; build parents HEAAA-20..26 `done`. (`COMPLETED-TICKETS.md`)
* Integration INT-01..INT-05 in dependency order, each independently reviewed; the combined candidate passes every check that can run in the build environment: install, lint, format, typecheck, boundary, build, unit 1441/0 failed, integration-db 1279/0 failed, migration check plus 19 of 19 seeded controls, a11y smoke 8/8, patient e2e 3/3, admin real-stack run 7/7, secrets clean, SAST and OSV with no blocking finding, SBOM, workflow hygiene, CMS typecheck/db tests/build, tofu fmt. QA PASS on the raw reports (HEAAA-26). (`VERIFICATION-RESULTS.md`)
* 10 real screenshots of the administrator path from the running stack, plus earlier ticket-level patient-portal captures. No mockups are presented as screenshots. (`APP-SCREENSHOTS.md`)

## 3. Blockers and dispositions

| Item | Disposition |
| --- | --- |
| INT-05 findings F01..F15, INT-04 F01..F11, INT-01..03 findings | **Fixed and closed** (fix → independent re-review → rerun). No open Critical or High finding. |
| SAST 7 and OSV 3 findings | **Non-blocking** by the gates' own thresholds; listed in `VERIFICATION-RESULTS.md` section 2. Dependency updates for `minimatch` and `yaml` to be routed before G3. |
| SEC-03 F08, F10..F13 (Low/Medium) | Routed and worked (HEAAA-181, ruling HEAAA-205, later corrections). **Re-verification on the integrated revision is open**; owner Cybersecurity in quality-security (HEAAA-30). Not relabeled optional. |
| Container image scan, contract, e2e-smoke, Lighthouse, N-1, observability tofu, CI `check-needs` | **Not run, not waived.** Blocking for acceptance/G3. They must run in CI (or equivalent) on `af27830` or its successor. |
| Security assessment on the integrated candidate | **Not done.** Existing assessments are static and per ticket revision. Pre-G3 re-assessment is required. |
| Visual evidence for doctor, front-desk, marketing site, CMS, telehealth | **Gap.** Only the administrator path is captured on the candidate. QA execution must capture the rest. |
| MR / pipeline | **None for the candidate.** No pull request was opened for `HEAAA-141` and no GitHub Actions run exists; results are local runs of the CI scripts. Branch protection and rulesets cannot be enforced on this GitHub plan, so required checks are procedural. A human may wish to require a PR plus a CI run before acceptance. |

## 4. Review-round ledger

See `VERIFICATION-RESULTS.md` section 5. INT-05 used 4 cumulative rounds with escalation decision D1 (HEAAA-621), recorded and reviewed; no loop is open and none exceeded its limit without that recorded decision. Per-ticket round counts are held on each ticket and were not re-audited in this package. These package documents: round 0 of 3.

## 5. Limitations the reviewer should weigh

1. The checks were executed by the Integrator in a Docker-less environment and reviewed by QA from raw reports; neither the QA reviewer nor I re-executed them.
2. The integration-db full log is not committed (test names trip gitleaks); only the summary is.
3. Seeded and fixture-based admin sign-in (CI WebAuthn fixture) proves the flow in CI mode only; the fixture is refused outside `EHR_ENV=ci`.
4. Nothing is deployed and no environment, credentials or release tag exist.

## 6. Next permitted actions

* **Gate owner (Product Owner Reviewer), BUILD_REVIEW on HEAAA-28:** record PASS or CHANGES REQUIRED on the exact document revisions; no confirmations are used. Changes reopen the affected reviews.
* **After acceptance (Orchestrator):** release HEAAA-29 (qa-execution) and HEAAA-30 (quality-security); the pending checks above are their entry list.
