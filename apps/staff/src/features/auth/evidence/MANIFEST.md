# FE-08 evidence manifest

Base: `fafd13f` (tip of FE-06 branch; contains FE-02 app shell and BE-04 identity core). Candidate commit: see the submission comment.

| Check                               | Tool / version                                                      | Command (from `apps/staff`)                                               | Raw report                                     | Result                                                   |
| ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| Unit + jsdom axe                    | vitest 5.1.0, axe-core 4.14.0                                       | `NODE_ENV=test pnpm exec vitest run`                                      | `raw/unit-staff.txt`                           | pass                                                     |
| Playwright + axe (layout, contrast) | @playwright/test 1.64.1, @axe-core/playwright 4.14.0, Chromium 1248 | `pnpm exec playwright test -c src/features/auth/e2e/playwright.config.ts` | `raw/playwright.txt`, `playwright-report.json` | 10 passed (desktop and phone), rerun after round 1 fixes |
| Type check                          | tsc 5.9.3                                                           | `pnpm exec tsc -p tsconfig.json --noEmit`                                 | `raw/typecheck-staff.txt`                      | pass                                                     |
| Lint                                | eslint 10.14.0                                                      | `pnpm exec eslint apps/staff/src/features/auth apps/staff/src/app`        | `raw/lint.txt`                                 | pass                                                     |
| Format                              | prettier 3.9.10                                                     | `pnpm exec prettier --check ...`                                          | `raw/format.txt`                               | pass                                                     |

The Playwright run uses a CONTRACT MOCK of the identity endpoints. It is not the local OIDC conformance IdP run. Screenshots: `screenshots/` (desktop and phone: sign-in, sign-in problem, doctor, front desk, idle warning, signed out, session ended).
