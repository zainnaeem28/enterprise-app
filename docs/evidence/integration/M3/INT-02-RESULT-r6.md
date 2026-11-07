# INT-02 round 3 of 3 (r6) — combined candidate 84d6b5d

Candidate: `84d6b5d` (HEAD of the integration branch; includes HEAAA-209 mount 0cd1105, HEAAA-210 catalogue routes 0c1d466, HEAAA-211 runner doc). No merges or patches of my own this round. Node v24.22.2, PostgreSQL 17 (`EHR_TEST_ADMIN_URL`), synthetic data, no credentials in artifacts. Raw output: `raw/r6/` (`candidate-commit.txt`). Round 3 of 3 of the bounded cycle (human confirmation 571c2b28).

| Check | Result |
| --- | --- |
| install (frozen lockfile), lint, typecheck, build, boundary fixture | pass (raw/r6/install, lint, typecheck, build, boundary) |
| prettier (`format:check`) | pass on re-run. First run failed on 9 stale, git-ignored Playwright `test-results/` files left in my worktree by the r5 failed browser launch (`format-check-first-run-stale-test-results.txt`); I deleted that ignored directory and re-ran: pass (`format-check.txt`). Not a product defect. |
| unit (`run-unit.mjs`) | pass: 602 tests in 8 reports, none skipped or failed (`unit.txt`, `unit.exit` 0) |
| `integration-db.sh`, `INTEGRATION_SKIP_N_MINUS_1=true` | **pass on attempt 2**: db-foundation 40/40, kernel 23/23, api 662/662, worker 76/76 = 801 tests, 0 failures, 0 skipped (`integration-db-full.txt`, exit 0) |
| N-1 / upgrade path | not run (no release tag exists; unchanged limitation) |

**Attempt 1 of integration-db failed and is kept** (`integration-db-attempt1-FAILED-concurrent-server-use.txt`): api `platform/db.dbtest.js` failed with "terminating connection due to administrator command" (asynchronous activity after the test ended), and 26 worker tests failed after `bootstrap` died with `error: tuple concurrently updated` on `ALTER ROLE app_owner`. Both are cluster-level races: the roles are global on the shared test server, so another session was using `ehr-test-db` at the same time (I cannot see other sessions; this is my inference from the error text, not proven). Nothing in the candidate changed between attempts. A full re-run from scratch passed all four suites. Risk to flag: the integration-db job is not safe to run concurrently against one server; CI should give each job its own server (DevOps).

## Scenarios (database/HTTP-route suites in the passing api run)

| Scenario | Result |
| --- | --- |
| 100 parallel bookings of one slot (TC-BK-13 one account, TC-BK-14 100 patients) | pass: exactly one appointment (same tests as r5, re-executed in attempt 2) |
| Merge versus booking race (TC-MG-09, F05 guard) | pass |
| All-participant merge counts ("INT-02 fix B"), merge time bound TC-MG-14 | pass |
| **Patient booking journey through the real UI** | **BLOCKED — not demonstrated (INT02-R6-B1)** |

I did not re-derive the per-test line numbers; the test names are in `raw/r6/integration-db-full.txt`.

## Blocker INT02-R6-B1: the real API process cannot serve the booking journey

The browser runner works now (HEAAA-211: Chromium started, no missing libraries). I started the real built API (`node apps/api/dist/src/main.js`, schema from empty via the real migrations, role `app_api`) and the built patient app (`vite preview`, `/api` proxied to the API) and drove the real UI in Chromium. Screenshots and logs: `raw/r6/ui/` (01-landing.png, 02-after-sign-in.png, 03-book-direct.png, `journey-run.txt`, `route-probe.txt`, `api-process.log`; scripts `r6-journey.mjs`, `r6-setup.mjs`).

Actual results:
- Landing renders; "Sign in" leads to the "Continue to secure sign-in" page. The browser's `GET /api/v1/auth/session` returns **404**.
- `/book` in the browser shows "We can't find this, or it isn't available to you" (no session, no linked patient, so the mounted booking routes are not reachable).
- Direct probes against the API process (`route-probe.txt`): `/readyz` 200; `/api/v1/auth/session` 404; `/api/v1/auth/sign-in` 404; `GET /api/v1/services` 401 and `/locations` 401 (mounted, but refuse everyone); `GET /api/v1/clinicians` 404; `POST /api/v1/availability/search` 404; `POST /api/v1/holds` 404.

Cause, from the code at 84d6b5d: `apps/api/src/composition.ts` `buildControllers` mounts only the catalogue controllers, and `apps/api/src/main.ts` calls `createApp` without `policy`, so the default `DenyUntilIdentityPolicy` applies. The identity (auth) controllers and policy, the availability search, holds/confirm/appointments (scheduling core), flow/waitlist controllers are only mounted by the test harnesses (`identity/testkit.ts`, `scheduling/*/testkit.ts`). Also, the UI calls `GET /api/v1/clinicians` for the doctor step, and no patient-facing route with that path exists in `apps/api` (only the integrations host serves `public/v1/clinicians`). HEAAA-209/210 fixed the web mount and the catalogue routes, but the rest of the path (sign-in, session, availability, holds, confirm, patient appointments, patient clinician list, plus a real IdP or configured fixture) is not wired in the production composition root. A patient cannot book through the real app regardless of the browser.

I did not build a test-only composition that would stand in for `main.ts`: that would show a harness, not the candidate, and I will not present it as the real journey. Per the task, this check is an explicit blocker, not a pass.

Needed (Orchestrator to assign): wire identity + scheduling (availability, core, flow) controllers and the identity guard policy in `composition.ts`/`main.ts` (with IdP configuration for a CI fixture), provide a patient-readable clinician list, then re-run the journey. This is a product gap beyond the bounded cycle's three rounds: the third round is now spent, so a new bounded cycle needs a real human decision.

## Recorded notes

- INT02-R5-N1 (0704 edited in place): closed by HEAAA-211's evidence document (no persistent environment has applied it; negative finding from records, as stated there).
- INT02-R4-N1, INT02-R5-N2: unchanged accepted limitations.
- Cleanup: servers stopped, throwaway database `ehr_int02_r6_ui` dropped.

## State

Executed and verified on 84d6b5d: install, lint, prettier (after cleaning stale ignored files), typecheck, build, boundary, unit (602), db-foundation, kernel, api (662), worker (76), concurrency and merge scenarios. **Not executed / blocked:** patient booking journey (INT02-R6-B1), N-1. Not marked logical Integrated; candidate not frozen; not submitted to QA; no gate approved. Findings: INT02-R6-B1 (blocking). Cumulative integration round count: 3 of 3 used; escalating, no further correction loop without a human decision. Independent review of this evidence: Backend Reviewer and Frontend Reviewer (not the Integrator), pending.
