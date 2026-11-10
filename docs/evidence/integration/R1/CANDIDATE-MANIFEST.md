# INT-05 candidate manifest (R1, round 1)

| Item | Value |
| --- | --- |
| Candidate commit (product tree) | `e6871fa0b691112fada340e91b409b5b562b4fae` on branch `HEAAA-141-sdlc-ticket-int-05-integrate-r1-release-candidate-and-run-the-complete-combined-check-set` |
| Evidence commit | the commit that adds this directory on top of the candidate commit (no product file changed by it) |
| Base | INT-04 tip `8cb02eb` (fast-forward; contains INT-02 and INT-03 merges) |
| Merged in order | FE-16 `1835ea1` (HEAAA-136), DO-08 `844b741` (HEAAA-111), DO-09 `f28b637` (HEAAA-113), DO-10 `1836e0a` (HEAAA-138), SEC-06 `ff86a83` (HEAAA-115). All five merged without conflicts; their tickets are `done` with an approved review decision. |
| Integrator-authored change | `pnpm-lock.yaml` only: re-resolved for the `apps/cms` importer added by FE-16 (`pnpm install --lockfile-only`). Additive: 424 to 832 packages, none removed, none changed (verified by key comparison against the INT-04 lock). |
| `pnpm-lock.yaml` sha256 | `130b035c9f5b916b3f313e0fcb83f6d245ebe68603374b2ad31f86f31dec53f1` |
| `pnpm-workspace.yaml` sha256 | `60ce4d1dbf137701a4683d171391c51662700c2f3e32a7caab8b2efc22540e65` (unchanged from INT-04) |
| `package.json` sha256 | `efb549f11e2c5befd1569159acf10cc46b474ff6dff5a4276f01260e3f176539` |
| Image digests | none built: no Docker daemon on this host; the container image scan did not run |
| Configuration | CI env `CI=true`; PostgreSQL 17.11 (embedded-postgres binaries, new cluster, UTF8 / C.UTF-8, loopback, trust auth, synthetic data only); admin run `EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1` |
| Tools | Node 24.22.2, pnpm 12.16.1, gitleaks 8.30.1, semgrep 1.184.0, osv-scanner 2.7.0, trivy 0.76.2, syft 1.57.0, OpenTofu 1.13.9, actionlint 1.7.12, Chromium 156.0.8078.4 (Playwright), PostgreSQL 17.11 |

## State of the candidate

**Not release-ready.** `pnpm install --frozen-lockfile` fails on this candidate (INT05-F01) and several required CI jobs fail on it (see `INT-05-RESULT-r1.md`). The candidate must not be frozen for BUILD_REVIEW until the findings below are corrected, independently reviewed and re-run.

## Known blocked or pending items

| Item | Condition |
| --- | --- |
| Container image scan, `contract` and `e2e-smoke` jobs | need a Docker daemon; not available on this host. Run in CI. |
| N-1 compatibility / upgrade path | no release tag exists (first release); not a pass |
| Lighthouse CI | not run (needs the runner-only install) |
| `tofu validate` / `tofu test` for `observability` | provider other than AWS not cached offline; not run |
| `apps/cms` database tests (`test:db`) and a CI job for `apps/cms` | no CI job exists (INT05-F10) |
| Real AWS apply, deploy, restore and DR execution | authored only; no environment or credential; G3 and OPERATIONS_RECEIPT not reached |
