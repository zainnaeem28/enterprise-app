# INT-05 candidate manifest (R1, round 2): NOT release-ready

| Item | Value |
| --- | --- |
| Candidate commit (product tree) | `320ec2a922cf3f85020f655e8c9670f72e82e76b` on `HEAAA-141-sdlc-ticket-int-05-integrate-r1-release-candidate-and-run-the-complete-combined-check-set` |
| Base | round 1 candidate `e6871fa` |
| Merged | 591, 592, 593, 595, 596, 597, 598, 600, 603, 599 (see `INT-05-RESULT-r2.md`) |
| `pnpm-lock.yaml` sha256 | `9688c96f669208aa1c8329cfdb5a04334b7c85348c495d8356d654e2916442d2` (no `sharp@`/`@img/sharp-*`) |
| `pnpm-workspace.yaml` sha256 | `3f7bcd4de6e26ef3028e6fa621d4c696ce7c8fc9085bd141e310410273d21f88` (591 + 603 union, approved in HEAAA-609) |
| `package.json` sha256 | `efb549f11e2c5befd1569159acf10cc46b474ff6dff5a4276f01260e3f176539` |
| Image digests | none: no Docker daemon |
| Configuration | CI env `CI=true`; PostgreSQL 17 (embedded binaries, new cluster, synthetic data); admin run `EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1` |
| Tools | Node 24.22.2, pnpm 12.16.1, gitleaks 8.30.1, semgrep 1.184.0, osv-scanner 2.7.0, trivy 0.76.2, syft 1.57.0, OpenTofu 1.13.9, actionlint 1.7.12, Chromium 156.0.8078.4 |
| Open blockers | INT05-F11, F12, F13 |
| Pending items | container image scan, contract, e2e-smoke (Docker); Lighthouse; N-1 (no release tag); observability tofu |
