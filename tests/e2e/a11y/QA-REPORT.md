# QA-06 report: automated accessibility and browser matrix (TC-A11Y-01, automated parts of TC-A11Y-04/05/06 and TC-XB-01)

Candidate: commit `00faee1709d38e8a21254856a1fbedd7697294f0` plus the uncommitted `tests/e2e/a11y/**` of this ticket (committed on branch HEAAA-145). Environment: `ENV-INT/ci`-equivalent local run on the built staff, patient and brand-site artefacts (`vite preview` and `apps/site/dist/server/server.js`).
Tools: Playwright 1.64.1, @axe-core/playwright 4.14.0 (tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa), Chromium headless shell 156.0.8078.4.
Command: `QA_BROWSERS=chromium NODE_PATH=$PWD/apps/staff/node_modules pnpm --filter @ehr/staff exec playwright test -c ../../tests/e2e/a11y/playwright.config.ts`
Raw evidence: `evidence/report.json` (axe summaries attached per test), `evidence/junit.xml`, `evidence/run.log`.

## Result: PASS for the automated parts on all three engines. Chromium 125, Firefox 125, WebKit 125 passed; 0 failed, 0 flaky, 0 skipped.

| Case | Scope | Chromium | Firefox | WebKit |
| --- | --- | --- | --- | --- |
| TC-A11Y-01 | axe, serious/critical fail, on 58 key pages (staff signed-out, desk, doctor and administrator realms; patient portal; brand site incl. 404) at 1280 px and 360 px = 116 scans, each with a non-empty rule count and a visible landmark and heading | pass, no serious/critical violations, `KNOWN_EXCEPTIONS` empty | pass | pass |
| TC-A11Y-04 (automated) | no horizontal scroll at 360 px on every page | pass | pass | pass |
| TC-A11Y-05 (automated) | forced-colors and reduced-motion render on the site | pass | pass | pass |
| TC-A11Y-06 (automated) | empty "Link a family member" form: `aria-invalid` field with `aria-describedby` error | pass | pass | pass |
| TC-XB-01 (automated) | sign-in redirect, doctor landing, admin banner, patient entry and booking, site services and Book hand-off with opaque IDs only, site keyboard skip link | pass | pass | pass |

Moderate/minor axe findings, if any, are in the per-test `axe-summary` attachments of `evidence/report.json` (not gating).

## Blockers and limitations
- **Firefox and WebKit ran on a rootless test host** via `tests/e2e/harness/browsers-env.sh` (HEAAA-584, commit 0fd62df): Firefox 157.0 and Playwright WebKit 27.2 (software rendering, not real Safari). Their sandboxes are disabled on this host. Command: `. tests/e2e/harness/browsers-env.sh; NODE_PATH=$PWD/apps/staff/node_modules pnpm --filter @ehr/staff exec playwright test -c ../../tests/e2e/a11y/playwright.config.ts --project=firefox --project=webkit` gave 250 passed (5.6 min). Raw: `evidence/report-firefox-webkit.json`, `junit-firefox-webkit.xml`, `run-firefox-webkit.log`. Real Safari/Edge/branded Chrome stay in TC-XB-02 (Pending-human).
- API answers in the browser are contract mocks (session shape; empty lists elsewhere); this proves rendered UI accessibility, not API behaviour. Pages were scanned in empty-data state; pages with populated data are not covered.
- Pending-human (not performed): TC-A11Y-02/03/07/08 and the human parts of 04/05/06 (screen readers, zoom, real devices), TC-XB-02 (real devices and branded Chrome/Safari/Edge), TC-XB-03 (unsupported old browser).
- A first Chromium attempt failed only because the host had no fonts (zero-height text); fixed in the environment, not in the specs. One selector in TC-A11Y-06 was corrected (button "Send request").
