# RUN-GUIDE — run and check the product locally

How to go from a clean checkout to a running api, worker, site, patient, staff and cms, and to every local check. Synthetic data only. This is for local development and review, not for production. Companion documents: `README.md` (install and static checks), `scripts/ci/README.md` (CI scripts), `db/README.md` (database), `docs/build-review/R1/RUN-GUIDE.md` (a snapshot of the commands used for the Release 1 candidate; this file is the maintained one).

Every command below was run on a clean checkout of the revision recorded in the completion comment of HEAAA-649. Where something could not be confirmed, the text says so under **Not verified** rather than implying it works.

## 1. Prerequisites

| Need                  | Version / source                                                                                                                                                                                                         | Used by                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Node                  | 24.22.2 (`.nvmrc`; `engine-strict=true` in `.npmrc` refuses other majors)                                                                                                                                                | everything                   |
| Corepack and pnpm     | pnpm 12.16.1 is pinned in `package.json`; `corepack enable` provides it                                                                                                                                                  | everything                   |
| PostgreSQL 17         | Any server you can reach as a **superuser with trust authentication on loopback** (the helpers connect without a password). `docker compose -f docker/compose.ci.yml up -d --wait` gives one on `127.0.0.1:55432`        | migrations, DB tests, api, worker |
| `openssl`             | system package                                                                                                                                                                                                           | `admin-stack.mjs` (TLS front) |
| Pinned CI tools       | `scripts/ci/install-tools.sh` (gitleaks, Semgrep, OSV-Scanner, Syft, Trivy, actionlint, OpenTofu; versions and sha256 in `scripts/ci/tools.lock`)                                                                         | security checks only          |
| Chromium              | `scripts/ci/install-browser.sh` (rootless, Linux x86_64, needs network and `apt`), then `eval "$(scripts/ci/install-browser.sh --env)"`. On a machine with a normal desktop or CI image you can use `pnpm --filter @ehr/staff exec playwright install --with-deps chromium` instead | browser checks                |
| Docker                | only for `docker/compose.ci.yml`, container image scan and the `contract` and `e2e-smoke` CI jobs                                                                                                                        | optional                      |

Minimal containers have no fonts and Chromium aborts with `SkFontMgr_FontConfigInterface ... Not implemented` (the first browser step then fails with "browser has been closed"). Install a font package, or point `FONTCONFIG_FILE` at a fontconfig file that lists a directory holding at least one `.ttf`.

## 2. Get the code and install

```sh
git clone https://github.com/zainnaeem28/enterprise-app && cd enterprise-app
git checkout <revision under test>
corepack enable
pnpm install --frozen-lockfile
pnpm build            # needed before api, worker, site, DB tests and browser checks
```

Only the root lockfile is committed. Dependencies and licences: `docs/DEPENDENCIES.md`.

## 3. Environment variables (names only)

Never commit values. Secrets (marked **S**) are random strings of at least 32 characters; generate them per run, for example `openssl rand -hex 32`.

**Both api and worker** (kernel config): `EHR_ENV` (`ci`, `dev`, `staging` or `production`; required), `EHR_DATABASE_URL` (**S**; role `app_api` for the api and `app_worker` for the worker), `EHR_ORGANISATION_ID` (UUID; required by the worker and the api), `EHR_QUEUE_SCHEMA` (default `queue`), `EHR_LOG_LEVEL` (default `info`), `EHR_POOL_MAX` (default 10). `EHR_DEPLOYABLE` is set by the process itself.

**Api only**

