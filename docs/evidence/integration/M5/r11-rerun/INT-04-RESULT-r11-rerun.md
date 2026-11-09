# INT-04 r11 re-run (HEAAA-571)

Candidate under test: code `33331f4` (r10 tip `d7cc3e5` + reviewed F34 fix `e589ae7`, which contains the reviewed gitleaks allowlist `5b48400`); branch `HEAAA-571-int04-r11-rerun` from `f59c330` (the r11 evidence commit; no code changes since `33331f4`). Fresh clone, PostgreSQL 17.11 (UTF8, C.UTF-8, new cluster, loopback), `pnpm install --frozen-lockfile`, `pnpm build`. Synthetic data. No code patched by the Integrator.

## Executed
| Check | Result |
|---|---|
| integration-db x2 (`INTEGRATION_SKIP_N_MINUS_1=true`) | pass x2: db-foundation 120, kernel 23, api 1015, worker 121 = 1279 tests, 0 failed, 0 skipped each (`gates/integration-db-run*-summary.txt`) |
| `admin.dbtest` looped x15 on the built file | 15/15 pass, 22/22 tests each (F34 did not recur) (`gates/admin-loop.txt`) |
| `admin-stack.mjs` on a freshly migrated DB | pass, exit 0, 7/7 steps; 10 screenshots in `shots/` |
| `secrets.sh` full history + tree, history scoped to `33331f4` | pass (`gates/secrets-33331f4.txt`) |
| `secrets.sh` full history on `f59c330` (the r11 evidence commit) | **FAIL: 130 findings, see F36** (`gates/secrets.txt`) |
| `deps.sh` (OSV-Scanner 2.7.0 on pnpm-lock.yaml) | pass; 2 non-blocking (minimatch 10.2.6 GHSA-g3hv-75wg-m249, yaml 2.8.1 GHSA-48c2-rrv3-qjmp) (`gates/deps.txt`) |
| actionlint 1.7.12 + `check-workflow-hygiene.mjs` | pass |
| `container-scan.sh` (Trivy 0.76.2 config scan) | **FAIL: AWS-0053 HIGH, `infra/modules/compute/main.tf` ALB `internal = false`, see F37** (`gates/container.txt`) |
| `lint`, `format:check`, `test:boundary`, `typecheck` | pass |

## Not run
- Container IMAGE scan: Dockerfiles exist (`docker/Dockerfile.api`, `.worker`) but no Docker daemon in this environment.
- N-1 compatibility: no release tag in the repository.
- `check-needs.mjs`: needs CI `NEEDS_JSON`; not applicable locally. Unit suite and semgrep not re-run (no code change since r11 run that passed them).
- Seeded-violation control.

## New findings
- **INT04-F36 (evidence/gate, Integrator-owned artefact):** the r11 evidence commit `f59c330` commits raw logs (`r11/gates/integration-db-run*.txt`, `r11/prepare-db*.txt`) whose migration/test names trip gitleaks `generic-api-key` (130 hits, same pattern as the r11 note 1). `secrets.sh` full history therefore FAILS on any branch containing `f59c330`. Product code is clean. Fix: Integrator replaces those raw logs with summaries (this commit does not rewrite history), or DevOps adds a reviewed allowlist for `docs/evidence/**`. Needs decision/owner via Orchestrator.
- **INT04-F37 (infra, DevOps):** Trivy config check AWS-0053 HIGH blocks `container-scan.sh`: public ALB (`internal = false`) in `infra/modules/compute/main.tf:59`. Either intentional (edge/WAF, CloudFront) and needs a dated, owned entry in `trivy/.trivyignore` with review, or a design change. Not previously run (r10, r11 skipped container scan), present since before r10.
- F35 (admin-stack not re-runnable on a used DB) unchanged, informational; the passing run used a new database.

## Environment notes (host, not defects)
Chromium needs `LD_LIBRARY_PATH` to the extracted libs, `FONTCONFIG_FILE`, `PLAYWRIGHT_BROWSERS_PATH`.

Not QA, G3 or deployment approval. Raw integration-db logs deliberately not committed (F36).
