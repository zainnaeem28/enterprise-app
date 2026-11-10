# INT-02 r10 — combined candidate f8b70bb (round 1 of 3, fresh budget)

**Result: INT02-R9-B1 is CLOSED by live evidence** (the real worker now creates waitlist offers; patient decline and accept work in the UI). **One new finding is open: INT02-R10-B1** (the notification templates the offer job sends are not provisioned anywhere; on a database without them every offer job fails). Everything else the task named passes, except the items listed under "Not demonstrated" and the `integration-db` flakes (2 of 3 attempts failed on test-side causes, none on product code).

## Candidate
- Candidate `f8b70bb` (= merge `16b1df1` = `768961e` + HEAAA-236 fix). This evidence branch merges `f8b70bb` with `git merge --no-ff` (merge commit carries only r9 evidence files; `git diff f8b70bb <evidence head> -- . ':!docs'` is empty). Product-code diff `768961e..f8b70bb` (4 files, `raw/r10/code-diff-768961e-f8b70bb.txt`): `apps/worker/src/jobs/scheduling/offer-waitlist.ts`, `apps/api/src/modules/scheduling/flow/testkit.ts`, new `waitlist-worker-scope.dbtest.ts`, new migration `1603_identity_principal_patients_scope_read.sql`. I made no product-code change.
- Node v24.22.2, PostgreSQL 17 (`EHR_TEST_ADMIN_URL`), `NODE_ENV=test` for DB tests, synthetic data, IdP = CI fixture, secrets generated per run in process env only. Raw output: `raw/r10/`.

## Checks (on f8b70bb)
| Check | Result |
| --- | --- |
| install (frozen), lint, prettier, typecheck, build, boundary fixture | pass, all exit 0 (`raw/r10/install, lint, format-check, typecheck, build, boundary`) |
| unit (`run-unit.mjs`) | pass: **745** tests, none skipped/failed (`unit.txt`) |
| `integration-db.sh` (`INTEGRATION_SKIP_N_MINUS_1=true`) attempt 1 | **pass, exit 0**: db-foundation 40, kernel 23, api 667, worker 78 = **808**, 0 failures |
| attempt 2 (no change between) | **exit 1**: api 668 tests, 1 failure = file-level `alerts.dbtest.js`; all its tests passed; error "Test hook before … generated asynchronous activity after the test ended … terminating connection due to administrator command" (INT02-R10-N2) |
| attempt 3 (no change between) | **exit 1**: worker 2 failures in `identity.dbtest.js` `purge_sessions` (INT02-R10-N1, test seed defect) |
| New regression test for R9-B1 (`offer_waitlist as app_worker in patients scope`) | passes in attempt 1 (3 tests incl. "the real worker role and scope produce an offer"); not failing in attempts 2/3 |
| 100 parallel bookings of one slot, merge-vs-booking race, all-participant merge counts, TC-MG-14 | pass in attempt 1 (inside the api suite); api failures in attempts 2/3 are unrelated to these (attempt 3 api suite 667/0 failed) |
| N-1 / upgrade path | **not run** (no release tag; unchanged limitation) |

## Real-UI journeys (real API `main.js` as `app_api`, real worker `main.js` as `app_worker`, built patient app via `vite preview`, Chromium)
Scripts `raw/r10/ui/r10-*`; results `journey-run.txt`; screenshots `01..28-*.png` (actual application), `29-NOT-EXERCISED-...png`; `booked.ics`; `api-process.log` and `worker-process.log` (no warn/error lines); `notifications-summary.txt`. Database from empty via real migrations; reference data by the real worker job; task types synced by the worker itself.

