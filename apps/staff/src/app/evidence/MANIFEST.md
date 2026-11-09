# INT04-F15 evidence (fixes INT04-F03-R1 and R2)

Base: HEAAA-139 tip `c067035`; F03 commit rebased on it. Candidate commit: see the submission comment.

| Check                                                                                     | Tool                                   | Command (in `apps/staff`)                                       | Result                                                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Unit + jsdom axe (whole staff app, incl. 11 admin screens, admin sign-in, sign-in link)   | vitest 5.1.0, axe-core                 | `NODE_ENV=test pnpm exec vitest run`                            | 278 passed                                                                                  |
| Playwright + axe in Chromium (layout, contrast), real `StaffApp` entry, desktop and phone | @playwright/test, @axe-core/playwright | `pnpm exec playwright test -c src/app/e2e/playwright.config.ts` | 24 passed, 0 axe violations (`raw: playwright.txt`, `playwright-report.json`, `axe/*.json`) |
| Type check                                                                                | tsc                                    | `pnpm exec tsc -p tsconfig.json --noEmit`                       | pass                                                                                        |
| Lint / format                                                                             | eslint, prettier                       | on `src/app`, `src/features/auth`, `src/features/admin-config`  | pass                                                                                        |

Axe tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice. `axe/<project>-<screen>.json` holds one result per screen.
Screenshots (`screenshots/`, desktop and phone): staff sign-in with the Administrator sign-in link, admin sign-in, and the 11 admin screens.

Fixes: R1 `AdminSignInLink` composed into `/sign-in` below the Google button (`StaffApp.tsx`, `SignInPage.tsx` slot). R2 axe evidence added; it found `landmark-unique` on `/admin/policies` (nested sections with the same label), fixed in `Policies.tsx`.

Limits: API traffic is a CONTRACT MOCK (session and empty lists); no real API, database or security key ran. Chromium ran with libraries and fonts from `/tmp` (Liberation/DejaVu fallback fonts, not the brand font).
