# HEAAA-211: non-root browser runner and migration 0704 environment check

Author: DevOps Engineer. Review: DevOps Reviewer (independent). No credentials in this file.

## 1. Browser runner (non-root, no apt)

Executed 2026-11-07 on the Integrator host (uid 1000, Debian, no apt):

1. Browser binary (needs network to cdn.playwright.dev, no root):
   `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers pnpm exec playwright install chromium`
   (installed chromium-1248 + headless shell; Playwright 1.64.1 from the repo lockfile).
2. System libraries (glib, nss, X11, gbm, ... ) extracted from Debian `.deb` files into a user directory, no install:
   `fetchlibs.py` (this folder, from the FE-04 run) downloads the packages and their missing dependencies from deb.debian.org and unpacks them under `/tmp/fe04-libs`. It needs `/tmp/fe04-debs/Packages.xz` (the Debian `Packages` index) first. A prepared copy exists at `/tmp/fe04-libs` on this host.
3. Run with:
   ```
   export PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers
   export LD_LIBRARY_PATH=/tmp/fe04-libs/usr/lib/x86_64-linux-gnu
   export FONTCONFIG_FILE=/tmp/fe04-libs/fonts.conf
   pnpm --filter @ehr/patient exec playwright test   # or any script using @playwright/test
   ```
   Add `--no-sandbox` launch args if the container forbids user namespaces.

Verification (executed): from `apps/patient`, `chromium.launch()` + `setContent` + `screenshot` succeeded with
Chromium 156.0.8078.4 (screenshot 5356 bytes). `ldd` on the headless shell showed no missing libraries.
Not executed: the FE-04 specs themselves and the booking-journey screenshots (they need the app and
fixtures running; that is the Integrator's/QA's run). Limit: `/tmp` is not persistent across hosts; repeat steps 1-2 on a new host.

## 2. INT02-R5-N1: was migration 0704 applied anywhere before the in-place edit?

Evidence checked (repository and Paperclip records):
- `db/migrations/0704_patient_matching_registration.sql` was added in 233d88e (BE-08, 2026-11-06) and edited in c57f700 (2026-11-07). One day apart, both unmerged feature work.
- No release tag, no deployment evidence, no environment inventory in the repository.
- Paperclip: G3 (HEAAA-34) is `backlog`, deploy (HEAAA-35) and release-plan (HEAAA-33) are `blocked`. No G3 has been granted, so no deployment credential was released and no DEVOPS-PLAN environment (staging/production) has been provisioned or deployed (DEVOPS-PLAN: configuration is plan only until G2/G3; first production release is targeted May 2027).

Conclusion: **no persistent environment has applied 0704.** The only databases that applied either revision are ephemeral CI and local test databases created from empty. The in-place edit is acceptable; no forward migration is required on environment grounds.
Limit: this is a negative finding from the available records. I have no cloud access and cannot enumerate unrecorded developer databases; any long-lived local database that ran 233d88e's 0704 must be recreated (the db-foundation checksum guard would flag it).
