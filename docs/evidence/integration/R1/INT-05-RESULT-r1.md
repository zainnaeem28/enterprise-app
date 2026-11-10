# INT-05 result, round 1

Candidate `e6871fa` (merge of FE-16, DO-08, DO-09, DO-10, SEC-06 on INT-04 `8cb02eb`, plus the re-resolved `pnpm-lock.yaml`). Manifest: `CANDIDATE-MANIFEST.md`. Raw reports: `gates/`. Screenshots: `shots/`. Everything ran in a clean clone (`/tmp/int05/repo`) with synthetic data. Nothing was deployed. This is not QA, G3 or deployment approval.

**Result: FAIL. The combined candidate does not pass the required check set. Ten findings are filed (below); none was fixed by the Integrator because every fix is outside the Integrator's allowed paths.**

## Executed

| Check (CI job) | Result | Raw report |
| --- | --- | --- |
| Merge of five reviewed branches | pass, no conflicts | git history |
| `pnpm install --frozen-lockfile` on the merged tree before re-resolution | **fail**: `ERR_PNPM_OUTDATED_LOCKFILE` (apps/cms has 12 deps not in the lock) | `gates/lockfile-reresolve.txt` |
| `pnpm install --frozen-lockfile` after re-resolution | **fail**: `ERR_PNPM_IGNORED_BUILDS` (esbuild 0.18.20, 0.25.12, 0.28.2); packages are installed, exit code 1 (INT05-F01) | `gates/install-frozen.txt` |
| `pnpm build` | pass (exit 0) | `gates/build.txt` |
| lint-types: `pnpm lint` | **fail**, 6 errors (INT05-F03) | `gates/lint.txt` |
| lint-types: `pnpm format:check` | **fail**, 2 files (INT05-F04) | `gates/format.txt` |
| lint-types: `pnpm typecheck`, `pnpm test:boundary` | pass | `gates/typecheck.txt`, `gates/boundary.txt` |
| workflow-hygiene (actionlint 1.7.12, SHA pins, fixture isolation) | pass (shellcheck/pyflakes not installed, so the actionlint script checks were off) | `gates/actionlint.txt`, `gates/hygiene.txt`, `gates/fixture-isolation.txt` |
| unit (`run-unit.mjs`) | pass: 1441 tests in 10 reports (apps/cms 88), 0 skipped, 0 failed | `gates/unit.txt` |
| sast (semgrep) | pass, 1677 files, 7 non-blocking findings (3 pnpm-workspace policy notes, Terraform notes) | `gates/sast.txt` |
| secrets (gitleaks full history, 443 commits) | **fail**, 15 findings (INT05-F05) | `gates/secrets-summary.txt`, `gates/exit-codes.txt` |
| deps (OSV-Scanner) | **fail**, 4 blocking advisories (INT05-F02) | `gates/deps.txt` |
| sbom (syft) | pass: CycloneDX 1.7, 1001 components | `gates/sbom.txt` |
| container-scan: Trivy config, 27 targets | pass, no blocking misconfigurations; the image step did not run (no Docker, exit 127) | `gates/container-scan.txt` |
| integration-db (four suites, `INTEGRATION_SKIP_N_MINUS_1=true`) | **pass**: db-foundation 120, kernel 23, api 1015, worker 121 = 1279 tests, 0 failed, 0 skipped. One earlier attempt hit a full disk and was discarded; the reported run is a complete re-run | counts here (log not committed: test names trip gitleaks, see INT04 r11 note 1) |
| migration-check | **fail**, rule `X-admin-owns-nothing` (INT05-F06); migrate-from-empty, migration lint, secret-reference lint pass | `gates/migration-check.txt` |
| a11y-smoke (staff) | **fail**, 8 of 8 tests (INT05-F07) | `gates/a11y-smoke.txt` |
| bundle-budget: staff gzip ceiling | **fail**: 162327 > 122880 bytes (INT05-F08) | `gates/staff-bundle-gzip.txt` |
| patient-e2e-a11y: bundle budget | pass | `gates/patient-bundle-budget.txt` |
| patient-e2e-a11y: Playwright journey and axe | **fail**, 1 of 3, then the empty-suite guard fails (INT05-F09) | `gates/patient-e2e.txt` |
| admin-run: driver and stack self-tests, migrate, `admin-stack.mjs` on a fresh database | **pass**, 7 of 7 steps, 10 actual-application screenshots | `gates/admin-stack.txt`, `shots/` |
| `tofu fmt -check -recursive infra` | pass | `gates/tofu-fmt.txt` |
| `tofu validate` and `tofu test` on 12 of 13 modules (archive, ci-trust, compute, database, dr/rehearsal, dr/restore-boundary, edge, identity, kms, network, secrets, storage) | pass: 8, 9, 8, 10, 6, 7, 10, 5, 2, 3, 4, 7 tests, 0 failed | `gates/tofu.txt` |

