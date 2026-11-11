# HEAAA-819 (R3-F01) local results

Base: origin/dev f22dc62. Synthetic data only. Not run: hosted CI (owner ruling B: no hosted CI).

* `NODE_ENV=test npx vitest run` (apps/staff): 15 files, 284 tests passed (includes new check-in banner, triage-without-triage wrapped-shape banner, workspace banner placement tests; desk.test.tsx mock now returns `{ patientBanner }`).
* `tsc -p apps/staff/tsconfig.json --noEmit`, eslint on features/doctor and features/preconsult: clean.
* Real browser (Playwright 1.64.1, headless Chromium, doctor harness with contract-mocked API): `pnpm exec playwright test -c src/features/doctor/e2e/playwright.config.ts`: 20 passed. New test "banner stays in view while scrolling the whole workspace" at 1280x900, 640x450 (200% zoom), 360x740, scrolls to the note and Sign button and asserts the banner (name, DOB) is in the viewport. With the fix reverted the test fails. Note: this sandbox has no system fonts, so a font file was supplied through FONTCONFIG_FILE for the run.
* Not executed: preconsult Playwright config, full-stack run with real API (mock only), DR-04/05/06 dialogs scrolled (they carry name and DOB by props; modal over the sticky banner).
