# FE-10 evidence manifest (HEAAA-125)

Base commit (prerequisite merges, unchanged): 914d50d9fd78eec38553c197340527ba53b1fa31. Candidate = the commit that adds this folder; diff: `git diff 914d50d9fd78eec38553c197340527ba53b1fa31 -- apps/staff/src/features/doctor`.
Tools: node v24.22.2, vitest/5.1.0 linux-x64, playwright Version 1.64.1, chromium headless shell 1248 (axe-core 4.14.0 via @axe-core/playwright in the specs), pnpm 12.16.1.

| Check                                                                                                                 | Command (from apps/staff unless noted)                                      | Raw report                                 | Result                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Typecheck                                                                                                             | `pnpm exec tsc -p tsconfig.json --noEmit`                                   | raw/typecheck-staff.txt                    | exit 0                                                                                                                    |
| Unit (jsdom, whole staff app incl. 22 doctor tests)                                                                   | `NODE_ENV=test pnpm exec vitest run`                                        | raw/unit-staff.txt                         | 9 files, 104 tests passed                                                                                                 |
| Playwright PR subset + axe (wcag2a/aa, 21aa, 22aa; serious/critical fail) on every screen, desktop 1280 and phone 390 | `pnpm exec playwright test -c src/features/doctor/e2e/playwright.config.ts` | raw/playwright.txt, playwright-report.json | 14 passed                                                                                                                 |
| Lint                                                                                                                  | `pnpm exec eslint apps/staff/src/features/doctor` (root)                    | raw/lint.txt                               | exit 0                                                                                                                    |
| Format                                                                                                                | `pnpm exec prettier --check apps/staff/src/features/doctor` (root)          | raw/format.txt                             | exit 0                                                                                                                    |
| Frozen-lockfile install                                                                                               | `pnpm install --frozen-lockfile --filter @ehr/staff...`                     | n/a                                        | succeeded; no dependency added                                                                                            |
| Secret scan, dependency scan, SAST, container scan                                                                    | CI tools (gitleaks, osv, semgrep, trivy)                                    | n/a                                        | NOT RUN: tools are not installed in this sandbox. No dependency was added; no credential is in code, tests or screenshots |

All API traffic in these tests is contract mocks; no real API/DB/identity provider was exercised. Dependencies added: none. Conditions touched: C-03, C-16 (UI side only).
Screenshots (sha256):

```
4e4fe116fcac20044a05e522377b30c6d8847027623a2f5f85d6ee7f9a7b136b  desktop-1-schedule.png
d1379ace83fdf93d9e67a0aad3ce68282419cc5e71ca3c30da07ed8dbcbedf67  desktop-10-video-notes.png
a3f877c32a2c6fcfa1401ff9440ec63b24ead082a5fe5cb5c301b3074ad07e0f  desktop-11-cosign-queue.png
dfbd9b65c830fc689db0eee0a44f4689eee364a53f9f125914263ea99dfa5646  desktop-2-chart-note.png
a65bdfae3a046c46a2dd033450aaf4138173b63ee29b90a94b5f5f95256f85e5  desktop-3-sign-dialog.png
9937bd9e73836cc6362cfcd3011ef8062b0adde355c98cf3cdc54a4b8250056e  desktop-4-reauth.png
2f69de409a84d1428704a0c608b5b352ea8728c71a69cb5a3e9aca17a5bc8671  desktop-5-signed-addendum.png
1e2b2de686c430e48cea3d1e3e3f264b184175754098880220300b6fc3b83a33  desktop-6-btg-dialog.png
96a129e51629254a6f3d8b417e27066e528a9e18182194b8dfcd3f0bd52b79e8  desktop-7-emergency-access.png
2e62ad510d1fd3706a2018b4d5aff008f0ae3cd200212158db75d0a74251c34a  desktop-8-alert-tray.png
4fb1ef3d8afb0c1b0cb46669e9ca4125470f7cc9508df998d629290706ce9197  desktop-9-alerts-paused.png
b141ed94c05adac512a98e9d2eed594b5f4b51a5d98b64789acf2098b0e0a4ef  phone-1-schedule.png
e08c302fdd9142819cdd10276433a17e8f0b7d78b0a10d1f09aadd7fd0411888  phone-10-video-notes.png
fc51ae6a3ea52c34f89f0ba4a98bcd24b1432dc5f21fd8591aaf2ccb560d57c4  phone-11-cosign-queue.png
a0a0f1b7f62fbb47d267f75d45fe57a97bcdde2eb3a102b01c6e7b56ab7ea51a  phone-2-chart-note.png
88365e79fc74b2406b5ac541747075e32feb734fc0d173908a9fda4f5c2d0fa6  phone-3-sign-dialog.png
5efd465392ceb5b66d1499a75c922cd4adbba7b097125d9af93a32f03952a214  phone-4-reauth.png
a0737848af50375fc493c900c7cef205e5aaf1f8f93f573b893b3142b5967152  phone-5-signed-addendum.png
5bcb6a926d775de071ae074b52ea08ef5b2d814f0783e363c0f95f9f3c7b9be4  phone-6-btg-dialog.png
d875f2a0cce77ea141a61c5b88a1edd8c26fa8f1b77bdf0a93ff9f7307fa23a4  phone-7-emergency-access.png
730aedff6e734427e820b8cbea950586ddc764b0183ee1d0132dd7f60d7d2aea  phone-8-alert-tray.png
34fc0f02f2d7a1cfa97bd9e32a8d109e6f8080edf7829efb42b05b41fc5c7d09  phone-9-alerts-paused.png
```