- Platform: `EHR_MIN_CLIENT_RELEASE` (required integer), `EHR_PORT` (default 3000; the api binds all interfaces), `EHR_INSTANCE_COUNT`, `EHR_INTEGRATIONS_HOST`, `EHR_REQUEST_TIMEOUT_MS`, `EHR_TEMPLATE_LANGUAGES`.
- Identity: `EHR_STAFF_HOST` and `EHR_PATIENT_HOST` (bare host names, no port, must differ), `EHR_ALLOWED_ORIGINS`, `EHR_OIDC_STATE_KEY`, `EHR_CSRF_KEY`, `EHR_RATE_KEY`, `EHR_MATCH_CHECK_KEY`, `EHR_CHECKIN_QR_KEY` (all **S**), `EHR_STAFF_OIDC_CLIENT_ID`, `EHR_STAFF_OIDC_CLIENT_SECRET` (**S**), `EHR_STAFF_OIDC_REDIRECT_URI`, `EHR_STAFF_WORKSPACE_DOMAIN`, `EHR_STAFF_OIDC_ISSUER|AUTHORIZATION_ENDPOINT|TOKEN_ENDPOINT|JWKS_URI` (default to Google), `EHR_PATIENT_OIDC_ISSUER|AUTHORIZATION_ENDPOINT|TOKEN_ENDPOINT|JWKS_URI`, `EHR_PATIENT_OIDC_CLIENT_ID`, `EHR_PATIENT_OIDC_REDIRECT_URI`, `EHR_PATIENT_OIDC_CLIENT_SECRET` (optional, **S**).
- Admin realm: `EHR_ADMIN_ATTESTATION_ROOTS_PEM`, `EHR_ADMIN_ALLOWED_AAGUIDS`, `EHR_ADMIN_DECOY_KEY` (**S**, different from the rate and CSRF keys), `EHR_ADMIN_RP_NAME`. `EHR_ADMIN_CI_FIXTURE` is accepted only together with `EHR_ENV=ci` (section 7).
- Telemetry (`EHR_TELEMETRY`, `OTEL_*`) is defined but off by default.

**Worker only**: `EHR_PATIENT_HOST` and `EHR_CHECKIN_QR_KEY` (without both, the scheduling and telehealth ports refuse, section 9), `EHR_CALENDAR_WEBHOOK_URL` (without it calendar jobs refuse), `EHR_METRIC_NAMESPACE`.

**Site**: `PORT` (default 8080), `SITE_ORIGIN`, `PUBLIC_API_ORIGIN` (default `http://127.0.0.1:3001`; the api listens on one port, so point it at `EHR_PORT`), `PATIENT_ORIGIN`, `ANALYTICS_SRC`. Origins must be https except `localhost` and `127.0.0.1`.

**Patient and staff** (vite): `API_ORIGIN` (default `http://127.0.0.1:3000`), `CLIENT_RELEASE` (default `r1.000000000000`, which satisfies `EHR_MIN_CLIENT_RELEASE=1`).

**Cms** (`apps/cms/.env.example`): `CMS_DATABASE_URL` (**S**; the database user must start or end with `cms`), `PAYLOAD_SECRET` and `CMS_PREVIEW_SECRET` (**S**, different from each other), `CMS_PUBLIC_URL`, `CMS_SITE_PREVIEW_URL`, `CMS_GOOGLE_CLIENT_ID`, `CMS_GOOGLE_CLIENT_SECRET` (**S**), `CMS_GOOGLE_HOSTED_DOMAIN`, `CMS_ALLOWED_EMAILS`, `CMS_PREVIEW_TTL_SECONDS`, `CMS_SESSION_TTL_SECONDS`. The cms refuses to start if `DATABASE_URL`, `PRODUCTION_DATABASE_URL`, `APP_DATABASE_URL` or any `PG*` connection variable is set: unset them first.

**Scripts and tests**: `EHR_TEST_ADMIN_URL` (superuser URL of a throwaway server, no password, for example `postgres://postgres@127.0.0.1:55432/postgres`), `CMS_TEST_DATABASE_URL`, `JUNIT_DIR`, `CI_TOOLS_DIR` (default `/tmp/ci-tools`), `PLAYWRIGHT_BROWSERS_PATH`, `SMOKE_PROJECT`, `ADMIN_STACK_DB|PORT_API|PORT_STAFF|PORT_TLS|LOGS`, `ADMIN_RUN_*` (`scripts/ci/README.md`).

## 4. Database

```sh
export EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres   # your throwaway server
scripts/ci/migration-check/prepare-db.sh ehr    # creates database ehr, applies db/roles (as superuser) and db/migrations (as app_owner)
```

`prepare-db.sh` fails if `ehr` already exists. To start over: `node scripts/ci/migration-check/db-admin.mjs drop ehr` and run it again. Roles are cluster-global and idempotent. By hand, see `db/README.md` (`migrate.mjs bootstrap`, `migrate`, `plan`; `catalog-check.mjs`).

**What is in the database afterwards.** Migrations are DDL only, so the database is structurally complete and empty. There is no supported "seed everything" command. Data comes from three places:

