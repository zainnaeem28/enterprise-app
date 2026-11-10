# INT-05 result, round 2

Candidate `320ec2a` on branch `HEAAA-141-sdlc-ticket-int-05-...`. Base: round 1 candidate `e6871fa` (INT-04 `8cb02eb` plus FE-16, DO-08, DO-09, DO-10, SEC-06). Raw reports: `gates/`. Screenshots: `shots/`. Synthetic data only, nothing deployed. This is not QA, G3 or deployment approval.

**Result: FAIL. 3 blocking findings are open (INT05-F11, F12, F13). All round 1 findings F01 to F10 are verified fixed on this candidate except where noted below.**

## Merged (in order, all reviewed; each ticket `done` with an approved review or review ticket)

HEAAA-591 `48da00e`, 592 `aa21d0b`, 593 `2a640f5`, 595 `9efdec2`, 596 `cb37276`, 597 `0e169aa`, 598 `6bf5988`, 600 `942f96e`, 603 `4a364ba` (reviewed in HEAAA-609, which also approved the combined `pnpm-workspace.yaml`), 599 `5353ae4` (licence decision record, `docs/DEPENDENCIES.md`). Decisions 594 and 604 are in the branches that implement them.

Conflict: `pnpm-workspace.yaml` between 591 and 603 only. Resolved as the exact union that HEAAA-609 approved (591 keys, then 603's `ignoredOptionalDependencies: [sharp]`). No other conflicts.

Integrator-authored change: `pnpm-lock.yaml` re-resolved (`pnpm install --lockfile-only`): `sharp@` and `@img/sharp-*` entries are absent (0 matches); overrides applied; lock passes pnpm supply-chain policy. `pnpm install --frozen-lockfile` exits 0 (F01 fixed).

## Executed

| Check (CI job) | Result | Raw report |
| --- | --- | --- |
| frozen install | pass (exit 0) | (this run, `pnpm install --frozen-lockfile`) |
| `pnpm lint` | pass (F03 fixed) | `gates/lint.txt` |
| `pnpm format:check` | **fail**, 8 files (INT05-F11) | `gates/format.txt` |
| typecheck, boundary, build | pass | `gates/typecheck.txt`, `boundary.txt`, `build.txt` |
| workflow-hygiene (actionlint, SHA pins, fixture isolation) | pass | `gates/actionlint.txt`, `hygiene.txt`, `fixture-isolation.txt` |
| unit (`run-unit.mjs`) | pass on re-run: 1441 tests, 0 skipped, 0 failed (apps/cms 88). First run: 1 failure in `@ehr/staff` (INT05-F14), passes alone 3 of 3 and on re-run | `gates/unit.txt` (first), `gates/unit-rerun.txt` |
| sast | pass | `gates/sast.txt` |
| secrets, default scan (all refs, 469 commits) | fail: 2 hits in `infra/modules/compute/examples/sg-wiring/main.tf` and `infra/modules/loadtest/tests/plan.tftest.hcl`, from commits `9a0625c` and `15c52dd` on DO-11 branches that are not part of the candidate (`git merge-base --is-ancestor` is false) | `gates/secrets.txt` |
| secrets, candidate history (`SECRETS_RANGE=HEAD`, 471 commits) | pass, no findings (F05 fixed) | `gates/secrets-HEAD.txt` |
| deps (OSV) | pass (F02 fixed) | `gates/deps.txt` |
| sbom | pass | `gates/sbom.txt` |
| container-scan | config scan not re-run for a changed tree here: exit 127, no Docker (image step cannot run) | `gates/container-scan.txt` |
| migration-check | **fail** on the secret-reference lint, `.github/workflows/ci.yml:749` (INT05-F12). The rest passes, including `X-admin-owns-nothing` and `X-extensions-allowlisted` (F06 fixed) and migrate-from-empty | `gates/migration-check.txt` |
| migration-check seeded controls | **fail**: 7 seeded defects not caught (INT05-F13) | `gates/migration-seed.txt`, `gates/seeded-migration-check.txt` |
| integration-db (`INTEGRATION_SKIP_N_MINUS_1=true`) | pass: 120 + 23 + 1015 + 121 = 1279 tests, 0 failed, 0 skipped | `gates/integration-db-summary.txt` (full log not committed: test names trip gitleaks) |
| a11y-smoke (staff) | pass 8 of 8 (F07 fixed); seeded controls pass | `gates/a11y-smoke.txt`, `gates/a11y-seeded.txt` |
| staff bundle gzip | pass: initial 96887 / 122880, largest lazy chunk 15203 / 30720, total 175073 / 196608 (F08 fixed) | `gates/staff-bundle-gzip.txt` |
| patient-e2e-a11y: bundle, Playwright journey and axe | pass 3 of 3 (F09 fixed) | `gates/patient-bundle.txt`, `gates/patient-e2e.txt` |
| admin-run: self-tests, migrate, `admin-stack.mjs` | pass, 7 of 7 steps, 10 actual-application screenshots | `gates/admin-stack.txt`, `shots/` |
| cms job: typecheck, `test:db` (7 tests, 0 skipped), `next build` | pass (F10 fixed; reproduced locally against a throwaway database, CI job `cms` itself not run) | `gates/cms-typecheck.txt`, `cms-test-db.txt`, `cms-next-build.txt` |
| `tofu fmt -check -recursive infra` | pass | `gates/tofu-fmt.txt` |
| tofu validate and test | not re-run: `infra/` is byte-identical to round 1 (`git diff e6871fa HEAD -- infra` is empty); round 1 result (12 of 13 modules pass) carries | round 1 `gates/tofu.txt` |

Redaction: one migration file name in `gates/prepare-db.txt` and `gates/migration-check.txt` is replaced by `[name redacted]` because it trips gitleaks generic-api-key (same class as INT04-F36). Nothing else was edited.

Environment notes: Chromium needed shared libraries and a fonts config from the scratch tool directory (without fonts, headings measure as hidden and the browser tests fail). The `cms` build needs `DATABASE_URL` unset (the CMS refuses it by design); my shell had it set.

## Not run (unchanged from round 1 unless stated)

Container image scan, `contract` and `e2e-smoke` (no Docker); Lighthouse; N-1 upgrade check (no release tag; migration-check prints that it did not run); tofu validate/test for `observability`; the CI-side `check-needs.mjs` aggregate (needs the Actions context).

## Findings (round 2)

| ID | Severity | Finding | Suggested owner |
| --- | --- | --- | --- |
| INT05-F11 | blocking | `format:check` fails on 8 files introduced by HEAAA-596: `apps/staff/src/app/StaffApp.tsx`, `features/admin-compliance/AdminCompliancePortal.tsx`, `features/admin-config/AdminConfigPortal.tsx`, `features/availability/AvailabilityPortal.tsx`, `features/doctor/DoctorPortal.tsx`, `features/messages/MessagesPortal.tsx`, `features/preconsult/PreconsultDesk.tsx`, `tests/e2e/smoke/bundle-gzip.mjs`. Verified: the same files pass prettier at the parent of the 596 merge and fail at the 596 tip. F04 was fixed by 592; 596 reintroduced the class. | Frontend (596 author), reviewer DevOps/Frontend Reviewer |
| INT05-F12 | blocking | The `cms` job added by HEAAA-598 runs `psql "postgres://postgres@127.0.0.1:55433/postgres"` (`.github/workflows/ci.yml:749`); the secret-reference lint rule (RDS master user in an application connection string) flags it, so migration-check fails. 598 did not run migration-check. Fix is in the workflow (for example create the role through `PGUSER`/`psql -U` or a lint-recognised service-bootstrap form), or a narrow, recorded lint exemption for the throwaway CI service. | DevOps |
| INT05-F13 | blocking | `scripts/ci/migration-check/seed.sh` adds its seeded migration as `0900_seed.sql`, which now shares version 900 with the real `0900_scheduling_schema_and_tables.sql`. Migrate-from-empty fails with `DUPLICATE_VERSION` in the throwaway copy, so 7 seeded controls (M-1, M-2, M-4-views, M-5-patient-guard, M-5-definer, EXPAND_DESTRUCTIVE, R-app-owner-no-audit-insert) are not caught for the stated reason. Not caused by round 1 corrections; this job had never run on a tree containing the scheduling migrations (INT05-F06 was the first sign). Fix: use a version number above the newest migration (computed, not hard-coded). | Backend / DevOps |
| INT05-F14 | non-blocking, watch | `apps/staff/src/features/preconsult/desk.test.tsx` "says so when offline and disables the clinical writes" failed once in the first parallel `run-unit.mjs` run (`Unable to find an element with the text: /You are offline/`); it passes 3 of 3 alone and in the second full run. HEAAA-596 lazy-loads the portals, so timing in a loaded runner is a suspect. | Frontend |
| INT05-N1 | note for Orchestrator | The default gitleaks scan covers every ref in a clone. In a clone holding the DO-11 branches (HEAAA-588 and the loadtest branch) it reports 2 `origin_verify_secret` hits in `infra/` test fixtures (synthetic value `0123456789abcdef...`). They are not in the candidate. They need the same narrow, value-pinned allowlist treatment before DO-11 is merged, otherwise `secrets` fails on the next candidate. CI scans the pushed history, so this is not a failure of this candidate. | Security / DevOps |

## Round count

This is cumulative round 2 for INT-05 (round 1: F01 to F10; round 2: F11 to F13 blocking, F14 watch). `review-ledger` updated. Two rounds; a third unresolved round would require escalation.

## Next permitted action

Orchestrator: correction tickets for F11, F12, F13 (and F14 triage) with independent reviewers. Then the Integrator merges the reviewed fixes and re-runs the affected jobs plus the full set on a new candidate. Not submitted to QA: the candidate does not pass.
