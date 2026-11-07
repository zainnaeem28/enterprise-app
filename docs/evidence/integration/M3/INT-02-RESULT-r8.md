# INT-02 r8 — combined candidate 1161488 (round 2 of 3, fresh budget, human confirmation 2c52b85a)

Candidate: `1161488a8cbf30566f5f33b494f3fc4ff59bc646` (HEAD of the integration branch; R7-B1 and R7-N1 fixes HEAAA-222, review PASS HEAAA-223). I made no product-code changes. Node v24.22.2, PostgreSQL 17 (`EHR_TEST_ADMIN_URL`), synthetic data, IdP = CI fixture (`scripts/ci/local-idp.mjs`), secrets generated per run in the process environment only. Raw output: `raw/r8/` (`candidate-commit.txt`). Evidence is committed on top of the candidate.

| Check | Result |
| --- | --- |
| install (frozen lockfile), lint, prettier, typecheck, build, boundary fixture | pass (`raw/r8/install, lint, format-check, typecheck, build, boundary`) |
| unit (`run-unit.mjs`) | pass: 602 tests in 8 reports, none skipped or failed |
| `apps/api/dist/src/identity-env.test.js` run directly (not in `pnpm test`, see R8-N1) | pass: 3/3 incl. host-with-port refusals (`identity-env-test.txt`) |
| `integration-db.sh`, `INTEGRATION_SKIP_N_MINUS_1=true` | pass first attempt, exit 0: db-foundation 40, kernel 23, api **664**, worker **77** = **804 tests**, 0 failures, 0 skipped (`integration-db.txt`, `.exit`) |
| 100 parallel bookings of one slot (TC-BK-13, TC-BK-14); merge vs booking race (TC-MG-09); all-participant merge counts; TC-MG-14 time bound | pass (inside the api run) |
| N-1 / upgrade path | **not run** (no release tag; unchanged limitation) |
| R7-B1 end to end (fresh DB, no manual sync) | **closed, verified** (below) |
| R7-N1 host with port refused | **closed, verified** (below) |
| Real-UI journeys (real API + worker processes, Chromium) | A book, B change, C cancel **pass**; D waitlist **FAIL** (INT02-R8-B1) |

## R7-B1: sign-in on a fresh database with no manual task-type sync
`r8-setup.mjs` no longer calls `syncTaskTypes`. After setup `queue_api.task_type` had **0 rows** (`ui/task-type-before.txt`). The real worker process (`apps/worker/dist/main.js`) was then started; its log shows `task types synced, count 34` before any request (`ui/worker-process.log`). Sign-in then returned 302 to the callback, `__Host-sid` set (Secure, HttpOnly), `GET /auth/session` 200, and the whole journey ran. The pipeline step also works: `pnpm --filter @ehr/worker run sync-task-types` as `app_worker` printed `count 34` (`ui/sync-task-types-cli.txt`; idempotent upsert, run against the same database after the journey). I did not run the control (journey without the worker) this round; the r7 evidence is that control.

## R7-N1: host with a port
Real `main.js` with `EHR_PATIENT_HOST=127.0.0.1:4174`: `invalid configuration: EHR_PATIENT_HOST must be a host name without a port`, exit 1, name only (`ui/host-port-refusal.txt`). Unit coverage in `identity-env.test`.

## Real-UI journeys (processes: IdP fixture, API `main.js` as `app_api`, worker `main.js` as `app_worker`, built patient app via `vite preview` with `/api` proxied)
Scripts in `raw/r8/ui/`: `r8-setup.mjs`, `r8-launch.sh`, `r8-journey.mjs`, `r8-run.sh`; result `journey-run.txt` (4xx response bodies and request bodies included), screenshots `01..18-*.png` (actual application), `api-process.log` and `worker-process.log` (no warn/error lines), `db-state.txt`.

| Journey | Result | Observed |
| --- | --- | --- |
| A. landing, sign in, services, place, clinician, availability, hold, review, confirm, My appointments | pass | holds 201, confirm 200, list 200 with one Confirmed appointment |
| B. detail, change time (UI: pick another slot, review, "Change to this time") | pass | `POST /appointments/{id}/reschedule` 200; the new appointment (new id) is the only Confirmed one in the list; DB `slot_occupancy`: one `rescheduled` |
| C. cancel (policy text, confirmation dialog, cancel) | pass | `POST /appointments/{id}/cancel` 200, "Your appointment was cancelled"; list empty; DB: `cancelled_patient` |
| D. waitlist join (second service whose clinician has no availability, UI reaches "No times", "join the waitlist") | **fail** | `POST /waitlist-entries` **422** `kernel.validation_failed` on `/from` and `/to`; UI shows "Something went wrong on our side" (screenshot `18-FAILED-join.png`) |