1. **Organisation, queue tables, reference data, synthetic principals.** `scripts/ci/admin-stack.mjs` (section 7) creates the organisation row (`00000000-0000-7000-8000-0000000000a1`), installs the queue library, syncs task types, runs the real worker job `identity.apply_reference_data`, and seeds four synthetic admin-realm principals. It needs a database that has not been seeded before (a second run fails with `principal_realm_subject_uq`): drop and prepare `ehr` again between runs.
2. **Synthetic test data files.** `node tests/data/generate.mjs <out-dir> [--seed S]` writes `accounts.json`, `organisations.json`, `services.json`, `patients.json`, `seeds.json` and `manifest.json`. **Not verified / not available:** nothing in the repository loads these files into the database.
3. **Test suites** create their own throwaway databases from `EHR_TEST_ADMIN_URL`.

## 5. Start the applications

Start order: database, api, worker, then the front ends. The api and worker have no `dev` script: they run from `dist`, so run `pnpm build` after every code change.

The api needs a migrated database, an organisation row and the queue library (installed by `admin-stack.mjs`, section 4 item 1; no standalone command exists). The simplest working environment is the one `admin-stack.mjs` builds: run it once (section 7) so the database `ehr` is seeded, then start the processes yourself with the variables of section 3. The values `apiEnv()` uses are in `scripts/ci/admin-stack.mjs`; the admin-realm values must be the public fixture values (`EHR_ENV=ci`, `EHR_ADMIN_CI_FIXTURE=1`, root certificate, AAGUID) because a non-CI environment needs a real hardware-attestation root.

```sh
node apps/api/dist/src/main.js          # api, EHR_PORT (default 3000)
node apps/worker/dist/main.js           # worker (graphile-worker), no port
curl -i http://127.0.0.1:3000/healthz   # shallow; /readyz is the deep check; both skip the client-release check
curl -i -H 'X-Client-Release: r1.000000000000' http://localhost:3000/api/v1/auth/session   # 401 auth.unauthenticated when signed out
```

Every `/api/*` request needs `X-Client-Release: r<N>.<12 hex>` with `N >= EHR_MIN_CLIENT_RELEASE`. The api chooses the realm from the `Host` header (`EHR_STAFF_HOST` or `EHR_PATIENT_HOST`, port stripped). Cookies are `Secure` with the `__Host-` prefix.

Front ends (each in its own terminal; vite picks the next free port if 5173 is taken, so give each a port):

```sh
pnpm --filter @ehr/staff   run dev -- --port 5173    # proxies /api to API_ORIGIN
pnpm --filter @ehr/patient run dev -- --port 5174    # proxies /api to API_ORIGIN
PORT=8080 PUBLIC_API_ORIGIN=http://127.0.0.1:3000 pnpm --filter @ehr/site run start   # after pnpm build; marketing site
pnpm --filter @ehr/cms run dev                       # port 3100; needs the CMS variables and a CMS-role database
pnpm --filter @ehr/ui run gallery                    # component gallery (optional)
```

Checked while writing this guide: api and worker start and answer `/healthz` and `/readyz`; the staff dev server proxies `/api` to the api (`401` when signed out); the site starts and answers `/` with 200. **Not verified:** the patient dev server (it is the same vite setup as staff), `pnpm --filter @ehr/cms run dev` (needs Google OAuth values and a CMS database; only its tests were run), and a worker without `EHR_PATIENT_HOST`/`EHR_CHECKIN_QR_KEY`.

A worker left over from a previous run may log `identity.admin_event` failing with `kernel.validation_failed` for jobs of an earlier seeded run. Drop and re-prepare the database to clear it.

## 6. Signing in with synthetic users

There are no dev-login routes. Three identity paths exist:

