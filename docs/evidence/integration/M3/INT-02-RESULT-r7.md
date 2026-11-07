# INT-02 r7 — combined candidate dc474e4 (round 1 of 3, fresh budget, human confirmation 2c52b85a)

Candidate: `dc474e40cebf8610bd5a0d46020a14e96b108dba` (HEAD of the integration branch; API composition wiring HEAAA-217, review PASS HEAAA-218). No merges or patches of my own to product code. Node v24.22.2, PostgreSQL 17 (`EHR_TEST_ADMIN_URL`), synthetic data, IdP = CI fixture (`scripts/ci/local-idp.mjs`), secrets generated per run in the process environment only. Raw output: `raw/r7/` (`candidate-commit.txt`). Evidence is committed on top of the candidate; the candidate itself is unchanged.

| Check | Result |
| --- | --- |
| install (frozen lockfile), lint, typecheck, build, boundary fixture | pass (`raw/r7/install, lint, typecheck, build, boundary`) |
| prettier (`format:check`) | pass |
| unit (`run-unit.mjs`) | pass: 602 tests in 8 reports, none skipped or failed |
| `integration-db.sh`, `INTEGRATION_SKIP_N_MINUS_1=true` | pass first attempt: db-foundation 40, kernel 23, api **664**, worker 76 = **803 tests**, 0 failures, 0 skipped (`integration-db.txt`, exit 0) |
| 100 parallel bookings of one slot (TC-BK-13 one account, TC-BK-14 100 patients) | pass (in the api run) |
| Merge versus booking race (TC-MG-09, F05 guard); all-participant merge counts; TC-MG-14 time bound (50 s of 60 s) | pass (in the api run) |
| N-1 / upgrade path | not run (no release tag; unchanged limitation) |
| **Patient booking journey, real UI + real API process** | **pass** (below), with one prerequisite finding |

## Booking journey (real `apps/api/dist/src/main.js` + built patient app, Chromium)

Stack, all separate processes: fixture OIDC IdP (`local-idp.mjs`, port 9099), the real built API (`main.js`, role `app_api`, database from empty via the real migrations), the built patient app served by `vite preview` with `/api` proxied (one origin, so no CORS). Browser: Chromium 156 via the documented runner (`BROWSER-RUNNER-AND-0704.md`). Scripts in `raw/r7/ui/`: `r7-setup.mjs` (database, reference data via the real worker job, settings catalogue, synthetic fixtures), `r7-launch.sh`, `r7-journey.mjs`. Result: `journey-run.txt`, screenshots `01..09-*.png`, `api-process.log` (no warn/error lines), `db-state.txt`.

| Step | Result | Observed |
| --- | --- | --- |
| landing, Sign in, secure sign-in page, IdP, callback | pass | callback 302; `__Host-sid` cookie set (Secure, HttpOnly); lands on `/account`; `GET /auth/session` 200 |
| service listing | pass | `GET /services` 200, 1 service |
| place + clinician listing | pass | `GET /locations` 200; `GET /clinicians?serviceId&locationId` 200; "Dr. Synthetic" offered |
| availability search | pass | `POST /availability/search` 200; 112 slot buttons |
| hold | pass | `POST /holds` 201; timer "Held for 10:01" |
| review, confirm | pass | `POST /appointments/{id}/confirm` 200; "Your appointment is booked" |
| My appointments | pass | `GET /patients/{id}/appointments` 200; one Confirmed appointment; DB: one `slot_occupancy` row `confirmed`, 4 audit events |

Not exercised in this run (not in the task's list): cancel/change, waitlist, staff sign-in, add to calendar.

## Fixtures and what I seeded by SQL (disclosure)

Seeded as superuser into a throwaway database: organisation catalogue (jurisdiction, location, service, room, operating state), one clinician principal with `staff_profile`, `service_clinician` and a weekly availability template (SQL, not the template API), one patient with a patient-realm principal and `patient_link`. Reason: the patient module's controllers (registration, link) and any admin/staff UI are not mounted in the composition root (declared out of scope in `INT-02-r7-api-composition.md`), so a patient can only reach the booking path if a link already exists. The sign-in, session, listing, search, hold, confirm and appointments calls are all the real handlers.

## Findings

- **INT02-R7-B1 (blocking for any real deployment; not blocking this run's journey, which applied the step by hand): nothing in production syncs `queue_api.task_type`.** On a freshly migrated database the first sign-in answered 401: the API's audit enqueue raised `queue_api.enqueue: task type not allowed` (seen with a temporary `pg` error hook, diagnostic only, not part of the evidence run), and the callback maps every failure to the generic 401 page. ARCHITECTURE 21.8 says a `kernel queue sync-task-types` step runs in the deploy pipeline before the API rollout and again at worker start; no such command exists, `startWorker` does not call `syncTaskTypes`, and the worker's `main.ts` registers no tasks. Only test kits call it. In `r7-setup.mjs` I ran `syncTaskTypes` for the composition root's job list (the same list, `composition.ts:79`), which is what the architecture assigns to the pipeline. Owner: DevOps/Backend (worker boot + pipeline step); also the worker registers no job handlers, so queued jobs would not run in the real worker (not tested here).
- **INT02-R7-N1 (config trap): `EHR_PATIENT_HOST` / `EHR_STAFF_HOST` validation accepts `host:port`, but `hostOf()` strips the port from the request `Host` before the lookup**, so a value with a port never matches and `/auth/sign-in` answers 404. Found when my first run used `127.0.0.1:4174`; with `127.0.0.1` it works. Either reject a port in `identity-env.ts` or compare with it. Low severity (fails closed, found at first start).
- **INT02-R7-N2: the patient app calls `GET /api/v1/me`, which the API does not serve (404).** The patient module is not mounted. The journey did not depend on it (patient IDs come from `/auth/session`), but the 404 occurs on every page load and the UI's `/me` consumer is untested against the real API.
- INT02-R6-B1 (API composition root): **closed by evidence** on this candidate (routes mounted; journey passes).
- Carried notes unchanged: INT02-R4-N1, INT02-R5-N2; INT02-R6 note on `integration-db` not being safe to run concurrently on one server (no collision this round).

## Reproduce
`pnpm install --frozen-lockfile && pnpm build`; browser env per `BROWSER-RUNNER-AND-0704.md`; `node raw/r7/ui/r7-setup.mjs "$PWD"` (prints the `app_api` URL), `raw/r7/ui/r7-launch.sh "$PWD" <that URL> <logdir>`, `node raw/r7/ui/r7-journey.mjs "$PWD" <outdir>`. Servers stopped and database `ehr_int02_r7_ui` dropped afterwards. One `vite preview` process of mine on port 4174 could not be stopped from my session (a process-kill was refused); it serves static files only.

## State
Executed and verified on dc474e4: install, lint, prettier, typecheck, build, boundary, unit (602), db-foundation, kernel, api (664), worker (76), the concurrency and merge scenarios, and the real-UI/real-API booking journey. **Not executed:** N-1, cancel/change/waitlist/staff UI journeys. Findings: INT02-R7-B1 (blocking for deployment), INT02-R7-N1, INT02-R7-N2. Not marked Integrated; candidate not frozen; not submitted to QA; no gate approved. Cumulative integration round: 1 of 3 in the fresh budget. Independent review of this evidence: Backend Reviewer and Frontend Reviewer (not the Integrator), pending.