| Journey | Result | Observed |
| --- | --- | --- |
| A book (landing, sign in, service, place, clinician, availability, hold, review, confirm) | pass | session 200, `__Host-sid` Secure+HttpOnly, hold 201, confirm 200 |
| A2 Add to calendar | pass | `appointment.ics` download 304 bytes, VCALENDAR/VEVENT/DTSTART (client-side ICS only) |
| B change time | pass | `POST /appointments/{id}/reschedule` 200, one Confirmed |
| C cancel | pass | `POST …/cancel` 200 |
| D waitlist join | pass | `POST /waitlist-entries` 201, "You are on the waitlist" |
| **E offer created by the real worker, patient DECLINES in the UI** | **pass** | cancel frees slot, `scheduling.offer_waitlist` creates `waitlist_offer` (`offered`, ~15 min expiry) within seconds; "A time opened up for you" page; `POST /waitlist-offers/{id}/decline` 200; offer `declined`, entry stays `active` |
| **F second freed slot, second offer, patient ACCEPTS in the UI** | **pass** | different slot booked and cancelled; second offer; `POST …/accept` 200; page "You accepted the offer"; offer `accepted`, entry `fulfilled`, appointments list shows the new Confirmed "Waitlist visit" |
| G staff view | **not exercised** | staff app is still a connection placeholder (`apps/staff/src/App.tsx`); screenshot 29 records that |

Observations: (1) the product does not re-offer a slot the same entry declined (`candidates()` excludes it by design); my first F attempt reused the same slot and correctly got no offer (`raw/r10/ui/attempt2-same-slot/`), so F books a different slot. (2) The offer link is opened by URL (`/waitlist/offers/{id}?expires=…`) because no notification link is delivered to a browser in this environment.
Worker: 34 task types registered; jobs picked up and completed: `identity.record_sign_in`, `scheduling.on_reservation_confirmed`, `on_slot_freed`, `offer_waitlist`; error-free `queue._private_jobs` (0 rows with `last_error`); future jobs queued: `send_previsit`, `expire_offer`.

## Notifications (attempted, partial)
With the templates loaded (below), each offer produced four `waitlist_offer` rows: **`in_app` sent (2 of 2)**, `email`, `sms`, `push` **suppressed** (6). Why they are suppressed (no deliverable address/consent/provider in this synthetic setup) was **not determined**. No notification rows at all were created for booking confirmation, change or cancel (no `appointment_confirmation` etc.), so I cannot say whether the booking path is meant to send in this slice. No external provider was contacted. Reminder / pre-visit delivery not observed (jobs are future-dated).

## Findings
- **INT02-R10-B1 (blocking pending Backend/Orchestrator decision; notifications provisioning): the R1 notification templates are not provisioned by any migration, worker job, or bootstrap step, and without a published `waitlist_offer` template `offerToCandidate` throws `NotificationsValidationError(['templateKey'])`.** Evidence: first run on a fresh database (`raw/r10/ui/attempt1-no-templates/`): jobs 11 and 15 `scheduling.offer_waitlist` failed every attempt with `kernel.validation_failed`, the hold and offer roll back, retries run to attempts 4-5, no offer ever exists; reproduced with `offer-diagnosis.txt` (stack: `NotificationService.send` send.js:36, `WaitlistService.offerToCandidate`). The R9-B1 fix itself works (the hold now succeeds; the failure is after it). `r1-templates.ts` says the set "is DATA for an administrator to load through TemplateService (this ticket ships no migration data)", and no admin UI or run-guide step exists. In this run (and in `raw/r10/ui/attempt2-same-slot/` and the final run) the templates were loaded by SQL in setup (disclosed below), so journeys E and F pass only with that seeding. Decision needed: an owner must provide the provisioning (a seed/migration or documented, tested admin step) or confirm it is a deliberate deployment step recorded in RUN-GUIDE; a worker failure that retries silently for a missing template should also be considered.
- **INT02-R9-B1: closed** (offer created by the real worker as `app_worker` in patients scope; decline and accept in the UI; DB states above).
- **INT02-R10-N1 (test defect, definite cause): `apps/worker/src/jobs/identity/identity.dbtest.ts` `purge_sessions` seed uses `Buffer.alloc(32, Math.floor(Math.random() * 255))` as `token_hash`** (line about 216), only 255 values for 6 sessions in the first test, so a unique-key collision (`session_token_hash_uq`, key `\x5656…`) happens about 6% of the time; the second test then sees the leftovers (`5 !== 2`). Seen in attempt 3 (`integration-db-attempt3.txt`). Pre-dates this candidate (BE-04 commit `c274c74`). Not a product defect; fix is a unique hash per session.
- **INT02-R10-N2 (flake, class of INT02-R9-N2): file-level failure with every test passing, "terminating connection due to administrator command" in a `before` hook after the test ended**, now in `alerts.dbtest.js` (r9: `signin.dbtest.js`). Two different files, two of six runs across r9 and r10, none changed between attempts. Likely teardown races (`DROP DATABASE … WITH (FORCE)` while a pool or LISTEN connection still lives); not investigated beyond the signature. R9-N2 stays open, now as a recurring flake that fails the pipeline about one run in three; Backend should find the cause rather than rely on re-runs.
- INT02-R9-N1 (candidate named e7f06fb lacked the frontend fix): resolved in f8b70bb (contains the merge). Reviewers' decision on merge 768961e is recorded in HEAAA-237 per the task.
- INT02-R7-N2 (`GET /api/v1/me` 404): known limitation, still on every page load; journeys unaffected. Carried: INT02-R4-N1, INT02-R5-N2; `integration-db` must not run concurrently on one server.

