# CI scripts (F-02, HEAAA-68)

Entry points used by `.github/workflows/ci.yml`. Each job script is runnable locally; each writes its raw reports to `reports/<job>/` (uploaded as an artifact by CI) and exits non-zero on any blocking finding, missing report or empty result. Source: DEVOPS-PLAN 4.1, 4.2, 5.1, 14; NFR-15.

| Job (required check name) | Entry point                                        | Tool (pinned)                                         | Blocks on                                                                                                                |
| ------------------------- | -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `workflow-hygiene`        | `actionlint`, `check-workflow-hygiene.mjs`         | actionlint 1.7.12                                     | actionlint error; `uses:` not a 40-char SHA or not on the allow-list; no `permissions`; no timeout; swallowed failures   |
| `lint-types`              | `pnpm lint`, `pnpm format:check`, `pnpm typecheck` | project (F-01)                                        | any error                                                                                                                |
| `unit`                    | `run-unit.mjs`                                     | project test scripts                                  | failed, skipped or zero-test suite; missing/malformed JUnit report; nothing ran                                          |
| `build`                   | `pnpm build`                                       | project (F-01)                                        | build error; no output files                                                                                             |
| `sast`                    | `sast.sh`, `check-semgrep.mjs`                     | Semgrep CE 1.184.0, committed ruleset `semgrep/rules` | any ERROR finding; any finding under `semgrep/sensitive-paths.txt`; scan error; zero files scanned                       |
| `secrets`                 | `secrets.sh`                                       | gitleaks 8.30.1                                       | any finding in the PR commits (full history on `main`) or in the working tree                                            |
| `deps`                    | `deps.sh`, `check-osv.mjs`                         | OSV-Scanner 2.7.0 on `pnpm-lock.yaml`                 | HIGH/CRITICAL (CVSS >= 7) with a fixed version; unknown severity; missing lockfile                                       |
| `container-scan`          | `container-scan.sh`, `check-trivy-config.mjs`      | Trivy 0.76.2                                          | HIGH/CRITICAL misconfiguration; root user; no HEALTHCHECK; image HIGH/CRITICAL with a fix. **No Dockerfile yet** (below) |
| `sbom`                    | `sbom.sh`, `check-sbom.mjs`                        | Syft 1.57.0, CycloneDX JSON                           | missing or empty SBOM; no npm packages                                                                                   |
| `ci-status`               | `check-needs.mjs`                                  | none                                                  | any required job that is not `success` (skipped counts as failure)                                                       |

Binaries come from `tools.lock` (version, URL, sha256; verified by `install-tools.sh`). No third-party GitHub Action is used. Semgrep is installed with `pip install semgrep==1.184.0` (version pinned; transitive Python dependencies are **not** hash-locked: limitation).

## Pending: jobs that need application code (F-09, HEAAA-79) - NOT passing

`integration-db` (PostgreSQL 17), `migration-check`, `contract` (Schemathesis), `a11y-smoke`, `e2e-smoke`, `bundle-budget`, and the PHI-in-logs and authorization-test gates of DEVOPS-PLAN 5.1 do not exist in `ci.yml`. They are not reported as passing and the aggregate `ci-status` does not include them. Until F-09 lands, a green `ci-status` does **not** mean those controls passed.

## Known limits of the jobs that do exist

- **Container scan**: the repository has no Dockerfile. The config scan ran (0 targets); the image scan is written to `reports/container-scan/IMAGE-SCAN-NOT-PERFORMED.txt` and a notice. It is not an image pass. It starts scanning automatically when a Dockerfile is committed.
- **Unit**: only the root boundary test exists today (F-01). Workspace packages must write JUnit XML to `$JUNIT_DIR` from their `test` script (contract documented in `run-unit.mjs`).
- **SAST**: ruleset is a registry snapshot (`semgrep/rules/registry-snapshot.yml`, packs and download hashes in its header, fetched 2026-11-05). The custom rules for audit-write and `SET LOCAL` scope patterns (DEVOPS-PLAN 14) need the code they check and are not written. Refresh procedure: download `https://semgrep.dev/c/p/<pack>` for owasp-top-ten, typescript, nodejs, secrets, dockerfile, terraform, de-duplicate by rule id, format with Prettier, review the diff in a pull request.
- **Dependency scan** queries osv.dev and **Trivy** downloads its check bundle and vulnerability database at run time, so results can change between runs without a code change. "Known exploited" (CISA KEV) is not evaluated. Dependabot _alerts_ are disabled (below); `dependabot.yml` version updates are configured for npm and GitHub Actions only (no Docker or Terraform manifest exists yet).
- **Workflow hygiene** is line-based (no YAML parser); actionlint covers syntax. shellcheck and pyflakes are not installed, so actionlint does not lint the shell inside `run:` blocks beyond its own checks.
- **Not requested by the ticket and not done**: required-check or ruleset configuration on GitHub (impossible on this plan), cosign, ECR, any deploy workflow.

## GitHub state actually found (read-only, managed token, 2026-11-06 00:09 UTC; DEVOPS-PLAN 4.1)

| Control                                                  | Found                                                                                                             | Enforced?                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Repository `zainnaeem28/enterprise-app`                  | Private, owned by a User account, default branch `main`, token has admin on the repository                        | -                                                           |
| Branch protection on `main`                              | `GET /branches/main/protection` -> 403 "Upgrade to GitHub Pro or make this repository public"; `protected: false` | **No. Required checks are procedural only.**                |
| Rulesets                                                 | `GET /rulesets` -> 403, same message                                                                              | **No. Required checks are procedural only.**                |
| Required status checks / required PR review / CODEOWNERS | Cannot be configured without the above                                                                            | **Procedural only**                                         |
| Actions enabled / allowed actions                        | Enabled; `allowed_actions: all`                                                                                   | No allow-list at GitHub level; the CI script is the control |
| SHA pinning required (repository setting)                | `sha_pinning_required: false`                                                                                     | **Procedural only**; the CI script enforces on any plan     |
| Default `GITHUB_TOKEN` permissions                       | `read`; `can_approve_pull_request_reviews: false`                                                                 | Yes (also declared per workflow and job)                    |
| Environments                                             | 0 exist. Required reviewers on a private repository are documented to need a paid plan; not tried                 | **None. Environment protection is procedural only.**        |
| Code scanning                                            | 403 "not enabled for this repository"                                                                             | Not used (CodeQL not selected, DEVOPS-PLAN 14)              |
| Dependabot alerts                                        | `GET /vulnerability-alerts` -> 404 (disabled)                                                                     | No; only the owner can enable it                            |
| Secret scanning / push protection                        | `GET /secret-scanning/alerts` -> 403 "Resource not accessible by integration"                                     | **Unverified** (feature state unknown)                      |

Consequence, stated plainly: until the repository owner moves to a plan that supports rulesets (DEVOPS-PLAN 4.1 Recommendation A1), nothing technical stops a direct push to `main` or a merge with failing or absent checks. `ci.yml` makes the checks run and fail; making them _required_ is an owner action that has not happened. This ticket changes no GitHub setting.
