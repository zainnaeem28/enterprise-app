# INT03-F17 decision log: messaging UI scope (HEAAA-384)

Owner: Solution Architect (`7efe9f61`). Independent review: Solution Architect Reviewer (technical), Product Owner Reviewer (scope conformance). Not human-approved.
Revision 2 (HEAAA-389): corrects review round 1 findings F17-R1 (condition 1 now has a named mechanism, owners and controls) and F17-R2 (point 4 completed). Option B and the rejection of C are unchanged; see "Changes in revision 2" at the end.
Basis: HEAAA-344 branch tip `7a2fca0` (evidence `docs/evidence/integration/M4/INT-03-RESULT-r8.md`, candidate `787d608`). Raw command output: `raw/evidence-greps.txt`.

## Question

INT-03 r8 found (INT03-F17, medium): the patient UI has no compose form ("Writing a new message is not available yet"), and the staff routes list `kind='staff'` threads only (BE-19 README O-2), so staff cannot see or answer a patient's message. Is patient-to-care-team messaging in M4/R1 scope, and what is the minimal conforming design?

## What the approved documents say

| Source | Text |
| --- | --- |
| PRD 4.4 row G-14 (line 112) | Patient messaging F-PP-09 is **S**; "patient messaging stays S and may slip without blocking R1". Decision **D-5** |
| PRD D-5 (line 394) | Default if the owner does not decide: "Staff only; patient messaging may slip" |
| PRD RA-R1-25 (line 260) | "Staff create tasks and send secure messages to other staff. Patient messaging (F-PP-09, S) is accepted only if D-5 retains it." |
| ARCHITECTURE 22.12 / 29.2 | Patient threads exist only while flag `patient_messaging` is on, "D-5 default: off"; patient routes 404 otherwise |
| DELIVERY-PLAN C-07, line 236 | "patient messaging behind a flag and off. The default is built and tested"; F-PP-09 "built behind a flag, off unless D-5 retains it" |
| UI-UX 4 (lines 61, 89) | Patient nav "Messages (if D-5 retains it)"; PP-37 "optional until D-5 is decided" |
| TEST-CASES TC-MSG-03 | Tested only if D-5 retains F-PP-09, otherwise `N/A` |

No owner decision on D-5 is recorded: the G1 (HEAAA-11) and G2 (HEAAA-19) tasks carry no D-5 answer, and no task decides it. The PRD default therefore governs: **R1 = staff messaging only; patient messaging flag off.**

## What the build does (tip `7a2fca0`)

- API: staff `GET/POST /threads`, `…/messages` (kind `staff`), tasks, and patient `GET/POST /patients/{id}/threads` behind the flag. Permission `messaging.thread.patient` is in the catalogue but no staff route serves `kind='patient'` threads (O-2). Patient reply `POST /threads/{id}/messages` on the patient host is not served (controller.ts lines 11-13).
- Patient app: `/messages` route exists. **No navigation links to it** (grep of `apps/patient/src/app` for a `/messages` link: no match, exit 1). With the flag off the API answers 404 and the screen reads as not-found, so nothing is offered to the patient.
- Staff app: FE-12 screens (`apps/staff/src/features/messages`) exist for staff threads and tasks but are not routed (INT03-F16).
- The INT-03 r8 journey enabled the flag in its throwaway database (`ui/enable-flag.mjs`). It is not the R1 configuration.

## Options

| # | Option | For | Against |
| --- | --- | --- | --- |
| A | Build full patient messaging in M4: a recipient (care team) list route for patients, a patient reply route, a staff route and inbox for `kind='patient'` threads under `messaging.thread.patient`, patient compose and reply UI, staff patient-thread UI | Meets F-PP-09 fully | F-PP-09 is S and D-5's default excludes it; needs new API contracts (recipient source, patient reply on a second permission, staff patient-thread listing and triage/assignment) plus routing, notification and safety rules (who watches the inbox, response-time notice, urgent-symptom disclaimer) that the PRD and architecture do not define. A contract change of this size reopens design review and G2. Delays INT-03 |
| B | **Keep the D-5 default: patient messaging stays flag off in R1, recorded as a deferral. The R1 messaging acceptance (RA-R1-25) is staff-to-staff in the staff UI** | Exactly what the approved PRD, architecture, delivery plan, UI-UX and test plan specify; no contract change; reversible (flag + recorded design gaps) | Patients cannot message the clinic online in R1 (PRD fallback: patients phone the clinic, ARCHITECTURE line 613) |
| C | Add only a patient compose form now | Small | **Unsafe**: a patient's message would reach no staff screen (O-2), so it would go unread. Rejected |