## Not demonstrated (explicit)
- Staff view (no staff UI). N-1 / upgrade. Google calendar sync (connect, push, two-way: no Google account, no `EHR_CALENDAR_WEBHOOK_URL`); only the ICS download. Email/SMS/push delivery and the reason for suppression. Notification links reaching the patient (the offer page was opened by URL). Telehealth, documents and merge UIs. `integration-db` clean pass is one of three attempts.

## Fixtures seeded by SQL (disclosure)
Superuser SQL into throwaway database `ehr_int02_r10_ui` (dropped afterwards): organisation catalogue, two services, room, operating state, two clinician principals with `staff_profile` and `service_clinician`, weekly template for clinician 1, one patient with patient-realm principal and `patient_link`, `booking_policy waitlist_enabled=true` for the waitlist service, **availability template for clinician 2 inserted by SQL mid-run (journey E)**, and **new in r10: all English R1 notification templates inserted by SQL and published (INT02-R10-B1)**. Booking, change, cancel, waitlist join, offer creation, decline, accept, ICS download and all worker jobs went through real product code. Reason for the rest: patient registration/link controllers, admin and staff UIs are not mounted. No credentials in any artifact (DB URLs carry a role name only; the IdP JSON holds public fixture endpoints).

## Reproduce
`pnpm install --frozen-lockfile && pnpm build`; browser env per `BROWSER-RUNNER-AND-0704.md`; `raw/r10/ui/r10-run.sh "$PWD" "$PWD/docs/evidence/integration/M3/raw/r10/ui"` (needs `EHR_TEST_ADMIN_URL`, ports 3000, 4174, 9099 free); DB tests: `NODE_ENV=test INTEGRATION_SKIP_N_MINUS_1=true bash scripts/ci/migration-check/integration-db.sh`. Servers stopped by pid; database dropped.

## State
Executed and verified on f8b70bb: install, lint, prettier, typecheck, build, boundary, unit (745), `integration-db` (pass once of three; two failures are test-side, N1/N2), journeys A-F in the real UI against real API and worker. **Open:** INT02-R10-B1 (blocking pending decision), INT02-R10-N1, INT02-R10-N2/R9-N2. **Not executed:** above. Not marked Integrated; not submitted to QA; no gate approved. **Integration round 1 of 3 in the fresh budget.** Independent review: Backend Reviewer and Frontend Reviewer, pending.
