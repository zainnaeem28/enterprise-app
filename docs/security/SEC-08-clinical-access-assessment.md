# SEC-08 Security assessment: clinical access, banner allergies, break-the-glass and the red-flag alert path

Ticket HEAAA-126 (SEC-08) · release R1 · milestone M4 · author: Cybersecurity (`83cd0a46`) · reviewer stage: Security Reviewer (`074b2525`)
Requirements: RA-R1-11, RA-R1-17 · PRD BR-13, BR-14, BR-34, 8.3 · ARCHITECTURE 27.4, 28.2, 25.5, 32 · SHARED-BOUNDARIES 6.3, 6.6 · TEST-CASES 6, 8.2

## 1. Scope, revision and method

**Assessed revision.** Branch `HEAAA-102-sdlc-ticket-be-18-...` at commit `c973a3b3dba8733941ae8d2c754b97bdc66ed243` (BE-18). It is the tip of the stack and contains the other prerequisites as ancestors, checked with `git merge-base --is-ancestor`:
- BE-16 chart, banner, allergy summary: `e6595073da56e76e5b5b75ad076ac909f11f313e` (HEAAA-96)
- BE-07 staff alerts: `6c8929a1df06150470cc37121a81393541e3ccf6` (HEAAA-98)
- BE-08 patient core (`staff_scope`): `47eb3ddf6d671490e6af417ef048fa203511cbc0` (HEAAA-86)
- BE-18 front door, triage, red-flag rule: `c973a3b3` (HEAAA-102)

None of these commits is on `main`. The M3 combined candidate (INT-02, HEAAA-124) failed and is blocked, so **no integrated tree exists**. Findings that depend on composition (route registration order, the `staff_scope_allows_patient` stub, worker handlers) are stated as such and need a re-read on the first integrated revision that contains the clinical modules (INT-03).

**Method.** Static, read-only review of the commits with `git show` / `git grep`. Nothing was executed:
- **No tests were re-run.** I rely on the reviewers' reports: BE-16 41/41 (`chart.dbtest`), BE-07 32/32 (`alerts.dbtest`), BE-18 35 pass + 1 `todo`. I did not reproduce them.
- **No active probing**, no scanner, no database, no network call. No SAST, secret or dependency tool was configured for this ticket.
- **No code changed.** The only file written is this document.

**Surfaces reviewed (acceptance list).**

| Surface | Read |
| --- | --- |
| Assignment rules (BQ-5, 27.4) | `identity/assignment.ts`, `guard-policy.ts`, `chart/assignment.ts`, `chart/access.ts` |
| Chart reads and writes | `chart/controller.ts`, `lists.ts`, `summary.ts`, migration 1602 (RLS and grants) |
| Banner, `allergies: null`, audit of allergy summary reads | `chart/banner.ts`, `chart/audit-port.ts`, ARCHITECTURE 28.2, patient `controller.ts` / `service.ts` (BE-08), role seed `reference-data.ts` |
| Break-the-glass | `audit/service.ts` (`openBtg`, `reviewBtg`, `activeBtgGrants`), migrations 0202 and 0203, `identity/scope.ts`, `chart/access.ts` (refusal) |
| Red-flag path and alert target resolution | `frontdoor/triage.ts`, `adapters.ts`, `ports.ts`, `jobs.ts`, `questionnaire.ts`, `notifications/alerts/service.ts`, `controller.ts`, migration 1201, role seed |

## 2. What holds (verified by reading the code)

