# INT-04 round 4b (verification of F20/F21 corrections)

Candidate tip `1340b9f` = r4 tip `fccc299` + F20 `370682c` (HEAAA-505, Release Reviewer PASS) + F21 `5d8a1e4` (HEAAA-506, Security Reviewer PASS, fixture design only). Clean worktree, `pnpm install --frozen-lockfile`. Raw logs: `raw/int04-r4b/gates/`.

| Check | Result |
|---|---|
| format:check | pass (F20 closed) |
| lint, typecheck, build | pass |
| unit (`scripts/ci/run-unit.mjs`) | 1334 tests, none failed or skipped; boundary pass |
| gitleaks `fccc299..HEAD` (8.30.1) | no leaks |
| admin fixture self-test (headless Chromium, `CI=true EHR_ADMIN_CI_FIXTURE=1`) | pass: enrolment chains to fixture root, sign-in verified |

Not re-run (unchanged since r4, no touched paths): integration-db, release tests, semgrep, hygiene.

## F21 remains open
The fixture exists and its guard is reviewed. There is still no script or CI job that starts the real API, database and built staff app, signs in as admin through the fixture, drives admin configuration, audit viewer and break-the-glass review, and captures screenshots. The Security Reviewer states this explicitly (HEAAA-506). Writing it is product/CI code outside the Integrator's allowed paths. So no real admin-path screenshots and no end-to-end admin run exist; INT-04 acceptance is not met. Not submitted to QA. Nothing integrated, human-approved or deployed.
