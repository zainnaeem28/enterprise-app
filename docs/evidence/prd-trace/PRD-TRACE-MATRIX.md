# PRD requirement trace (matrix)

| Field | Value |
| --- | --- |
| Task | HEAAA-955 (audit 4 of HEAAA-807 `completeness-audit` rev 1). Carried into the R4 package HEAAA-828 (link there). |
| Final dev head traced | `60d962e469d4856a8fd16704416962f350b50354` (`origin/dev`, "HEAAA-939: secret-replica crontab test …") |
| Author | QA Engineer agent. This is QA trace evidence. It is **not** an independent review (a separate task), **not** human acceptance and **not** G3. |
| Inputs | `docs/PRD.md` sections 8.2 and 9 (RA-R1-01..32, RA-R2-01..11, RA-R3-01..07, NFR-1..22); `docs/TEST-CASES.md` (274 case IDs, section 15.1 row-to-case map, statuses after HEAAA-805); evidence under `docs/evidence` (r2 `cdc388d`, qa-r3 `7860f5f`/`ae1f6c9`/`ff5476e`, ruling C `d357128`); a fresh run on this head (section 2) |
| Reproduce | `node scripts/ci/run-unit.mjs` then `node docs/evidence/prd-trace/build-matrix.mjs` (reads `reports/unit`, the evidence folders and git history; fails on a stale code path) |

## 1. Read this first

1. **What passed on the final head.** Executed on `60d962e` in this task: lint (0 errors, 30 warnings), format check, typecheck, build, boundary test, and **all 1,678 unit tests (0 failed, 0 skipped)**. Every requirement row below shows how many of those unit tests sit under its merged code (column "Unit @ head").
2. **What did not run on the final head.** The database-backed suites (`*.dbtest` through `integration-db.sh`) and the API/browser case suites (`tests/api/**`, `tests/e2e/**`) were **not rerun on `60d962e`**. The host disk is at 100% (65 MB free of 48 GB), and these suites need a throwaway PostgreSQL 17 plus build output; running them would risk filling the disk shared with other agents. Their last recorded passing results are on older heads. Each row names that head and how many commits have touched the row's mapped code since. **A row is called "PASS (no later change to mapped code)" only when that count is 0.** This is a statement about evidence age, not a fresh pass. Follow-up: gap G-01.
3. **Cases that did not pass are never counted as passes.** Blocked, skipped, human-required and unrecorded cases are listed in section 6 and classified as defect, gap or go-live item.
4. **R2 and R3 requirements are not built** (PRD 4.3 makes them later releases). They have no merged code and no executable case. They are listed so that nothing is missing from the trace; they are a scope fact, not a defect of R1.

## 2. Executed on the final head

