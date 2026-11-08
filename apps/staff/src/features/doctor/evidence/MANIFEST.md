# FE-10 evidence manifest (HEAAA-125)

Base commit (prerequisite merges, unchanged): 914d50d9fd78eec38553c197340527ba53b1fa31. Candidate = the commit that adds this folder; diff: `git diff 914d50d9fd78eec38553c197340527ba53b1fa31 -- apps/staff/src/features/doctor`.
Tools: node v24.22.2, vitest/5.1.0 linux-x64, playwright Version 1.64.1, chromium headless shell 1248 (axe-core 4.14.0 via @axe-core/playwright in the specs), pnpm 12.16.1.

| Check                                                                                                                 | Command (from apps/staff unless noted)                                      | Raw report                                 | Result                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Typecheck                                                                                                             | `pnpm exec tsc -p tsconfig.json --noEmit`                                   | raw/typecheck-staff.txt                    | exit 0                                                                                                                    |
| Unit (jsdom, whole staff app incl. 24 doctor tests)                                                                   | `NODE_ENV=test pnpm exec vitest run`                                        | raw/unit-staff.txt                         | 9 files, 106 tests passed                                                                                                 |
| Playwright PR subset + axe (wcag2a/aa, 21aa, 22aa; serious/critical fail) on every screen, desktop 1280 and phone 390 | `pnpm exec playwright test -c src/features/doctor/e2e/playwright.config.ts` | raw/playwright.txt, playwright-report.json | 14 passed                                                                                                                 |
| Lint                                                                                                                  | `pnpm exec eslint apps/staff/src/features/doctor` (root)                    | raw/lint.txt                               | exit 0                                                                                                                    |
| Format                                                                                                                | `pnpm exec prettier --check apps/staff/src/features/doctor` (root)          | raw/format.txt                             | exit 0                                                                                                                    |
| Frozen-lockfile install                                                                                               | `pnpm install --frozen-lockfile --filter @ehr/staff...`                     | n/a                                        | succeeded; no dependency added                                                                                            |
| Secret scan, dependency scan, SAST, container scan                                                                    | CI tools (gitleaks, osv, semgrep, trivy)                                    | n/a                                        | NOT RUN: tools are not installed in this sandbox. No dependency was added; no credential is in code, tests or screenshots |

All API traffic in these tests is contract mocks; no real API/DB/identity provider was exercised. Dependencies added: none. Conditions touched: C-03, C-16 (UI side only).
Screenshots (sha256):

```
d04c7583c8b96053967384edb3db04e28b96c6365bd592f29c9223250753fe85  desktop-1-schedule.png
d1379ace83fdf93d9e67a0aad3ce68282419cc5e71ca3c30da07ed8dbcbedf67  desktop-10-video-notes.png
4aac96864969aa8f33db3d63e9562cf8451edb128d11b7e4fd8c8186fbc446e6  desktop-11-cosign-queue.png
19dd92c6b5440c006d59767d39a13faa98efee38db76f3833fa96dc90d7cbbe0  desktop-2-chart-note.png
fcd8fcc2d39d08e0a13a38da9c6b57d87ada31033f97239bf3c5664848b3aaec  desktop-3-sign-dialog.png
fb5ce5d7433a022296ef5b5dd3c5ddcf300f4dd2302d218a359381a159962b18  desktop-4-reauth.png
d6047c8901ac8121136082a5056ec2b7647450e8ef533288f2f2e8e5936e66b2  desktop-5-signed-addendum.png
1e2b2de686c430e48cea3d1e3e3f264b184175754098880220300b6fc3b83a33  desktop-6-btg-dialog.png
88e5415f3460901e7288de2cfc47db12705e10338fa613e174cc5ddbd74026dd  desktop-7-emergency-access.png
fe95eaa78da1a37338f1936bbfa1efe3fc5f6f0c6899e4ac0ab7964227cce876  desktop-8-alert-tray.png
0549e3290e67b532deb7d731119fb639fd17ade3544eb6d71aa4757a05285896  desktop-9-alerts-paused.png
406184436c1bd5d381ae8f35225d9f8f61467101bea361507cbd4062ba6931a2  phone-1-schedule.png
e08c302fdd9142819cdd10276433a17e8f0b7d78b0a10d1f09aadd7fd0411888  phone-10-video-notes.png
c0dbdec085861d72d13f55782af25c94b802023211ec6439249d53459a757b56  phone-11-cosign-queue.png
93a65721972e2e6e81670b930c3de29b4d325eee194f903e9fbf02ca5c2283d8  phone-2-chart-note.png
2cd6b59932fa31b381c58002c8d22d7d5f04c371c9741b28375cec46180bf680  phone-3-sign-dialog.png
04dd570aa44ef6bcc83b8100de1b312b3996283ea0619654efc4d503be01d93a  phone-4-reauth.png
189efb59e692a3de2b7da6b60c0fd0b3679c694e603dd167decef0c417a19391  phone-5-signed-addendum.png
5bcb6a926d775de071ae074b52ea08ef5b2d814f0783e363c0f95f9f3c7b9be4  phone-6-btg-dialog.png
0800d279cc5df1c01b6eb1e63a4181fa23df111008dccc2a669aa183e6671902  phone-7-emergency-access.png
5371d05f19d50179ee7f808479ef051aac6a7362c8868553202c94e80447be08  phone-8-alert-tray.png
58dd9b3ef89c130ee20622876c72e2dc568d74cb9180cd32e480caed030946eb  phone-9-alerts-paused.png
```
