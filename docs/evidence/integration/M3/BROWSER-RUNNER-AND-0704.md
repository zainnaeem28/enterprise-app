# HEAAA-211: non-root browser runner and migration 0704 environment check

Author: DevOps Engineer. Review: DevOps Reviewer (independent). No credentials in this file.

## 1. Browser runner (non-root, no apt)

Executed 2026-11-07 on the Integrator host (uid 1000, Debian, no apt):

1. Browser binary (needs network to cdn.playwright.dev, no root):
   `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers pnpm exec playwright install chromium`
   (installed chromium-1248 + headless shell; Playwright 1.64.1 from the repo lockfile).
2. System libraries (glib, nss, X11, gbm, ... ) extracted from Debian `.deb` files into a user directory, no install. Host is Debian 13 (trixie); suite `trixie`, mirror `https://deb.debian.org/debian/`. Exact command (re-executed 2026-11-07 into an empty directory; it reproduced the original run: 68 packages, index identical):
   ```
   FETCHLIBS_DEBS=/tmp/fe04-debs FETCHLIBS_LIBS=/tmp/fe04-libs \
   python3 -I docs/evidence/integration/M3/fetchlibs.py \
     libxcomposite1 libpango-1.0-0 libxdamage1 libcups2t64 libasound2t64 libnss3 \
     libgbm1 libxkbcommon0 libxrandr2 libcairo2 libatk-bridge2.0-0t64 libxfixes3
   ```
   The script itself downloads `dists/trixie/Release` and `main/binary-amd64/Packages.xz` (no manual step), resolves dependencies, skips what dpkg already has, and writes `MANIFEST.txt` (name, version, SHA256) into `FETCHLIBS_DEBS`. Paths, suite and mirror are set by env (`FETCHLIBS_DEBS`, `FETCHLIBS_LIBS`, `FETCHLIBS_SUITE`, `FETCHLIBS_BASE`).
   - Package list provenance: the original FE-04 argument list was not recorded. The 12 packages above are the leaf set (nothing else in the fetched set depends on them) reconstructed from the 68 packages that run unpacked; their dependency closure is exactly that set. Browser needs on a different host may differ because already-installed packages are skipped.
   - Index: `trixie` is a moving suite. The run used `Packages.xz` SHA256 `7778d3e3f303b7ddb8ce0fe7c8d57473a076c6bf2e8f241f75421d2396352498` (e.g. libnss3 2:3.110-1+deb13u4); it was still current on 2026-11-07. Later runs may fetch newer versions; compare against `MANIFEST.txt`.
   - Integrity (F-RUN-2): `Packages.xz` is checked against the SHA256 in the suite `Release` file, and each `.deb` against the SHA256 in `Packages`; a mismatch aborts before unpacking. Residual risk, accepted for a throwaway test host only: the `Release` file is fetched over HTTPS but its GPG signature (`InRelease`) is not verified (no `gpgv` on the runner), so trust rests on TLS to deb.debian.org. Do not use this for production images; use apt or a pinned snapshot there.
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
