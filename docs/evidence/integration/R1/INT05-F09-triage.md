# INT05-F09 triage: patient-e2e-a11y journey, ECONNREFUSED 127.0.0.1:3000 (HEAAA-597)

## Verdict

- **Pre-existing, not caused by the five INT-05 merges.** `apps/patient/e2e/journey.spec.ts` is byte-identical at the HEAAA-176 CI commit `5a72226` and at candidate `e6871fa`; the failing path is in the spec itself.
- **Premise corrected:** HEAAA-176 *is* in the candidate (`5a72226` is an ancestor of `e6871fa`; it added the `patient-e2e-a11y` job). The job needs no API or IdP fixture: the spec is a labelled contract mock (`page.route('**/api/v1/**')`). No second CI wiring ticket is needed, so nothing is duplicated.
- **Owner of the fix:** Frontend (FE-03, HEAAA-91) test code, applied here under DevOps' CI-job remit. The CI job config is unchanged.

## Root cause

Clicking "Continue to secure sign-in" navigates the page to `/api/v1/auth/sign-in`. The mock fulfilled that with `302 -> /api/v1/auth/callback`. Chromium does not pass the follow-up of a fulfilled 302 back through `page.route`, so the callback request fell through to the `vite preview` proxy (`/api` -> `API_ORIGIN`, default `http://127.0.0.1:3000`), where nothing listens: `http proxy error ... ECONNREFUSED 127.0.0.1:3000`. Tests 2 and 3 never use that hop and passed; the empty-suite guard then failed because only 2 of 3 passed.

## Fix

In the mock, a *navigation* request to sign-in now completes the callback itself (session set, `302 -> returnTo`). The probe (`fetch`, `redirect: 'manual'`) still receives the documented `302 -> callback`, the callback case is unchanged, and no assertion was weakened, skipped or marked optional. Only `apps/patient/e2e/journey.spec.ts` changed.

## Evidence (actual, local; Chromium 1248 headless shell, no CI run)

- Before (candidate `e6871fa`, built dist): 1 failed, 2 passed; `ECONNREFUSED 127.0.0.1:3000` on `/api/v1/auth/callback?code=c&state=s&to=%2Faccount` (reproduces `gates/patient-e2e.txt`).
- After: `3 passed`; `check-report.mjs apps/patient/dist-reports/axe-report.json 3` -> `playwright: 3 ran, 3 passed, 0 failed, 0 flaky, 0 skipped, 0 error(s)`; `prettier --check` clean.
- Limitation: run against the existing built `dist` of `e6871fa` in a scratch copy (the spec does not depend on source), not via `pnpm --filter @ehr/patient exec playwright test` in a fresh checkout, and not in GitHub Actions. The Integrator's full re-run is the CI-equivalent proof.
- Host note: this host has no system fonts; headings measure 0 px high and read as hidden unless `FONTCONFIG_FILE` points at a fonts config. That is a host artefact, not a CI issue (ubuntu-24.04 runners have fonts).
