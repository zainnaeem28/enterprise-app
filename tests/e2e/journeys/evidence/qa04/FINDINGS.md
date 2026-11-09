# QA-04 findings (automated cases, ENV-INT/ci, fresh stack)

Run: `node --test --test-concurrency=1 tests/api/booking/*.test.mjs tests/api/clinical/*.test.mjs` on the exact commit named in the
submission comment. Raw: `run-spec.txt`, `run-junit.xml` in this folder. 53 tests: 47 pass, 6 fail. Every failure is a product
defect with a root cause below (none is a test defect). Stable IDs `QA04-F01..F06`; round 1 (cumulative round count = 1).

| ID | Cases | Sev | Defect (root cause) | Evidence |
| --- | --- | --- | --- | --- |
| QA04-F01 | TC-SAF-01/03c, 01/04b (RA-R1-07, BR-10, AC-08) | P0 | A red-flag triage is refused `403 auth.forbidden` and **no alert is ever created**; a red flag raised through the patient questionnaire also yields no alert a doctor can see. Root cause: `notifications.staff_scope_allows_patient(uuid)` is still the fail-closed stub `SELECT false` (migration 1201 states "BE-08 or INT-02 replaces the body ... CREATE OR REPLACE"; no later migration does), so the `staff_alert_staff_insert` and `staff_alert_target_select` policies reject every patient-bound alert (`red_flag`, `note_unsigned`). Same stub makes any patient alert invisible to staff. | `pg_get_functiondef` returns `SELECT false`; `notifications.staff_alert` has 0 rows after 6 flagged triages; audit `denied` rows (`clinical.route`). Patient still sees the emergency advice (TC-SAF-01/04a passes). |
| QA04-F02 | TC-BK-17 (SAR-09, RA-R1-03 6.5(b)) | P0 | Three parallel assignments of the SAME room at the same time all return 200 and all three queue entries hold the room. `PUT /appointments/{id}/assignment` writes `queue_entry.room_id` only; the collision check reads `slot_occupancy.room_id`, which the assignment never writes, so no check or constraint can fire (it also fails sequentially). | `ℹ queue entries holding the room: 3`, statuses `200,200,200`. |
| QA04-F03 | TC-BK-11 (RA-R1-02, J-04) | P1 | Front desk cannot book for a patient: `POST /holds` answers `403` for a `front_desk` session with `scheduling.booking.manage`. The staff variants of the booking routes are not mounted (`scheduling/core/controller.ts` header, "open item O-1"). | `403`, audit `denied proxy.route`. |
| QA04-F04 | TC-BK-01a (RA-R1-02, AC-01) | P1 | `GET /appointments/{reservationId}/calendar.ics` (documented in ARCHITECTURE 29.3) is not implemented: `404`. The `.ics` template exists but nothing serves it. | `404 kernel.not_found`. |
| QA04-F05 | TC-CAL-05 (RA-R1-04) | P1 | The calendar-sync controllers are not mounted in the API: `POST /webhooks/google/calendar` answers `404` (a bad token should be `401`) and `GET /calendar-link` answers `404` unauthenticated (no `/calendar-link*` routes). `createCalendarControllers` is exported but not referenced by `composition.ts`. A doctor cannot link a calendar. | `404` on both; grep of composition. |
| QA04-F06 | (TC-BK-13 observation) | P3 | On the long-running stack (many thousand rows) one of 100 parallel holds by the same patient answered `404 kernel.not_found` instead of `409 slot_taken` (2 of 3 runs). Not reproduced on a fresh stack (0 of 4 runs). Logged, not blocking; to be re-checked under TC-NFR load. | earlier run output (not retained) |

(F06 is an observation, not one of the 6 failing tests.)

## Not executed here, and why (never counted as passed)

- TC-BK-03/TC-CAL-01/03 against a real Google meeting, TC-CAL-05 steps 3-5, TC-CAL-06: need the Google test tenant (ENV-INT/staging, Blocked).
- TC-SAF-02 escalation timing (PM-confirm-1), TC-SAF-07 (human, never recorded by QA), TC-SAF acceptance: BLOCKED on D-12a. The red-flag rules in these tests are synthetic fixtures; they prove the mechanism, not clinical content.
- TC-PC-02 QR, TC-PC-04/CL-10 steps 2-4 (vital ranges are D-12a data and need elevated admin), TC-PC-07/13/14/15/16 banner and alert-stream cases, TC-CL-04/06/08: not in this batch (banner/UI cases belong to the browser journeys; ranges/escalation need the D-12a rows).
- TC-NT-03 (.ics in three real clients), real email/SMS sandbox delivery: human / staging. On ci the vendors are disabled, which is the provider-failure path of TC-NT-04.
- TC-NT-07 admin_pool compliance-only alerts: needs the elevated admin session (TC-ADM); only principal targeting is asserted.
