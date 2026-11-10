# INT-05 candidate manifest (R1, round 4)

| Item | Value |
| --- | --- |
| Candidate commit (product tree) | `af278307f70c626e451389bd55b86aea9e4016ce` on `HEAAA-141-sdlc-ticket-int-05-integrate-r1-release-candidate-and-run-the-complete-combined-check-set` |
| Base | round 3 candidate `e40739b` |
| Merged since round 3 | HEAAA-623 INT05-F15 fix `d6ea96e` (review HEAAA-624 PASS); HEAAA-626 disk cleanup in `seed.sh` `af27830` (review done) |
| Product diff vs round 3 | `scripts/ci/migration-check/seed.sh` only |
| `pnpm-lock.yaml` sha256 | `9688c96f669208aa1c8329cfdb5a04334b7c85348c495d8356d654e2916442d2` (unchanged) |
| Image digests | none: no Docker daemon |
| Configuration | `CI=true`; PostgreSQL 17.11 (embedded binaries, UTF8 cluster, trust auth like CI, synthetic data); admin run `EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1` |
| Tools | Node 24.22.2, pnpm 12.16.1, gitleaks, semgrep, osv-scanner, syft, OpenTofu, actionlint 1.7.12 (versions pinned by `scripts/ci/tools.lock`), Chromium 156.0.8078.4 |
| Open blockers | none from this run |
| Pending items (unchanged) | container image scan, contract, e2e-smoke (no Docker); Lighthouse; N-1 (no release tag); observability tofu; CI-side `check-needs.mjs` |