Limitation on the tofu row: the dependency lock files were removed in the scratch clone only (the AWS provider 5.100.0 binary came from an offline cache of the terraform registry, so its hash did not match the lock file's opentofu-registry hashes). Provider integrity was therefore not verified; the repository files were not changed.

## Trial (not part of the candidate)

The root changes that FE-16 asked for in `apps/cms/REQUESTS.md` and `root-changes.request.patch` (`allowBuilds: {esbuild: false}` and overrides for dompurify, happy-dom, esbuild) were applied in the scratch clone only. `pnpm install --lockfile-only` succeeded and `deps.sh` then passed with 0 blocking advisories (`gates/trial-deps-with-requested-overrides.txt`). This shows the fix direction for F01 and F02; it is not a verified correction and needs the reviewed correction ticket.

## Findings (stable IDs, round 1)

| ID | Severity | Finding | Owner suggested | Notes |
| --- | --- | --- | --- | --- |
| INT05-F01 | blocking | Frozen install exits 1 with `ERR_PNPM_IGNORED_BUILDS`; no `allowBuilds` policy for the esbuild versions that `apps/cms` brings in. Every CI job installs with the frozen lock, so none can pass. | DevOps (root `pnpm-workspace.yaml`) | FE-16 requested `allowBuilds: {esbuild: false}`. Then the Integrator re-resolves the lock. |
| INT05-F02 | blocking | `deps` fails: dompurify 3.4.15 (GHSA-cg2g-xh64-v4q7 9.2, GHSA-mrv2-3pqr-j5jr 7.6) and happy-dom 20.14.6 (GHSA-834v-8h66-3h79 8.8, GHSA-c8p4-j97h-3vg8 8.6). All are new through the Payload tree. | DevOps / Security | Overrides requested by FE-16; trial passes. SEC-07 should review the licence and dependency posture of the new tree (see F10). |
| INT05-F03 | blocking | Lint errors: `scripts/bootstrap/test/tasks.test.mjs:97` (unused `argv`), `scripts/bootstrap/test/workflow-policy.test.mjs:33,54,59,63` (`no-regex-spaces`), `scripts/restore/task/run.mjs:103` (unused `hashes`). | DevOps (DO-10, DO-08) | Files outside the Integrator's paths. |
| INT05-F04 | blocking | Prettier fails on `.github/workflows/infra.yml` and `scripts/bootstrap/README.md`. | DevOps | |
| INT05-F05 | blocking | gitleaks full history: 15 `generic-api-key` hits: `scripts/bootstrap/test/aws-result.test.mjs` (1), `tests/api/platform/admin.test.mjs` (4), five `docs/evidence/integration/M5/sec05-reread/*.txt` files (2 each). All look like test fixtures or evidence text; not triaged as real secrets. Same class as INT04-F36/F07. | Security / DevOps (narrow allowlist) | History cannot be rewritten; needs a path-and-commit scoped allowlist or a non-key-shaped fixture. |
| INT05-F06 | blocking | migration-check `X-admin-owns-nothing` fails: the administrator role owns the `btree_gist` support functions created by migration 0900 in schema `scheduling` (`gbt_*`, `gbtreekey*`). No earlier integration round ran this job. | Backend / Solution Architect | Decide whether extension member objects are exempt in the check or ownership must change. |
| INT05-F07 | blocking | a11y-smoke fails 8/8: the staff app now redirects `/` to `/sign-in`, so the smoke spec waits for text ("You are not signed in", "Reference for support") that no longer appears. INT-04 wired the admin portal into the staff app; the smoke spec was not updated. | Frontend / QA | |
| INT05-F08 | blocking | Staff bundle gzip ceiling: 162327 bytes against a ceiling of 122880. The admin portal grew the shell. | Frontend / Architect | Either code-split or the budget is changed by a recorded decision. |
| INT05-F09 | blocking | patient-e2e-a11y journey test fails: the preview server proxies `/api/v1/auth/callback` to 127.0.0.1:3000 and nothing listens there (ECONNREFUSED). The CI job starts no API or IDP fixture (HEAAA-176 "FE-03 CI wiring" is not merged). Probably pre-existing; not caused by the five merged branches. | DevOps / Frontend | Triage needed. |
| INT05-F10 | non-blocking (needed before the R1 candidate is frozen) | Open requests from FE-16 `apps/cms/REQUESTS.md`: no CI job for `apps/cms` (typecheck, `test`, `test:db`); `docs/DEPENDENCIES.md` has no rows for the new top-level dependencies; `**/.next/**` not in the eslint ignores; `apps/cms` `build` script is `tsc --noEmit`, so `next build` is never run. LGPL-3.0 `@img/sharp-libvips-linux-x64` (optional dependency of `next`) needs a licence-policy decision. Brand site CMS integration (`ContentSource`, `/preview`) and deploy are not done. | DevOps, Architect, Orchestrator | |

## Round count

This is cumulative round 1 for INT-05. The `review-ledger` document is not updated by this run (no independent review has run yet).

## Next permitted action

Orchestrator: open correction tickets for F01 to F09 and route F10; each fix needs independent review. Then the Integrator re-resolves the lockfile, merges the reviewed fixes and re-runs the full check set on a new candidate. The host disk (100% full, shared with other work) must have more free space before the re-run: two attempts failed on `No space left on device`.
