# QA automation harness (QA-02, HEAAA-109)

Source: TEST-CASES 0.2, 0.3, 2, 3; DEVOPS-PLAN 5.1, 5.3, 14. Bound environment: `ENV-INT/ci` (other names are accepted only so a result cannot claim a wrong binding; none is provisioned by this ticket).

| Part                             | Path                                               | Purpose                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic data and role accounts | `tests/data/`                                      | Deterministic generators (`generate.mjs <out> [--seed S] [--volume VOL-n --volume-limit N]`), accounts of TEST-CASES 2, SEED-FILES built in memory, identifier scan (TC-NFR-09) |
| Browser harness                  | `tests/e2e/harness/`                               | `playwright.config.mjs` (traces on, JUnit, no retries), `finalize.mjs` (validates JUnit, archives traces, writes `run-manifest.json`)                                           |
| API harness                      | `tests/api/harness/schemathesis-run.mjs`           | Schemathesis wrapper: target guard, rate cap, fixed seed, redacted bearer, JUnit gate, manifest                                                                                 |
| Self-tests                       | `node tests/e2e/harness/selftest.mjs [report-dir]` | 19 tests of the harness itself (not of the application). JUnit + manifest in `reports/qa-harness-selftest`                                                                      |

## Environment (all from the environment's secret store, never the repository)

- `QA_ENVIRONMENT` (required, e.g. `ENV-INT/ci`), `QA_CANDIDATE_COMMIT` (40 hex; defaults to `GITHUB_SHA` or `git rev-parse HEAD`).
- `QA_SECRET_<ACCOUNT>` per account, e.g. `QA_SECRET_STF_DR_A1`; `accounts.mjs#credentialsFromEnv` fails naming missing variables only.
- `QA_API_BEARER` (optional) for Schemathesis; `QA_FORBIDDEN_HOSTS` (production hosts, always refused); `QA_CI_SERVICE_HOSTS` (service container names `ENV-INT/ci` may target besides loopback).
- `QA_BASE_URL`, `QA_TEST_DIR`, `QA_REPORT_DIR` for the Playwright config; `QA_PLAYWRIGHT_BIN` if Playwright is not installed with `apps/staff`.

## Run (Playwright)

```sh
cd apps/staff && QA_ENVIRONMENT=ENV-INT/ci QA_BASE_URL=http://127.0.0.1:4173 QA_TEST_DIR=<specs> \
  node_modules/.bin/playwright test -c ../../tests/e2e/harness/playwright.config.mjs
node tests/e2e/harness/finalize.mjs reports/qa-e2e --min-tests <expected>
```

A green exit status alone is not evidence: `finalize.mjs` fails on an empty run, fewer tests than expected, any failure or skip, missing traces or an undeterminable tool version.

## Limits

- Authoring no case: TC- case specs are later tickets. Sign-in against the real identity slice (conformance IdP, Cognito, Google test tenant) is not wired here; accounts are identities plus environment-supplied secrets only.
- Schemathesis is not installed in the authoring workspace; the wrapper is tested with a fake binary (runner logic only). It still needs a run with the pinned version (4.33.1, as in `tests/e2e/smoke/contract/run.sh`).
- `playwright.config.mjs` uses `trace: 'on'`; API-only specs produce no `trace.zip` (`traces.traceZips` is recorded in the manifest).