## Decision

**Option B.** INT03-F17 is a recorded deferral, not an M4 defect, under PRD D-5 default (lines 112, 394), RA-R1-25 (line 260) and DELIVERY-PLAN C-07.

Conditions that make it conforming:

1. **Flag stays off, with these controls (F17-R1).**
   - **(a) Mechanism.** The flag is a data row, not environment configuration: `organisation.feature_flag` with `key = 'patient_messaging'` and `location_id IS NULL` (ARCHITECTURE 22.5, class C1; UQ (`key`, `location_id`) NULLS NOT DISTINCT). A missing row means off. It is read in two places, both organisation-wide only: the API `patientMessagingOn()` (`apps/api/src/modules/messaging/common.ts:66-73`, otherwise `404`) and the DB trigger that refuses a `kind = 'patient'` thread (`2001_messaging_triggers.sql:87-88`, `PS001`). A per-location row has no effect on either. No migration, seed or infra file writes this key; only test code does (`raw/evidence-greps.txt`).
   - **(b) Release check, owner DevOps Engineer** (routed as its own task, see Follow-up). A pre-release check (before the release is promoted) and a post-deploy check (after the last rollout stage, inside the observation window of DEVOPS-PLAN 9.2) **fail** if `SELECT 1 FROM organisation.feature_flag WHERE key = 'patient_messaging' AND enabled` returns a row in staging, production or demo. Any enabled row fails, organisation-wide or per location, so a later code change that starts reading location rows is also covered. The query is read-only, returns no PHI, and runs under a read-only role. A failure blocks promotion (pre-release) or starts the 9.3 defect path (post-deploy). It goes into DEVOPS-PLAN (sections 15.3 and 9.2) through the DevOps plan's own review. It is not assumed to exist until that revision passes review.
   - **(c) Runtime path, owner Solution Architect, Security Reviewer as reviewer of the admin path.** The only application write path is `PUT /api/v1/admin/feature-flags` (`packages/contracts/openapi/organisation.yaml:776`, `organisation.*`, admin realm, elevation required). It is BE-23 (HEAAA-118, M5) and is not built at `7a2fca0`. **Decision: in R1 that route refuses any write that sets `patient_messaging` to enabled (organisation-wide or per location), with `400 kernel.validation_failed`, until point 4 is built and reviewed.** This needs no contract change: the route is already specified as "settings validated against their JSON schema" (ARCHITECTURE 29.4), and this is a rule in that schema. Writing `enabled = false` or deleting the row stays allowed. The refused attempt and every accepted flag change are audited with who, before and after (C5, BE-23 acceptance), so an attempt is visible. Lifting the refusal is part of the point 4 design change and its G2 delta, not a configuration edit. The acceptance line is added to BE-23 through a comment on HEAAA-118 (its review chain already ends with the Security Reviewer). This is a refusal, not an accepted residual risk. What is left is a direct database write by a privileged role (a migration owner or break-glass). That is covered by the check in (b) and by the migration review of DEVOPS-PLAN 5.2.
   - **(d) Test-only writes.** The INT-03 `ui/enable-flag.mjs` scripts (`docs/evidence/integration/M4/raw/r7/` and `raw/int03-r8/`) and the messaging testkit write (`apps/api/src/modules/messaging/testkit.ts:99`, `:317`, a superuser insert) are test-only. They run only against a throwaway local database created for that run. They must never run against staging, production, demo or any other shared environment, and no credential for those environments is ever given to them. The check in (b) detects it if this rule is broken.
   - Enabling the flag requires D-5 to retain F-PP-09 **and** every item in point 4 to be built and reviewed, through a scope change (PM) and a design change (Solution Architect) that reopen review and the G2 delta.
