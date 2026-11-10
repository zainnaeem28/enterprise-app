# QA-06 report: automated accessibility and browser matrix (TC-A11Y-01, automated parts of TC-A11Y-04/05/06 and TC-XB-01)

Candidate: base `00faee1709d38e8a21254856a1fbedd7697294f0` plus the `tests/e2e/a11y/**` of this ticket (committed on branch HEAAA-145; the commit is named in the submission comment). Environment: `ENV-INT/ci`-equivalent local run on the built staff, patient and brand-site artefacts (`vite preview` and `apps/site/dist/server/server.js`).
Tools: Playwright 1.64.1, @axe-core/playwright 4.14.0 (tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa), Chromium 156, Firefox 157.0, Playwright WebKit 27.2.
Command (all three engines in one run, `--workers=1` because the shared host disk ran out of space with parallel workers): `. tests/e2e/harness/browsers-env.sh; NODE_PATH=$PWD/apps/staff/node_modules pnpm --filter @ehr/staff exec playwright test -c ../../tests/e2e/a11y/playwright.config.ts --workers=1`
Raw evidence: `evidence/report.json` (axe summaries attached per test, with the final URL scanned), `evidence/junit.xml`, `evidence/run.log`.

## Result: PASS for the automated parts on all three engines. 375 passed (125 per engine) in 7.7 min; 0 failed, 0 flaky, 0 skipped.

| Case | Scope | Chromium | Firefox | WebKit |
| --- | --- | --- | --- | --- |
| TC-A11Y-01 | axe, serious/critical fail, on 58 distinct key pages (staff signed-out, desk, doctor and administrator realms; patient portal; brand site incl. 404) at 1280 px and 360 px = 116 scans per engine, each with a non-empty rule count and a visible landmark and heading; every test asserts the final URL path equals the page named, and the report's `finalUrl` values are 58 distinct pages on each engine (finding QA06-F1: the booking steps /book/doctor, /book/time, /book/confirm are reached through the flow with mocked services, places, clinicians, slots and hold, not by URL) | pass, no serious/critical violations, `KNOWN_EXCEPTIONS` empty | pass | pass |
| TC-A11Y-04 (automated) | no horizontal scroll at 360 px on every page | pass | pass | pass |
| TC-A11Y-05 (automated) | forced-colors and reduced-motion render on the site | pass | pass | pass |
| TC-A11Y-06 (automated) | empty "Link a family member" form: `aria-invalid` field with `aria-describedby` error | pass | pass | pass |
| TC-XB-01 (automated) | sign-in redirect, doctor landing, admin banner, patient entry and booking, site services and Book hand-off with opaque IDs only, site keyboard skip link | pass | pass | pass |

Moderate/minor axe findings, if any, are in the per-test `axe-summary` attachments of `evidence/report.json` (not gating).

## Blockers and limitations
- **Firefox and WebKit ran on a rootless test host** via `tests/e2e/harness/browsers-env.sh` (HEAAA-584, commit 0fd62df): Firefox 157.0 and Playwright WebKit 27.2 (software rendering, not real Safari). Their sandboxes are disabled on this host. Real Safari/Edge/branded Chrome stay in TC-XB-02 (Pending-human).
- Earlier parallel runs hit `ENOSPC` on the shared host disk (3 tests each, different tests each time, all browsers writing); they are not counted. The reported run is the single clean `--workers=1` run above.
- API answers in the browser are contract mocks (session shape; empty lists elsewhere); this proves rendered UI accessibility, not API behaviour. Pages were scanned in empty-data state (QA06-F2). Pending, not scanned: tables and lists with data, open dialogs and menus, populated and invalid forms other than the family form, API error and offline states, session-expiry states, and the video visit with a live call.
- Pending-human (not performed): TC-A11Y-02/03/07/08 and the human parts of 04/05/06 (screen readers, zoom, real devices), TC-XB-02 (real devices and branded Chrome/Safari/Edge), TC-XB-03 (unsupported old browser).
- A first Chromium attempt failed only because the host had no fonts (zero-height text); fixed in the environment, not in the specs. One selector in TC-A11Y-06 was corrected (button "Send request").
