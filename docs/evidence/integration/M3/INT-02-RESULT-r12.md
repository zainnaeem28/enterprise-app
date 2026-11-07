# INT-02 r12 result (HEAAA-253, round 3 of 3 in budget ad27569a)

Candidate: `5e11b94` (base `daa90a0` + HEAAA-248 notification producers, INT02-R11-N1). Evidence is committed on top of it. I made no product-code changes. Node v24.22.2, PostgreSQL 17 on the shared test host, synthetic data, IdP = CI fixture, per-run secrets in process env only. Raw output: `raw/r12/` (`candidate-commit.txt`). Not marked Integrated, not submitted to QA, no gate approved.

## Verdict
No blocking product defect found in what was run. Three limits are **not demonstrated** (staff view, N-1 migration, a merge-then-notice journey through the UI) and one infrastructure flake occurred (DB attempt 1). Review of this evidence by Backend and Frontend Reviewers is still required.

## Checks actually run (current candidate)
| Check | Result |
|---|---|
| install (frozen lockfile), lint, prettier, typecheck, build, boundary | pass (`install/lint/format-check/typecheck/build/boundary.txt`) |
| unit (`run-unit.mjs`) | pass: 745 tests in 8 reports, none skipped/failed (`unit.txt`) |
| DB tests (`integration-db.sh`, `INTEGRATION_SKIP_N_MINUS_1=true`), 5 attempts | **4 of 5 pass** (attempts 2-5: 820 tests, 0 failed, 0 skipped). **Attempt 1 failed**: worker suite aborted in `migrate.mjs bootstrap` with `error: tuple concurrently updated` (role bootstrap contention on the shared cluster), 16 worker audit tests cancelled; db-foundation 40, kernel 23, api 679 all passed in that attempt. Finding INT02-R12-N3 (below). |
| 100-parallel booking race (TC-BK-13) | pass in attempts 2-5 |
| merge-vs-booking race / T1-T4 merge guard | pass (db-foundation) |
| 10x chart merge count test | pass (70 s whole test incl. seeding; bound check inside it passes) |
| merge between publish and handler: confirm/cancel/reschedule resolve to survivor (`notices.dbtest.ts`) | pass |

### Voided runs (disclosure)
`void-first-batch/`: five DB attempts run by the interrupted earlier run; attempts 2-5 failed because the run's `TMPDIR` was deleted when that run ended (`mkdtemp ENOENT`), attempt 1 failed (api timing, merge bound 103 s, 100-parallel) while the UI journeys ran on the same host. `void-second-batch-no-dist/`: five attempts that failed instantly because `dist/` was missing; rebuilt (`build-rebuild-before-db.txt`) and re-run. None of these count as evidence for or against the candidate.

## Real UI + API + worker journeys (fresh migrated DB, Chromium, screenshots `raw/r12/ui/*.png`, log `ui/journey-run.txt`)
Templates before API boot: 0 rows (negative control); after boot: 34 published rows, 8 keys, provisioned by `main.ts` (`ui/template-counts.txt`). No manual task-type sync.
- A book (service, place, clinician, hold, review, confirm): pass. Add to calendar: pass (`booked.ics`, 304 bytes, VEVENT + DTSTART).
- B change time: pass, still one confirmed. C cancel (policy text, dialog, cancelled, list empty): pass.
- D waitlist join: pass. E freed slot -> worker offer -> decline: pass. F second offer -> accept -> appointment listed, entry fulfilled: pass.
- H video booking + reschedule: pass in UI.
- I negative control (templates retired): booking still confirms; see N2.

### Notices through the running system (counts per template/status, from `journey-run.txt`)
- After confirm: `appointment_confirmation` 1 sent (in_app) + 3 suppressed (email/sms/push, `preference_off`); `appointment_reminder_48h` 4 queued, `appointment_reminder_4h` 4 queued.
- After change: old reminders 48h/4h all `cancelled`, new ones queued; `appointment_rescheduled` 1 sent + 3 suppressed.
- After cancel: `appointment_cancelled` 1 sent + 3 suppressed; all reminders for the appointment `cancelled`.
- Not demonstrated: delivery of a reminder at its due time (only queued/cancelled states observed); email/sms/push delivery (suppressed by default preferences).
- Patient merge followed by notices: **only covered by a DB test** (`merge between publish and handler run`), not by a UI journey. Not demonstrated through the running system.

## Specific questions
- **OBS-2 (report only):** booking a video visit through the UI created **no telehealth session** (0 sessions, 0 with reservation) after the initial booking, and none after reschedule. So the reschedule question cannot be answered positively: no meeting exists for either reservation in this run. Reported as INT02-R12-N1 for a human/Orchestrator decision; not fixed.
- **FR-N1:** BookedPage now says "We will remind you before your visit." and reminders are actually created (above). Truthful for the 48h/4h queue; delivery not shown.
- **Negative control (N2, INT02-R12-N2):** with all `appointment_*` templates retired by SQL (delete is refused by a trigger), a booking still confirms but `scheduling.on_reservation_confirmed` fails with `kernel.validation_failed` (2 attempts at observation) and no notices are created. Fail-safe for the booking, but silent to the patient; the boot-time provisioning (R10-B1) is what prevents this normally.
- **Staff view:** not exercised. `apps/staff` is a connection placeholder (`App.tsx`), no schedule/waitlist UI. `ui/32-FAILED-staff...png` is the placeholder page. Not demonstrated.
- **N-1:** skipped (`INTEGRATION_SKIP_N_MINUS_1=true`). Not demonstrated.

## Findings (stable IDs; all non-blocking observations, severity for human decision)
| ID | Summary |
|---|---|
| INT02-R12-N1 | Video visit booking and reschedule create no telehealth session/meeting (OBS-2). |
| INT02-R12-N2 | With templates absent, `on_reservation_confirmed` retries with `kernel.validation_failed` and no notice, no operator-visible signal beyond job errors. |
| INT02-R12-N3 | DB suite attempt 1: `tuple concurrently updated` in role bootstrap on the shared cluster; 4 of 5 attempts pass. Likely concurrent bootstrap by another client; not proven. Test-infra, not product. |
R7-N2 remains a known limitation.

## SQL seeding disclosure
`r12-setup.mjs` creates the synthetic organisation, patient and clinician data. The waitlist journey inserts clinician availability for the waitlist service by SQL (screenshot 20). The negative control retires templates by SQL. Appointments, cancels, offers, accepts and declines went through the UI/API; the worker produced the offers.

## Reproduce
`pnpm install --frozen-lockfile && pnpm build`; browser env per `BROWSER-RUNNER-AND-0704.md`; `raw/r12/ui/r12-run.sh` (needs `EHR_TEST_ADMIN_URL`); DB tests `bash scripts/ci/migration-check/integration-db.sh` with a persistent `TMPDIR`. Servers stopped by pid afterwards.