- **Administrator realm (works end to end).** Sign-in uses WebAuthn. `scripts/ci/admin-stack.mjs` seeds these synthetic principals in `admin_pool`: `ci-admin` (roles `org_admin` and `compliance_officer`; the one the browser run signs in as, after enrolling the fixture's software security key), `ci-requester`, `ci-approver` and `ci-btg-holder` (holds one pending break-the-glass grant). Enrolment tokens are random, single use and exist only for the duration of the run. The realm accepts only `https://<EHR_STAFF_HOST>`; the run serves `https://staff.ci.test` through a loopback TLS front with a per-run self-signed certificate. `EHR_ENV=ci` and the fixture flag are refused outside CI by design.
- **Staff (Google Workspace) and patient (patient pool) realms.** `node scripts/ci/local-idp.mjs [port=9099] [sub] [email]` starts an OIDC identity provider that signs in whoever opens `/authorize` as one fixed synthetic identity (defaults `sub-ci-patient`, `patient@example.org`) and prints the endpoint variables to put into `EHR_PATIENT_OIDC_*` or `EHR_STAFF_OIDC_*` (client id `test-client`). A first sign-in creates a person and principal with **no roles**; staff roles need a role change request approved by a second person, patient access needs a patient link. **Not verified:** a complete staff or patient browser sign-in over plain `http://localhost` (cookies are `Secure`/`__Host-`), and staff sign-in through the CLI (the CLI sets no `hd` claim, which `EHR_STAFF_WORKSPACE_DOMAIN` requires). There is no local command that grants roles to a user.
- **QA accounts.** `tests/data/accounts.mjs` lists synthetic keys (`STF-FD-A`, `ADM-1`, `PAT-01`..`PAT-12`, ...) with `*.invalid` e-mail addresses and secrets read from `QA_SECRET_<KEY>`. The harness (`tests/e2e/harness/README.md`) does not wire sign-in itself.

## 7. Run the real stack end to end (administrator path)

One command starts the api, worker and built staff app behind the TLS front, drives Chromium through enrolment, sign-in, configuration, audit viewer and break-the-glass review, and writes screenshots:

```sh
pnpm build
node scripts/ci/migration-check/db-admin.mjs drop ehr          # only if ehr already exists / was seeded
scripts/ci/migration-check/prepare-db.sh ehr
eval "$(scripts/ci/install-browser.sh --env)"                  # Chromium paths
CI=true EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1 node scripts/ci/admin-stack.mjs
```

Output: `artifacts/admin-run/` (ten screenshots and `summary.json`) and `reports/admin-run/` (api, worker, preview and TLS front logs). Expect `admin run passed (7 steps)`. Self-tests that need neither database nor browser: `node scripts/ci/admin-stack.mjs --selftest` and `node scripts/ci/admin-run.mjs --selftest`.

## 8. Checks

Static checks and build (no database, no browser):

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test:boundary
```

Unit suites (no database; fails on skipped, failed or empty suites; reports in `reports/unit/`):

```sh
node scripts/ci/run-unit.mjs
```

Database checks (PostgreSQL 17, `EHR_TEST_ADMIN_URL` set, `pnpm build` done):

```sh
scripts/ci/migration-check/migration-check.sh                      # lint, migrate from empty, catalog rules, secret-reference lint
scripts/ci/migration-check/seed.sh migration-check                 # seeded-violation control; every seeded defect must be caught (about 90 s)
INTEGRATION_SKIP_N_MINUS_1=true scripts/ci/migration-check/integration-db.sh   # api, worker, kernel and db-foundation suites (about 3 min)
```

Without a release tag `r<N>` that is an ancestor of `HEAD`, the N-1 (upgrade) path cannot run; that is why it is skipped, and it is not a pass. N-1 runs against the newest rehearsal baseline tag (currently `r206`; `r133` is kept), which is not a release; see `scripts/ci/migration-check/README.md`. `seed.sh integration-db` is the control for the integration job. A single suite: `EHR_TEST_ADMIN_URL=... node --test apps/api/dist/src/<path>.dbtest.js`.

Cms database tests use their own throwaway CMS-role database and empty it:

```sh
# once, on the throwaway server: CREATE ROLE cms_ci LOGIN SUPERUSER; CREATE DATABASE cms_test OWNER cms_ci;
env -u DATABASE_URL CMS_TEST_DATABASE_URL=postgres://cms_ci@127.0.0.1:55432/cms_test pnpm --filter @ehr/cms run test:db
```

If `CMS_TEST_DATABASE_URL` is unset the suite is skipped, which CI treats as a failure.

Browser checks (Chromium installed and on the path, `pnpm build` done; none needs the api):

```sh
SMOKE_PROJECT=a11y NODE_PATH=$PWD/apps/staff/node_modules \
  pnpm --filter @ehr/staff exec playwright test -c ../../tests/e2e/smoke/playwright.config.ts --project=a11y
node tests/e2e/smoke/check-report.mjs reports/smoke/a11y-report.json 8     # staff accessibility smoke, 8 mocked scenarios
pnpm --filter @ehr/patient run test:a11y                                    # port 4174
pnpm --filter @ehr/site run test:a11y                                       # starts its own fake api
```

The patient and `packages/ui` checks both use port 4174: run them one at a time. `pnpm --filter @ehr/staff run test:a11y` is **stale on this revision** (see the table in section 10): use the smoke project above, which is what CI runs. Other browser tools: `node scripts/ci/browser-smoke.mjs <app-dir> <out-dir> <port> <route>...` (screenshots of built routes), `pnpm --filter @ehr/site run lighthouse` (needs Chrome).

Security and supply-chain checks (need `scripts/ci/install-tools.sh`; raw reports go to `reports/<job>/`; do not commit integration logs, test names trip gitleaks):

```sh
scripts/ci/install-tools.sh && scripts/ci/sast.sh && scripts/ci/secrets.sh && scripts/ci/deps.sh && scripts/ci/sbom.sh
node scripts/ci/check-workflow-hygiene.mjs
```

## 9. What refuses locally by design

These are not defects. A port that has no adapter configured refuses every call so that nothing silently pretends to work; the condition that lifts the refusal is a row of the conditions register in `docs/DELIVERY-PLAN.md` section 4. Mocks are never evidence for an external service.

| What you see                                                                                                                                                                      | Why                                                                                                                                                                                     | Lifted by (DELIVERY-PLAN) |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Worker job fails with `PortNotConfiguredError` / `port not configured: object_store`, `package_store`, `package_writer`, `audit_anchor_archive.*`; api throws `port not configured: object_store` / `package_store` | No object storage exists: no environment or hosting is authorised or chosen                                                                                                             | C-01, C-12                |
| `port not configured: secret_store`, `secret_writer`, `payload_sealer` (api), `payload_opener` (worker); admin routes that need a signer, tester, secret store or sealer return 503 | No secret store or payload sealer (key management) exists locally                                                                                                                       | C-01, C-12                |
| Email, SMS, push, video and Google Calendar calls fail as `VendorUnavailableError('disabled')` or error class `no_adapter`; calendar jobs also refuse for `calendar_channel_key` and `calendar_webhook_url` | The vendor gateway has an empty adapter registry and no vendor connection is enabled; no vendor is chosen and no sandbox or test tenant exists                                          | C-10 (sandboxes and Google test tenant), C-11 (vendor selection, BAAs) |
| Malware scanning: `port not configured: malware_scanner`; OCR suggestions are `skipped`                                                                                          | No scan or OCR vendor is chosen or available                                                                                                                                            | C-10, C-11                |
| The marketing site shows placeholder content; it does not read the CMS                                                                                                            | The site uses `placeholderContent` behind a `ContentSource` until the CMS runtime is decided and wired                                                                                  | C-19                      |
| Deletion requests are stored as `blocked_d8`; approving one returns 409 `privacy.blocked_on_decision`                                                                             | The meaning of deletion (D-8) is undecided; no data is deleted                                                                                                                          | C-05                      |

Also refusing, by the same mechanism, when their service wiring is missing: `scheduling_flow`, `telehealth`, `clinical`, `alerts`, `messaging`, `reporting`, `compliance_alerts`, `patient_execute_merge`, `privacy_assemble_export` and `audit_export_sink` (the first nine load only when the worker has `EHR_PATIENT_HOST`, `EHR_CHECKIN_QR_KEY` and a built api), and `terminology_source` (UMLS licence, C-09). The condition numbers above are looked up in the register, not in code: the code names the port, not the condition.

## 10. Observed on a clean checkout, not fixed here

| Item                                                                                                                      | Effect                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @ehr/staff run test:a11y` (`apps/staff/e2e/shell.a11y.spec.ts`) fails 3 of 3                                | The app now redirects a signed-out visitor to `/sign-in`, so the spec waits for text that no longer appears. CI uses the smoke project (section 8), which passes. |
| `tests/e2e/smoke/api-container.sh` starts the api with only five variables                                                  | By reading `apps/api/src/main.ts` the api needs the identity and admin variables as well; not run here (no Docker).                                                |
| `pnpm format:check` fails on `apps/cms/src/payload-types.ts` after `@ehr/cms` tests have run                                  | The file is git-ignored and generated by the cms tests; delete it (or run `format:check` before the cms tests). |
| `admin-stack.mjs` is not repeatable on a seeded database                                                                   | Drop and prepare `ehr` before each run.                                                                                                                           |

## 11. Known limits

No Docker daemon was available to the author of this guide, so `docker/compose.ci.yml`, the container image scan, and the `contract` and `e2e-smoke` jobs were not run; PostgreSQL 17.11 was run from a rootless binary with trust authentication on `127.0.0.1:55432` instead. No cloud environment exists; nothing is deployed. Deploy workflows exist but need an exact-environment G3 release decision and credentials.
