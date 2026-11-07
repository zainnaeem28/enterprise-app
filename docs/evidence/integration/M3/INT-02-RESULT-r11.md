# INT-02 r11 — combined candidate daa90a0 (round 2 of 3, fresh budget)

**Result: INT02-R10-B1, R10-N1 and R10-N2 are CLOSED on this evidence.** On a fresh migrated database with **no SQL-seeded notification templates**, API boot provisioned them (8 keys, 34 rows) and the real worker created, and the patient accepted and declined, waitlist offers. The five `integration-db` runs all passed. **One new finding is open: INT02-R11-N1** (booking confirmation, change and cancel create no notifications, because nothing in the code sends them). Staff view, N-1 and the items under "Not demonstrated" were not exercised.

## Candidate
- Candidate `daa90a0` (base `f8b70bb` + HEAAA-241). This evidence branch fast-forwarded to `daa90a0` and then merged the r10 evidence commit `e432ad5` (docs only; it is how the r10 scripts reach this branch). I made no product-code change. Raw output: `raw/r11/`, scripts `raw/r11/ui/r11-*`.
- Node v24.22.2, pnpm 12.16.1, PostgreSQL 17 (`EHR_TEST_ADMIN_URL`), `NODE_ENV=test` for DB tests, synthetic data, IdP = CI fixture, secrets generated per run in process env only.

## Checks (on daa90a0)
| Check | Result |
| --- | --- |
| install (frozen), lint, prettier, typecheck, build, boundary fixture | pass, all exit 0 (`raw/r11/install, lint, format-check, typecheck, build, boundary`) |
| unit (`run-unit.mjs`) | pass: **745** tests, none skipped/failed (`unit.txt`) |
| `integration-db.sh` (`INTEGRATION_SKIP_N_MINUS_1=true`), **5 attempts**, nothing changed between | **5 of 5 exit 0**: db-foundation 40, kernel 23, api **671**, worker 78 = **812** tests, 0 failures each (`integration-db-attempt1..5.txt/.exit`). r10 was 1 of 3. |
| Teardown flake R10-N2 and purge_sessions collision R10-N1 | not reproduced in 5 runs (r10 failed 2 of 3). Five runs is not proof that the flake is gone; the fix adds error handlers on 5 pools only (HEAAA-242 limitation), so another pool could still race. |
| 100 parallel bookings of one slot | pass (`TC-BK-13`, `TC-BK-15`, 100 parallel confirmations) in every attempt |
| merge-vs-booking race | pass (`T3: a merge holding the root lock makes a concurrent reservation write wait…`) |
| all-participant merge counts | pass (`INT-02 fix B: the composition root registers every module; all participants run, report counts for all their tables…`) |
| New provisioning tests (`template-provisioning.dbtest`) | pass, incl. "concurrent boots on an empty database provision each key once (advisory lock)" |
| N-1 / upgrade path | **not run** (no release tag; unchanged limitation) |

## Real-UI journeys (real API `main.js` as `app_api`, real worker `main.js` as `app_worker`, built patient app via `vite preview`, Chromium 156)
Journey script `raw/r11/ui/r11-journey.mjs`, output `journey-run.txt`, screenshots `01..29-*.png` (actual application), `booked.ics`, `api-process.log`, `worker-process.log` (0 warn/error lines), `notifications-summary.txt`, `template-counts.txt`. Database from empty via real migrations; reference data by the real worker job; task types synced by the worker itself.

**R10-B1 control (the point of this run):** `template-counts.txt`
1. After setup, **before** API boot: `rows 0, published 0, keys 0` (negative control: the database has no templates, none seeded by SQL).
2. After API boot: `rows 34, published 34, keys 8` (`appointment_cancelled`, `appointment_confirmation`, `appointment_reminder_48h`, `appointment_reminder_4h`, `appointment_rescheduled`, `consent_request`, `previsit_request`, `waitlist_offer`). API log: `{"provisioned":8,"present":0,… "notification templates provisioned"}`.
3. Second API boot on the same database: `provisioned 0, present 8`, still 34 rows (idempotent, `raw/r11/ui/restart/api-process.log`).
4. Missing-template failure mode: demonstrated in r10 (`raw/r10/attempt1-no-templates`: offer job fails `kernel.validation_failed` on every retry). I did **not** re-create that failure on this candidate, because boot now provisions the templates; the "before API boot" count of 0 followed by a working offer is the paired control.

| Journey | Result | Observed |
| --- | --- | --- |
| A book (landing, sign in, service, place, clinician, availability, hold, review, confirm) | pass | session 200, hold 201, confirm 200 |
| A2 Add to calendar | pass | `appointment.ics` download, VCALENDAR/VEVENT/DTSTART (client-side ICS only) |
| B change time | pass | `POST …/reschedule` 200 |
| C cancel | pass | `POST …/cancel` 200 |
| D waitlist join | pass | `POST /waitlist-entries` 201 |
| E worker-created offer, patient DECLINES | pass | `scheduling.offer_waitlist` created the offer in seconds with **no seeded templates**; `POST …/decline` 200; offer `declined`, entry `active` |
| F second offer, patient ACCEPTS | pass | `POST …/accept` 200; offer `accepted`, entry `fulfilled`; appointments list shows the new Confirmed "Waitlist visit" |
| G staff view | **not exercised** | staff app is still a connection placeholder (`apps/staff/src/App.tsx`); `FAIL staff app…` line in `journey-run.txt` is that record, screenshot 29 |

