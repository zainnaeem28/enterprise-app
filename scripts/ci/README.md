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

Binaries come from `tools.lock` (version, URL, sha256; verified by `install-tools.sh`). No third-party GitHub Action is used. Semgrep is installed by `install-tools.sh semgrep`: a sha256-verified pip wheel (tools.lock) installs the transitive wheel set from `semgrep-requirements.txt` with `--require-hashes` into `$CI_TOOLS_DIR/semgrep-site` (CPython 3.13, Linux x86_64; no venv/ensurepip needed). Run: `CI_TOOLS_DIR=/tmp/ci-tools scripts/ci/install-tools.sh semgrep && CI_TOOLS_DIR=/tmp/ci-tools scripts/ci/sast.sh`.

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

## Admin run (INT04-F22a, `admin-run.mjs`)

Real-stack browser driver for the administrator path: sign-in with the CI WebAuthn fixture (`admin-fixture/`), admin configuration (creates a service and checks it persisted), the audit viewer (entries for the last 24 hours) and the break-the-glass review (records a decision, checks it is stored). It starts nothing: the CI start script runs the API, PostgreSQL and the built staff app (`vite preview`, static files) behind a TLS front, with the `adminFixtureEnv()` values, seeds an admin principal with an approved enrolment token and one pending break-the-glass grant opened by another principal, then runs `CI=true EHR_ADMIN_CI_FIXTURE=1 node scripts/ci/admin-run.mjs`.

Variables (names only; the token is read from the environment, never printed or written): `ADMIN_RUN_STAFF_URL`, `ADMIN_RUN_HANDLE`, `ADMIN_RUN_ENROLMENT_TOKEN` (required); `ADMIN_RUN_API_URL`, `ADMIN_RUN_RP_ID`, `ADMIN_RUN_OUT` (default `artifacts/admin-run`). The staff origin's host must equal the `EHR_STAFF_HOST` / allowed origin the API was started with. Output: numbered screenshots and `summary.json` (step, ok, error text without secrets) in `$ADMIN_RUN_OUT`; exit code 1 if any step fails or a prerequisite is missing.

Self-test without a stack or browser: `node scripts/ci/admin-run.mjs --selftest` (configuration checks, secret redaction, screenshot naming).

### Start script and CI job (INT04-F22b)

`admin-stack.mjs` is the start script. It must be one process with the driver because the fixture's attestation root is generated per run in memory. It creates the fixture, installs the queue library and syncs task types, inserts the organisation, applies the reference data through the real worker job, seeds an administrator (`org_admin` and `compliance_officer`, each through the real request states), an approved single-use enrolment token and one pending break-the-glass grant held by another principal, starts the API, the worker and `vite preview` of the built staff app, puts the TLS front in front of both, runs `admin-run.mjs` with the same fixture, and stops everything. All keys and the token are random per run. Logs go to `reports/admin-run/`, screenshots and `summary.json` to `artifacts/admin-run/`.

#### https origin and TLS front (INT04-F27, decision `f27-decision` on HEAAA-513)

The admin realm only accepts `https://<EHR_STAFF_HOST>` (no port), so the run uses the host `staff.ci.test` (`.test` never resolves publicly) with `EHR_ALLOWED_ORIGINS=https://staff.ci.test` and no production code change. `admin-stack.mjs` generates a one-day self-signed certificate per run with `openssl` (SAN `DNS:staff.ci.test` only; the key is read into memory and its temp directory removed before any child starts), and serves it from an in-process `node:https` front on `127.0.0.1:${ADMIN_STACK_PORT_TLS:-4443}`. The front sends `/api` and `/api/*` straight to the API (original `Host`), and everything else to `vite preview` (`Host` rewritten; vite 8 blocks other hosts before its proxy). It replaces any client `x-forwarded-*`/`forwarded` header with `x-forwarded-proto: https` and the peer address, and logs only method, path, status and duration to `reports/admin-run/tls-front.log`. All listeners are loopback only.

Handover to the driver: `ADMIN_RUN_STAFF_URL=https://staff.ci.test`, `ADMIN_RUN_CONNECT=127.0.0.1:<tls port>` and `ADMIN_RUN_TLS_CERT_PEM=<public certificate>` (the in-memory option is the environment variable; the key is never passed). `ADMIN_RUN_API_URL` stays unset. The driver (F26/F27 driver task) launches Chromium with `--host-resolver-rules=MAP staff.ci.test:443 127.0.0.1:<tls port>` and `--ignore-certificate-errors-spki-list=<SPKI pin>`, and its Node calls trust only this certificate.

CI job `admin-run` (`ci.yml`, in `ci-status` needs) runs it on PostgreSQL 17 after `pnpm build` and `prepare-db.sh ehr`, and uploads both folders as `admin-run-screenshots`. `EHR_ENV=ci` and `EHR_ADMIN_CI_FIXTURE=1` are set on that one step only.

Guard `check-ci-fixture-isolation.mjs` (run by `workflow-hygiene`, with `--selftest`): fails if `EHR_ENV=ci` or `EHR_ADMIN_CI_FIXTURE` appears in any other workflow or local action, in `ci.yml` outside the `admin-run` job, or under `infra/`, `docker/`, `scripts/deploy/`.

Status of the evidence: the self-tests, the guard (including a seeded violation), prettier, actionlint and the workflow-hygiene check were executed. The stack itself (seeding, API, worker, preview, browser steps) has **not** been run: this environment has no PostgreSQL, Docker or built `dist`. The first CI run of `admin-run` is the first real execution; expect to correct seed or environment details from its logs.
