# FE-14 evidence manifest

Candidate: the commit that adds this file (git log of this branch). Base: FE-13 `0214e00` (includes FE-17 `e526377`), merged with BE-23 `1a5f4e1` (clean merges, no conflicts).
Tools: pnpm 12.16.1, node 24.22.2, vitest 5.1.0, @playwright/test 1.64.1 (Chrome Headless Shell), axe-core 4.14.0 (WCAG 2a/2aa/21aa/22aa, serious+critical fail).

| Check                                         | Command                                                                           | Result               | Raw                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------- | -------------------- | ------------------------------------------ |
| Type check                                    | `pnpm exec tsc -p tsconfig.json --noEmit` (apps/staff)                            | exit 0               | raw/typecheck.txt                          |
| Lint                                          | `pnpm exec eslint apps/staff/src/features/admin-config` (root)                    | exit 0               | raw/eslint.txt                             |
| Format                                        | `pnpm exec prettier --check apps/staff/src/features/admin-config`                 | exit 0               | raw/prettier.txt                           |
| Unit (feature) incl. jsdom axe on 7 screens   | `NODE_ENV=test pnpm exec vitest run src/features/admin-config`                    | 35 passed            | raw/unit.txt                               |
| Unit (whole staff app)                        | `NODE_ENV=test pnpm exec vitest run`                                              | 15 files, 248 passed | raw/unit-whole-staff-app.txt               |
| Playwright PR subset + axe, desktop and phone | `pnpm exec playwright test -c src/features/admin-config/e2e/playwright.config.ts` | 10 passed            | raw/playwright.txt, playwright-report.json |

Acceptance mapping: save with audit (server-side; UI says so and sends If-Match/ids) · secrets write-only (unit + e2e assert absent from DOM, field cleared) · integration test and health (unit + e2e) · block-only cancellation (policies unit/e2e) · neutral display name (services unit/e2e).
Screenshots (actual candidate, mocked API): `screenshots/{desktop,phone}-1..6-*.png`.

## Not run / limitations

- Secret scan, dependency scan, SAST, container scan: no tool or CI runner in this workspace; CI on the integrated candidate must run them. No dependency was added.
- Playwright needed system libraries and a font that this sandbox lacks; they come from checksum-verified Debian packages unpacked under /tmp and used via `LD_LIBRARY_PATH`/`FONTCONFIG_FILE`. Nothing outside this worktree changed.
- Contract mocks only (see README: opaque integration/vital-range rows, integration admin routes not built). Physical security key is Pending-human.
- Independent review (Frontend Reviewer) not yet done.
