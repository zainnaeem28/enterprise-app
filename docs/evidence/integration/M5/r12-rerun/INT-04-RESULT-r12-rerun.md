# INT-04 r12 re-run (HEAAA-580)

Candidate: branch `HEAAA-571-int04-r11-rerun` at `bcaf403` = `98fbac5` + reviewed F36 `f27b962` (HEAAA-578, HEAAA-579 PASS) + reviewed F37 `bcaf403` (HEAAA-576, HEAAA-577 PASS). Product code unchanged since `33331f4`. Fresh clone, `pnpm install --frozen-lockfile`, `pnpm build`, PostgreSQL 17.11 (UTF8, C.UTF-8, new cluster, loopback). Synthetic data. No code patched by the Integrator.

## Executed (all on bcaf403)
| Check | Result |
|---|---|
| `secrets.sh` full history + tree | pass, 0 findings (F36 closed) |
| `container-scan.sh` Trivy config (23 targets) | pass, no blocking misconfigurations (AWS-0053 gone, F37 closed); script then exits 127 at the image step (no Docker) |
| `tofu validate` compute, edge; `tofu test` compute 8/8, edge 10/10; `tofu fmt -check -recursive infra` | pass |
| Checkov 3.4.3 | compute 46 pass/0 fail/0 skip; edge 59 pass/0 fail/13 skip |
| integration-db x2 (`INTEGRATION_SKIP_N_MINUS_1=true`) | pass x2: db-foundation 120, kernel 23, api 1015, worker 121 = 1279, 0 failed, 0 skipped each |
| `admin-stack.mjs` on a freshly migrated DB | pass, 7/7 steps, 10 screenshots in `shots/` |
| `deps.sh` (OSV-Scanner) | pass |
| `lint`, `format:check`, `typecheck`, `test:boundary` | pass |
| actionlint + `check-workflow-hygiene.mjs` | pass |

## Not run
- Container IMAGE scan: no Docker daemon; needs CI.
- N-1 compatibility: no release tag.
- `check-needs.mjs` (needs CI `NEEDS_JSON`), unit suite and semgrep (no product code change since they passed), seeded-violation control.
- Real AWS apply / CloudFront VPC origin behaviour: IaC validated by mock-provider tests only; F37-R1 (XFF hop count unrecorded) carried forward as non-blocking.

## Environment note (not a defect)
A first integration-db attempt used a PG cluster created with the host default locale (not UTF8). The api test `consent text` (200 emoji title) then failed deterministically (400 invalid_format) in 2 runs; the same code passes on the required UTF8 cluster. Treat PostgreSQL UTF8 as a prerequisite of integration-db. A concurrent disk-full also invalidated one earlier batch; discarded and re-run. Raw logs are not committed (summaries only).

Not QA, G3 or deployment approval.