A first attempt of this run (not kept as evidence) booked the earliest slot (today) and the change was refused as too close to the start, which is the product's cut-off behaviour working; the journey now books a slot days ahead.

**Not demonstrated:** staff view (the staff app in this candidate is a connection placeholder page, `apps/staff/src/App.tsx`; there is no staff schedule/waitlist UI to exercise), waitlist offer accept/decline, add to calendar, calendar sync, telehealth, documents UI, merge UI, N-1.

## Fixtures seeded by SQL (disclosure)
Superuser SQL into a throwaway database: organisation catalogue (jurisdiction, location, two services, room, operating state), two clinician principals with `staff_profile` and `service_clinician`, the weekly availability template for clinician 1 (SQL, not the template API; clinician 2 deliberately has none), one patient with a patient-realm principal and `patient_link`. Reason as in r7: the patient registration/link controllers and any staff/admin UI are not mounted, so these paths cannot be reached through the product. Reference data came from the real worker job and the settings catalogue from the real service. No credentials in any artifact (the database URL contains only a role name).

## Findings
- **INT02-R8-B1 (blocking for the waitlist journey; HEAAA-107 patient UI vs HEAAA scheduling-flow API): patient "Join the waitlist" always fails.** The UI sends `{patientId, serviceId, mode, locationId?, clinicianId?}` (`WaitlistPage.tsx:25-32`); the API handler requires `from` and `to` (`flow/controller.ts:368-369`) and answers 422. The OpenAPI body is `OpaqueObject` (`scheduling.yaml`, `/waitlist-entries`), so neither side was checked against a shape. Owner: Frontend + Backend (decide the date window, put the real schema into the contract). Not seen by unit/db tests because each side is tested against its own assumption.
- **INT02-R8-N1 (test wiring): `apps/api` `pnpm test` globs `dist/test/**/*.test.js` only**, so `dist/src/identity-env.test.js` (3 tests, the R7-N1 regression test) never runs in the unit job. Run directly here (3/3 pass). Fix the glob (Backend/DevOps).
- **INT02-R8-N2 (carried from R7, observed not exercised): the worker boots with `"tasks":0`** (`worker-process.log`): it syncs 34 task types but registers no handlers, so queued jobs (audit, notifications, merge) would not run in the real worker. I did not enqueue and wait for a job end to end. Backend to confirm scope.
- INT02-R7-N2 (`GET /api/v1/me` 404): recorded known limitation (Orchestrator). Seen once per page load in `journey-run.txt`; **the booking, change and cancel journeys are not affected** (patient id comes from `/auth/session`).
- INT02-R7-B1: closed by evidence. INT02-R7-N1: closed by evidence. Carried notes unchanged: INT02-R4-N1, INT02-R5-N2, `integration-db` not safe to run concurrently on one server (I ran the UI stack only after it finished).

## Reproduce
`pnpm install --frozen-lockfile && pnpm build`; browser env per `BROWSER-RUNNER-AND-0704.md`; `raw/r8/ui/r8-run.sh "$PWD" "$PWD/docs/evidence/integration/M3/raw/r8/ui"` (needs `EHR_TEST_ADMIN_URL`). Servers stopped by pid and database `ehr_int02_r8_ui` dropped afterwards (I could not verify listening ports: `ss` is not installed on this host).

## State
Executed and verified on 1161488: install, lint, prettier, typecheck, build, boundary, unit (602), identity-env test, db-foundation, kernel, api (664), worker (77), concurrency and merge scenarios, real-UI booking, change and cancel. **Failed:** real-UI waitlist join (INT02-R8-B1). **Not executed:** N-1, staff view, other UI journeys listed above. Not marked Integrated; candidate not frozen; not submitted to QA; no gate approved. Cumulative integration round: 2 of 3 in the fresh budget. Independent review of this evidence: Backend Reviewer and Frontend Reviewer (not the Integrator), pending.