| Check | Result on `60d962e` |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build` | pass |
| `pnpm lint` | pass, 0 errors, 30 warnings |
| `pnpm format:check` | pass (the 6-file failure recorded on `d357128`, finding QA805-F01, is gone) |
| `pnpm typecheck` | pass |
| `pnpm test:boundary` | pass |
| `node scripts/ci/run-unit.mjs` | pass: api: 366 tests, 0 failed; app-shell: 89 tests, 0 failed; cms: 92 tests, 0 failed; kernel: 170 tests, 0 failed; patient: 211 tests, 0 failed; site: 76 tests, 0 failed; staff: 298 tests, 0 failed; ui: 175 tests, 0 failed; worker: 200 tests, 0 failed; boundary: 1 tests, 0 failed |
| Not run | integration-db and N-1 (needs PostgreSQL; disk), `tests/api/**` and browser suites, SAST, secret scan, dependency audit, container scan, Schemathesis, Lighthouse (no hosted CI per owner ruling B; tools not installed here) |

Unit counts per file are in `head-run/unit-by-file.csv`. Node 24.22.2, pnpm 12.16.1 (from `package.json`). Synthetic data only; no live system was touched.

## 3. How to read the matrix

- **Merged code**: files or folders on the head that implement the row (checked to exist by the generator).
- **Cases and last recorded result**: case IDs from `docs/TEST-CASES.md` section 15.1 (and NFR mapping), with the result found in the evidence files. "pass N" is a recorded pass; "skipped/blocked" is a case the run recorded as skipped or blocked; "no result" means no evidence file contains a result for it.
- **Oldest evidence head**: the oldest candidate among the recorded passes, and how many commits touched the mapped code since. Evidence heads: `cdc388d` (R2 run), `00faee1` (QA-06 a11y), `7860f5f`/`ff5476e` (qa-r3 supplement), `d357128` (ruling C platform run, 26 commits behind this head).
- **Unit @ head**: unit tests passing on this head under the mapped paths, and the number of `*.dbtest` files under them that were not run on this head.

Case IDs are shown without the `TC-` prefix.

## 4. Release 1 acceptance rows (PRD 8.2)

| Requirement | Merged code | Cases and last recorded result | Unit @ head | Oldest evidence head | Status |
| --- | --- | --- | --- | --- | --- |
| **RA-R1-01** A new patient completes sign-up with email/phone OTP and can enable MFA. A staff user signs in only through Go… | `apps/api/src/modules/identity/oidc.ts`<br>`apps/api/src/modules/identity/auth.controller.ts`<br>`apps/api/src/modules/identity/sessions.ts`<br>`apps/api/src/modules/identity/realms.ts`<br>`apps/patient/src/features/auth`<br>`apps/staff/src/features/auth`<br>`db/migrations/0500_identity_schema_and_tables.sql` | pass 7: ID-04 ID-06 ID-08 ID-09 ID-10 ID-11 ID-12<br>skipped/blocked 6: ID-01 ID-02 ID-03 ID-03b ID-05 ID-07 | 53 pass, 0 fail; 0 dbtest file(s) not run | cdc388d, 3 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-02** A patient books, reschedules and cancels an appointment for each of in-person and video, from the doctor's tem… | `apps/api/src/modules/scheduling/core`<br>`apps/api/src/modules/scheduling/availability`<br>`apps/api/src/modules/scheduling/flow/notices.ts`<br>`apps/patient/src/features/booking`<br>`db/migrations/0903_scheduling_booking_functions.sql` | pass 11: BK-01 BK-02 BK-03 BK-04 BK-05 BK-06 BK-07 BK-08 BK-09 BK-10 BK-11<br>no result 1: BK-12 | 50 pass, 0 fail; 6 dbtest file(s) not run | cdc388d, 11 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-03** No double booking: for a slot that is not overbookable, under 100 parallel confirmations exactly one succeeds … | `apps/api/src/modules/scheduling/core/service.ts`<br>`apps/api/src/modules/scheduling/core/concurrency.dbtest.ts`<br>`db/migrations/0903_scheduling_booking_functions.sql`<br>`db/migrations/2408_scheduling_overbook_cap_per_slot.sql` | pass 6: BK-13 BK-14 BK-15 BK-16 BK-17 BK-18<br>no result 1: PERF-07 | 0 pass, 0 fail; 1 dbtest file(s) not run | cdc388d, 3 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-04** A doctor's Google Calendar receives a "Busy" block with no patient name, reason or diagnosis, and syncs a Goog… | `apps/api/src/modules/calendar-sync`<br>`apps/worker/src/jobs/calendar-sync`<br>`db/migrations/1400_calendar_sync_tables.sql` | pass 5: CAL-01 CAL-02 CAL-03 CAL-04 CAL-05<br>no result 1: CAL-06 | 0 pass, 0 fail; 1 dbtest file(s) not run | cdc388d, 1 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-05** A confirmation and two reminders (times [G2 setting]) are sent with an .ics attachment and a log-in prompt onl… | `apps/api/src/modules/notifications/render.ts`<br>`apps/api/src/modules/notifications/r1-templates.ts`<br>`apps/api/src/modules/notifications/allowlist.ts`<br>`apps/api/src/modules/notifications/forbidden.ts`<br>`apps/api/src/modules/scheduling/core/ics.ts` | pass 7: NT-01 NT-02 NT-04 NT-05 NT-06 NT-07 NT-08<br>no result 1: NT-03 | 0 pass, 0 fail; 0 dbtest file(s) not run | cdc388d, 0 commit(s) | PARTIAL: executed part passed, no later code change; rest in section 6 |
| **RA-R1-06** Check-in (desk and QR), questionnaire and consent review, vitals with out-of-range highlighting, triage catego… | `apps/api/src/modules/clinical/frontdoor`<br>`apps/staff/src/features/preconsult`<br>`db/migrations/1700_frontdoor_tables.sql` | pass 5: PC-01 PC-05 PC-06 PC-08 PC-14<br>**FAIL 2: PC-07 PC-13**<br>no result 5: PC-02 PC-03 PC-04 PC-09 PC-15 | 34 pass, 0 fail; 2 dbtest file(s) not run | cdc388d, 3 commit(s) | **FAIL** |
| **RA-R1-07** Blocked until D-12a is decided. A red-flag triage answer alerts the on-duty doctor and shows emergency advice.… | `apps/api/src/modules/clinical/frontdoor/redflag.ts`<br>`apps/api/src/modules/notifications/alerts`<br>`db/migrations/1200_staff_alert_tables.sql` | pass 3: SAF-01 SAF-03 SAF-04<br>no result 2: SAF-02 PC-16 | 0 pass, 0 fail; 1 dbtest file(s) not run | cdc388d, 1 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-08** Blocked until D-12a is decided. A consultation cannot start without required consents except by a recorded eme… | `apps/api/src/modules/clinical/frontdoor/consents.ts`<br>`apps/api/src/modules/scheduling/flow/previsit.ts` | pass 3: SAF-05 SAF-06 SAF-08<br>no result 1: SAF-07 | 0 pass, 0 fail; 0 dbtest file(s) not run | cdc388d, 0 commit(s) | PARTIAL: executed part passed, no later code change; rest in section 6 |
| **RA-R1-09** A doctor writes a note from a template, signs it and it locks; later changes are addenda; trainee notes cannot… | `apps/api/src/modules/clinical/notes`<br>`apps/api/src/modules/clinical/chart/terminology.ts`<br>`apps/staff/src/features/doctor`<br>`db/migrations/1800_notes_tables.sql` | pass 5: CL-01 CL-02 CL-03 CL-05 CL-07<br>no result 2: CL-04 CL-06 | 29 pass, 0 fail; 2 dbtest file(s) not run | cdc388d, 3 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-10** A telehealth visit runs with device check, waiting room and notes side by side, and shows both time zones when… | `apps/api/src/modules/telehealth`<br>`apps/worker/src/jobs/telehealth`<br>`apps/patient/src/features/telehealth`<br>`db/migrations/1500_telehealth_tables.sql` | pass 3: TH-02 TH-03 TH-05<br>skipped/blocked 2: TH-01 TH-04<br>no result 1: PERF-06 | 16 pass, 0 fail; 1 dbtest file(s) not run | d357128, 1 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-11** Every chart view is logged. Out-of-assignment access is blocked until a reason is entered, alerts compliance a… | `apps/api/src/modules/audit`<br>`apps/api/src/modules/clinical/chart/access.ts`<br>`apps/api/src/modules/clinical/chart/break-glass-controller.ts`<br>`db/migrations/0200_audit_event.sql`<br>`db/migrations/0202_audit_btg_and_export.sql` | pass 7: AU-01 AU-02 AU-03 AU-04 AZ-10 AZ-11 AZ-16 | 0 pass, 0 fail; 1 dbtest file(s) not run | cdc388d, 1 commit(s) | PASS on older head; 1 later commit(s) to mapped code: rerun needed (G-01) |
| **RA-R1-12** Audit entries cannot be deleted by any role, including admin. The audit viewer shows who, what, when, from whe… | `apps/api/src/modules/audit`<br>`apps/api/src/modules/admin-routes/audit-routes.ts`<br>`db/migrations/0203_audit_rls_and_grants.sql`<br>`db/migrations/0204_audit_anchor_archive_receipt.sql` | pass 3: AU-05 AU-06 AU-07<br>skipped/blocked 2: AU-08 AU-09 | 0 pass, 0 fail; 1 dbtest file(s) not run | d357128, 0 commit(s) | PARTIAL: executed part passed, no later code change; rest in section 6 |
| **RA-R1-13** Uploads are virus-scanned before anyone can open them, classified and staff-confirmed. Infected files are quar… | `apps/api/src/modules/documents`<br>`apps/worker/src/jobs/documents`<br>`db/migrations/1000_documents_schema_and_tables.sql` | pass 4: DOC-03 DOC-04 DOC-06 DOC-07<br>skipped/blocked 4: DOC-01 DOC-02 DOC-05 DOC-08 | 0 pass, 0 fail; 1 dbtest file(s) not run | cdc388d, 4 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-14** Patient can set notification preferences, request a data export and request account deletion; compliance sees … | `apps/api/src/modules/privacy`<br>`apps/api/src/modules/patient/export.ts`<br>`apps/patient/src/features/privacy`<br>`db/migrations/1900_privacy_schema_and_tables.sql`<br>`db/migrations/2600_privacy_deletion_tables.sql` | pass 5: PR-01 PR-02 PR-03 PR-04 PR-05 | 9 pass, 0 fail; 2 dbtest file(s) not run | cdc388d, 12 commit(s) | PASS on older head; 12 later commit(s) to mapped code: rerun needed (G-01) |
| **RA-R1-15** Admin configures clinics, rooms, hours, holidays, services, booking policies, message templates and roles. Boo… | `apps/api/src/modules/organisation`<br>`apps/staff/src/features/admin-config` | pass 6: AD-01 AD-02 AD-03 AD-05 AD-06 AD-07<br>skipped/blocked 1: AD-04 | 41 pass, 0 fail; 2 dbtest file(s) not run | d357128, 0 commit(s) | PARTIAL: executed part passed, no later code change; rest in section 6 |
| **RA-R1-16** Brand site pages for services, doctors (with next available slot), locations and contact exist; "Book" hands o… | `apps/site/src`<br>`apps/cms/src/collections`<br>`apps/cms/src/globals` | pass 5: BS-01 BS-02 BS-05 BS-06 BS-07<br>skipped/blocked 2: BS-03 BS-04 | 88 pass, 0 fail; 0 dbtest file(s) not run | cdc388d, 6 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **RA-R1-17** A user in Clinic A cannot find a patient registered only in Clinic B; a patient cannot view another patient's … | `apps/api/src/modules/identity/scope.ts`<br>`apps/api/src/modules/patient/scope.ts`<br>`db/migrations/0502_identity_rls_and_grants.sql`<br>`db/migrations/0904_sec03_bind_definer_functions_to_caller.sql` | pass 22: AZ-01 AZ-02 AZ-03 AZ-04 AZ-05 AZ-06 AZ-07 AZ-08 AZ-09 AZ-10 AZ-11 AZ-12 AZ-13 AZ-14 AZ-15 SEC-C7-01 SEC-C7-02 SEC-C7-03 SEC-C7-04 SEC-C7-05 SEC-C7-06 SEC-C7-07 | 0 pass, 0 fail; 0 dbtest file(s) not run | cdc388d, 1 commit(s) | PASS on older head; 1 later commit(s) to mapped code: rerun needed (G-01) |
| **RA-R1-19** Patient edits profile (demographics, emergency contact, insurance cards, preferred pharmacy and language) and … | `apps/api/src/modules/patient/service.ts`<br>`apps/patient/src/features/profile`<br>`db/migrations/0700_patient_schema_and_tables.sql` | pass 2: PP-01 PP-02 | 26 pass, 0 fail; 0 dbtest file(s) not run | d357128, 0 commit(s) | PASS (no later change to mapped code) |
| **RA-R1-20a** Testable now. Default proxy visibility (D-7 default): a linked proxy sees appointments only and nothing else; … | `apps/api/src/modules/identity/proxy.ts`<br>`apps/api/src/modules/identity/proxy-scopes.ts`<br>`apps/patient/src/features/profile`<br>`db/migrations/2620_proxy_rules_tables.sql` | pass 2: PP-03 AZ-14 | 26 pass, 0 fail; 0 dbtest file(s) not run | cdc388d, 8 commit(s) | PASS on older head; 8 later commit(s) to mapped code: rerun needed (G-01) |
| **RA-R1-20b** Blocked on D-7. Guardian/proxy link creation, verification, age-out and revocation behave per the proxy rules;… | `apps/api/src/modules/identity/proxy.ts`<br>`apps/api/src/modules/identity/proxy-scopes.ts`<br>`apps/staff/src/features/guardians`<br>`db/migrations/2623_proxy_rules_rls_and_grants.sql` | pass 2: PP-04 PP-05 | 7 pass, 0 fail; 0 dbtest file(s) not run | d357128, 0 commit(s) | PASS (no later change to mapped code) |
| **RA-R1-21** Patient completes the pre-visit questionnaire, e-signs consents and uploads insurance cards before the visit (… | `apps/api/src/modules/scheduling/flow/previsit.ts`<br>`apps/patient/src/features/previsit`<br>`apps/staff/src/features/preconsult` | skipped/blocked 2: PP-06 PP-07 | 56 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **RA-R1-22** When a slot frees up, waitlisted patients receive an offer, the first to accept within the acceptance time [G2… | `apps/api/src/modules/scheduling/flow/waitlist.ts`<br>`apps/worker/src/jobs/scheduling` | pass 4: BK-19 BK-20 BK-21 BK-22 | 0 pass, 0 fail; 0 dbtest file(s) not run | cdc388d, 0 commit(s) | PASS (no later change to mapped code) |
| **RA-R1-23** A doctor defines availability templates, leave and blocked time; slot search reflects them within one booking … | `apps/api/src/modules/scheduling/availability`<br>`apps/staff/src/features/availability`<br>`db/migrations/1100_availability_tables.sql` | pass 3: DR-01 DR-02 DR-03 | 42 pass, 0 fail; 3 dbtest file(s) not run | ff5476e, 2 commit(s) | PASS on older head; 2 later commit(s) to mapped code: rerun needed (G-01) |
| **RA-R1-24** A doctor opens a patient chart summary showing problems, allergies, medications, vitals, history and documents… | `apps/api/src/modules/clinical/chart`<br>`apps/staff/src/features/doctor` | pass 3: CL-10 CL-08 PC-14<br>**FAIL 2: PC-07 PC-13**<br>no result 2: CL-09 PC-15 | 29 pass, 0 fail; 1 dbtest file(s) not run | cdc388d, 4 commit(s) | **FAIL** |
| **RA-R1-25** Staff create tasks and send secure messages to other staff. Patient messaging (F-PP-09, S) is accepted only if… | `apps/api/src/modules/messaging`<br>`apps/staff/src/features/messages`<br>`db/migrations/2000_messaging_schema_and_tables.sql` | pass 4: MSG-01 MSG-02 MSG-03 MSG-04 | 12 pass, 0 fail; 1 dbtest file(s) not run | d357128, 0 commit(s) | PASS (no later change to mapped code) |
| **RA-R1-26** Admin turns feature flags per location and posts a maintenance banner (F-AD-11, S); the cookie-consent banner … | `apps/api/src/modules/organisation/admin/flag-rules.ts`<br>`apps/api/src/modules/reporting`<br>`apps/site/src/consent.ts`<br>`apps/site/src/components/ConsentBanner.tsx` | pass 3: AD-08 AD-09 AD-10<br>skipped/blocked 1: BS-08 | 0 pass, 0 fail; 1 dbtest file(s) not run | d357128, 0 commit(s) | PARTIAL: executed part passed, no later code change; rest in section 6 |
| **RA-R1-27** [Rec] Registering a patient whose name, date of birth and phone/email match an existing record shows a duplica… | `apps/api/src/modules/identity/merge.ts`<br>`apps/api/src/modules/patient/merge`<br>`db/migrations/0803_patient_merge_functions.sql`<br>`apps/worker/src/merge-e2e.dbtest.ts` | pass 7: MG-01 MG-02 MG-03 MG-04 MG-06 MG-07 MG-12<br>skipped/blocked 7: MG-05 MG-08 MG-09 MG-10 MG-11 MG-13 MG-14 | 0 pass, 0 fail; 4 dbtest file(s) not run | d357128, 0 commit(s) | PARTIAL: executed part passed, no later code change; rest in section 6 |
| **RA-R1-28** [Rec] A booking for a video visit is refused or flagged when the patient's stated location is outside the clin… | `apps/api/src/modules/telehealth/rules.ts`<br>`apps/api/src/modules/telehealth/service.ts`<br>`db/migrations/2640_identity_licensed_state_admin_write.sql` | pass 3: TH-06 TH-07 TH-08 | 0 pass, 0 fail; 0 dbtest file(s) not run | d357128, 0 commit(s) | PASS (no later change to mapped code) |
| **RA-R1-29** Manual insurance eligibility: staff record verification status and date against the patient's insurance card; … | `apps/api/src/modules/clinical/frontdoor/followups.ts`<br>`apps/api/src/modules/clinical/frontdoor/common.ts`<br>`db/migrations/1700_frontdoor_tables.sql` | pass 1: PC-10 | 0 pass, 0 fail; 0 dbtest file(s) not run | ff5476e, 0 commit(s) | PASS (no later change to mapped code) |
| **RA-R1-30** Staff book a follow-up appointment and create a referral for a patient from the chart or the pre-consultation … | `apps/api/src/modules/clinical/frontdoor/followups.ts`<br>`apps/api/src/modules/clinical/frontdoor/referrals.ts`<br>`db/migrations/2300_patient_referral_accept_scope.sql` | pass 2: PC-11 PC-12 | 0 pass, 0 fail; 0 dbtest file(s) not run | cdc388d, 0 commit(s) | PASS (no later change to mapped code) |
| **RA-R1-31** Admin opens integration settings for the R1 integrations (Google Workspace sign-in and calendar, email, SMS, p… | `apps/api/src/modules/integration-core`<br>`apps/api/src/modules/integrations-host`<br>`apps/api/src/modules/admin-routes/integration-routes.ts`<br>`apps/staff/src/features/admin-compliance` | pass 2: AD-13 AD-14<br>skipped/blocked 3: AD-11 AD-12 AD-15 | 27 pass, 0 fail; 2 dbtest file(s) not run | d357128, 0 commit(s) | PARTIAL: executed part passed, no later code change; rest in section 6 |
| **RA-R1-32** [Rec] Admin and compliance roles (every role that can assign roles, change configuration or policy, read audit… | `apps/api/src/modules/identity/admin`<br>`apps/staff/src/features/admin-auth`<br>`db/migrations/2400_identity_admin_tables.sql`<br>`db/migrations/2405_identity_admin_second_key_session.sql` | pass 25: SEC-01 SEC-02 SEC-03 SEC-04 SEC-05 SEC-07 SEC-08 SEC-09 SEC-10 SEC-12 SEC-13 SEC-14 SEC-20 SEC-21 SEC-22 SEC-23 SEC-C7-01 SEC-C7-02 SEC-C7-03 SEC-C7-04 SEC-C7-05 SEC-C7-06 SEC-C7-07 AD-05 AD-10<br>skipped/blocked 9: SEC-06 SEC-11 SEC-15 SEC-16 SEC-17 SEC-18 SEC-19 SEC-24 SEC-25 | 22 pass, 0 fail; 4 dbtest file(s) not run | cdc388d, 0 commit(s) | PARTIAL: executed part passed, no later code change; rest in section 6 |

RA-R1-18 (all R1 NFR targets) is the sum of the NFR rows in section 5; it has no cases of its own.

## 5. Non-functional requirements (PRD 9)

| Requirement | Merged code | Cases and last recorded result | Unit @ head | Oldest evidence head | Status |
| --- | --- | --- | --- | --- | --- |
| **NFR-1** Availability, patient and doctor portals: 99.9 % monthly. Measurement scope [Rec] (SA-F-05): outages of third … | `infra/modules/observability`<br>`infra/modules/database` | no result 2: REC-07 REC-08 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-2** Recovery point objective: ≤ 15 min, also for loss of a whole cloud region unless the owner decides otherwise (… | `infra/modules/dr`<br>`infra/modules/database` | no result 2: REC-01 REC-03 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-3** Recovery time objective: ≤ 4 h, also for loss of a region (D-26)… | `infra/modules/dr`<br>`scripts/restore` | no result 2: REC-02 REC-03 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-4** Backups: Automated, encrypted, cross-region copy; restore-test cadence set at G2… | `infra/modules/dr`<br>`infra/modules/database`<br>`.github/workflows/restore-test.yml` | no result 2: REC-01 REC-02 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-5** Deployments: Zero downtime; rollback and database migration plan per release… | `.github/workflows/deploy-production.yml`<br>`infra/modules/compute`<br>`scripts/ci/migration-check` | no result 1: REC-04 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-6** API latency: p95 < 500 ms for normal reads/writes at peak load… | `tests/load/scenarios/perf-01-mixed.js` | no result 2: PERF-01 PERF-03 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-7** Page load: LCP < 2.5 s on 4G… | `lighthouserc.cjs`<br>`apps/site/src`<br>`apps/patient/src` | no result 1: PERF-05 | 287 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-8** Slot search: p95 < 1 s across all locations… | `apps/api/src/modules/scheduling/availability/search.ts`<br>`tests/load/scenarios/perf-02-slot-search.js` | no result 1: PERF-02 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-9** Capacity at launch (peak): ~8,000 appointments/day; ~4,000 prescriptions/day; ~1,500 deliveries/day; ~250 conc… | `tests/load`<br>`infra/modules/loadtest`<br>`.github/workflows/loadtest-run.yml` | no result 3: PERF-01 PERF-06 PERF-08 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-10** Accessibility: WCAG 2.2 AA on all portals and the brand site… | `tests/e2e/a11y`<br>`apps/patient/src/a11y.test.tsx`<br>`apps/staff/src/a11y.test.tsx`<br>`apps/site/src/a11y.test.tsx`<br>`packages/ui` | pass 3: A11Y-01 A11Y-05 A11Y-06<br>no result 5: A11Y-02 A11Y-03 A11Y-04 A11Y-07 A11Y-08 | 210 pass, 0 fail; 0 dbtest file(s) not run | 00faee1, 10 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **NFR-11** Browsers/devices: Current Chrome, Safari, Edge, Firefox; phones from 360 px… | `tests/e2e/a11y/xb.spec.ts`<br>`packages/ui` | pass 1: XB-01<br>no result 2: XB-02 XB-03 | 175 pass, 0 fail; 0 dbtest file(s) not run | 00faee1, 2 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **NFR-12** Encryption: TLS 1.2+ in transit; encryption at rest; managed key service with rotation… | `infra/modules/kms`<br>`infra/modules/edge`<br>`infra/modules/storage`<br>`infra/modules/database` | no result 2: NFR-01 NFR-02 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-13** Audit: Append-only record of every view, create, change, export, print of patient data with user, time, IP/dev… | `apps/api/src/modules/audit`<br>`infra/modules/archive`<br>`infra/RETENTION.md` | pass 3: AU-05 AU-06 AU-07<br>skipped/blocked 3: AU-08 AU-09 PERF-04 | 0 pass, 0 fail; 1 dbtest file(s) not run | d357128, 1 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **NFR-14** Application security: OWASP ASVS L2 baseline; L3 for authentication, prescribing and payment paths… | `docs/security`<br>`packages/kernel/src`<br>`apps/api/src/platform` | no result 1: NFR-08 | 0 pass, 0 fail; 2 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-15** CI security gates: SAST, dependency, secret and container scanning on every change; blocking findings fail the… | `.github/workflows/ci.yml`<br>`scripts/ci/sast.sh`<br>`scripts/ci/deps.sh`<br>`scripts/ci/secrets.sh`<br>`scripts/ci/container-scan.sh` | no result 5: NFR-03 NFR-04 NFR-05 NFR-06 NFR-07 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-16** Penetration test: Independent test before each production release with new external surface… | `docs/security/TC-PEN-01-scope-and-rules-of-engagement.md` | no result 1: PEN-01 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-17** Public-form protection: Rate limiting, bot protection on public forms, upload scanning… | `apps/api/src/modules/documents`<br>`apps/site/src/server.ts`<br>`infra/modules/edge` | pass 2: BS-06 DOC-03<br>no result 1: NFR-12 | 0 pass, 0 fail; 1 dbtest file(s) not run | cdc388d, 7 commit(s) | PARTIAL: executed part passed on an older head; rest in section 6 |
| **NFR-18** Data handling: Health data absent from logs, URLs, analytics, SMS and email; synthetic data outside production… | `packages/kernel/src/logging/redact.ts`<br>`apps/site/src/analytics.ts`<br>`apps/api/src/modules/notifications/forbidden.ts` | no result 2: NFR-09 NFR-10 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-19** Hosting: HIPAA-eligible US region with signed BAA. Provider is an owner decision (D-30); the Architect recomme… | `docs/GO-LIVE.md`<br>`infra/accounts` | no result 1: NFR-11 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-20** Monitoring: Uptime, errors, latency, queue backlogs, integration failures, with on-call alerts that reach a na… | `infra/modules/observability/alarms.tf`<br>`infra/modules/observability/canaries.tf` | no result 1: REC-08 | 0 pass, 0 fail; 0 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-21** Integration resilience: Every external call has a timeout and back-off retry; failure visible on an operations… | `apps/api/src/modules/integration-core`<br>`packages/kernel/src`<br>`apps/worker/src/runner.ts` | no result 1: REC-06 | 0 pass, 0 fail; 3 dbtest file(s) not run | none | NOT EXECUTED |
| **NFR-22** Time handling: Store UTC; show in the location time zone… | `apps/api/src/modules/scheduling/core`<br>`apps/api/src/modules/telehealth/rules.ts`<br>`packages/kernel/src` | pass 2: BK-10 TH-02 | 0 pass, 0 fail; 5 dbtest file(s) not run | cdc388d, 15 commit(s) | PASS on older head; 15 later commit(s) to mapped code: rerun needed (G-01) |

## 5.1 R2 and R3 acceptance rows (not built)

| Requirement | Merged code | Cases | Status |
| --- | --- | --- | --- |
| **RA-R2-01** 100 % of signed prescriptions have a recorded allergy, interaction, duplicate-therapy and dose-range… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-02** Signing a prescription requires re-authentication. A Schedule II–V prescription is refused without p… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-03** Every signed prescription, to partner and non-partner pharmacies alike, is sent through the certifie… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-04** If the network is unavailable the prescription stays Signed and unsent with visible retry state on t… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-05** Partner pharmacist sees only a mirror of own pharmacy's prescriptions; can report accept, query or r… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-06** The pharmacy cannot extend a prescription; refill requests reach the prescriber.… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-07** A controlled-substance Delivered/Collected update is refused without ID check and recipient recorded… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-08** Unacknowledged prescriptions alert the care team and patient after the agreed window (initially 2 h,… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-09** Patient pays an invoice by card using the provider's hosted fields or tokens; no card number is stor… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-10** Partner pharmacy onboarding creates organisation, locations and MFA-protected staff accounts. Approv… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R2-11** Patient views health record (summaries, problems, allergies, medications, immunisations).… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R3-01** A partner pharmacy posts delivery status and a tracking link by portal and by API/webhook. The patie… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R3-02** A doctor orders a lab test; the order reaches the lab by HL7 v2 or FHIR or, if no interface, a requi… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R3-03** An unmatched electronic result goes to the reconciliation queue and is never attached to a chart.… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R3-04** Normal results are released to the patient immediately; abnormal results are released only after the… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R3-05** A critical result alerts the ordering doctor at once and escalates to the on-call doctor if not ackn… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R3-06** Lab desk prints sample labels/barcodes and records collection and courier hand-off.… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |
| **RA-R3-07** Pharmacy performance report shows acknowledgement time, fulfilment time and failed deliveries.… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |

## 6. Gaps: defects, test gaps and go-live items

Every case that has no passing result, with its class. A "defect" is a failure or a stale/misleading test or a missing feature; a "gap" is a case that could have run and has no recorded result; a "go-live item" needs a person, an environment or a vendor that does not exist yet. Nothing here is waived (PRD RA-R1-18, 8.3).

| Class | Count |
| --- | --- |
| DEFECT (fix merged, case not rerun) | 2 |
| DEFECT (stale test) | 1 |
| GAP (blocked by test hooks/harness) | 9 |
| GAP (no recorded result) | 8 |
| GO-LIVE (CI gates) | 5 |
| GO-LIVE (environment) | 14 |
| GO-LIVE (human) | 38 |
| GO-LIVE (sandbox/vendor) | 16 |

### DEFECT (fix merged, case not rerun)

| Case | Rows | Reason |
| --- | --- | --- |
| TC-PC-07 | RA-R1-06, RA-R1-24 | failed on cdc388d (qa-banner REPORT F-1..F-5, finding R3-F01). The fix HEAAA-819 (ef760d1) is merged; its evidence is staff component and mocked-API Playwright tests (docs/evidence/qa-banner/r3-fix-HEAAA-819). The real-stack case has not been rerun, so the fai |
| TC-PC-13 | RA-R1-06, RA-R1-24 | failed on cdc388d (qa-banner REPORT F-1..F-5, finding R3-F01). The fix HEAAA-819 (ef760d1) is merged; its evidence is staff component and mocked-API Playwright tests (docs/evidence/qa-banner/r3-fix-HEAAA-819). The real-stack case has not been rerun, so the fai |

### DEFECT (stale test)

| Case | Rows | Reason |
| --- | --- | --- |
| TC-AD-04 | RA-R1-15 | skip text says "NOT DELIVERED", but the template admin routes were merged (HEAAA-665, apps/api/src/modules/notifications/admin-controller.ts); the platform case was never rewritten or rerun |

### GAP (blocked by test hooks/harness)

| Case | Rows | Reason |
| --- | --- | --- |
| TC-BS-08 | RA-R1-26 | BLOCKED: needs a browser session; the consent unit tests (apps/site/src/consent.test.ts) cover the logic only and are not a substitute  |
| TC-MG-05 | RA-R1-27 | BLOCKED: needs a signed clinical note authored under the merged patient; the note authoring/sign flow is not driven by the platform harness (QA-04 owns clinical journeys)  |
| TC-MG-08 | RA-R1-27 | BLOCKED: needs controllable test hooks to order the hold and merge transactions; the product exposes none in ENV-INT/ci  |
| TC-MG-09 | RA-R1-27 | BLOCKED: needs controllable test hooks to order transactions; none exposed  |
| TC-MG-10 | RA-R1-27 | BLOCKED: needs the job-type on_merged registry check from CI; no runner for it in tests/api/platform  |
| TC-MG-11 | RA-R1-27 | BLOCKED: depends on the signed-note flow (see TC-MG-05)  |
| TC-MG-13 | RA-R1-27 | BLOCKED: needs location care-relationship end and new-location booking flows not driven by this harness  |
| TC-MG-14 | RA-R1-27 | BLOCKED: needs the 10x ARCH 35.3 chart dataset generator; not in scope of this ticket's harness  |
| TC-PP-07 | RA-R1-21 | BLOCKED: same flow as TC-PP-06 (QA-04)  |

### GAP (no recorded result)

| Case | Rows | Reason |
| --- | --- | --- |
| TC-BK-12 | RA-R1-02 | no result in any evidence file; automated or browser case that was not recorded as run |
| TC-CAL-06 | RA-R1-04 | no result in any evidence file; automated or browser case that was not recorded as run |
| TC-CL-04 | RA-R1-09 | no result in any evidence file; automated or browser case that was not recorded as run |
| TC-CL-06 | RA-R1-09 | no result in any evidence file; automated or browser case that was not recorded as run |
| TC-PC-03 | RA-R1-06 | no result in any evidence file; automated or browser case that was not recorded as run |
| TC-PC-04 | RA-R1-06 | no result in any evidence file; automated or browser case that was not recorded as run |
| TC-PC-09 | RA-R1-06 | no result in any evidence file; automated or browser case that was not recorded as run |
| TC-PC-16 | RA-R1-07 | no result in any evidence file; automated or browser case that was not recorded as run |

### GO-LIVE (CI gates)

| Case | Rows | Reason |
| --- | --- | --- |
| TC-NFR-03 | RA-R1-18, NFR-15 | owner ruling B: no hosted CI; the scripts exist (scripts/ci) and ran locally on d357128 (docs/evidence/qa-ruling-c/ci-summary-raw.txt: deps pass; sast and secrets exit 1; not rerun on this head) |
| TC-NFR-04 | RA-R1-18, NFR-15 | owner ruling B: no hosted CI; the scripts exist (scripts/ci) and ran locally on d357128 (docs/evidence/qa-ruling-c/ci-summary-raw.txt: deps pass; sast and secrets exit 1; not rerun on this head) |
| TC-NFR-05 | RA-R1-18, NFR-15 | owner ruling B: no hosted CI; the scripts exist (scripts/ci) and ran locally on d357128 (docs/evidence/qa-ruling-c/ci-summary-raw.txt: deps pass; sast and secrets exit 1; not rerun on this head) |
| TC-NFR-06 | RA-R1-18, NFR-15 | owner ruling B: no hosted CI; the scripts exist (scripts/ci) and ran locally on d357128 (docs/evidence/qa-ruling-c/ci-summary-raw.txt: deps pass; sast and secrets exit 1; not rerun on this head) |
| TC-NFR-07 | RA-R1-18, NFR-15 | owner ruling B: no hosted CI; the scripts exist (scripts/ci) and ran locally on d357128 (docs/evidence/qa-ruling-c/ci-summary-raw.txt: deps pass; sast and secrets exit 1; not rerun on this head) |

### GO-LIVE (environment)

| Case | Rows | Reason |
| --- | --- | --- |
| TC-NFR-01 | RA-R1-18, NFR-12 | needs a deployed host, cloud console or owner document (TEST-CASES 0.3 "no test environment") |
| TC-NFR-09 | RA-R1-18, NFR-18 | needs a deployed host, cloud console or owner document (TEST-CASES 0.3 "no test environment") |
| TC-NFR-10 | RA-R1-18, NFR-18 | needs a deployed host, cloud console or owner document (TEST-CASES 0.3 "no test environment") |
| TC-NFR-12 | RA-R1-18, NFR-17 | needs a deployed host, cloud console or owner document (TEST-CASES 0.3 "no test environment") |
| TC-PERF-01 | RA-R1-18, NFR-6, NFR-9 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-PERF-02 | RA-R1-18, NFR-8 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-PERF-03 | RA-R1-18, NFR-6 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-PERF-04 | RA-R1-18, NFR-13 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-PERF-05 | RA-R1-18, NFR-7 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-PERF-06 | RA-R1-10, RA-R1-18, NFR-9 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-PERF-07 | RA-R1-03, RA-R1-18 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-PERF-08 | RA-R1-18, NFR-9 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-REC-06 | RA-R1-18, NFR-21 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |
| TC-REC-09 | RA-R1-18 | needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md) |

### GO-LIVE (human)

| Case | Rows | Reason |
| --- | --- | --- |
| TC-A11Y-02 | RA-R1-18, NFR-10 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-A11Y-03 | RA-R1-18, NFR-10 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-A11Y-04 | RA-R1-18, NFR-10 | assistive-technology or real-device run (TEST-CASES 12) |
| TC-A11Y-07 | RA-R1-18, NFR-10 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-A11Y-08 | RA-R1-18, NFR-10 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-AU-09 | RA-R1-12, NFR-13 | BLOCKED: audit/clinical retention period not decided at G2 (open decision); type OPS: DevOps evidence  |
| TC-BS-03 | RA-R1-16 | BLOCKED: needs the CMS with a marketing login (C-19 decides the content source; apps/cms is not a deployed service in ENV-INT/ci) and a human for the editing journey  |
| TC-CL-09 | RA-R1-24 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-ID-03 | RA-R1-01 | Pending-human (AUTO+H): the second factor is a passkey ceremony on a real device in the managed pool. The script half (the API accepts only a session minted from a completed pool sign-in) is TC-ID-10/  |
| TC-ID-03b | RA-R1-01 | PENDING-HUMAN: stays pending until a real person runs it after the staging apply (TEST-CASES TC-ID-03b); a written case is not evidence.  |
| TC-ID-05 | RA-R1-01 | BLOCKED (AUTO+H): refusal comes from the Workspace 2SV enforcement policy only; `hd` / `email_verified` cannot detect it, so a local claim check would be false evidence. Needs the Workspace test tenan  |
| TC-ID-07 | RA-R1-01 | OPS + HUMAN: evidence is the owner/DevOps policy export dated within 30 days; QA reads it. Not a script. Pending-human.  |
| TC-NFR-02 | RA-R1-18, NFR-12 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-NFR-08 | RA-R1-18, NFR-14 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-NFR-11 | RA-R1-18, NFR-19 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-NFR-13 | RA-R1-18 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-NT-03 | RA-R1-05 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-PC-02 | RA-R1-06 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-PC-15 | RA-R1-06, RA-R1-24 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-PEN-01 | RA-R1-18, NFR-16 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-REC-01 | RA-R1-18, NFR-2, NFR-4 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-REC-02 | RA-R1-18, NFR-3, NFR-4 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-REC-03 | RA-R1-18, NFR-2, NFR-3 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-REC-04 | RA-R1-18, NFR-5 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-REC-05 | RA-R1-18 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-REC-07 | RA-R1-18, NFR-1 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-REC-08 | RA-R1-18, NFR-1, NFR-20 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-SAF-02 | RA-R1-07 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-SAF-07 | RA-R1-08 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-SEC-11 | RA-R1-32 | PENDING-HUMAN (HUMAN): ENV-INT/bootstrap needs two real custodians (TEST-CASES 5.2). QA reviews the evidence; no result is recorded here.  |
| TC-SEC-16 | RA-R1-32 | PENDING-HUMAN (HUMAN + OPS): a measured elapsed time from a real runbook run; QA never records it.  |
| TC-SEC-17 | RA-R1-32 | OPS + HUMAN (path A): the owner/DevOps policy export; not a script. Pending-human.  |
| TC-SEC-19 | RA-R1-32 | OPS + HUMAN (path A): inventory and quarterly access review evidence; not a script. Pending-human.  |
| TC-SEC-24 | RA-R1-32 | PENDING-HUMAN (Cybersecurity review of the spike report P-1..P-7). The rerun of TC-SEC-03, 21, 23 is part of this suite; the human half is not recorded here.  |
| TC-SEC-25 | RA-R1-32 | OPS (ENV-DR): result of the DR drill, TC-REC-03 owns it. Not a script.  |
| TC-TH-01 | RA-R1-10 | BLOCKED: no video vendor selected (C-11) and no vendor sandbox (C-10); nothing here proves a real vendor  |
| TC-XB-02 | RA-R1-18, NFR-11 | needs the named person; QA never records a result for it (TEST-CASES 12) |
| TC-XB-03 | RA-R1-18, NFR-11 | assistive-technology or real-device run (TEST-CASES 12) |

### GO-LIVE (sandbox/vendor)

| Case | Rows | Reason |
| --- | --- | --- |
| TC-AD-11 | RA-R1-31 | BLOCKED: no Google, e-mail, SMS, push or analytics sandbox in ENV-INT/ci (C-10); health depends on a real vendor probe  |
| TC-AD-12 | RA-R1-31 | BLOCKED: no secret store (OutboundSecretStore) in ENV-INT/ci (INT-N8); the write cannot complete without it. Needs ENV-INT/staging  |
| TC-AD-15 | RA-R1-31 | BLOCKED: needs a working e-mail integration and booking confirmation against a sandbox (C-10)  |
| TC-AU-08 | RA-R1-12, NFR-13 | BLOCKED: audit.verify_anchors treats the Object Lock archive as the authority (INT04-F10 D-2); the archive store is infrastructure that does not exist in ENV-INT/ci  |
| TC-BS-04 | RA-R1-16 | BLOCKED: needs Chrome network capture and an analytics sandbox; none is provisioned in ENV-INT/ci (ANALYTICS_SRC unset, so the site loads no analytics at all)  |
| TC-DOC-01 | RA-R1-13 | BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket and scanner  |
| TC-DOC-02 | RA-R1-13 | BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket and scanner  |
| TC-DOC-05 | RA-R1-13 | BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket and scanner  |
| TC-DOC-08 | RA-R1-13 | BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket and scanner  |
| TC-ID-01 | RA-R1-01 | BLOCKED: sign-up and the OTP are the managed patient pool (hosted page); no pool and no e-mail/SMS sandbox in ENV-INT/ci (TEST-CASES 0.3, DEVOPS-PLAN 3.5). Needs ENV-INT/staging after the staging appl  |
| TC-ID-02 | RA-R1-01 | BLOCKED: the OTP is checked by the managed pool, not by this API. The API-side limit on failed callbacks is asserted in TC-ID-11 step 1. OTP wording and rate limit need ENV-INT/staging.  |
| TC-PP-06 | RA-R1-21 | BLOCKED: the pre-visit request/questionnaire/e-sign journey is the QA-04 clinical suite and insurance-card upload needs the object store (C-01)  |
| TC-SEC-06 | RA-R1-32 | NOT APPLICABLE on the built path: D-35 path B (separate admin_pool realm) is built; there is no Google admin identity. The path B equivalent (WebAuthn assertion is the only way to a grant) is TC-SEC-0  |
| TC-SEC-15 | RA-R1-32 | BLOCKED (ENV-INT/staging): needs the egress block to the managed pool on the staging account. In ci the admin realm has no external IdP at all (sessions live only in our database), so a ci run would p  |
| TC-SEC-18 | RA-R1-32 | NOT APPLICABLE on the built path B and BLOCKED for path A: needs the Workspace test tenant; the hourly reconciliation job is not built (identity README: person_link/directory_check not part of BE-05).  |
| TC-TH-04 | RA-R1-10 | BLOCKED: no video vendor selected (C-11) and no vendor sandbox (C-10); nothing here proves a real vendor  |

### Register of gaps raised by this trace

| ID | Class | Statement | Proposed owner and next action |
| --- | --- | --- | --- |
| G-01 | Defect (evidence) | No passing run of the DB-backed suites or of `tests/api/**` and browser suites exists on `60d962e`. The newest recorded runs are `d357128` (platform, 26 commits older), `ff5476e` (qa-r3) and the HEAAA-789 integration-db run on rebase `c87dc62`. Commits since touch code mapped by several rows (see "commits" in section 4). | Orchestrator: assign a run on a host with disk (the throwaway PostgreSQL 17 plus build), then rerun the trace generator. Host disk is 100% full (65 MB free): needs cleanup by the host owner |
| G-02 | Defect (stale test) | TC-AD-04 is still a skip saying "NOT DELIVERED" although the template admin routes were merged (HEAAA-665) and have a real-DB test | QA: rewrite TC-AD-04 against `/api/v1/admin/message-templates` and run it |
| G-03 | Scope question | TC-AU-01b: no chart export/print route in R1, so the PRD wording on audited export/print has nothing to test | PM via Orchestrator: confirm no chart export/print in R1, or raise a feature defect |
| G-04 | Gap | Cases with no recorded result at all (class "GAP (no recorded result)") | QA: record results or reasons; most are browser cases for the check-in desk, triage and banner screens |
| G-05 | Go-live | Human, operations, sandbox and environment cases are pending (classes "GO-LIVE") and are listed in `docs/GO-LIVE.md` where an owner action exists | Owner and DevOps, per TEST-CASES 12 |
| G-06 | Go-live | R2 and R3 are not built | Product, later releases |
| G-07 | Gap | CI gates (SAST, dependency, secret, container) are not run on the head: no hosted CI (owner ruling B). On `d357128`: lint pass, dependency audit pass, SAST exit 1 (workflow YAML parse), secret scan exit 1 (24 historic findings, allow-list HEAAA-930 since merged) | DevOps and Security Reviewer: rerun on the head once tools are installed |

## 7. Limitations

- The case-to-requirement map is the one in `docs/TEST-CASES.md` 15.1 and the NFR mapping in `build-matrix.mjs`; it is not independently reviewed.
- "Merged code" is a path list chosen by QA and checked to exist, not a call graph. A row can be affected by code outside its list.
- Result extraction reads case IDs from test titles; a title that does not carry its ID is counted as "no result". Sub-case IDs (for example 03a) are folded into their base case, and a base case counts as passed if any recorded sub-case passed and none failed.
- Evidence age is measured by commits to the mapped paths, not by behaviour. Zero later commits means the code under test is byte-identical; it does not cover shared libraries outside the list.
- Statuses of human-required cases stay pending until the named person records them.
