# Browser, contract and budget jobs (F-09, HEAAA-79)

Source: DEVOPS-PLAN 5.1 (AL-07), 14; TEST-CASES 0.2, 0.3 (`ENV-INT/ci`); NFR-7. Jobs in `.github/workflows/ci.yml`; raw reports in `reports/<job>/`.

| Job             | Entry point                                                                                | Tool (pinned)                                  | Blocks on                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract`      | `contract/run.sh`                                                                          | Schemathesis 4.33.1 (pip, runner only)         | any response violating its documented schema, status, content type or headers; a 5xx; an implemented route missing from OpenAPI; an empty selection or run |
| `a11y-smoke`    | Playwright project `a11y` + `@axe-core/playwright` (versions in `apps/staff/package.json`) | Chromium from Playwright                       | serious or critical axe violation in any of 4 shell states at 1280 px and 360 px; fewer than 8 tests; any skip                                             |
| `e2e-smoke`     | Playwright project `e2e`                                                                   | Playwright (as above)                          | any failure; fewer than 6 tests; any skip or flaky test                                                                                                    |
| `bundle-budget` | `bundle-gzip.mjs`, `lighthouserc.cjs`                                                      | Lighthouse CI 0.16.0 (`pnpm dlx`, runner only) | JS above 120 KiB gzip; LCP above 2.5 s (simulated 4G, median of 3); script weight above 300 KiB; TBT above 300 ms; CLS above 0.1; no report                |

`seed.sh <job>` is the seeded-violation control that ends each job (a broken copy of the build, or a stub server, must fail the gate for the stated reason).

## What each job covers today

- **contract** tests only the documented operations the API implements. `select-operations.mjs` compares the API's route inventory with the bundled OpenAPI; today that is `GET /api/v1/alerts/stream` (1 of 252 documented). The count is printed and stored in `selection.json`; the rest are `notYetImplemented`, not passed. The API runs in the pinned Node image against the built workspace (`api-container.sh`), because the repository has no Dockerfile.
- **e2e-smoke** runs the built shell through `vite preview` with `/api` forwarded to that API container (same origin, no CORS). Only the first two journeys use the real API; the release-dialog and release-bar journeys use contract mocks of documented problem+json responses.
- **a11y-smoke** answers the API with contract mocks (no API needed). Automated rules find only part of WCAG; the manual audit is not replaced (DEP-17).
- **bundle-budget** measures the shell served by `vite preview` (no compression), so script sizes are raw bytes.

## Run locally

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @ehr/staff exec playwright install --with-deps chromium
SMOKE_PROJECT=a11y NODE_PATH=$PWD/apps/staff/node_modules \
  pnpm --filter @ehr/staff exec playwright test -c ../../tests/e2e/smoke/playwright.config.ts --project=a11y
node tests/e2e/smoke/check-report.mjs reports/smoke/a11y-report.json 8
```

`NODE_PATH` lets the specs under `tests/` import `@playwright/test` from the staff package; `tests/` is not a workspace package.