1. **Chart access is assignment-bound and fails closed.** `clinical.chart.read` is in `ASSIGNMENT_BOUND_PERMISSIONS`. The guard and `ChartAccess` both apply it. An unassigned holder gets `403 clinical.not_assigned` with `btgAvailable`, audited as `denied` in its own transaction. The business transaction rolls back. A missing assignment source answers "no". A pre-visit permission held in addition does not turn the refusal into a partial answer.
2. **`allergies: null` is real.** `bannerFor` fills the allergy part only when `chartRead` (assigned or BTG) or `previsitRead` (permission at a location where the patient is in scope) holds. Otherwise `null`, never an empty list. `none_recorded` is distinct. When the part is filled, one `view` audit row of resource `clinical.allergy_summary` is written in the same transaction (an audit failure rolls the read back). When null, none is written. The row carries no allergy text.
3. **Every chart read is audited** (RA-R1-11 first sentence): list reads, chart summary and banner each write a `view` row with patient ID, IP and user agent, in the caller's transaction.
4. **RLS is the second line.** FORCE RLS on all six chart tables. Role-named policies. Outer columns qualified (the SEC-03 F01 tautology defect is not present in migration 1602). Insert policies pin `recorded_by` and `created_by` to the principal. Column-level grants only. No DELETE or TRUNCATE. No patient-audience policy.
5. **BTG grant integrity.** The grant is created for the caller only (policy pins holder principal, person and realm). Reason is 10 to 500 characters. Duration is 60 s to 24 h (default 4 h). Grants are never deleted or re-keyed (trigger). Review is once, by a different person (service check and database trigger). Expiry and revocation are honoured per request, because the scope build reads active grants each time.
6. **Red-flag raise is atomic and fail-safe.** The alert, triage row and queue category commit together. A rule question left blank is refused, not read as "no". If no one can receive the alert, the triage is not saved (409). The raiser is excluded from targets unless no one else can receive it. Alert payloads (NOTIFY and SSE) carry IDs only.
7. **Alert reads and acknowledge are target-bound.** Reads need membership in `target_principal_ids` plus patient scope. Acknowledge locks the row and returns 404 to a non-target, because the update policy requires target membership. Only a worker may add targets, and only add. The stream re-reads under the principal's own scope.

## 3. Findings

Severity scale: Critical / High block advancing the requirement they concern; Medium needs a correction or an explicit recorded risk acceptance; Low / Info are hardening. Every ID is stable across rounds. Owner is the role or ticket that should fix it. Parent is the lane the correction ticket sits under (HEAAA-25 unless stated). `Routing` is a request to the Orchestrator: this ticket cannot create or assign work outside its allowed paths. Findings carried from earlier reviewers keep their original ID in the title.

### SEC08-F01 · High · The doctor roles cannot see, stream or acknowledge the red-flag alert addressed to them
- **Where:** `apps/worker/src/jobs/identity/reference-data.ts` (`DOCTOR` list, `trainee_doctor` = `DOCTOR` minus two); `notifications/alerts/controller.ts` (`GET /alerts`, `/alerts/open-ids`: `notifications.alert.read`; `POST /alerts/{id}/acknowledge`: `notifications.alert.acknowledge`); stream route `notifications.alert.read` (ARCHITECTURE 32.2 step 1). Same gap noted as BR07-F3 (ALR-N5).
- **Issue:** `triage.ts` targets the on-duty doctor (`scheduling.onDuty(..., 'on_duty_doctor')`) and, on escalation, the on-call doctor. The `doctor` and `trainee_doctor` roles hold `clinical.*` (which expands to `clinical.alert.red_flag.receive`) but neither `notifications.alert.read` nor `notifications.alert.acknowledge`. ARCHITECTURE 27.3 lists the same permissions for `doctor`, so the seed matches the design and the design is the defect. Only `front_desk`, `triage_nurse` and `compliance_on_call` hold the alert permissions.
- **Failure scenario:** A nurse saves a triage with "chest pain". The alert row is created with the on-duty doctor as target. The doctor's alert tray and SSE stream return `403 auth.forbidden`. The doctor never sees it and cannot acknowledge it. The only people who can see it are nurses and front desk who are not targets (and see only their own targeted alerts), so the flag reaches nobody. It is not lost in the database, but no human is told "at once" (BR-10, AC-08, TC-SAF-01).
- **Remediation:** Add `notifications.alert.read` and `.acknowledge` to `doctor` and `trainee_doctor` in 27.3 (Architect decision recorded in the architecture) and in the role seed. Add an end-to-end test: triage red flag, then the on-duty doctor principal reads the stream and acknowledges (TC-SAF-01 with the real role seed, not a test-injected grant). Add a reference-data test that every role holding `clinical.alert.red_flag.receive` also holds the two alert permissions.
- **Owner / parent:** Architect (27.3 matrix), then Backend Engineer who owns identity reference data (BE-04 lane). Parent HEAAA-25. Blocks acceptance of RA-R1-07 (safety-critical, BR-10).