Jobs after the run: 0 rows in `queue._private_jobs` with `last_error`; future jobs queued: `send_previsit`, `expire_offer`.

## Notifications
- Offers: each offer produced four `waitlist_offer` rows: `in_app` **sent**, `email`, `sms`, `push` **suppressed `preference_off`** (4 rows per offer, 8 total: 2 sent, 6 suppressed). The reason is now recorded (`preference_off`); I did not examine why the synthetic patient has those channels off by default.
- **Booking confirm, change, cancel: 0 notification rows after each** (probes in `journey-run.txt`: `NOTIFICATIONS after booking confirm/change/cancel: []`, taken 3 s after the API call). The task expected these to be created; they are not.

## Findings
- **INT02-R10-B1: closed.** Evidence above (0 templates before boot, 8 keys after, idempotent, offers created and accepted/declined without SQL template seeding). Limitation: `EHR_TEMPLATE_LANGUAGES` defaults to `en`; I exercised only English. Provisioning runs in `main.ts`, which this run executed (the HEAAA-242 reviewer did not).
- **INT02-R10-N1: closed** (purge_sessions collision not seen in 5 runs; fix is deterministic token_hash).
- **INT02-R10-N2 / R9-N2: no recurrence in 5 runs; recommend keeping open as "not shown to be fixed"** until more runs or a root cause. Backend decides.
- **INT02-R11-N1 (new, severity for Orchestrator/Backend to set; not a defect in the R10 fixes): no code path creates `appointment_confirmation`, `appointment_rescheduled`, `appointment_cancelled` or reminder notifications.** The templates are now provisioned, but `grep` for these keys in `apps/` outside `r1-templates.ts` and tests finds no sender; the only senders are `waitlist_offer` (`flow/waitlist.ts:466`) and `previsit_request` (`flow/previsit.ts:65`). The journeys confirm it (empty notification table after book/change/cancel). Either the producer was never built for this slice (then the expectation in this task and the templates are ahead of the code), or it belongs to a ticket not integrated. A decision is needed on whether M3 requires these notifications.
- INT02-R10-FR-N1 (identical offer screenshots): partly fixed. Offer pages now have their own screenshots (23 first offer, 24 after decline, 26 second offer, 27 accepted). Four pairs are still byte-identical because the page is the same: 23 and 26 (the offer page is visually identical for both offers; the ids differ only in the URL and in `journey-run.txt`), and 17/22/25 (appointments list after a cancel), 19/20 (fixture step with no UI change), 28/29 (the staff step failed on the same page). Treat the duplicates as non-evidence; the DB rows and API calls in `journey-run.txt` are the proof.
- INT02-R7-N2 (`GET /api/v1/me` 404): known limitation, still on every page load; journeys unaffected. Carried: INT02-R4-N1, INT02-R5-N2; `integration-db` must not run concurrently on one server (I ran them one after another).

## Not demonstrated (explicit)
- Staff view (no staff UI). N-1 / upgrade. Google calendar sync (only the ICS download). Email/SMS/push delivery (suppressed `preference_off`; no provider contacted). Notification links reaching the patient (offer page opened by URL). Telehealth, documents and merge UIs. Non-English template languages. Booking/change/cancel notifications (none exist, R11-N1). A negative control with the templates removed on this candidate.

## Fixtures seeded by SQL (disclosure)
Superuser SQL into throwaway database `ehr_int02_r11_ui` (dropped afterwards): organisation catalogue, two services, room, operating state, two clinician principals with `staff_profile` and `service_clinician`, weekly template for clinician 1, one patient with patient-realm principal and `patient_link`, `booking_policy waitlist_enabled=true` for the waitlist service, availability template for clinician 2 inserted by SQL mid-run (journey E). **No notification templates are seeded by SQL** (the r10 seeding block was removed from `r11-setup.mjs`). Booking, change, cancel, waitlist join, offer creation, decline, accept, ICS download, template provisioning and all worker jobs went through real product code. No credentials in any artifact.

## Reproduce
`pnpm install --frozen-lockfile && pnpm build`; browser env per `BROWSER-RUNNER-AND-0704.md`; `raw/r11/ui/r11-run.sh "$PWD" "$PWD/docs/evidence/integration/M3/raw/r11/ui"` (needs `EHR_TEST_ADMIN_URL`, ports 3000, 4174, 9099 free); DB tests: `NODE_ENV=test INTEGRATION_SKIP_N_MINUS_1=true bash scripts/ci/migration-check/integration-db.sh`. Servers stopped by pid; database dropped.

## State
Executed and verified on daa90a0: install, lint, prettier, typecheck, build, boundary, unit (745), `integration-db` 5 of 5 pass (812 tests), journeys A-F in the real UI against real API and worker with boot-time template provisioning. **Open:** INT02-R11-N1 (decision needed), R9-N2 recurrence watch, carried R7-N2/R4-N1/R5-N2. **Not executed:** above. Not marked Integrated; not submitted to QA; no gate approved. **Integration round 2 of 3 in the fresh budget.** Independent review: Backend Reviewer and Frontend Reviewer, pending.
