# RUN-GUIDE — building, testing and running the Release 1 candidate

Candidate `af278307f70c626e451389bd55b86aea9e4016ce` (local branch `HEAAA-141-sdlc-ticket-int-05-integrate-r1-release-candidate-and-run-the-complete-combined-check-set`, not pushed; check out `origin/HEAAA-27-sdlc-build-package-prepare-milestone-build-evidence-and-real-screenshots` to get these commits; evidence commit `3cb45ed`). Commands below are the ones the INT-05 run used (`scripts/ci/README.md`, `README.md`, `tools.lock`). Synthetic data only. This guide is for local review and CI, not for production. I verified these commands exist in the repository; I did not run them in this task.

## 1. Prerequisites

* Node 24.22.2 (`.nvmrc`), Corepack (pnpm 12.16.1 is pinned).
* PostgreSQL 17 with a superuser URL, for DB checks.
* Pinned CI tools via `scripts/ci/install-tools.sh` (gitleaks, Semgrep, OSV-Scanner, Syft, Trivy, actionlint, OpenTofu; versions and sha256 in `scripts/ci/tools.lock`). Chromium via `scripts/ci/install-browser.sh` for browser checks.
* Docker is needed only for container image, `contract` and `e2e-smoke` jobs (not run so far).

## 2. Get the code

```sh
git clone https://github.com/zainnaeem28/enterprise-app && cd enterprise-app
git checkout 3cb45ed        # evidence commit on the candidate branch; product tree is af27830
corepack enable
pnpm install --frozen-lockfile
```

## 3. Static checks and build

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test:boundary
node scripts/ci/run-unit.mjs          # all unit suites; fails on skipped/failed/empty
```

## 4. Database checks (PostgreSQL 17)

Set `EHR_TEST_ADMIN_URL` to a superuser URL of a throwaway server (names only here; never commit a URL with a password).

```sh
scripts/ci/migration-check/migration-check.sh
scripts/ci/migration-check/seed.sh                 # 19 seeded controls must all be caught
INTEGRATION_SKIP_N_MINUS_1=true scripts/ci/migration-check/integration-db.sh
pnpm --filter @ehr/cms run test:db                 # CMS DB tests (unset any production DATABASE_URL first; the CMS guard refuses it)
```

## 5. Run the application and capture the administrator path (real stack)

```sh
scripts/ci/migration-check/prepare-db.sh ehr
CI=true EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1 EHR_TEST_ADMIN_URL=<superuser url> node scripts/ci/admin-stack.mjs
```

This starts the real API, worker and built staff app behind a per-run TLS front at `https://staff.ci.test`, drives Chromium through sign-in with the CI WebAuthn fixture, configuration, audit viewer and break-the-glass review, and writes screenshots (default `artifacts/admin-run`, logs `reports/admin-run`). `EHR_ENV=ci` and the fixture flag are refused outside CI by design. Self-test without a stack: `node scripts/ci/admin-stack.mjs --selftest`.

Other apps: `pnpm --filter @ehr/patient run dev` and `pnpm --filter @ehr/staff run dev` (Vite dev servers; need the API and an identity provider, the CI conformance IdP is `scripts/ci/local-idp.mjs`); `pnpm --filter @ehr/cms run dev` (port 3100); `pnpm --filter @ehr/site run build && pnpm --filter @ehr/site run start`. Browser/a11y: `pnpm --filter @ehr/patient run test:a11y`, `pnpm --filter @ehr/staff run test:a11y`.

## 6. Security and supply-chain checks

```sh
scripts/ci/install-tools.sh && scripts/ci/sast.sh && scripts/ci/secrets.sh && scripts/ci/deps.sh && scripts/ci/sbom.sh
node scripts/ci/check-workflow-hygiene.mjs
cd infra && tofu fmt -check -recursive
```

Raw reports go to `reports/<job>/`. Do not commit full integration-db logs (test names trip gitleaks).

## 7. Known limits of this environment

No Docker daemon: image scan, `contract`, `e2e-smoke` not run. No release tag: N-1 not run. Lighthouse and observability tofu not run. No GitHub Actions run exists for this candidate. Nothing is deployed; deploy workflows exist but need G3 and environment credentials.
