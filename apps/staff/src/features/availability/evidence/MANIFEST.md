# FE-11 evidence manifest (HEAAA-123)

Base commit (prerequisite merges, unchanged): 15d6cb7 (FE-08, BE-12, BE-14, FE-07 and later backend conformance). Candidate = the commit that adds this folder; diff: `git diff 15d6cb7 -- apps/staff/src/features/availability`.
Tools: node v24.22.2, pnpm 12.16.1, vitest/5.1.0 linux-x64, playwright Version 1.64.1, chromium headless shell 1248, axe-core 4.14.0 via @axe-core/playwright in the spec.

| Check                                                                                                                                                                                             | Command (from apps/staff unless noted)                                            | Raw report                                 | Result                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Typecheck                                                                                                                                                                                         | `pnpm exec tsc -p tsconfig.json --noEmit`                                         | raw/typecheck-staff.txt                    | exit 0                                                                                                                    |
| Unit (jsdom, whole staff app incl. 42 availability tests)                                                                                                                                         | `NODE_ENV=test pnpm exec vitest run`                                              | raw/unit-staff.txt                         | 11 files, 148 tests passed                                                                                                |
| Playwright PR subset + axe (wcag2a/aa, 21aa, 22aa; serious/critical fail) on hours list, editor, affected appointments, leave, calendar x4 states, return from Google; desktop 1280 and phone 390 | `pnpm exec playwright test -c src/features/availability/e2e/playwright.config.ts` | raw/playwright.txt, playwright-report.json | 16 passed                                                                                                                 |
| Lint                                                                                                                                                                                              | `pnpm exec eslint apps/staff/src/features/availability` (root)                    | raw/lint.txt                               | exit 0                                                                                                                    |
| Format                                                                                                                                                                                            | `pnpm exec prettier --check apps/staff/src/features/availability` (root)          | raw/format.txt                             | exit 0                                                                                                                    |
| Frozen-lockfile install                                                                                                                                                                           | `pnpm install --frozen-lockfile --filter @ehr/staff...`                           | n/a                                        | succeeded; no dependency added                                                                                            |
| Secret scan, dependency scan, SAST, container scan                                                                                                                                                | CI tools (gitleaks, osv, semgrep, trivy)                                          | n/a                                        | NOT RUN: tools are not installed in this sandbox. No dependency was added; no credential is in code, tests or screenshots |

All API traffic in these tests is contract mocks; no real API/DB/Google service was exercised. Dependencies added: none. Conditions touched: C-10 (UI side, unverified live), C-16.
Screenshots (sha256):

```
14165a13e5d6baa14e48e13f08ea96abab588ad1d3da846bcd620c1a36e49b24  desktop-1-hours-list.png
6b8291a91a639f0e4ba69f258b92b1ba675c24370cf32f7ac72f0d99f70d79ed  desktop-2-hours-editor.png
3ec33a3a274de11d2276af25cde0d5470a8c7640d04196b100a3123b1819184c  desktop-3-hours-affected.png
07029a85f425d9b2a3219b440b9f792cc246f01cbe5a3319f748d7be2fe3fcd0  desktop-4-calendar-not_linked.png
358f55b3f51303354780eab8cfcf49c00f769dfeabec74517a475803b02f7a57  desktop-5-calendar-active.png
be5e75fde2cc326f9baf4910fc8e2d608ba56edf7c91ab49bde9815ac1f0ebe6  desktop-6-calendar-token_revoked.png
77db614b62540b3ff499f148b5adce70cb08a36c48f1cadda878d2cfa4233ba4  desktop-7-calendar-error.png
f72b3e976d24c5a806e22c2d2926da02ca8650d41d9b8f5083879181dd5a8857  desktop-8-calendar-denied.png
9e411519ccb6797f2760baedb77aa061e0a230ad7850bc5f42a7078cd1648b30  desktop-9-leave-affected.png
c0f9752d41462a270d38de226b61044f9ed6aef25ad8edda244d94843ce32cee  phone-1-hours-list.png
74571cb6b9764b73b8e90dfedb3a9df24b0537a539b6e02d69d3ce915ed0899f  phone-2-hours-editor.png
2f6ac0571ce2b38e07210d18c93eb607d9ee3d85ffc07c955194a7261c59033d  phone-3-hours-affected.png
5d338f8f69e5a38ce715354ec0937593eddfc60c354065b2b0c2554e61371298  phone-4-calendar-not_linked.png
14e89feaf8970171a5baaaf1f4b025adc90597f4ec97d112bd4a499e6e6792b3  phone-5-calendar-active.png
d3a6c19fa0183f5a4cb5c192038d1b85c940e239548ebf5b4c76b17d5cb8929c  phone-6-calendar-token_revoked.png
422a6c8150efda88acd47d0f7a44f56c2ffaaeaf0d07405ecd586d65d283608f  phone-7-calendar-error.png
bf720758315151243ff72c1ec2681ec9b432d47bae4b9830defca6da8fd5cea7  phone-8-calendar-denied.png
582e30e13b38a70ec30da2fa484e21c78963c3637deda30addc8b2c719e3ff2b  phone-9-leave-affected.png
```
