# INT03-F17 decision log: messaging UI scope (HEAAA-384)

Owner: Solution Architect (`7efe9f61`). Independent review: Solution Architect Reviewer (technical), Product Owner Reviewer (scope conformance). Not human-approved.
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

1. **Flag stays off.** `patient_messaging` must be off in every R1 environment (staging, production, demo). Turning it on with the current build lets a patient create a thread no staff screen shows. Enabling it requires D-5 to retain F-PP-09 **and** the items in point 4 to be built and reviewed. DevOps/Release keep this in the environment configuration check.
2. **Acceptance journey "messaging" = RA-R1-25, staff to staff**, run in the staff UI with the flag off: staff creates a thread with another staff principal, sends, the other reads and replies; tasks create/complete. This depends on INT03-F16 (route the staff app, including FE-12 messages and tasks). No separate F17 implementation task. The INT-03 re-run needs a fixture with **two** staff principals (r8 had one, so it only showed a note-to-self thread).
3. **Patient side with the flag off**: no nav entry, routes 404 as not-found (already true). TC-MSG-03 is recorded `N/A` (D-5 default). The INT-03 patient journey should be run with the flag off; the r8 "messages list/new" screenshots are flag-on diagnostics only.
4. **Deferred design (only if D-5 later retains F-PP-09; reopens design review and G2 delta, not implemented now):** (a) patient-readable care-team recipient source (or route to a location/role inbox instead of named principals); (b) patient reply route on the patient host; (c) staff listing/reading/replying for `kind='patient'` threads under `messaging.thread.patient`, scoped by `staff_scope`; (d) inbox ownership, response-time notice and "not for emergencies" text; (e) patient compose/reply UI and staff patient-thread UI; (f) TC-MSG-03 activated.

Reason: it follows the approved PRD and architecture without a new contract, keeps patient data from going to an unwatched place, and is reversible. Between A and B, B is simpler, cheaper and already designed and tested.

## Follow-up

- Orchestrator: close INT03-F17 as deferral (D-5 default) once reviewed; make sure the F16 correction covers routing FE-12 messages and tasks; INT-03 re-run uses two staff principals and the flag off for the R1 messaging journey.
- If the owner/PM later retains F-PP-09 under D-5, the PM opens the scope change and the Solution Architect designs point 4.