### SEC08-F02 · High · Break-the-glass cannot be opened and the compliance alert does not exist in any candidate; no ticket owns the open route
- **Where:** `audit/README.md` ("Not built: HTTP routes of 31"); `audit/service.ts` `openBtg`; `chart/testkit.ts` (a `sink.on_btg_opened` test stand-in); `notifications/alerts/service.ts` `resolveTargets` (the `compliance_permission` kind needs an injected `TargetResolver`); `docs/TICKETS.md` (BE-24 covers BTG *review*; FE-10 covers the BTG *dialog*).
- **Issue:** ARCHITECTURE 27.4 specifies `POST /patients/{id}/break-glass` to create the grant, the compliance alert and the audit row. Across BE-16, BE-07, BE-08, BE-18 there is no such route, no real handler for `audit.btg_opened` (only a test sink), and no implementation of `TargetResolver.permissionHolders`/`roleHolders` (`grep` finds only the interface). TICKETS.md assigns no backend ticket to the open route or to the `audit.btg_opened` handler.
- **Failure scenario:** Today this fails closed: no one can open a grant, so an unassigned doctor stays refused. The risk is the first fix. A route added without the handler yields silent out-of-assignment access: a grant that no compliance principal is told about (AC-12 "compliance is alerted", TC-AZ-10 fails, RA-R1-11 second sentence unmet). The review queue is also empty, because nothing raises the alert that compliance acts on.
- **Remediation:** Orchestrator assigns one owner for: the open route (`audit.btg.open`, rate-limited, reason required), the `audit.btg_opened` handler that raises a `btg_opened` alert to `compliance_on_call`/`compliance_officer` via a real `TargetResolver`, and the closing of the alert when the grant ends. Acceptance: TC-AZ-10 and TC-AZ-11 end to end with the real role seed, and a negative test that a grant with no alert target is refused (the open fails if no compliance principal can receive it, as the red flag does).
- **Owner / parent:** Orchestrator assigns (candidates: Backend Engineer on BE-01/BE-24 lane, or BE-17 for the patient route). Parent HEAAA-25. Blocks acceptance of RA-R1-11.

