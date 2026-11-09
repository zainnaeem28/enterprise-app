# FE-13 evidence manifest

Candidate: see the commit that adds this file (git log of this branch). Base: FE-17 `e526377`. Tools: pnpm 12.16.1, node 24.22.2, vitest 5.1.0, @playwright/test 1.64.1 (Chrome Headless Shell 156), axe-core 4.14.0 (WCAG 2a/2aa/21aa/22aa, serious+critical fail).

| Check                                         | Command (from `apps/staff`)                                                           | Result               | Raw                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------ |
| Type check                                    | `pnpm exec tsc -p tsconfig.json --noEmit`                                             | exit 0               | raw/typecheck.txt                          |
| Lint                                          | `pnpm exec eslint apps/staff/src/features/admin-compliance` (repo root)               | exit 0               | raw/eslint.txt                             |
| Format                                        | `pnpm exec prettier --check apps/staff/src/features/admin-compliance`                 | exit 0               | raw/prettier.txt                           |
| Unit (feature) incl. jsdom axe on 4 screens   | `NODE_ENV=test pnpm exec vitest run src/features/admin-compliance`                    | 26 passed            | raw/unit.txt                               |
| Unit (whole staff app, no regression)         | `NODE_ENV=test pnpm exec vitest run`                                                  | 14 files, 213 passed | raw/unit-whole-staff-app.txt               |
| Playwright PR subset + axe, desktop and phone | `pnpm exec playwright test -c src/features/admin-compliance/e2e/playwright.config.ts` | 12 passed            | raw/playwright.txt, playwright-report.json |

Screenshots (actual candidate, mocked API): `screenshots/{desktop,phone}-1..8-*.png`.

## Not run / limitations

- Secret scan, dependency scan, SAST, container scan: no tool or CI runner available in this workspace; CI on the integrated candidate must run them. No dependency was added.
- Playwright needed system libraries Chrome lacks in this sandbox; they were fetched (checksum-verified Debian packages) into a temp dir and used via `LD_LIBRARY_PATH`. Nothing outside this worktree changed.
- Contract mocks only; no real API/DB/security key (Pending-human). See README for the missing role-change read route and the wiring request.
