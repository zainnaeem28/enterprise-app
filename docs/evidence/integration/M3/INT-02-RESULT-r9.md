# INT-02 r9 — combined candidate 768961e (round 3 of 3, fresh budget, human confirmation 2c52b85a)

**Result: FAIL on one blocking finding (INT02-R9-B1, waitlist offers are never created by the real worker).** Everything the task named except offer accept/decline passes. Per the task, a failed round 3 stops the loop and goes to a human.

## Candidate and a correction to the task statement

- The task names candidate `e7f06fb` as "linear on 0fec269 and dfd95f8". **It is not.** `e7f06fb` and `dfd95f8` are both children of `0fec269` (siblings); `dfd95f8` (frontend R8-B1 fix, HEAAA-228/230) is not an ancestor of `e7f06fb` (worker wiring, HEAAA-231/232). Evidence: `git merge-base --is-ancestor dfd95f8 e7f06fb` fails.
- **INT02-R9-N1 (integration finding):** `e7f06fb` on its own does not build: `apps/patient/src/features/booking/api.ts(266,13): TS2322 WaitlistRequest is not assignable to ... { from; to }` (`raw/r9/typecheck-e7f06fb-alone.txt`, `build-e7f06fb-alone.txt`, both exit 1). It is the old frontend against the new strict API schema.
- Action (Integrator): I merged `dfd95f8` into `e7f06fb` with `git merge --no-ff`, **no conflicts, disjoint files** (dfd95f8 touches 4 files under `apps/patient/src/features/booking`; e7f06fb touches 5 files under `apps/api/src/worker-ports.ts` and `apps/worker/src`). Result: **candidate `768961eec2acc4b40a44a95dd9a0e3e46aa3eccf`** (`raw/r9/candidate-commit.txt`). `git diff --stat e7f06fb 768961e` equals the dfd95f8 diff and `git diff --stat dfd95f8 768961e` equals the e7f06fb diff, so the content is exactly the union of the two reviewed changes. I made no other product-code change. Reviewers: please confirm the merge is content-neutral (the two diffs above) and decide whether it needs its own review.
- This evidence is committed on top of 768961e. Node v24.22.2, PostgreSQL 17 (`EHR_TEST_ADMIN_URL`), synthetic data, IdP = CI fixture (`scripts/ci/local-idp.mjs`), secrets generated per run in the process environment only. Raw output: `raw/r9/`.

## Checks (all on 768961e)

| Check | Result |
| --- | --- |
| install (frozen lockfile), lint, prettier (`format:check`), typecheck, build, boundary fixture | pass (`raw/r9/install, lint, format-check, typecheck, build, boundary`) |
| unit (`run-unit.mjs`) | pass: **745 tests** in 8 reports, none skipped or failed (api 193 now includes `identity-env.test`: R8-N1 closed, see `unit.txt` lines for the host-with-port refusals; patient 109) |
| `integration-db.sh`, `INTEGRATION_SKIP_N_MINUS_1=true`, **attempt 1** | **exit 1**: db-foundation 40, kernel 23, api 665 with **1 failure**, worker 78. The failing item is the file-level result of `signin.dbtest.js` (every test inside it passed): `Test hook "before" ... generated asynchronous activity after the test ended ... error: terminating connection due to administrator command` (`integration-db-attempt1.txt`, `.exit`). See INT02-R9-N2 |
| `integration-db.sh`, same command, **attempt 2** (no change in between) | **pass, exit 0**: db-foundation 40, kernel 23, api **664**, worker **78** = **805 tests**, 0 failures, 0 skipped (`integration-db-attempt2.txt`, `.exit`) |
| 100 parallel bookings of one slot (TC-BK-13 one account, TC-BK-14 100 patients, TC-BK-15, 20-round BE11-F01 regression) | pass in both attempts (inside the api run) |
| Merge vs booking race (TC-MG-09 and the F05 guard), all-participant merge counts ("INT-02 fix B"), TC-MG-14 time bound (48-49 s of 60 s) | pass in both attempts |
| N-1 / upgrade path | **not run** (no release tag; unchanged limitation) |
| Real-UI journeys (real API + real worker processes, Chromium) | A book, B change, C cancel **pass**; D waitlist join **pass (live 201)**; E offer **FAIL** (INT02-R9-B1) |

## Real-UI journeys (processes: IdP fixture, API `main.js` as `app_api`, worker `main.js` as `app_worker`, built patient app via `vite preview` with `/api` proxied, Chromium)