2. **Acceptance journey "messaging" = RA-R1-25, staff to staff**, run in the staff UI with the flag off: staff creates a thread with another staff principal, sends, the other reads and replies; tasks create/complete. This depends on INT03-F16 (route the staff app, including FE-12 messages and tasks). No separate F17 implementation task. The INT-03 re-run needs a fixture with **two** staff principals (r8 had one, so it only showed a note-to-self thread).
3. **Patient side with the flag off**: no nav entry, routes 404 as not-found (already true). TC-MSG-03 is recorded `N/A` (D-5 default). The INT-03 patient journey should be run with the flag off; the r8 "messages list/new" screenshots are flag-on diagnostics only.
4. **Deferred design (only if D-5 later retains F-PP-09; reopens design review and the G2 delta; not implemented now).** Each item below is a design gap. None is designed by this decision.
   - (a) A care-team recipient source that a patient can read, or routing to a location or role inbox instead of named principals.
   - (b) A patient reply route on the patient host (`POST /threads/{id}/messages`, ARCHITECTURE 29.2). It is not served today (O-2).
   - (c) Staff listing, reading and replying for `kind = 'patient'` threads under `messaging.thread.patient`, scoped by `staff_scope`.
   - (d) Inbox ownership, a response-time notice and "not for emergencies" text.
   - (e) Patient compose and reply UI, and a staff patient-thread UI.
   - (f) TC-MSG-03 activated.
   - (g) **Attachments** (F-PP-09 includes them; `messaging.message.attachment_document_ids`, 22.12). Patient upload through the documents upload and malware scan path, with a size and type limit. A document is attached only after its scan passes. Who can read it: the patient and the thread's staff participants under `staff_scope`. The document's patient must equal the thread's patient. Handling a failed scan. Audit of access.
   - (h) **New-message notifications both ways.** To the patient when staff reply, and to staff (the inbox owner from (d)) when a patient writes. This needs templates, recipients, channels, dedupe keys and patient preferences. The notification carries no message content and no subject, only a prompt to sign in (22.13: `notifications.notification` holds no message content).
   - (i) **Proxy rules (D-7).** Whether and how a proxy reads or writes a patient's messages, adolescent confidentiality, and what happens when proxy access is revoked. Until D-7 is decided, the D-7 default holds (a proxy sees appointments only), as the current patient screen does (a proxy-only account sees a permission note and makes no thread call, `apps/patient/src/features/messages/messages.test.tsx:121`).
   - (j) **The platform change behind O-2.** Today a route has one permission. Staff routes that serve `kind = 'patient'` threads need `messaging.thread.patient` while staff threads use the staff permission, so the platform must allow a permission per handler in the route inventory (or separate routes), with its contract and authorization tests. Item (c) depends on this.
   - (k) **What happens to patient threads if the flag goes on and then off** (22.12, thread R/K, message K). The threads and messages stay stored and are retained under 22.12/22.16. Nothing is deleted when the flag goes off. With the flag off, patient routes return `404`. Whether staff can still read or close existing patient threads, and whether the patient sees them again when the flag goes back on, must be decided. Patient merge must re-point `thread.patient_id` and `message.patient_id` to the survivor (R/K), and attachments with them.

Reason: it follows the approved PRD and architecture without a new contract, keeps patient data from going to an unwatched place, and is reversible. Between A and B, B is simpler, cheaper and already designed and tested.

## Follow-up

- **DevOps Engineer** (own task, routed by HEAAA-389): add the `patient_messaging` pre-release and post-deploy check of condition 1(b) to DEVOPS-PLAN, reviewed by the DevOps Reviewer.
- **BE-23 (HEAAA-118)**: add the acceptance from condition 1(c). The route refuses enabling `patient_messaging`, and the attempt is audited. A test proves the `400` and the audit row. Recorded on HEAAA-118. Its existing reviewers (Backend Reviewer, then Security Reviewer) check it.
- Orchestrator: close INT03-F17 as a deferral (D-5 default) only after this decision passes review. Make sure the F16 correction covers routing FE-12 messages and tasks. The INT-03 re-run uses two staff principals and the flag off for the R1 messaging journey.
- If the owner or PM later retains F-PP-09 under D-5, the PM opens the scope change and the Solution Architect designs point 4, items (a) to (k).

## Changes in revision 2 (HEAAA-389, review round 1 of 3 on HEAAA-387 and HEAAA-385)

| Finding | Correction |
| --- | --- |
| F17-R1 (blocking) | Condition 1 now names the mechanism (a). It adds a DevOps-owned pre-release and post-deploy check (b), routed as a task. It decides that R1 `PUT /admin/feature-flags` refuses enabling the flag, audited, with owner and reviewer (c). It states that the r7/r8 `enable-flag.mjs` and testkit writes are test-only (d) |
| F17-R2 | Point 4 adds attachments (g), notifications both ways with no content (h), proxy rules under D-7 (i), the O-2 platform change (j), and flag on-then-off behaviour with retention and merge (k) |