### SEC08-F03 · High · Escalation of an unacknowledged red flag is not wired, and an empty or inactive on-call target still reads as success
- **Where:** `frontdoor/README.md` limitations 3 and 4; `frontdoor/jobs.ts`; `triage.ts` `retargetUnacknowledged`; `adapters.ts` `onDuty` (`checkActive` is false for system scope); `grep` for `retargetUnacknowledged` and `clinical.roster_gap` outside the module finds no handler.
- **Issue:** (a) The worker handler `clinical.on_alert_unacknowledged` that calls `retargetUnacknowledged` is not built (outside BE-18's allowed paths). Without it the escalation job marks the alert `escalated` (level 1) but no new person is added. (b) `clinical.roster_gap` is published when no doctor is rostered, but no handler raises the operations alert that 25.5 requires. (c) In a patients-scope job the principal status is not checked, so a kill-switched or suspended on-call doctor is added as a target; the job returns a non-empty list and the alert looks escalated. (d) Escalation happens once (32.4); when it adds nobody there is no further step and no operations signal.
- **Failure scenario:** The on-duty doctor is in surgery and does not acknowledge. The timer fires, the alert shows `escalated`, and nobody new is notified (handler absent), or the only on-call doctor is inactive and receives it into a tray no one opens. The flag is silent while the dashboard says it escalated. When no doctor is rostered at all, the fallback to every `red_flag.receive` holder works, but the roster gap that should alert operations is dropped.
- **Remediation:** Build the worker handler and the `roster_gap` operations alert (owner below). In `retargetUnacknowledged`, resolve activity through a worker-readable path, add only active principals, and when the result is empty raise an operations alert and leave the alert at `escalated` visibly "no recipient". Add a test: ack timer fires, on-call doctor is notified, inactive on-call is skipped, empty on-call raises the operations alert. Note the escalation timer for `red_flag` has no default (D-12a); RA-R1-07 stays blocked until the safety reviewer sets it, so this must be proven with a configured value.
- **Owner / parent:** Backend Engineer for the worker handler (`apps/worker/src/jobs/clinical`) and BE-18 author for `retargetUnacknowledged`; Orchestrator must widen the allowed paths. Parent HEAAA-25. Blocks acceptance of RA-R1-07.

### SEC08-F04 · Medium · Alert creation and target changes are not audited, so target resolution cannot be reconstructed
- **Where:** `notifications/alerts/service.ts` `audit()` (returns without writing when `d.audit` is absent or when neither `requestId` nor `jobId` is passed); `frontdoor/adapters.ts` (`raise: (tx, input) => d.alerts.raise(tx, input)` and `addTargets`, no context passed); `triage.ts` audit row (`change: { category, redFlag, alertId, retriage }`).
- **Issue:** The triage reaches `AlertService.raise` and `addEscalationTargets` through a port that does not pass `AlertContext`. The service then writes no `create` audit row, and no `targetsAdded` row on escalation. The audit dependency is also optional. The audit row of the triage records the alert ID but not who was chosen. The stored `target_principal_ids` array is overwritten when targets are added, and `staff_alert_event` rows carry no target. After the fact, compliance cannot tell who was told, who was added at escalation, or whether the fallback to "every holder of the permission" fired. The acceptance asks for audit of alert target resolution.
- **Failure scenario:** After a missed red flag, the question "who was notified, and when was the on-call doctor added?" has no durable answer. A target list containing a doctor from another team (an `onDuty` roster error) is invisible to review.
- **Remediation:** Pass the request or job context through the port. Make the audit dependency mandatory. Record in the audit `change`: resolution basis (`on_duty`, `permission_fallback`, `on_call`), the resolved principal IDs (IDs are not PHI) and, on escalation, the principals added. Add `escalated` events that include the added count. Add a test that the audit row exists and names the targets.
- **Owner / parent:** Backend Engineer (BE-07 and BE-18 authors). Parent HEAAA-25.

### SEC08-F05 · Medium · BE18-F02 (carried): a questionnaire submitted with an unloadable template is stored as "no red flag", and a self-reported red flag raises no alert until triage
- **Where:** `frontdoor/questionnaire.ts` submit (`const schema = tpl?.schema ?? {}` then `evaluateRedFlags(schema, answers)`); header comment (the alert is raised only when triage is saved, 25.5).
- **Issue:** (a) When the template version cannot be loaded, the schema is `{}`, there are no rules and no unanswered questions, so the response is submitted with `red_flag = false` and no emergency advice. Triage fails toward safety in the same situation; submit fails open. (b) By design a patient's red-flag answer produces the emergency advice on screen but no staff alert until a nurse saves triage at check-in. There is no sweep for submitted responses with `red_flag = true` that are not triaged.
- **Failure scenario:** (a) A template is retired or the catalogue read fails. A patient answering "chest pain: yes" is submitted as clear and sees no advice. (b) A patient submits at home the evening before, with chest pain. No clinician is told until arrival.
- **Remediation:** (a) Refuse the submit when the template cannot be loaded (503/409), as triage does. Add a test. (b) Architect and the D-12a safety reviewer decide whether a submitted red flag outside a visit must raise a staff alert or a next-day task; record the decision either way.
- **Owner / parent:** (a) BE-18 author. (b) Architect with the safety reviewer. Parent HEAAA-25.

### SEC08-F06 · Medium · Break-the-glass attribution on audit rows exists only in the chart module
- **Where:** `chart/audit-port.ts` `BtgAwareAudit` (used only by the chart runtime); `audit/service.ts` `record` and `envelope.ts` (`btgGrantId` is taken from the caller's envelope and never inferred).
- **Issue:** The base `AuditService.record` does not attach `btg_grant_id` when the scope holds a BTG grant for the patient. Only rows written by chart services carry it. A BTG holder is in scope for the patient across all modules (the grant adds the patient to `btgPatientIds`, which `staff_scope`-style predicates accept everywhere). Rows written by patient, documents, scheduling and front-door services under the grant have `btg_grant_id = NULL`.
- **Failure scenario:** The compliance reviewer of a BTG event (TC-AZ-10/11) filters by grant and sees the chart views but not the document downloads, demographic views or triage reads made under the same grant, so "exactly what the holder read" is incomplete.
- **Remediation:** Move the grant lookup into `AuditService.record`: when `tx.scope.btgPatientIds` contains the envelope's `patientId` and no grant is named, attach the active grant. Keep the chart port as a thin pass-through. Add a cross-module test.
- **Owner / parent:** Backend Engineer, audit module (BE-01 lane). Parent HEAAA-25.

### SEC08-F07 · Medium · The database trusts the route guard for who may open a BTG grant, and a grant widens access patient-wide
- **Where:** migration 0203 `btg_grant_open` policy; `audit/service.ts` `openBtg`; migration 1602 `*_btg_select` policies for realm `admin_pool`; `identity/scope.ts`.
- **Issue:** The insert policy checks only that the holder is the caller and the realm matches. It does not check that the caller holds `audit.btg.open`, that the patient exists in the organisation, that the realm is `google`, or how many grants are open. Duration may be 24 h and there is no rate or concurrency limit. Authorisation to open a grant is therefore a single route-guard check; any handler bug that reaches `openBtg` self-grants access. A grant puts the patient in `btgPatientIds` for every module's staff policy, not only the chart. Migration 1602 also grants `admin_pool` principals chart read for patients in their `btgPatientIds`, although no admin role holds `audit.btg.open`.
- **Failure scenario:** A future route calls `openBtg` with a request-supplied patient. A front-desk user obtains a 24-hour grant to any patient UUID with a 10-character reason, and reads documents, demographics and chart. Alternatively a doctor opens grants for many patients in a loop; nothing limits or flags the volume beyond the (currently absent) compliance alert.
- **Remediation:** Defence in depth: restrict the insert to realm `google`, require the patient to exist (and to be visible to the organisation), and cap active grants per holder and per day with a compliance alert on the cap. Cap the maximum duration per setting (default 4 h, hard maximum below 24 h unless justified). Decide and record whether `admin_pool` BTG read policies on clinical tables are intended; remove them if not. Add a negative test that a principal without `audit.btg.open` cannot insert a grant directly.
- **Owner / parent:** Backend Engineer, audit module; Architect confirms the admin-realm question. Parent HEAAA-25.

### SEC08-F08 · Medium · Banner: two registrations of one route with different shapes, and the doctor role lacks `patient.read`
- **Where:** `chart/controller.ts` (`GET /patients/:patientId/banner`, header comment: "the composition root registers this controller first"); BE-08 `patient/controller.ts` lines near 546 to 565 and `service.ts` 487 to 498 (`allergySummary: null`); `reference-data.ts` `DOCTOR` (no `patient.read`); ARCHITECTURE 27.3.
- **Issue:** (a) The banner route is declared twice. Registration order decides silently which handler answers. The BE-08 handler returns a banner whose allergy part is the field `allergySummary: null`, not the specified `allergies` object, so a wrong order drops allergies for every user including assigned doctors. (b) `GET /patients/{id}` is a `banner: true` route in 28.2, but it is served by the BE-08 profile handler, which cannot attach the allergy part. (c) The standalone banner route requires `patient.read`, which the `doctor` and `trainee_doctor` roles do not hold, so doctors get 403 when a screen opens the banner by ID (the chart routes embed it without that check).
- **Failure scenario:** A doctor opens a patient from the schedule. The screen calls `GET /patients/{id}/banner`. Either 403, or an allergy-less banner from the wrong handler. The UI shows "Allergies not available" or nothing, for a patient with a severe allergy (BR-34, AL-01, TC-PC-13).
- **Remediation:** Remove the BE-08 banner and profile banner allergy handling, or make it call `clinical.allergySummary` through the response layer, so there is one implementation and one field name. Add `patient.read` to the clinical roles in 27.3, or change the banner route's permission (Architect decision). Add TC-PC-13 on the integrated base for every `banner: true` route as doctor, nurse, front desk and a role with neither permission.
- **Owner / parent:** Backend Engineer (BE-16, BE-08 integration at INT-03); Architect for the permission. Parent HEAAA-25.

### SEC08-F09 · Medium · Red-flag insert and referral accept depend on a fail-closed stub that is not yet replaced (BE18-F01 carried); the replacement body must be reviewed
- **Where:** migration 1201 `notifications.staff_scope_allows_patient` (returns `false`); `staff_alert_staff_insert`, `staff_alert_target_select`, `staff_alert_target_acknowledge`, `staff_alert_creator_select` policies; BE-18 README limitations 1 and 2.
- **Issue:** On the candidate stack a staff red-flag insert is refused by RLS, and patient-bound alerts are invisible to all staff, so the red-flag path does not work end to end here. The tests pass only with the intended function body installed in a throwaway database. This fails closed, which is the right default, but the proof of TC-SAF-01 is open until the body is replaced.
- **Failure scenario:** The body is replaced with a looser check (for example organisation-wide, or `staff_scope` without the location filter) so that the alerts pass, and every nurse or desk user then reads every patient's red flag. Or the replacement is correct but the first integrated tree is not re-tested.
- **Remediation:** The replacement must be exactly the `patient.staff_scope` location predicate used by the T-STAFF templates (`EXISTS staff_scope WHERE patient_id = $1 AND location_id = ANY(app.location_ids)`) with the corrected, qualified form from SEC-03 F01. Re-run TC-SAF-01 and TC-SAF-02 on the integrated revision with the real role seed (after SEC08-F01). Confirm the receiving on-call doctor at a different location is added by ID and can still read the alert under the replacement predicate.
- **Owner / parent:** BE-08 / INT-03 integrator. Parent HEAAA-25.

### SEC08-F10 · Low · Assignment rules are weaker than they read, and a view does not record which rule granted it
- **Where:** `chart/assignment.ts` (`reservationSource`, `careTeamSource`); `identity/assignment.ts`.
- **Issue:** (a) `reservationSource` grants access for any reservation not in `held`, `cancelled_*`, `expired`, up to 24 months in the past **and any date in the future**, whether or not it was attended (`no_show` is not excluded). Anyone who can create a reservation naming a clinician (front desk `scheduling.booking.manage`, or the patient on the portal) gives that clinician 24 months of chart access without a clinical relationship and without any alert. This matches the BQ-5 default text, but BQ-5 is a default awaiting confirmation. (b) `careTeamSource` tests only `to_date IS NULL`; whether a future-dated `from_date` can exist and count needs confirming against the care-team insert path. (c) The `view` audit row does not say which rule (`care_team`, `reservation`, `authored`, `assistant_of`, `btg`) granted the read, so a compliance sweep cannot isolate weak-basis views. (d) A trainee's supervisor link and an assistant's support row are not time-bounded beyond the assistant's `to_date`.
- **Failure scenario:** A doctor asks a colleague at the desk to book a "placeholder" appointment for a neighbour or celebrity, reads the chart for 24 months, and the audit shows only an ordinary `view`.
- **Remediation:** Record the granting rule in the `view` audit row `change`. Ask the owner to confirm BQ-5 at G2 and consider counting only `confirmed/checked_in/completed` reservations and future ones within a bounded window. Add a monitored report of chart views whose only basis is `reservation` with no check-in. Confirm `from_date` handling.
- **Owner / parent:** Backend Engineer (BE-16 author); Product Manager for the BQ-5 confirmation. Parent HEAAA-25.

### SEC08-F11 · Low · Carried stream and replay findings (not re-filed): SR07-F1, SR07-F2, BR07-F1, BR07-F2
- **Where:** `notifications/stream/hub.ts` and `alerts.service.ts`, as filed by the BE-07 reviewers.
- **Status at this revision:** Read and agree. SR07-F1: an open stream re-checks only the session row every 60 s, not the permission or location scope; exposure is bounded to alerts already targeted at that principal. SR07-F2: no instance-wide stream cap. BR07-F1: replay is `seq > Last-Event-ID` over open alerts; an alert that escalates or gains targets while disconnected is not replayed, and `seq` is assigned at insert, not commit, so a late commit with a lower `seq` can be skipped if its live NOTIFY was missed. The 60 s `open-ids` poll bounds both. BR07-F2: `db-test.mjs` M-5 is red until the catalog patch is applied.
- **Impact on the red-flag path:** BR07-F1 matters most for a critical alert. The poll bounds the delay to 60 s, which should be accepted in writing by the safety reviewer for `red_flag`.
- **Remediation:** As the original findings. Record the 60 s bound for red flags in the ALR notes.
- **Owner / parent:** As filed by the BE-07 reviewers. Parent HEAAA-25.

### SEC08-F12 · Info · Behaviours confirmed fail-closed, and limits to keep in mind
- A failed denial-audit write is logged and the 403 still stands (`recordDenied` never throws); only the audit row of that denial is lost, with an operations hook if configured. Confirm the hook is wired at composition.
- The `creator` read policy lets the nurse who raised a red flag read the alert row; `view`/`acknowledge` still use target membership, so the nurse sees it in no tray or stream.
- SECURITY DEFINER functions: none in the reviewed alert and chart code; trigger functions pin `search_path`.
- Admin-realm alerts cannot carry a patient (service refusal and CHECK).

## 4. Requirement traceability

| Requirement | Result at this revision |
| --- | --- |
| RA-R1-11 (every chart view logged; out-of-assignment blocked until a reason; compliance alerted; review queue) | Chart views logged: holds. Block on unassigned: holds. Reason entry, grant, compliance alert and queue: **not built** (SEC08-F02), attribution partial (SEC08-F06), grant hardening (SEC08-F07). |
| RA-R1-17 (patient safety banner; wrong-patient prevention; allergy part authorised) | Authorisation of the allergy part and `allergies: null`: holds in `bannerFor`. Single implementation and doctor access to the standalone route: **open** (SEC08-F08). |
| RA-R1-07 touchpoints (red-flag alert reaches a person, escalates) | Raise is atomic and safe. Reaching the doctor: **blocked** (SEC08-F01). Escalation: **not built** (SEC08-F03). End-to-end proof pending the stub replacement (SEC08-F09). Target audit: SEC08-F04. Self-submitted flag: SEC08-F05. |

## 5. Findings summary and routing

| ID | Severity | Blocks | Owner | Short title |
| --- | --- | --- | --- | --- |
| SEC08-F01 | High | RA-R1-07 | Architect, Backend (identity seed) | Doctor roles lack alert read and acknowledge |
| SEC08-F02 | High | RA-R1-11 | Orchestrator to assign; Backend | BTG open route, compliance alert and target resolver unbuilt and unowned |
| SEC08-F03 | High | RA-R1-07 | Backend (worker, BE-18) | Red-flag escalation handler and roster-gap alert not built; inactive on-call counted |
| SEC08-F04 | Medium | none | Backend (BE-07, BE-18) | Alert creation and target changes not audited |
| SEC08-F05 | Medium | none | BE-18 author; Architect | Submit fails open on an unloadable template; no staff alert for a self-reported red flag |
| SEC08-F06 | Medium | none | Backend (audit) | BTG attribution only in chart audit rows |
| SEC08-F07 | Medium | none | Backend (audit); Architect | BTG grant insert trusts the route; patient-wide scope; admin-realm read policies |
| SEC08-F08 | Medium | none | Backend; Architect | Banner route duplicated with different shape; doctor lacks `patient.read` |
| SEC08-F09 | Medium | none | BE-08 / INT-03 | `staff_scope_allows_patient` stub; replacement must be reviewed and retested |
| SEC08-F10 | Low | none | Backend; PM | Assignment rule weaknesses; no granting-rule in audit |
| SEC08-F11 | Low | none | As filed | Stream and replay observations carried |
| SEC08-F12 | Info | none | n/a | Fail-closed behaviours and limits |

**Routing request to the Orchestrator.** This ticket creates no tickets and changes no code. Please create correction items under HEAAA-25 for F01, F02, F03 (High, each blocks the named requirement until its fix is independently reviewed, retested and integrated) and tracking items for F04 to F10, record round 1 in this ticket's `review-ledger`, and widen the allowed paths for F03 (worker handler). F02 needs an explicit owner because no existing ticket carries the open route.

## 6. Limitations and what this is not

- Static review of the BE-18 tip. No test, scanner or probe was run by this author. Reported test counts are the reviewers' own and are not reproduced here.
- No integrated tree exists. Findings F03, F08 and F09 are composition-dependent and need a re-read on the first integrated revision with the clinical modules.
- The BE-17 note and encounter routes, the immunisation lists, the questionnaire-response list routes beyond what is cited, and the patient portal are outside this assessment.
- Clinical content (red-flag rules, escalation minutes, vital ranges) is a human D-12a decision and is not asserted.
- This document is an assessment. It is not a Security Reviewer PASS, not human approval, and not integration or deployment.