Scripts in `raw/r9/ui/` (`r9-setup.mjs`, `r9-launch.sh`, `r9-journey.mjs`, `r9-run.sh`, diagnostic `r9-offer-diagnosis.mjs`); results `journey-run.txt` (request bodies and 4xx bodies included), screenshots `01..23-*.png` (actual application), `booked.ics`, `api-process.log` (no warn/error lines), `worker-process.log` (the only "fail" text is the harmless missing-crontab info line), `offer-diagnosis.txt`. Database from empty via the real migrations; reference data from the real worker job; `queue_api.task_type` synced by the worker itself.

| Journey | Result | Observed |
| --- | --- | --- |
| A. landing, sign in, services, place, clinician, availability, hold, review, confirm | pass | callback 302, `__Host-sid` Secure+HttpOnly, session 200; holds 201; confirm 200 |
| A2. **Add to calendar** (button on the booked page) | pass | browser download `appointment.ics`, 304 bytes, contains `BEGIN:VCALENDAR`, `BEGIN:VEVENT`, `DTSTART` (`booked.ics`). This is the client-side ICS download only |
| A3. My appointments | pass | list 200, one Confirmed |
| B. detail, change time | pass | `POST /appointments/{id}/reschedule` 200; one Confirmed appointment; DB `rescheduled` x1 |
| C. cancel (policy text, dialog) | pass | `POST /appointments/{id}/cancel` 200; list empty |
| **D. waitlist join (R8-B1)** | **pass** | UI reaches "No times" then "Join the waitlist"; **`POST /waitlist-entries` 201** with body `{patientId, serviceId, from, to, locationId}` (no `mode`; `from` now, `to` +90 days); page "You are on the waitlist"; DB `waitlist_entry` `active` x1 |
| E. cancel frees a slot, worker offers it, patient accepts | **FAIL** | the worker ran `scheduling.on_slot_freed` then `scheduling.offer_waitlist` (both "Completed ... with success"), but **no `waitlist_offer` row was created**; accept/decline unreachable (`journey-run.txt`, screenshot `23-FAILED-...png`) |

## Worker pickup (R8-N2): verified for the jobs that ran

`worker-process.log`: `task types synced, count 34`, `"tasks":34 ... worker started`, then jobs started and completed with success: `identity.record_sign_in` x1 (on sign-in), `scheduling.on_reservation_confirmed` x2, `scheduling.on_slot_freed` x3, `scheduling.offer_waitlist` x3. `queue._private_jobs` after the run holds only two future-dated `scheduling.send_previsit` rows (attempts 0, no error). So the worker picks up queued jobs and the handler wiring from e7f06fb works for the identity and scheduling families. **Not observed:** any `notifications.*` job, any calendar-sync job, any audit export/anchor job. `notifications.notification` has 0 rows after booking, change, cancel; I did not determine whether a booking is supposed to produce a notification in this slice. Calendar-sync jobs need a connected Google account and `EHR_CALENDAR_WEBHOOK_URL`, which this environment does not have.

## Findings

