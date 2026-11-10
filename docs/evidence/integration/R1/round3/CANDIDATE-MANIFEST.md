# INT-05 candidate manifest (R1, round 3): NOT release-ready

| Item | Value |
| --- | --- |
| Candidate commit (product tree) | `e40739b3e409b2572d15af767818c7053257cddd` on `HEAAA-141-sdlc-ticket-int-05-integrate-r1-release-candidate-and-run-the-complete-combined-check-set` |
| Base | round 2 candidate `320ec2a` (evidence `c3ced95`) |
| Merged | HEAAA-611 `f509e895`, 613 `217f0b6`, 615 `019a719`, 617 `0e02364`, 619 `8bb4cf9` (each independently reviewed: 612, 614, 616, 618, 620) |
| `pnpm-lock.yaml` sha256 | `9688c96f669208aa1c8329cfdb5a04334b7c85348c495d8356d654e2916442d2` (unchanged from round 2) |
| Image digests | none: no Docker daemon |
| Configuration | `CI=true`; PostgreSQL 17.11 (embedded binaries, new UTF8 cluster, synthetic data); admin run `EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1` |
| Tools | Node 24.22.2, pnpm 12.16.1, gitleaks 8.30.1, semgrep 1.184.0, osv-scanner 2.7.0, syft 1.57.0, OpenTofu 1.13.9, actionlint 1.7.12, Chromium 156.0.8078.4 |
| Open blockers | INT05-F15 |
| Pending items | container image scan, contract, e2e-smoke (Docker); Lighthouse; N-1 (no release tag); observability tofu |