- **INT02-R9-B1 (blocking; Backend, scheduling flow + identity RLS): the real worker never creates a waitlist offer, so offer accept/decline cannot happen.** Root cause, reproduced with `r9-offer-diagnosis.mjs` (`offer-diagnosis.txt`): `offerToCandidate` runs in a *patients-scope* worker job; its hold calls `availability.resolve`, whose non-patient branch joins `identity.principal` (`apps/api/src/modules/scheduling/availability/search.ts`, `windows()`, `JOIN identity.principal pr ... realm = 'google' AND status = 'active'`). The RLS policy `principal_system_read` (`db/migrations/0502_identity_rls_and_grants.sql:100`) lets `app_worker` read `identity.principal` only when `app.job_scope = 'org'`. In the diagnosis, as `app_worker`: patients-scope sees **0** `identity.principal` rows, org-scope sees 3. No window is found, `resolve` returns `scheduling.outside_hours`, and `offerToCandidate` returns `{outcome:'skipped', reason:'scheduling.outside_hours'}` for every candidate; the job then ends "success" with `no_candidate`, silently. Same freed slot, same clinician, same fixtures that the patient UI books through the patient-audience path (which uses `identity.public_clinician`). The database tests in `waitlist.dbtest.ts` (which assert `offered`) evidently do not exercise this role/scope combination. Not reachable by any unit or db test of this repo; found only with the real worker. Fix options belong to Backend (read the clinician through a directory view the worker may read, or give the patients-scope job the same visibility), and a regression test under role `app_worker` with `job_scope = 'patients'`.
- **INT02-R9-N1 (integration): the named candidate `e7f06fb` does not contain the frontend fix and does not build** (above). Closed in this run by my merge `768961e` (disjoint, no conflict); needs a review decision on the merge.
- **INT02-R9-N2 (flake, low): `signin.dbtest.js` file-level failure in 1 of 2 `integration-db` runs** ("terminating connection due to administrator command" raised from its `before` hook after the tests ended). No code or environment change between attempts; the second run passed in full. Reported as intermittent; cause not investigated (likely a `DROP DATABASE ... WITH (FORCE)` racing a pool of this file's kit). Both raw outputs are kept.
- **R8-B1 (waitlist body): closed by evidence** (live 201, contract-valid body, DB row). **R8-N1 (test glob): closed** (identity-env tests run in the unit job, 745 total). **R8-N2 (worker registers no handlers): closed for identity and scheduling families** (34 tasks registered; jobs picked up and completed); other families not observed (above). R7-B1, R7-N1: still hold (the journey ran on a fresh database with no manual sync; same code).
- INT02-R7-N2 (`GET /api/v1/me` 404): known limitation, still seen on every page load (`journey-run.txt`); journeys unaffected.
- Carried notes unchanged: INT02-R4-N1, INT02-R5-N2; `integration-db` is not safe to run concurrently on one server (the UI stack ran only after it finished).

## Not demonstrated (explicit)

- **Waitlist offer accept and decline** — blocked by INT02-R9-B1; the UI offer page (`/waitlist/offers/{id}`) was therefore not reached with a real offer.
- **Staff view** — the staff app in this candidate is still a connection placeholder (`apps/staff/src/App.tsx`); there is no staff schedule/waitlist UI. Not exercised.
- **Add to calendar beyond the ICS download** — Google calendar sync (connect, push, two-way) not run (no Google account).
- **N-1 / upgrade**, telehealth UI, documents UI, merge UI, notification delivery.

## Fixtures seeded by SQL (disclosure)

Superuser SQL into a throwaway database `ehr_int02_r9_ui`: organisation catalogue (jurisdiction, location, two services, room, operating state), two clinician principals with `staff_profile` and `service_clinician`, the weekly availability template for clinician 1, one patient with a patient-realm principal and `patient_link`. **New in r9:** (a) a `booking_policy` row with `waitlist_enabled = true` for the second service (waitlist is off by default; the admin API that turns it on has no reachable UI); (b) in journey E, an availability template for clinician 2, inserted by SQL mid-run so the same patient could book then cancel a slot of the waitlist service. Booking, change, cancel, waitlist join, the ICS download and all worker jobs went through the real product code. Reason for the rest: the patient registration/link controllers and any staff/admin UI are not mounted. No credentials in any artifact (database URLs carry only a role name; the IdP JSON holds public fixture endpoints).

## Reproduce
`pnpm install --frozen-lockfile && pnpm build`; browser env per `BROWSER-RUNNER-AND-0704.md`; `raw/r9/ui/r9-run.sh "$PWD" "$PWD/docs/evidence/integration/M3/raw/r9/ui"` (needs `EHR_TEST_ADMIN_URL`; port 4174 free — a stale `vite preview` of mine from r8 held it and served the old build until I stopped it; the first r9 UI attempt, discarded, ran against it and showed the old `mode` body, which is why journey results here are from a re-run on a free port). Servers stopped by pid; database dropped afterwards.

## State
Executed and verified on 768961e: install, lint, prettier, typecheck, build, boundary, unit (745), db-foundation, kernel, api (664, one of two runs), worker (78), concurrency and merge scenarios, real-UI book, change, cancel, waitlist join, ICS download, worker job pickup. **Failed:** offer creation by the real worker (INT02-R9-B1); `integration-db` attempt 1 (INT02-R9-N2, flake). **Not executed:** listed above. Not marked Integrated; candidate not frozen; not submitted to QA; no gate approved. **Cumulative integration round: 3 of 3 in the fresh budget — the loop stops here and goes to a human.** Independent review of this evidence: Backend Reviewer and Frontend Reviewer (not the Integrator), pending.
