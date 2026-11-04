# TEST-CASES — Enterprise EHR Platform (Stage 2 QA plan)

| Field | Value |
| --- | --- |
| Task | HEAAA-15 `[SDLC:qa-plan]` |
| Author | QA Engineer agent (`a2336f9b-c077-4b13-b5d3-393af748139b`) |
| Version | **Test cases draft 1** |
| Status | **DRAFT 1. Not independently reviewed. Not human-approved. This is not G2.** Nothing in this document has been executed. Every case is `Planned`. |
| Reviewer for this deliverable | Not the author. Per HEAAA-12 section 11 the QA lane is reviewed by the Product Owner Reviewer and the Solution Architect (Orchestrator assigns; none assigned yet) |
| Approved inputs (G1) | PRD revision 3: HEAAA-11 `prd` rev `bba336f3-e934-4dbb-9158-0909fda132d7` (`docs/PRD.md` @ `f8d3d6e`). ARCHITECTURE draft 4: HEAAA-11 `architecture` rev `f2d240e4-2f63-45a1-aaa1-16a1f8854c32` (`docs/ARCHITECTURE.md` @ `f8d3d6e`; HEAAA-41 rev `a29940b5`). Human acceptance of both on HEAAA-11, 2026-11-04 22:03Z |
| Design input | HEAAA-12 `shared-boundaries` rev `0fffc85d-c3cd-4bad-a7f3-4f774fbbbf5a` (draft 3; independent review PASS, `shared-boundaries-review` rev `80b898be`; sha256 of body `84ba3681…f680`). Cybersecurity review of its sections 7, 9.1 and 10 is still outstanding |
| Not yet available | HEAAA-13 technical design (ERDs, API contracts, failure design), HEAAA-14 UI/UX and mockups, HEAAA-16 DEVOPS-PLAN. All three are in progress. Steps that name screens, field names or endpoints use the PRD/boundary vocabulary and **must be re-bound to those revisions at alignment (HEAAA-17) before G2** (section 17) |
| Security routing carried | **SEC-D-19 condition C7** (ARCHITECTURE 8.4, ADR-011; Cybersecurity HEAAA-42 comment `e6414334`), see section 5. Also RA-R1-32 (C1, C4, C6) |

## 0. How to read this

**Release scope.** The cases cover R1 in full detail (target: production by end of May 2027). R2 and R3 are in section 14 as outline cases with reserved IDs. They are detailed at the milestone that builds them, because their contracts do not exist yet. R4 has no acceptance in the PRD and no cases.

**Decisions and defaults.** Where the PRD default applies unless the owner decides otherwise, the case tests the default and says so. Examples: D-3 block-only cancellation, D-4 no lab sample booking in R1, D-6 no patient visit summary in R1, D-7 proxy sees appointments only, and D-35 **path B** (separate admin pool) in effect. A case tagged `[G2 setting]` tests that the system follows the configured value. The PRD 7.2 proposals (10-minute hold, 48 h/4 h reminders, 15-minute idle timeout and so on) are provisional until G2. The expected results below use them as example values only.

**Blocked cases.** A case is `BLOCKED` when its decision is open (section 13). A blocked case is not skipped and not waived. It stays in the plan and blocks the criterion it covers.

**Execution status values.** `Planned` (written, not run), `Ready` (candidate, environment and data exist), `Passed`, `Failed`, `Blocked`, `Pending-human` (needs the named person; stays pending until that person performs it). This draft uses only `Planned`, `Blocked` and `Pending-human`.

### 0.1 Case fields

Each case has: **ID**; **Req** (requirement and rule it proves); **Role** (BA actor or realm); **Pre** (preconditions and synthetic data); **Steps**; **Expected**; **Pri**; **Type** (P positive, N negative, B boundary, E exception/recovery, S patient-safety, X concurrency, A11Y, L load, SEC security); **Auto** (see 0.2).

**Priority.** P0: safety-critical, security, privacy, or data-loss. A failure blocks acceptance and cannot be waived by the client (PRD RA-R1-18, 8.3). P1: core journey for the release. P2: important behaviour. P3: polish or low-risk. A defect in a safety-critical rule is severity-high whatever its frequency (PRD 8.3).

### 0.2 Automation decision

| Code | Meaning | Who executes |
| --- | --- | --- |
| `AUTO` | Fully scripted: API/contract, database/RLS, job, or browser end-to-end. Runs in CI or on the QA environment against the integrated candidate | QA agent or CI. Evidence: tool and version, candidate commit, assertion count, raw report |
| `AUTO+H` | A script does the mechanics. A human confirms what a script cannot judge (for example a rendered email in a real mailbox, a calendar client display) | QA agent for the script; the **named human** for the confirmation |
| `HUMAN` | Requires a real person (clinical judgement, assistive technology, a physical security key, an owner decision, a document review) | The named person. **The QA agent never records a result for it.** |
| `OPS` | Evidence comes from an operations exercise (restore test, DR drill, policy export) run by DevOps/the operations owner. QA reviews the evidence | DevOps owner; QA checks freshness and content |

A case is automated only when a script can fail it for the right reason. Mocks may be used for authoring, but a case marked `AUTO` that depends on a third party (Google, SMS, e-prescribing, video, payment) passes only against that provider's real sandbox or test environment. Where none exists the case stays `Blocked` with the missing sandbox named. A mock does not prove an external service.

### 0.3 Environments (names are placeholders until DEVOPS-PLAN is aligned)

| ID | Purpose | Data | Notes |
| --- | --- | --- | --- |
| `ENV-INT` | Integrated candidate, functional and security cases | Synthetic only (BR-35) | Real PostgreSQL 17+ with RLS and the real database roles (HEAAA-12 6.2); real Google Workspace **test** domain with an admin OU; vendor sandboxes for email/SMS/video. No production system |
| `ENV-LOAD` | Load and capacity (NFR-6..9). PRD DEP-14 | Generated synthetic volume (section 3.3) | Production-like sizing is a DevOps/owner cost decision. If it is not provisioned, the load cases are `Blocked`, not reduced |
| `ENV-DR` | Restore and regional-recovery exercise (NFR-2..4) | Synthetic | Region loss is in scope unless the owner decides otherwise (D-26) |
| `ENV-A11Y` | Same build as `ENV-INT` for assistive-technology runs on real devices | Synthetic | Needs the browsers/screen readers listed in section 11 |

Credentials, tokens and real personal data never go in this document, in evidence, or in screenshots (BR-35, BR-36). Test credentials come from the environment's secret store.

## 1. Traceability summary

Every R1 acceptance row (RA-R1-01..32) and every R1-applicable BA acceptance example has at least one case. The full matrix is section 15. Coverage is a statement about the plan, not about execution: **no case has been run**.

| Group | Cases |
| --- | --- |
| Identity and sessions | TC-ID |
| SEC-D-19 (C1–C7) | TC-SEC (25), TC-SEC-C7 (7) |
| Authorization and RLS | TC-AZ |
| Booking, calendar, notifications | TC-BK, TC-CAL, TC-NT |
| Pre-consultation, safety, clinical | TC-PC, TC-SAF, TC-CL, TC-DR |
| Telehealth, audit, documents, privacy | TC-TH, TC-AU, TC-DOC, TC-PR |
| Admin, brand, patient, messaging, merge, API | TC-AD, TC-BS, TC-PP, TC-MSG, TC-MG, TC-API |
| Non-functional | TC-A11Y, TC-XB, TC-PERF, TC-REC, TC-NFR, TC-PEN |

## 2. Roles and test accounts

Staff accounts live in a **Google Workspace test domain** that mirrors the production layout: a dedicated admin organisational unit (OU) with security-key-only 2-step verification, and ordinary staff OUs (C2). Names are synthetic. Patient and proxy accounts are in the patient pool; partner accounts (R2) in the partner pool. Realms follow HEAAA-12 7.1.

| Account | Realm / audience | Role (BA actor) | Locations | Notes |
| --- | --- | --- | --- | --- |
| `PAT-01`..`PAT-12` | `patient_pool` / patient | Patient (A-02) | n/a | `PAT-01` has MFA enabled, `PAT-02` has not. `PAT-03` is a dependant (age 17) of proxy `PRX-01`. `PAT-04`/`PAT-05` are probable duplicates (same name, date of birth, phone). `PAT-06` registered only through LOC-B1 |
| `PRX-01` | `patient_pool` / patient | Guardian/proxy (A-03) | n/a | Linked to `PAT-03` |
| `STF-FD-A` | `google` / staff | Front desk (A-04) | LOC-A1 | |
| `STF-TRI-A` | `google` / staff | Triage nurse (A-05) | LOC-A1 | |
| `STF-COORD-A` | `google` / staff | Care coordinator (A-06) | LOC-A1 | |
| `STF-DR-A1`, `STF-DR-A2` | `google` / staff | Doctor (A-07) | LOC-A1 | `A1` has EPCS proofing flag off in R1 (not used until R2) |
| `STF-DR-B1` | `google` / staff | Doctor (A-07) | LOC-B1 | Licensed states differ from `STF-DR-A1` (TL-1) |
| `STF-ASST-A` | `google` / staff | Assistant (A-08) | LOC-A1 | Scope per G-10 (open) |
| `STF-TRN-A` | `google` / staff | Trainee doctor (A-09) | LOC-A1 | Supervisor `STF-DR-A1` |
| `STF-ONCALL` | `google` / staff | On-call doctor (A-17) | LOC-A1, LOC-B1 | |
| `STF-MRO-A` | `google` / staff | Holder of `patient.merge` (BQ-3 proposal: front-desk lead / medical records) | LOC-A1 | Role set confirmed at G2 |
| `STF-BILL-A` | `google` / staff | Billing staff (A-13) | LOC-A1 | Limited in R1 |
| `STF-MKT` | CMS SSO | Marketing/content (A-14) | n/a | No patient data |
| `ADM-1`, `ADM-2`, `ADM-3` | `admin_pool` (path B) or `google`+OU (path A) | Org/system admin (A-15) | all | `ADM-1`/`ADM-2` are the bootstrap pair; `ADM-3` is created later by approval |
| `CMP-1`, `CMP-2` | as above | Compliance officer (A-16) | all | `CMP-2` is the second approver / BTG reviewer |
| `STF-OUT-OU` | `google` | Staff user whose Workspace account is **outside** the admin OU | | For C2/C7 |
| `STF-SUPER` | `google` | Workspace **super-admin** test identity | | For C3/C7. Not a real super-admin of any production tenant |
| `STF-SUSP` | `google` | Suspended Workspace account | | For C2 |
| `STF-NO2SV` | `google` | Account not enrolled in 2-step verification | | RA-R1-01 |
| `VIS-01` | none | Visitor (A-01) | | |

**Two-person rule for `person_id`.** Where a case needs "a different person", it uses accounts with different `person_id`. Where path B gives one human two principals (staff + admin), the case also runs the same-person variant (HEAAA-12 7.2.2): the approver and requester compare by `person_id`, not `principal_id`.

## 3. Synthetic data

### 3.1 Organisation and clinics

| ID | Content |
| --- | --- |
| `ORG-1` | One organisation. Two clinics. `LOC-A1` (IANA zone `America/New_York`), `LOC-A2` (same clinic, second location), `LOC-B1` (`America/Los_Angeles`). Each has rooms, opening hours, a holiday, and a per-location setting for hold, cut-off and reminders |
| `ORG-2` | A second organisation with one location and one patient. Used only to prove organisation isolation (BR-32) |
| `SVC-IN`, `SVC-VID`, `SVC-NEUTRAL`, `SVC-SENS` | In-person and video services. `SVC-SENS` has a condition-revealing internal name ("synthetic HIV clinic") and a neutral patient-visible display name set in the catalogue (BR-23 extension). `SVC-NEUTRAL` has an ordinary name |
| `DOC-TPL-1` | A doctor availability template: Mon–Fri 09:00–12:00 in 20-minute slots for `STF-DR-A1` at LOC-A1; one overbookable session with cap 2 |

### 3.2 Patients and clinical content

All patients are generated: names such as "Test Patient 01", dates of birth from a generator, phone numbers in a reserved test range, emails on a test domain. Clinical content uses obviously synthetic text. Allergy and medication items are RxNorm-coded test concepts. One entry per patient is free text to exercise the `uncoded` flag (SA-F-08). **No real person's data is allowed in any non-production environment** (BR-35). A scan of the seed files for patterns that look like real identifiers is part of TC-NFR-09.

Seeds used by name in the cases:

| Seed | Content |
| --- | --- |
| `SEED-CHART-1` | `PAT-01` with problems, allergies (one coded, one `uncoded`), medications, vitals, and a signed note authored by `STF-DR-A1` |
| `SEED-CHART-2` | `PAT-06` registered only at LOC-B1 |
| `SEED-DUP` | `PAT-04` and `PAT-05` with a few appointments, a signed note, an open task and a proxy grant each |
| `SEED-ATTACK` | Strings for injection and PHI-leak probes (script fragments, SQL metacharacters, a condition name, a medicine name, a test name) placed in free-text fields |
| `SEED-FILES` | A clean PDF, a clean image, an EICAR antivirus test string file, an oversized file, a file with a mismatched type, and a file with a double extension |

### 3.3 Volume sets (load)

| Set | Content |
| --- | --- |
| `VOL-1` (NFR-9) | 250,000 patients; 1,000 staff; 30+ clinics; appointment and audit history sized to the year-1 estimate in ARCHITECTURE 9.3 (audit about 2 million chart-view events a day at peak) |
| `VOL-2` (RLS worst case, HEAAA-12 6.8) | The year-1 patient count **all attached to one location**, so the staff-scope probe is at its worst |
| `VOL-3` (races) | 100 distinct patient accounts, plus one patient account used by 100 parallel sessions |

Generation scripts are test code. They are written only after valid G2 (WORKFLOW Stage 2: no application or test code before G2). This plan fixes the shapes and counts.

## 4. Identity, sign-in and sessions (RA-R1-01, J-02, J-22, AC-33)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-ID-01 | RA-R1-01, J-02 | Patient | New email and phone on test domain; email and SMS sandbox | 1. Open sign-up on `my.`<br>2. Enter email and phone<br>3. Read the OTP from the sandbox mailbox<br>4. Enter it<br>5. Complete profile | Account created. Portal then offers MFA. OTP is single-use | P1 | P | AUTO+H (OTP read from sandbox) |
| TC-ID-02 | RA-R1-01, J-02 | Patient | `PAT-02`, an unused OTP | 1. Start sign-up<br>2. Enter a wrong OTP 5 times<br>3. Enter the correct OTP afterwards<br>4. Re-use an already-used OTP | Wrong codes are refused and rate-limited (`429` + `Retry-After`, CN-11). A used or expired OTP is refused. No account detail leaks in the error (CN-03) | P0 | N, B | AUTO |
| TC-ID-03 | RA-R1-01 | Patient | `PAT-01` | 1. Enable MFA (passkey or email OTP; SMS as fallback)<br>2. Sign out<br>3. Sign in with the second factor<br>4. Try to sign in with the password/first factor only | Second factor is demanded; first factor alone does not open a session | P1 | P, N | AUTO+H (real passkey ceremony on a device) |
| TC-ID-04 | RA-R1-01, J-22 | Staff | `STF-DR-A1` on the Workspace test domain | 1. Open `staff.`<br>2. Choose Google sign-in<br>3. Complete Workspace 2SV<br>4. Land on the staff home | Session is created for audience `staff`, realm `google`. Staff cannot set or use a local password: no local-password form, no password-reset route exists (probe the routes) | P0 | P, SEC | AUTO+H (2SV completed by a real test device) |
| TC-ID-05 | RA-R1-01 | Staff | `STF-NO2SV` | Attempt sign-in | **Cannot sign in.** Refusal comes from Workspace policy or the ID-token checks (`hd`, `email_verified`). No session cookie is issued | P0 | N, SEC | AUTO+H |
| TC-ID-06 | RA-R1-01 | Staff | ID token for a user outside the allowed domain; ID token with `email_verified=false` | Replay each token against the callback | Both are refused. Nothing is written except a `denied` audit event | P0 | N, SEC | AUTO |
| TC-ID-07 | RA-R1-01 | Operations owner | Workspace policy export for staff OUs, dated within 30 days of the run | Read the export: 2SV required for every staff OU; security keys recommended for prescribers and admins | Export shows 2SV required on all staff OUs. The report states: *the platform cannot prove per sign-in which second factor was used* (SA-F-06) and does not claim to | P0 | SEC | OPS + HUMAN (owner/DevOps provides; QA reads) |
| TC-ID-08 | BR-17 (R1 part), RA-R1-01 | Staff | `STF-DR-A1` with a draft note | 1. Sign the note<br>2. Observe that re-authentication is demanded<br>3. Cancel the re-auth<br>4. Retry | Signing requires fresh re-authentication every time. Cancelling re-auth leaves the note unsigned and the draft intact | P0 | N | AUTO+H |
| TC-ID-09 | AC-33, X-20 | Staff | `STF-DR-A1`, idle timeout set to 15 min **[G2 setting]**; a draft note with unsaved text | 1. Type in the draft<br>2. Stay idle until just before the timeout<br>3. Act (still signed in)<br>4. Stay idle past the timeout<br>5. Act | Before the timeout the action works and the timer resets. After it, the action is refused and re-authentication is demanded. The draft text is preserved after re-auth. Server-side session is gone (a replayed cookie gets `401`) | P0 | B, E | AUTO |
| TC-ID-10 | HEAAA-12 5.1, CN-05 | Any | A signed-in session on each host | 1. Replay a `staff.` cookie against `my.` and `pharmacy.`<br>2. Replay a patient cookie against `staff.`<br>3. Check cookie attributes | Each session is bound to one audience; cross-use gets `401` or `403` (`auth.forbidden`). Cookies are `__Host-` prefixed, `Secure`, `HttpOnly`, `SameSite` set | P0 | N, SEC | AUTO |
| TC-ID-11 | NFR-14 (L3 for authentication) | Attacker | `my.` sign-in | 1. Brute-force with rate limit active<br>2. Try user enumeration by timing and message<br>3. Session fixation: reuse a pre-login cookie after login<br>4. CSRF on a state-changing POST without the token | Rate-limited. Messages identical for known and unknown accounts. Session ID changes at login. CSRF POST refused | P0 | SEC, N | AUTO (tool and version recorded) |
| TC-ID-12 | J-22, RA-R1-01 | Staff | Two browsers, same user | 1. Sign in on both<br>2. Sign out of one | The other session is not silently extended. Sign-out is server-side (a replayed cookie is refused). One session per browser on `staff.` | P1 | P, N | AUTO |

## 5. SEC-D-19 admin and compliance controls (RA-R1-32, condition C7)

**Source.** ARCHITECTURE draft 4 section 8.4 and ADR-011 (rev `f2d240e4`), conditions C1–C7 from Cybersecurity HEAAA-42 comment `e6414334`. "Admin and compliance roles" means every role that can assign roles, change configuration or policy, read audit data, export data, or approve break-the-glass. The exact role list is fixed in HEAAA-13; until then the cases use `ADM-*` and `CMP-*`.

**Path.** D-35 defaults to **path B** (separate `admin_pool` realm, HEAAA-12 section 7). Path A (staff realm + C1–C3) is still possible until HEAAA-13 freezes the identity ERD. Cases are tagged `A`, `B` or `A+B`. A case tagged `A+B` runs on whichever path is built and must pass on it. If the owner switches path, the tags tell QA which cases to rerun. Known wording gaps SA-F-18 (RA-R1-32 names C1 on either path; C1's Google-OIDC part exists only on path A) are handled by testing the **server-side elevation grant** on both paths and the Google forced-re-auth/`auth_time` check on path A only.

**Evidence rule.** PRD RA-R1-32: C1, C4, C6 evidence is a test run on the integrated candidate, not a design statement. C2, C3 evidence comes from operations (DEVOPS-PLAN) and QA checks it (TC-SEC-16, TC-SEC-17). The seven C7 cases are TC-SEC-C7-01..07 and are `P0`. Failure of any C7 case is a security blocker and may not be relabelled optional.

### 5.1 C1 — step-up and elevation grant

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-01 | C1, RA-R1-32 | `ADM-1` | Signed in, no elevation. A privileged action list from HEAAA-13 (assign role, change policy, read audit, export, approve BTG) | 1. Call each privileged action directly (API and UI) with the session only | Each is refused: `403 auth.forbidden` (reason: elevation required). Nothing is changed. A `denied` audit event exists per attempt with outcome and reason | P0 | N, SEC | A+B | AUTO |
| TC-SEC-02 | C1 | `ADM-1` | Elevation window configured (planning value 15 min; final value from HEAAA-13); test clock control or a short configured window in `ENV-INT` | 1. Obtain a grant with a real WebAuthn assertion<br>2. Perform a privileged action at window − 1 min<br>3. Perform it at window + 1 min | Step 2 succeeds. Step 3 is refused with the same elevation-required denial. The grant is not extendable by activity alone | P0 | B, SEC | A+B | AUTO |
| TC-SEC-03 | C1 | `ADM-1` | App-enrolled WebAuthn credential (security key, user verification required) | 1. Start elevation<br>2. Answer the challenge with a key that **fails user verification**<br>3. Answer with a key that is not enrolled<br>4. Replay a previous assertion | All three refused; no grant issued. Challenge is single-use and expires | P0 | N, SEC | A+B | AUTO+H (a physical key is needed for the positive control) |
| TC-SEC-04 | C1 | `ADM-1`, `ADM-2` | Two sessions for `ADM-1` (S1, S2); one for `ADM-2` | 1. Elevate S1<br>2. Use S1's grant identifier on S2<br>3. Use it from `ADM-2`'s session | Grant is bound to the session. S2 and `ADM-2` are refused | P0 | N, SEC | A+B | AUTO |
| TC-SEC-05 | C1 | `ADM-3` (new admin) | Admin role, no credential yet | 1. Try to enrol a credential by self-service<br>2. Try via a stale Google/staff session only<br>3. Enrol with the required fresh sign-in **and** second approver | Steps 1–2 refused. Step 3 succeeds and is audited with both people. Path B: enrolment only by single-use token (see TC-SEC-18) | P0 | N, SEC | A+B | AUTO+H |
| TC-SEC-06 | C1 (Google part) | `ADM-1` | Path A. HEAAA-13 spike result on forced re-authentication | 1. Elevate and capture the OIDC request: `prompt=login` and/or `max_age` present<br>2. Return an ID token with old `auth_time`<br>3. Return one with wrong `hd`<br>4. Return one with `email_verified=false` | Old `auth_time`, wrong `hd`, unverified email: each refused, no grant. If the spike showed Google does not honour forced re-auth or return `auth_time`, this case is replaced by "WebAuthn alone issues the grant and the Google check is absent", and QA records which branch was tested | P0 | N, SEC | A | AUTO (real Google test tenant; mocks do not count) |

### 5.2 C4 — second approver enforced in code

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-07 | C4 | `ADM-1` (requester), `ADM-2` (approver), `STF-FD-A` (subject) | Both admins eligible and elevated | 1. `ADM-1` requests the admin role for `STF-FD-A`<br>2. `ADM-2` approves | Role is assigned only after step 2. Audit has requester, approver, before/after role sets, outcome. Until step 2 the subject holds no admin role | P0 | P, SEC | A+B | AUTO |
| TC-SEC-08 | C4 | Approver conditions | Request pending from `ADM-1` for a subject | Try to approve as (a) the requester; (b) the subject; (c) an eligible admin **without** an active elevation; (d) a non-eligible staff member; (e) a compliance officer without the approver role; (f) the same human holding a second principal (path B: same `person_id`) | All refused. Only an eligible, elevated, different person succeeds. (f) is refused because the rule compares `person_id` | P0 | N, SEC | A+B | AUTO |
| TC-SEC-09 | C4 | `ADM-1`, `ADM-2` | Request expiry planning value 24 h; controllable clock | 1. Create a request<br>2. Approve at expiry − 1 min<br>3. Create another and approve at expiry + 1 min | Step 2 works. Step 3 refused; the request is `expired`; no role change. Expiry is audited | P0 | B | A+B | AUTO |
| TC-SEC-10 | C4 | `ADM-1`, `ADM-2` | Approver set = {`ADM-1`, `ADM-2`} | 1. Request removal of `ADM-2` from the approver set by `ADM-1`<br>2. Self-approve it<br>3. Approve with the other admin | The change to the approver set itself needs a different eligible person (steps 1–2 end in refusal, step 3 completes). Audited. (Billing-admin role: add the same checks in R2.) | P0 | N, SEC | A+B | AUTO |
| TC-SEC-11 | C4 bootstrap | DevOps + two humans | Fresh `ENV-INT` (new environment) | Follow the dual-controlled bootstrap runbook in DEVOPS-PLAN: create the first two admins. Then try to repeat the bootstrap | Exactly two admins created, both people recorded in the audit. After bootstrap the in-app rule applies and a second bootstrap is impossible without the runbook. No code path lets a single person create an admin | P0 | SEC | A+B | HUMAN (two real people) + QA reviews evidence |
| TC-SEC-12 | C4, C5 | `ADM-1`, `CMP-1` | Audit viewer | After TC-SEC-07..10, query audit for role-change events | Each event has requester, approver, before/after role sets, outcome. `config_change` events show who/what/before/after and **no secret values** (version IDs only). Events cannot be edited or deleted | P0 | SEC | A+B | AUTO |

### 5.3 C6 — kill switch and deprovisioning

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-13 | C6 | `ADM-1`, `ADM-2` | `ADM-3` has two active elevated sessions on two browsers | 1. `ADM-2` (elevated) uses the kill switch for `ADM-3`<br>2. `ADM-3` repeats a privileged action and a normal action from both browsers | Both sessions and the elevation are gone at once. Next request on each: `401`. Alert goes to compliance (`kill switch used`). Audit has `session_revoke` | P0 | SEC | A+B | AUTO |
| TC-SEC-14 | C6 | `ADM-3` | Same | Remove the admin role from `ADM-3` while elevated | Elevation ends immediately, not at expiry. Privileged action refused on the next call | P0 | SEC | A+B | AUTO |
| TC-SEC-15 | C6 | `ADM-3` | Simulate Google (path A) or the managed pool (path B) as unreachable (block the egress to it in `ENV-INT`) | Use the kill switch | It works because sessions live in our database. Property 4 of HEAAA-12 7.5: effective at once, also with the identity provider down | P0 | E, SEC | A+B | AUTO |
| TC-SEC-16 | C6 | HR/DevOps + human | A leaver scenario for an admin test person | 1. Record a deprovisioning request with a timestamp<br>2. Run the deprovisioning runbook<br>3. Record completion time | Completed the **same business day** for admin/compliance roles (one business day for other staff). Elapsed time is a measured fact in the evidence, not a statement | P0 | SEC | A+B | HUMAN + OPS |

### 5.4 C2, C3, C5 and path B properties

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-17 | C2 evidence | DevOps owner | Admin OU policy export | Read the export | Security-key-only 2SV for the admin OU; no SMS/TOTP fallback; no recovery bypass. Dated. Quarterly repeat is scheduled. Workspace edition that allows this is named (it was **Unverified** in ARCHITECTURE C2) | P0 | SEC | A (B: advisable) | OPS + HUMAN |
| TC-SEC-18 | C2 app check | System | `STF-OUT-OU`, `STF-SUSP` | Covered by TC-SEC-C7-04. This ID is the evidence link for the hourly re-check: confirm the job ran, its result, and its alerts | Job ran at least hourly in the observed window; mismatches produced elevation removal, role suspension, and a staff alert | P0 | SEC | A | AUTO |
| TC-SEC-19 | C3 evidence | Security owner | Super-admin inventory | Read: exactly two named super-admins, no shared accounts, security keys only; a sealed break-glass account that alerts on use; alerts on super-admin and OU/policy changes; last quarterly access review done by a non-super-admin | All present with dates | P0 | SEC | A | OPS + HUMAN |
| TC-SEC-20 | C5 | `ADM-1`, `CMP-1` | `SEED-CHART-1` | 1. As admin, open audit metadata<br>2. Try to read patient clinical data<br>3. Open a BTG with a reason<br>4. Run repeated exports to hit the limit | Admin sees audit metadata, no PHI by default. Clinical access only through BTG with reason; compliance alerted. Export rate limit enforced and alerted. Every config change audited | P0 | SEC | A+B | AUTO |
| TC-SEC-21 | Path B property 1–3 | Admin | `admin_pool` | 1. Look for any password, OTP or SMS sign-in on the admin route<br>2. Try the admin route with a `google` session<br>3. Try a clinical route with an `admin_pool` session<br>4. Try self-service recovery or profile change | None of the first-factor alternatives exists. Admin routes need realm `admin_pool`; clinical routes refuse it; `google` principal cannot reach admin routes. No self-recovery | P0 | N, SEC | B | AUTO |
| TC-SEC-22 | Path B rule 4, 7.2 | Admin | Same browser | Sign in as staff, then as admin | Changing realm needs sign-out and sign-in again. There are never two concurrent sessions in one browser on `staff.` | P1 | SEC | B | AUTO |
| TC-SEC-23 | Path B P-4 | `ADM-1`, `ADM-2`, new admin | Enrolment token (planning: single-use, at most 30 minutes, bound to one person, out-of-band) | 1. Create a token under dual control<br>2. Use it once<br>3. Use it a second time<br>4. Use it after 30 minutes<br>5. Use it as a different person | Only step 2 succeeds. 3–5 refused. All steps audited | P0 | B, SEC | B | AUTO |
| TC-SEC-24 | Path B 7.5 spike | Security reviewer | HEAAA-13 spike report P-1..P-7 | Read the spike report; check which fallback (F-1) is in the build; rerun TC-SEC-03, 21, 23 on that exact build | The build matches the recorded fallback decision, and Cybersecurity has reviewed the spike before the identity ERD freeze | P0 | SEC | B | HUMAN (Cybersecurity) + AUTO |
| TC-SEC-25 | Path B 7.4, DEP-16 | DevOps | `ENV-DR` | During the DR drill (TC-REC-05), try admin sign-in and elevation in the recovery region | Result recorded: works, or admins cannot elevate during failover and DEVOPS-PLAN accepts that within the 4 h RTO. Not assumed | P1 | E | B | OPS |

### 5.5 C7 — authorization tests (extend RA-R1-17, negative authorization)

Each case uses the seven bullet points of C7 verbatim. The expected result is "refused, nothing changed, denial audited" unless stated.

| ID | C7 item | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-C7-01 | Role elevation **without an approver** | `ADM-1`, subject `STF-FD-A` | `ADM-1` elevated | 1. Request the admin role for `STF-FD-A`<br>2. Try to activate it without approval (direct API call, UI, replay of request ID, direct SQL as `app_api` role)<br>3. Try with a forged approval row | Role never takes effect. Subject holds no admin permission after any attempt. The `app_api` role cannot write approval rows except through the identity function (HEAAA-12 observation O-2: the worker/function must check approval evidence the `api` alone cannot forge). Audit shows the attempts | P0 | N, SEC | A+B | AUTO |
| TC-SEC-C7-02 | **Self-approval** | `ADM-1`, `ADM-2` | | Approve own request as (a) requester; (b) subject; (c) requester through a second principal of the same person (path B); (d) subject approves a request created by someone else for themselves | All refused. A request cannot be approved by requester, subject, or the same `person_id` | P0 | N, SEC | A+B | AUTO |
| TC-SEC-C7-03 | **Stale `auth_time`** or **expired elevation** | `ADM-1` | Clock control | 1. Path A: present an ID token whose `auth_time` is older than the allowed age<br>2. Path A+B: use a grant past its window (TC-SEC-02)<br>3. Path B: use an admin-pool token with an old authentication time (P-6) or no `auth_time` (fallback F-1 uses the server's own challenge time) | Every stale or expired case is refused and audited. No grant is created or extended | P0 | N, SEC | A+B | AUTO |
| TC-SEC-C7-04 | **Account outside the OU holding an admin role** | `STF-OUT-OU`, `STF-SUSP`, `ADM-1` | Path A: directory read-only crossing live. Path B: `admin_pool` principal linked to a staff identity | **A:** (1) assign admin to `STF-OUT-OU` and to `STF-SUSP`: refused at assignment (fail closed). (2) Move an existing admin out of the OU; wait for or trigger the hourly re-check; (3) block the directory API and attempt a new admin assignment.<br>**B:** (1) create a `google` principal and give it a privileged role: refused (privileged roles exist only in `admin_pool`). (2) Suspend the linked staff identity of an `admin_pool` person; run the leaver-detection check (7.2.8, if Cybersecurity requires it) | **A:** step 1 refused; step 2 removes elevation, suspends the role, and raises a staff alert; step 3: no new admin assignment while the directory is unreachable. **B:** step 1 refused; step 2 disables the admin principal and revokes its sessions (or, if Cybersecurity decided no backstop, the expected result is "runbook only" and the case records that decision) | P0 | N, SEC | A+B (branches) | AUTO (needs real Workspace test tenant) |
| TC-SEC-C7-05 | **Workspace super-admin given an app admin role** | `STF-SUPER`, `ADM-1`, `ADM-2` | Directory reports `STF-SUPER` as super-admin | 1. Request admin for `STF-SUPER`, even with a valid approver<br>2. Request a compliance role for `STF-SUPER` | **A:** refused by `identity` regardless of approval, and audited. **B:** the `google` principal cannot hold privileged roles at all (rule 1). Whether a super-admin may additionally hold an `admin_pool` identity on path B is a question for Cybersecurity (C3 no longer guards admin roles on path B); QA records the answer given and tests it | P0 | N, SEC | A+B | AUTO |
| TC-SEC-C7-06 | **Workspace group change that does not grant a role** | `ADM-1`, Workspace admin | A Workspace group named like an app role (e.g. `app-admins`) | 1. Add `STF-FD-A` to the group in Workspace<br>2. Wait for any group sync; sign in again and open admin routes<br>3. Remove and re-add; try a privileged action | No app role is granted by group membership. At most the account becomes **eligible**; the grant still needs the app-side assignment and an approver (C4). Admin routes remain refused | P0 | N, SEC | A+B | AUTO (real Workspace test tenant) |
| TC-SEC-C7-07 | **Kill switch ending an active elevated session** | `ADM-3`, `ADM-2` | `ADM-3` elevated, performing a privileged action | 1. Fire the kill switch while an elevated request is in flight and again afterwards<br>2. Replay the old session cookie and the old grant ID | In-flight request completes or fails cleanly (no partial change). All following requests refused. Old cookie and grant useless. Alert and audit exist. Same as TC-SEC-13, run with the specific in-flight timing | P0 | X, SEC | A+B | AUTO |

## 6. Authorization, scope and row-level security (RA-R1-17, BR-32, HEAAA-12 section 6)

These cases run against the real PostgreSQL roles and policies. A test that only exercises the API cannot show that row-level security works, so each case with `DB` in the steps also connects directly as the named role.

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-AZ-01 | AC-34, RA-R1-17 | `STF-FD-A` (LOC-A1) | `SEED-CHART-2` (`PAT-06`, LOC-B1 only) | 1. Search by name, DOB, phone for `PAT-06` (POST `…/search`)<br>2. Open `PAT-06` by ID | No record shown and the response gives no hint it exists. By-ID request: `404` (not `403`). A `denied` audit event with reason `not_visible` exists (CN-04) | P0 | N, SEC | AUTO |
| TC-AZ-02 | AC-35, RA-R1-17 | `PAT-01` | `PAT-02` has a chart and appointments | Change IDs in URLs and API calls (appointments, documents, notes, messages) to `PAT-02`'s | `404` on every one. Denied events logged with the patient session. No data in any error field (CN-03) | P0 | N, SEC | AUTO |
| TC-AZ-03 | BR-32 | `STF-DR-A1` | `ORG-2` patient | Search and open a patient of `ORG-2` | Not found, organisation isolation holds; logged | P0 | N, SEC | AUTO |
| TC-AZ-04 | BR-32, HEAAA-12 6.3 | `STF-FD-A` | Patient cared for at LOC-B1 only, then booked at LOC-A1 | 1. Before booking: not visible<br>2. Book at LOC-A1 (care relationship created)<br>3. Look again<br>4. End the relationship | Visible only while a care relationship exists at the user's location. After step 4 not visible. Behaviour for cross-location chart visibility follows the PM answer to BQ-1. Until BQ-1 is answered the case checks only that visibility never exceeds the least-privilege reading | P0 | N, SEC | AUTO |
| TC-AZ-05 | HEAAA-12 6.2 | DB role `public`, `limited`, `reporting_ro` | Direct DB connection | `SELECT` every PHI table, view and read model as each role | `public` and `limited` get nothing from PHI/clinical tables. `reporting_ro` is refused on every PHI table, view and read model | P0 | SEC | AUTO |
| TC-AZ-06 | HEAAA-12 6.8 (RLS mechanics, SBR-13) | DB | Each function-owner role (`NOLOGIN`) | `SET ROLE` to each function-owner role; `SELECT` every PHI table | Only what its role-targeted policies and column grants allow (for `patient_match_owner`, identity columns only; for `scheduling_booking_owner`, C1 rows only). The M-5 catalog checks (`FORCE ROW LEVEL SECURITY` on every table, role-targeted policies, `security_invoker` views) pass | P0 | SEC | AUTO (also a CI gate) |
| TC-AZ-07 | HEAAA-12 6.8 | Every audience and realm | Each definer function in the 6.2 inventory | Call each definer function from each audience and realm that should not hold it | Refused. The patient-match function never returns out-of-scope demographics | P0 | N, SEC | AUTO |
| TC-AZ-08 | HEAAA-12 6.7, SBR-14 | Compliance principal with only `privacy.request.manage` | | 1. Query audit events, consents, incidents by SQL under its settings<br>2. Same through the API<br>3. `patient.identity_label` without the `patient_label` key, without a referencing record, and in a loop | Sees none of them. `identity_label` refused without the key, refused without a visible referencing record, audited per call, rate-limited | P0 | N, SEC | AUTO |
| TC-AZ-09 | HEAAA-12 6.6, SBR-11 | Staff at LOC-A1 and LOC-A2 | Patient cared for only at LOC-A2 | Check the staff-scope invariant: drift check job after deliberately removing and adding a scope row | Drift check finds and corrects both; alerts raised | P0 | E, SEC | AUTO |
| TC-AZ-10 | AC-12, BR-14, X-19 | `STF-DR-A2` | `PAT-01` not assigned to `A2`; `CMP-1` | 1. `A2` opens the chart<br>2. Gives a reason and proceeds<br>3. Check compliance view | Blocked until a reason is entered. Access then granted. Compliance alert raised. Event appears in the review queue with reason | P0 | N, S | AUTO+H |
| TC-AZ-11 | AC-12, BR-14 | `CMP-2` | A BTG event from TC-AZ-10 | Review it as "justified" and as "not justified" | Outcome recorded and audited. Reviewer cannot be the person who opened it (same-`person_id` rule). Reviewer needs the compliance BTG permission and sees the minimum required | P0 | N | AUTO |
| TC-AZ-12 | HEAAA-12 6.1, RA-R1-16 | Public audience | `integrations./public/v1/*` | 1. GET each public route<br>2. Try POST, PUT, DELETE<br>3. Look for any patient, reservation or room identifier in responses<br>4. Exceed the rate limit | GET only; PHI-free; start times only; no other audience data. Mutating verbs refused; `429` with `Retry-After` over limit | P0 | N, SEC | AUTO |
| TC-AZ-13 | Permission matrix (BA 1.1) | Each role in section 2 | Matrix as confirmed at G2 | Run the **role × capability** grid: for every cell with "—" attempt the action and expect refusal; for every allowed cell expect success | Result matches the G2 matrix cell by cell. The grid is generated from the matrix, and any cell with no result fails the run | P0 | N, P | AUTO |
| TC-AZ-14 | Proxy (D-7 default), RA-R1-20a | `PRX-01` | `PAT-03` linked; `PAT-01` not linked | 1. Open `PAT-03` appointments<br>2. Open `PAT-03` chart, documents, notes<br>3. Open `PAT-01` | Proxy sees appointments only (default). All else `404`. Another patient's data never opens | P0 | N, SEC | AUTO |
| TC-AZ-15 | Assistant (G-10 open) | `STF-ASST-A` | | Attempt sign, prescribe and EPCS actions | Assistant cannot sign (BR-17, AC-16). What the assistant may prepare follows the G2 decision. `BLOCKED` for prepare scope until G-10 is answered. The refusal part is testable now | P0 | N | AUTO |

## 7. Booking, calendar and notifications

### 7.1 Booking and rescheduling (RA-R1-02, J-04, J-05, AC-01..04)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-BK-01 | RA-R1-02, AC-01 | `PAT-01` | `DOC-TPL-1`, `SVC-IN`, free 09:00 slot, email/SMS sandbox | 1. Search slots<br>2. Select 09:00<br>3. Confirm | Appointment is `Confirmed`. Email/SMS with `.ics` is sent. Doctor's calendar shows "Busy" with no patient name. Audit rows exist | P1 | P | AUTO+H |
| TC-BK-02 | RA-R1-02 | `PAT-01` | `SVC-VID` | Book a video visit | Same as above plus a telehealth link; both time zones shown when patient and clinic zones differ (BR-05) | P1 | P | AUTO |
| TC-BK-03 | RA-R1-02, AC-02, BR-06 | `PAT-01` | Doctor has a Google meeting 09:00–10:00 | Search slots | No slot in 09:00–10:00 offered. Availability = template − bookings − synced busy | P1 | N | AUTO (real Google test calendar) |
| TC-BK-04 | RA-R1-02, BR-02 | `PAT-01` | Slot booked by another patient | Try to book the same slot (stale search) | `409 scheduling.slot_taken` with alternatives | P1 | N | AUTO |
| TC-BK-05 | RA-R1-02, AC-04, BR-01 **[G2 setting]** | `PAT-01` | Cut-off 24 h; visit in 10 h; D-3 default (block-only) | 1. Cancel within cut-off<br>2. Cancel a visit 25 h away | Within cut-off: cancel **blocked** with the reason, nothing charged (D-3 default). 25 h: free cancel. If D-3 later says fee, this case is rerun with that setting | P1 | N, B | AUTO |
| TC-BK-06 | RA-R1-02, J-05 | `PAT-01` | Confirmed appointment | Reschedule to another slot | Old slot released, new slot held and confirmed in one flow; reminders recomputed; Google block updated; audit rows | P1 | P | AUTO |
| TC-BK-07 | BR-04 **[G2 setting]** | `PAT-01` | Max future appointments per service = 3 | Book 3, then a 4th | 4th refused with a clear message; counts per patient per service | P2 | B | AUTO |
| TC-BK-08 | X-01, AC-03 | `PAT-01` | Hold = 10 min **[G2 setting]** | 1. Start checkout<br>2. Wait past expiry<br>3. Confirm | Hold expired; "slot no longer available" plus alternatives; no appointment | P1 | E, B | AUTO |
| TC-BK-09 | CN-06 | `PAT-01` | | 1. Send the same hold request twice with the same `Idempotency-Key`<br>2. Same key, different body<br>3. Same key on another route | 1: one hold, same response. 2: `409 kernel.idempotency_conflict`. 3: treated as a different key (per route template). Each step of hold then confirm has its own key | P1 | E | AUTO |
| TC-BK-10 | RA-R1-02, BR-05 | `PAT-01` | LOC-B1 (Pacific) and a patient browser in Eastern time | Book near a daylight-saving change date | Stored UTC, displayed in the location zone; no off-by-one-hour | P2 | B | AUTO |
| TC-BK-11 | Front desk booking | `STF-FD-A` | | Book for `PAT-01` at LOC-A1 and at LOC-B1 | Allowed at assigned location only; at LOC-B1 refused | P1 | P, N | AUTO |
| TC-BK-12 | NFR-7, usability | `PAT-01` on 360 px phone | | Complete TC-BK-01 on a phone | Journey is possible with no horizontal scroll; keyboard and touch work (see TC-A11Y-*) | P1 | P | AUTO+H |

### 7.2 No double booking (RA-R1-03, HEAAA-12 6.5)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-BK-13 | RA-R1-03 | 100 `PAT-*` sessions, one **non-overbookable** slot | `VOL-3` | 100 parallel confirmations (same patient account on 100 sessions) | Exactly one succeeds. 99 receive alternatives; exactly one appointment exists in the database | P0 | X | AUTO |
| TC-BK-14 | RA-R1-03, 6.5(c) | 100 **different** patients | `VOL-3` | Same as above with 100 distinct patients | Exactly one wins; the others see alternatives. No patient sees another's reservation | P0 | X | AUTO |
| TC-BK-15 | RA-R1-03, SA-F-10 | 100 patients, overbookable session cap 2 | | 100 parallel confirmations | Exactly 2 succeed; no more. Ties are decided by the database constraint | P0 | X, B | AUTO |
| TC-BK-16 | 6.5(a) | Patients A, B, C | A holds a slot; hold expires | B and C race for the same slot after A's hold expired | Exactly one wins. Neither gets a false "taken" | P0 | X | AUTO |
| TC-BK-17 | 6.5(b), SAR-09 | A, B, C with a room | Same, but for a **room** | Same race on the room | Same result for the room | P0 | X | AUTO |
| TC-BK-18 | 6.5(d) | Patient and public API | | Inspect slot-search and `/public/v1` responses for identifiers of other patients, reservations or rooms | None present | P0 | SEC | AUTO |
| TC-BK-19 | RA-R1-22, AC-05, BR-03 **[G2 setting]** | Waitlisted `PAT-01`, `PAT-02` | Slot frees; acceptance 30 min | 1. Free the slot<br>2. `PAT-01` ignores<br>3. After 30 min check | `PAT-01` is offered first. Offer lapses cleanly; `PAT-02` offered next | P1 | P, B | AUTO |
| TC-BK-20 | RA-R1-22 | `PAT-01`, `PAT-02` | Two offers at once | Both accept at once | Only the first is booked; the other sees a clean "no longer available" | P1 | X | AUTO |
| TC-BK-21 | RA-R1-22 | | Visit within 24 h | Acceptance time is 15 min **[G2 setting]** | Time-boxed accordingly | P2 | B | AUTO |
| TC-BK-22 | RA-R1-22 | | Waitlist patient whose account is merged meanwhile | Offer job runs after merge | Job resolves to the survivor (`on_merged: resolve`), no duplicate offer | P1 | E | AUTO |

### 7.3 Calendar sync (RA-R1-04, X-03)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-CAL-01 | RA-R1-04, BR-07 | `STF-DR-A1` | Google test calendar linked | Book a visit for `SVC-NEUTRAL` | A "Busy" block appears with no patient name, reason, or diagnosis | P0 | SEC | AUTO (real Google) |
| TC-CAL-02 | BR-23 extension | `STF-DR-A1` | Book `SVC-SENS` | Check the calendar block title and the `.ics` | Neutral label only. The internal condition-revealing service name does not appear anywhere | P0 | SEC | AUTO |
| TC-CAL-03 | RA-R1-04 | `STF-DR-A1` | A meeting created in Google | Run sync | Meeting is unavailable time for slot search within the sync delay | P1 | P | AUTO |
| TC-CAL-04 | RA-R1-04, X-03 **[G2 setting]** | `PAT-01` | Block Google API; stale threshold 15 min | 1. Search before the threshold<br>2. Search after it | Before: last-known busy times used. After: slot search does not silently use the stale data (flagged or restricted per design). Failure on operations dashboard | P0 | E, B | AUTO |
| TC-CAL-05 | RA-R1-04 | | Google push notification replay | Replay twice, and out of order | Idempotent; one effect | P1 | E | AUTO |
| TC-CAL-06 | RA-R1-04 | | Revoke Google authorisation | Run sync | Visible failure and alert, not silent; retry/back-off (BR-33) | P1 | E | AUTO |

### 7.4 Notifications and PHI-free messages (RA-R1-05, BR-08, BR-23, AC-06)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-NT-01 | RA-R1-05 | `PAT-01` | `SVC-SENS` appointment | Render every template (confirmation, 2 reminders, reschedule, cancel, waitlist offer, consent request, pre-visit request, receipts if any) in every configured language, for email, SMS, push, and `.ics` | None contains a diagnosis, test name, medicine name, condition-revealing service name, clinician name (BQ-2: excluded until PM decides). Only a log-in prompt and links. Variables come only from the allowlist | P0 | SEC | AUTO |
| TC-NT-02 | AC-06, BR-08 **[G2 setting]** | `PAT-01` | Reminders 48 h and 4 h | Advance the clock; read both reminders | Two reminders at the configured times; each has a log-in prompt and confirm/reschedule/cancel links and no clinical text | P1 | P | AUTO |
| TC-NT-03 | RA-R1-05, POR-09 | Human | `.ics` from TC-BK-01 | Open in Google Calendar, Outlook and Apple Calendar | Event opens correctly in all three, correct time zone, no PHI | P1 | P | HUMAN (real clients) |
| TC-NT-04 | X-04, BR-33 | `PAT-01` | Make SMS/email provider fail | Trigger a reminder | Retried with back-off; in-app notification still shown; failure on the operations view | P1 | E | AUTO |
| TC-NT-05 | BR-36, NFR-18 | System | Logs, URLs, analytics | Scan application logs and URLs for health data after the booking journeys | No health data in logs, URLs or analytics events | P0 | SEC | AUTO |
| TC-NT-06 | BQ-2 | `SEED-ATTACK` | Put a condition/medicine/test name in free-text fields | Trigger messages from records containing them | The text never reaches a message template (no free text binding) | P0 | N, SEC | AUTO |
| TC-NT-07 | HEAAA-12 8.3 | Staff | Alerts | Check that the alert stream sends a session only the alerts targeted to it | Staff only get alerts for their principal/role/location; `admin_pool` gets compliance types only | P0 | SEC | AUTO |
| TC-NT-08 | Notification preferences (F-PP-16) | `PAT-01` | | Turn off SMS, keep email | Preferences respected; essential security messages still sent | P2 | P | AUTO |

## 8. Pre-consultation, safety rules and clinical record

### 8.1 Pre-consultation portal (RA-R1-06, 29, 30; J-06)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-PC-01 | RA-R1-06, F-PC-01 | `STF-FD-A` | Appointment today | Check the patient in at the desk | Status moves to checked-in; patient appears in the queue | P1 | P | AUTO |
| TC-PC-02 | RA-R1-06 | `PAT-01` | QR code from the confirmation | Check in by QR on a phone | Same result; QR works once and expires; a QR for another patient's visit fails | P1 | P, N | AUTO+H |
| TC-PC-03 | RA-R1-06, F-PC-02 | `STF-FD-A` | Questionnaire and consent partly complete | Open the pre-visit checklist | Missing items flagged; front desk sees pre-visit items only (matrix), no clinical chart | P1 | P, N | AUTO |
| TC-PC-04 | AC-09, F-PC-04 | `STF-TRI-A` | SpO2 limit configured | Save vitals with SpO2 below the limit, then in range, then exactly at the limit | Below: value highlighted and triage-category prompt appears. In range: no highlight. At limit: behaves per the configured inequality (documented) | P1 | P, B | AUTO |
| TC-PC-05 | RA-R1-06 | `STF-TRI-A` | | Set a triage category | Queue orders by category then arrival; wait time shown | P1 | P | AUTO |
| TC-PC-06 | RA-R1-06 | Two staff | | Two staff edit the same triage record | Second save gets `412` (stale `ETag`); no silent overwrite (CN-07) | P1 | X | AUTO |
| TC-PC-07 | BR-34 | `STF-TRI-A` | | Open triage screen | Patient name, DOB and photo visible on every clinical screen | P0 | S | AUTO+H |
| TC-PC-08 | X-07 | `STF-FD-A` | Consent missing | Check-in a patient with missing consent | Flag raised (missing consent); consultation start blocked later (TC-SAF-05) | P1 | N | AUTO |
| TC-PC-09 | F-PC-09 (S) | | | Waitlist and no-show handling | Follows grace period **[G2 setting]**; no-show recorded | P2 | P | AUTO |
| TC-PC-10 | RA-R1-29, F-PC-05 | `STF-FD-A` | Insurance card uploaded | Record verification status and date manually | Saved and audited; no electronic eligibility request leaves the system (verify no outbound call) | P2 | P | AUTO |
| TC-PC-11 | RA-R1-30 | `STF-COORD-A` | Chart | Book a follow-up; create a referral | Follow-up appears in slot rules (RA-R1-02); referral has referrer, target, status; both audited. **No lab sample collection booking exists in R1** (D-4 default). Referral record owner is HEAAA-13 note | P1 | P | AUTO |
| TC-PC-12 | RA-R1-30 | `STF-FD-A` | | Same actions without permission | Refused; logged | P1 | N | AUTO |

### 8.2 Patient-safety rules (PRD 8.3: BR-09, BR-10, BR-14, BR-34, BR-37)

**`BLOCKED` until D-12a is decided:** TC-SAF-01..07 for RA-R1-07 and RA-R1-08. The PRD says RA-R1-07 and RA-R1-08 stay blocked, and R1 cannot go live, unless (i) a named licensed clinician reviews the R1 safety rules and their test results, or (ii) the owner records, dated, a knowing acceptance of **interim self-review**. Self-review is never independent review and is reported as such. The cases below are still written and automated now; **what is blocked is the acceptance of the criterion**, not the writing or the technical execution (execution before D-12a is allowed as development evidence, not as acceptance).

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SAF-01 | RA-R1-07, AC-08, BR-10 | `STF-TRI-A`, on-duty `STF-DR-A1` | Triage with red-flag question "chest pain" | 1. Answer "chest pain"<br>2. Save triage<br>3. Check doctor's alert and patient screen | On-duty doctor alerted at once (SSE and durable alert row). Patient sees emergency advice. Alert time recorded and audited | P0 | S | AUTO |
| TC-SAF-02 | RA-R1-07 | Same | Doctor does not acknowledge | Wait for the escalation timer (derived rule: on-call doctor) | Alert goes to the on-call doctor `STF-ONCALL`; each step audited. Escalation timing is a **[G2 setting]**; clinical window needs the clinical reviewer | P0 | S, E | AUTO + HUMAN review of the timing |
| TC-SAF-03 | RA-R1-07, BR-10 | | Boundary on every red-flag answer | Enter each configured red-flag answer; enter near-miss answers; leave the field blank | Every configured red flag alerts; non-red-flag answers do not; blank/invalid input is rejected, not treated as "no red flag" | P0 | S, B, N | AUTO |
| TC-SAF-04 | RA-R1-07 | | Alert channel down | Stop the alert stream; save red-flag triage | Alert row still exists and is delivered when the stream returns; failure visible; **the patient still sees the emergency advice** | P0 | S, E | AUTO |
| TC-SAF-05 | RA-R1-08, AC-07, BR-09 | `STF-DR-A1` | Service needs a signed consent; unsigned | Open the consultation | Cannot start. Message names the missing consent (no PHI) | P0 | S, N | AUTO |
| TC-SAF-06 | RA-R1-08, X-07 | `STF-DR-A1` | Same | Start with "emergency exception" and a reason; also try without a reason | With reason: starts; exception recorded and audited; compliance can see it. Without reason: refused | P0 | S, N | AUTO |
| TC-SAF-07 | RA-R1-08, PRD 8.3 (b) | Named licensed clinician **or** owner (interim self-review) | The above cases' rule text and results | The reviewer reads the rule text and results for BR-09, BR-10, BR-14, BR-34 and BR-37 and records a dated decision on the task | Either a named clinician's review, or the owner's dated knowing acceptance of interim self-review, recorded on the task **and** in the acceptance record, reported as **self-review (not independent)** where applicable. If neither exists, RA-R1-07/08 stay blocked and R1 cannot go live | P0 | S | HUMAN (never recorded by QA) |

### 8.3 Clinical documentation (RA-R1-09, 11, 24; J-09)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-CL-01 | RA-R1-09, BR-11 | `STF-DR-A1` | Visit; note template | Write a note from a template, sign (re-auth), then edit | Note locks on signing. Edit attempt fails with "locked"; changes only via addendum | P0 | P, N | AUTO |
| TC-CL-02 | AC-10, BR-11 | `STF-DR-A1` | Signed note | Correct a dose through an addendum | Addendum has author and time; original unchanged; patient ID on the addendum is the survivor's if merged | P0 | P | AUTO |
| TC-CL-03 | AC-11, BR-12 | `STF-TRN-A`, `STF-DR-A1` | Trainee note | 1. Release without co-signature<br>2. Supervisor co-signs<br>3. Release | 1 refused. 3 allowed. Co-sign audited. A co-sign by a non-supervisor is refused | P0 | N | AUTO |
| TC-CL-04 | SA-F-08 | `STF-DR-A1` | | Enter an allergy and a medication as RxNorm-coded items; then as free text | Coded items saved with codes. Free text saved and flagged `uncoded` with a warning that requires acknowledgement in R2 checks | P1 | P, B | AUTO |
| TC-CL-05 | RA-R1-09 | `STF-DR-A1` | Two doctors | Two sessions edit the same draft | Second save `412`; draft recoverable | P1 | X | AUTO |
| TC-CL-06 | CL deadline **[G2 setting]** | `STF-DR-A1` | Signed-note deadline 24 h | Leave a visit unsigned 24 h | Reminder sent to the doctor; no PHI in the reminder | P2 | B | AUTO |
| TC-CL-07 | CN-07 | | Signed record | Try to change any signed record through the API | Rejected; immutable | P0 | N, SEC | AUTO |
| TC-CL-08 | RA-R1-24, BR-34 | `STF-DR-A1` | `SEED-CHART-1` | Open the chart summary | Problems, allergies, medications, vitals, history, documents visible with name, DOB, photo. `uncoded` items are marked | P1 | P | AUTO+H |
| TC-CL-09 | RA-R1-24, BR-34 | | Two patients with the same name in two browser tabs | Switch between charts | Each screen shows the right patient banner; no stale banner after switching; wrong-patient risk is a human usability check | P0 | S | HUMAN (clinician/usability) |
| TC-DR-01 | RA-R1-23, F-DR-01 | `STF-DR-A1` | | Define availability, leave, blocked time | Slot search reflects it within one booking cycle | P1 | P | AUTO |
| TC-DR-02 | RA-R1-23 | `STF-DR-A1` | Existing bookings | Add leave over booked slots | Warns about conflicts; no silent cancellation | P1 | E | AUTO |
| TC-DR-03 | RA-R1-23 | `STF-DR-A2` | | Edit `A1`'s availability | Refused | P1 | N | AUTO |

## 9. Telehealth, audit, documents and privacy

### 9.1 Telehealth (RA-R1-10, 28; J-08)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-TH-01 | RA-R1-10 | `PAT-01`, `STF-DR-A1` | Video vendor sandbox | Device check, waiting room, join, notes side by side | Visit runs; both can see/hear; notes pane available to the doctor only | P1 | P | AUTO+H (real devices, audio and video) |
| TC-TH-02 | BR-05 | | Patient and clinic in different zones | Open the join page | Both time zones shown | P2 | P | AUTO |
| TC-TH-03 | X | `PAT-02` | Other patient's visit link | Join someone else's session | Refused; logged | P0 | N, SEC | AUTO |
| TC-TH-04 | BR-33 | | Video vendor outage | Start a visit | Visible failure, retry/fallback message, no data loss; operations dashboard | P1 | E | AUTO |
| TC-TH-05 | NFR | | Join link reuse | Reuse after the visit / before the window | Refused | P1 | N | AUTO |
| TC-TH-06 | RA-R1-28, TL-1 | `PAT-01` | Clinician's licensed states; D-2 not decided (states from D-2) | Book a video visit with a stated location outside the licensed states | Refused or flagged at booking. In-state: allowed. Cases use placeholder states; **real state values wait for D-2** (`BLOCKED` for production values) | P0 | N | AUTO |
| TC-TH-07 | RA-R1-28 | `PAT-01` | | At join, answer "I am in …" with a different state | Patient must confirm current location; outside licensed states refuses/flags | P0 | N | AUTO |
| TC-TH-08 | RA-R1-28 | | | Change clinician licensed states after booking | Next join re-checks | P2 | E | AUTO |

### 9.2 Audit (RA-R1-11, 12; AC-36; NFR-13)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-AU-01 | RA-R1-11, BR-13 | `STF-DR-A1` | `SEED-CHART-1` | View, search, export, print the chart | Each creates an audit event with user, time, IP/device, reason where needed, and no clinical values | P0 | P | AUTO |
| TC-AU-02 | HEAAA-12 8.1 rule 1 | | Force the audit insert to fail (fault injection) | Read a PHI record | The read fails and the business change rolls back. PHI is never accessed without an audit row | P0 | E, SEC | AUTO |
| TC-AU-03 | 8.1 rule 2 | | Denial path | Cause a denial and fail the separate denial write | Caller still gets the denial (fail closed); failure logged and alerted | P0 | E | AUTO |
| TC-AU-04 | 8.1 rule 3 | | A transaction without `transaction_timeout` or longer than the bound | Try to insert audit rows | Refused by the trigger; migrations never write audit rows | P0 | SEC | AUTO |
| TC-AU-05 | RA-R1-12, AC-36 | `ADM-1` | | Try to delete or edit audit entries via UI, API, and SQL as `app_*` roles | Not available / refused for every role including admin; the attempt is logged | P0 | N, SEC | AUTO |
| TC-AU-06 | RA-R1-12 | `CMP-1` | | Use the audit viewer filters: who, what, when, from where | Shows the required fields; PHI not shown | P1 | P | AUTO |
| TC-AU-07 | SA-F-11 | `CMP-1` | Large result | Request an export over the size limit | Runs as an asynchronous job with a size limit; notification when ready; exported file audited; rate limit | P1 | B | AUTO |
| TC-AU-08 | SAR-10 | | Audit anchoring | Alter a stored audit row at DB owner level in `ENV-INT`, run the anchor check | Mismatch detected, alert `audit anchor mismatch` raised | P0 | SEC | AUTO |
| TC-AU-09 | NFR-13 | | | Check retention configuration | Retention value set at G2 and applied; archival works | P1 | P | OPS |
| TC-AU-10 | 8.1 | | Chart-view load | Audit write under the load profile (about 2 million events/day peak) | Within p95 targets; no loss (TC-PERF-04) | P0 | L | AUTO |

### 9.3 Documents (RA-R1-13; J-19)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-DOC-01 | RA-R1-13 | `PAT-01` | `SEED-FILES` clean PDF | Upload; wait for scan | Not openable by anyone until scanned clean. Then classification by staff and confirmation, then retained | P1 | P | AUTO |
| TC-DOC-02 | AC-30, X-17 | `PAT-01` | EICAR file | Upload | Quarantined; uploader told; clinicians cannot open it; alert/ops record | P0 | N, SEC | AUTO |
| TC-DOC-03 | NFR-17 | | Oversize, wrong MIME vs content, double extension | Upload each | Rejected with a safe error; no PHI in the message | P1 | N, B | AUTO |
| TC-DOC-04 | AC-31, X-18 | `CMP-1` | Document on legal hold | Request deletion | Refused with reason recorded | P0 | N | AUTO |
| TC-DOC-05 | CN-12 | | Uploads | Check the upload path | Uploads use pre-signed URLs and never pass through the API; URLs expire; one URL cannot read another's file | P0 | SEC | AUTO |
| TC-DOC-06 | AZ | `PAT-02` | Another patient's file ID | Download by ID | `404`; logged | P0 | N, SEC | AUTO |
| TC-DOC-07 | BR-29 | | Retention | Delete after the retention period (clock control) | Allowed only after the legal period and no hold | P1 | B | AUTO |
| TC-DOC-08 | Scanner outage | | Stop the scanner | Upload | File stays unavailable; visible failure; no bypass | P0 | E, SEC | AUTO |

### 9.4 Privacy requests (RA-R1-14; J-21)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-PR-01 | RA-R1-14 | `PAT-01` | | Set notification preferences | Saved and respected (TC-NT-08) | P2 | P | AUTO |
| TC-PR-02 | RA-R1-14 | `PAT-01` | | Request a data export | Request recorded; identity verified; compliance sees it; export assembled asynchronously in chunks, each audited; delivered via the portal, no PHI in email | P1 | P | AUTO |
| TC-PR-03 | RA-R1-14 | `PAT-01` | | Request account deletion | Request recorded and visible to compliance. **What deletion means is `BLOCKED` on D-8**; this case checks the request flow only | P1 | P | AUTO |
| TC-PR-04 | RA-R1-14 | `PAT-02` | | Request another patient's export | Refused | P0 | N, SEC | AUTO |
| TC-PR-05 | RA-R1-14 | `CMP-1` | | Process a request with identity not verified | Refused with reason recorded | P1 | N | AUTO+H |

## 10. Admin, brand site, patient portal, messaging, merge and API conventions

### 10.1 System admin (RA-R1-15, 26, 31)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-AD-01 | RA-R1-15, F-AD-01 | `ADM-1` (elevated) | | Create clinics, rooms, hours, holidays | Saved; audited with before/after; appear in slot search | P1 | P | AUTO |
| TC-AD-02 | RA-R1-15 | `ADM-1` | | Create services, including `SVC-SENS` with a neutral display name | Neutral name is required where a service name reveals a condition; patient-visible name is the neutral one everywhere (TC-NT-01) | P0 | SEC | AUTO |
| TC-AD-03 | RA-R1-15, D-3 | `ADM-1` | | Set booking policy to block-only; try to set a fee | Block-only works. Fee/price fields are stored but nothing is charged in R1 (D-3 default). Rerun if D-3 changes | P1 | P | AUTO |
| TC-AD-04 | RA-R1-15 | `ADM-1` | | Edit message templates | Template variables restricted to the allowlist; a template with a free-text binding is rejected | P0 | N, SEC | AUTO |
| TC-AD-05 | RA-R1-15 | `ADM-1` | | Create a role and assign it | Needs the second approver (C4); no role is effective before approval | P0 | SEC | AUTO |
| TC-AD-06 | RA-R1-15 | `STF-FD-A` | | Open admin routes | Refused | P0 | N | AUTO |
| TC-AD-07 | BR-04 | `ADM-1` | | Set the future-appointment cap; test at the boundary | Cap applied (TC-BK-07) | P2 | B | AUTO |
| TC-AD-08 | RA-R1-26, F-AD-11 | `ADM-1` | Feature flag per location | Turn a flag on for LOC-A1 only | Behaviour appears at LOC-A1 and not LOC-B1; audited | P2 | P | AUTO |
| TC-AD-09 | RA-R1-26 | `ADM-1` | | Post a maintenance banner and remove it | Visible on all hosts, no PHI, removed cleanly | P3 | P | AUTO |
| TC-AD-10 | RA-R1-26 | `ADM-1` | | Change flags without elevation | Refused (C1) | P0 | N | AUTO |
| TC-AD-11 | RA-R1-31 | `ADM-1` | Sandboxes: Google, email, SMS, push, analytics | For each integration: save, test, view health | Health shows OK/failed correctly with a real failure injected | P1 | P, E | AUTO |
| TC-AD-12 | RA-R1-31, BD-11 | `ADM-1` | | Save a secret, then look for it in UI, API responses, logs, exports, audit | Secrets are write-only: never displayed, logged or exported. Audit has version IDs only | P0 | SEC | AUTO |
| TC-AD-13 | RA-R1-31 | `ADM-1` | | Change an integration setting | Audit: who, what, before, after (secret fields as version ID) | P0 | SEC | AUTO |
| TC-AD-14 | RA-R1-31, BD-11 O-2 | `ADM-1` | Admin-entered integration secret | Compromised-`api` scenario: write an approval row and enqueue a job directly | The worker-side check refuses without approval evidence the `api` alone cannot produce | P0 | SEC | AUTO |
| TC-AD-15 | RA-R1-31 | `ADM-1` | | Disable an integration | Dependent features fail visibly, not silently | P1 | E | AUTO |

### 10.2 Brand site (RA-R1-16, 26; F-BS-01..07)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-BS-01 | RA-R1-16 | `VIS-01` | | Open services, doctors (with next available slot), locations, contact | Pages exist and are correct. Next available slot may be up to 60 s old | P1 | P | AUTO |
| TC-BS-02 | RA-R1-16, J-01 | `VIS-01` | | Click "Book" from a doctor page | Hand-off to `my.` with service and doctor pre-selected; if not signed in, sign-in first | P1 | P | AUTO |
| TC-BS-03 | RA-R1-16 | `STF-MKT` | | Edit a page in the CMS and publish | Change goes live without a developer; marketing user cannot reach patient data | P1 | P, N | AUTO+H |
| TC-BS-04 | RA-R1-16 | | | Inspect analytics payloads | No health data in analytics events | P0 | SEC | AUTO |
| TC-BS-05 | RA-R1-16 | | | Check SEO metadata, sitemap, structured data | Present and valid | P2 | P | AUTO |
| TC-BS-06 | NFR-17 | | Public forms | Spam submission, rate limit, bot protection | Protected | P1 | SEC | AUTO |
| TC-BS-07 | F-BS-06 | | | English only until D-9 | No broken language switch | P3 | P | AUTO |
| TC-BS-08 | RA-R1-26, F-BS-07 | `VIS-01` | Cookie banner | 1. Before consent: observe network<br>2. Accept analytics | Before consent: no non-essential analytics requests. After: allowed. Choice remembered | P1 | P | AUTO |

### 10.3 Patient portal profile, proxy and pre-visit (RA-R1-19, 20, 21)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-PP-01 | RA-R1-19 | `PAT-01` | | Edit demographics, emergency contact, insurance card, preferred pharmacy and language | Changes visible and audited | P1 | P | AUTO |
| TC-PP-02 | RA-R1-19 | `PAT-01` | | Invalid input (dates in future, long strings, scripts from `SEED-ATTACK`) | Rejected or safely escaped; no stored script | P1 | N, SEC | AUTO |
| TC-PP-03 | RA-R1-20a | `PRX-01` | `PAT-03` | Default proxy view | Appointments only (see TC-AZ-14) | P0 | P | AUTO |
| TC-PP-04 | J-03 | `PRX-01` | | Request a proxy link | Request recorded; link needs verification (TC-PP-05 rules) | P1 | P | AUTO |
| TC-PP-05 | RA-R1-20b, AC-32 | `PRX-01` | `PAT-03` turns the age of consent | Age-out and revocation | **`BLOCKED` on D-7 / G-07**: rule values do not exist yet. Written when values are decided | P1 | E | BLOCKED |
| TC-PP-06 | RA-R1-21 | `PAT-01` | **[G2 setting]** 72 h before | Receive the request; complete the questionnaire; e-sign consents; upload insurance cards | Staff see completion status; consent versions stored with date | P1 | P | AUTO |
| TC-PP-07 | RA-R1-21 | `PAT-01` | Partial completion | Leave incomplete and check the staff view | Staff see "incomplete" and which items | P2 | P | AUTO |

### 10.4 Staff messaging and tasks (RA-R1-25)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-MSG-01 | RA-R1-25, F-DR-12 | `STF-DR-A1`, `STF-FD-A` | | Create a task; send a secure message | Delivered in the alert/task area; audited; no PHI in any email/SMS notice about it | P1 | P | AUTO |
| TC-MSG-02 | RA-R1-25 | Staff outside the org | | Send to a user in `ORG-2` | Refused | P0 | N | AUTO |
| TC-MSG-03 | RA-R1-25, D-5 | `PAT-01` | | Patient messaging | Tested only if D-5 retains F-PP-09. Otherwise the case is `N/A` and recorded as such | P2 | P | AUTO |
| TC-MSG-04 | RA-R1-25 | | `SEED-ATTACK` in a message | Open it | Script not executed; stored safely | P1 | SEC | AUTO |

### 10.5 Duplicate detection and merge (RA-R1-27, BR-37; HEAAA-12 9.2)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-MG-01 | RA-R1-27 | `STF-FD-A` | `SEED-DUP` | Register a patient with matching name, DOB and phone/email | Duplicate warning shown; user can proceed or cancel; the matching function returns no out-of-scope demographics | P0 | S | AUTO |
| TC-MG-02 | RA-R1-27, BQ-3 | `STF-MRO-A` | `SEED-DUP` | Request a merge of `PAT-04` into `PAT-05`; approve per the approval rule | After approval: survivor's chart shows both histories; merge audited with both IDs and counts | P0 | S | AUTO |
| TC-MG-03 | RA-R1-27 | `STF-FD-A` without `patient.merge` | | Request a merge | Refused | P0 | N | AUTO |
| TC-MG-04 | 9.2 | Requester sees only one patient | Patients cared for at different locations | Merge | Whole merge completes; all rows of both patients handled (the job runs with the exact patient IDs, not the requester's scope) | P0 | S | AUTO |
| TC-MG-05 | 9.2 | | Immutable rows | After merge, staff of the survivor open a signed note of the merged ID | Visible; original `patient_id` retained | P0 | S | AUTO |
| TC-MG-06 | 9.2 | | Force a failure in one participant | Run a merge | Everything rolls back; no partial merge; operations alert; request `failed` | P0 | E | AUTO |
| TC-MG-07 | 9.2 | Stale staff session and stale patient portal session | | Write against the merged ID after the merge | `409 patient.merged`; nothing written | P0 | X | AUTO |
| TC-MG-08 | 9.2 | | Hold racing the merge, both orders | Run both orders | Hold first: counted and re-pointed. Merge first: hold refused and its occupancy rolled back. Never an orphan on the merged ID | P0 | X | AUTO |
| TC-MG-09 | 9.2 | | Note insert racing the merge | Both orders | Same as above | P0 | X | AUTO |
| TC-MG-10 | 9.2 | | Queued job with the merged ID | One `resolve` type, one `fail` type | Each behaves as declared; undeclared job type fails the CI check | P0 | E | AUTO |
| TC-MG-11 | 9.2 | | Addendum to a signed note of a merged ID | Create | Carries the survivor's ID and refers to its parent | P0 | S | AUTO |
| TC-MG-12 | 9.2 | | Request whose patient was merged meanwhile; two merges sharing a patient | Run at once | `patient.already_merged`; no deadlock | P0 | X | AUTO |
| TC-MG-13 | 6.6, 6.8 | | Chained merge A→B then B→C; booking at a new location; ending a relationship | Run | C's staff see A's immutable rows; new location sees merged history; ending a relationship removes the merged-ID rows at that location | P0 | S | AUTO |
| TC-MG-14 | 9.2 time bound | | Chart of 10× the largest expected size | Merge | Completes inside the 60 s transaction bound or rolls back completely and is reported; writer wait time recorded | P1 | L | AUTO |

### 10.6 API conventions (HEAAA-12 5.2) — cross-cutting

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-API-01 | CN-03 | Any | | Trigger validation, auth and server errors on each module | `application/problem+json` with stable `code`, `status`, `title`, `requestId`; **no PHI in any error field**; validation errors list paths, not values | P0 | SEC | AUTO |
| TC-API-02 | CN-04 | | | `401` without session; `403 auth.forbidden` with session but no right; `404` for out of scope | Status codes as stated | P0 | N | AUTO |
| TC-API-03 | CN-05 | | | Search for a patient by name/DOB; inspect URLs and logs | Searches are `POST …/search`; no PHI in any path or query | P0 | SEC | AUTO |
| TC-API-04 | CN-07 | | | Update without `If-Match`, with a stale one | `428/412` per design; no silent overwrite | P1 | N | AUTO |
| TC-API-05 | CN-08 | | | `limit=1000`, tampered cursor, offset parameter | Limit capped at 100; tampered cursor refused; no offset pagination on PHI lists | P1 | B | AUTO |
| TC-API-06 | CN-10 | | | Check headers | `Cache-Control: no-store` on every `/api/*` and `/partner/*` response | P0 | SEC | AUTO |
| TC-API-07 | CN-11 | | | Exceed limits per principal and per IP | `429` with `Retry-After` | P1 | SEC | AUTO |
| TC-API-08 | CN-12 | | | 1 MB+ JSON body; unknown JSON fields on portal and `integrations.` | Large body refused; unknown fields ignored on portals, rejected on `integrations.` | P1 | B | AUTO |
| TC-API-09 | CN-01 | | | Compare each module's OpenAPI document with actual behaviour (contract test) | Responses match the contract for every R1 endpoint; no undocumented endpoints | P1 | P | AUTO |
| TC-API-10 | CN-13 | | | Follow one `requestId` | It appears in the response header, log, trace and audit event | P2 | P | AUTO |
| TC-API-11 | 8.2 | | Outbox | Kill the worker mid-job; restart | Job retried exactly once in effect (idempotent); exhausted jobs go to the dead-letter view | P1 | E | AUTO |

## 11. Non-functional cases

### 11.1 Accessibility (NFR-10, WCAG 2.2 AA) and browsers (NFR-11)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-A11Y-01 | NFR-10 | QA | Every portal and the brand site, each key page in the R1 journeys | Run the automated accessibility scan (tool and version recorded) | No WCAG 2.2 AA violations of serious/critical impact; known exceptions listed with reason and owner | P1 | A11Y | AUTO |
| TC-A11Y-02 | NFR-10 | Human tester | `ENV-A11Y` | Keyboard only: complete sign-in, booking, check-in, note writing, admin role request | Everything reachable and operable; visible focus; no keyboard trap; logical order; the session-timeout warning is operable | P1 | A11Y | HUMAN |
| TC-A11Y-03 | NFR-10 | Human tester using a screen reader (NVDA/JAWS on Windows, VoiceOver on macOS and iOS) | | Complete booking and the patient banner reading (BR-34) | Labels, roles, errors, live regions announce correctly; banner (name, DOB) is announced on chart screens | P1 | A11Y | HUMAN |
| TC-A11Y-04 | NFR-10 | Human | 200% zoom and 400% reflow; 360 px width | Complete booking and a triage entry | No loss of content or function; no horizontal scroll at 360 px | P1 | A11Y | AUTO+H |
| TC-A11Y-05 | NFR-10 | Human | | Contrast, colour-only meaning (vitals highlight, alert severities), reduced motion, text spacing | Highlights have a non-colour cue; contrast passes | P1 | A11Y | AUTO+H |
| TC-A11Y-06 | NFR-10 | | Forms and errors | Submit invalid forms | Errors linked to fields, announced, no PHI in the message | P1 | A11Y | AUTO+H |
| TC-A11Y-07 | NFR-10 | | Safety alerts | The red-flag alert and emergency advice | Perceivable with a screen reader and without colour or sound | P0 | A11Y, S | HUMAN |
| TC-A11Y-08 | NFR-10 | | Accessible name for the video join controls and waiting room | Complete TC-TH-01 with a screen reader | Operable | P2 | A11Y | HUMAN |
| TC-XB-01 | NFR-11 | QA | Current Chrome, Safari, Edge, Firefox | Run the booking, check-in, note, admin smoke journey on each | Same results on all four | P1 | P | AUTO |
| TC-XB-02 | NFR-11 | | Phones from 360 px; tablet | Same on iOS Safari and Android Chrome real devices | Usable; no layout break | P1 | P | AUTO+H |
| TC-XB-03 | NFR-11 | | Reverse: an unsupported old browser | Open `my.` | Clear unsupported message; no data corruption | P3 | N | AUTO |

### 11.2 Performance and load (NFR-6..9) — `ENV-LOAD`

Load results are valid only on `ENV-LOAD` (DEP-14) at ≥ 100% of the stated values, with headroom 2× sustained and 3× burst (ARCHITECTURE section 9). The tool, its version, the script revision, the candidate commit and the infrastructure sizing are recorded with every run. If `ENV-LOAD` is not provisioned the cases are `Blocked`; they are never run on a smaller system and reported as a pass.

| ID | Req | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-PERF-01 | NFR-6, NFR-9 | `VOL-1` | Mixed workload at peak: about 8,000 appointments/day equivalent, 1,000 staff sessions, normal reads and writes | API p95 < 500 ms; error rate within the agreed budget; no audit loss | P0 | L | AUTO |
| TC-PERF-02 | NFR-8 | `VOL-1`, all locations | Slot search across all locations at peak and 2× | p95 < 1 s | P0 | L | AUTO |
| TC-PERF-03 | HEAAA-12 6.8 | `VOL-2` | RLS probe on every PHI table under the `google` policy; patient and system audiences; audit inserts; merge write guard on the booking and note paths — at 2× sustained and 3× burst | Targets from TC-PERF-01 hold. If not, the fix is an index or a simpler policy, never dropping RLS | P0 | L | AUTO |
| TC-PERF-04 | NFR-13 | `VOL-1` | About 2 million chart-view audit events/day equivalent | All recorded; commit lag below the anchoring watermark (2 minutes); queries stay in budget | P0 | L | AUTO |
| TC-PERF-05 | NFR-7 | Production-like build; 4G profile | Measure LCP on the top pages: lab, then field once available | LCP < 2.5 s | P1 | L | AUTO |
| TC-PERF-06 | RA-R1-10, NFR-9 | 250 concurrent video visits at headroom (vendor load/sandbox limits known) | Run join and signalling at peak | Sustained; join success meets target; vendor limits and costs documented. If the vendor sandbox cannot do this, the case is `Blocked` with the vendor named | P0 | L | AUTO (needs vendor sandbox) |
| TC-PERF-07 | RA-R1-03 | `VOL-3` | TC-BK-13..15 under background load | Same exact-one result | P0 | L, X | AUTO |
| TC-PERF-08 | NFR-9 | | Soak for several hours at 1× and a burst at 3× | No leaks, no queue growth; the autoscaling and queue back-pressure behave as designed | P1 | L | AUTO |

### 11.3 Resilience, recovery and operations (NFR-1..5, 20, 21)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-REC-01 | NFR-2 | DevOps | `ENV-DR` | Restore the database from backup to a point in time; compare with the source's last writes | Recovered data is within 15 minutes of the failure point (RPO) | P0 | E | OPS |
| TC-REC-02 | NFR-3 | DevOps | `ENV-DR` | Timed restore of the database, documents, audit archive, identity, keys, secrets, images, DNS/CDN, jobs and integrations per component | Whole system serves again within 4 hours (RTO), per component steps in DEVOPS-PLAN | P0 | E | OPS |
| TC-REC-03 | NFR-2, 3, D-26 | DevOps | Region loss simulated | Fail over to the second region | RPO ≤ 15 min and RTO ≤ 4 h hold, unless the owner has decided otherwise. Sign-in and sessions after failover (patient/partner pools, admin pool, staff) verified | P0 | E | OPS |
| TC-REC-04 | NFR-5 | DevOps | Release rehearsal | Deploy with a database migration under load; then roll back | Zero downtime; rollback works for the application; the migration plan states what cannot be reversed | P0 | E | OPS + AUTO |
| TC-REC-05 | NFR-3, DEP-16 | DevOps | `ENV-DR` | During TC-REC-03: admin sign-in and elevation; TC-SEC-25 | Recorded outcome | P1 | E | OPS |
| TC-REC-06 | NFR-21, BR-33 | QA | Block each external service in turn: Google, SMS, email, video, malware scanner, directory | Run the matching journey | Timeout and back-off retry; failure visible on the operations dashboard; no silent drop; inbound messages idempotent | P0 | E | AUTO |
| TC-REC-07 | NFR-1 | QA/DevOps | Primary DB failure | Stop the primary during load | Standby takes over; clients retry; no committed data lost; brief errors only | P0 | E | OPS + AUTO |
| TC-REC-08 | NFR-20 | DevOps | Alert rules | Trigger uptime, error rate, latency, queue backlog, integration failure | Each alert reaches a **named on-call person** (DEP-15). If there is no named rota the case fails | P0 | E | OPS + HUMAN (the on-call person confirms receipt) |
| TC-REC-09 | 8.2 | QA | Worker crash with a backlog | Kill and restart | No lost or duplicate effects | P1 | E | AUTO |

### 11.4 Security and compliance NFRs (NFR-12..19)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-NFR-01 | NFR-12 | QA | Each host | TLS scan | TLS 1.2+ only; strong ciphers; HSTS | P0 | SEC | AUTO |
| TC-NFR-02 | NFR-12 | DevOps | | Review encryption at rest configuration and key rotation | Databases, object storage, backups, queues encrypted; managed key rotation enabled and evidenced | P0 | SEC | OPS |
| TC-NFR-03 | NFR-15 | CI | Candidate commit | Run SAST | Report is non-empty, for the right commit, with no open blocking finding. Tool and version recorded | P0 | SEC | AUTO |
| TC-NFR-04 | NFR-15 | CI | | Dependency scan | Same | P0 | SEC | AUTO |
| TC-NFR-05 | NFR-15 | CI | | Secret scan (history and working tree) | No secrets | P0 | SEC | AUTO |
| TC-NFR-06 | NFR-15 | CI | | Container image scan | No unwaived high/critical | P0 | SEC | AUTO |
| TC-NFR-07 | NFR-15 | CI | | Introduce a deliberate blocking finding on a throwaway branch | The build fails. Proves the gate works, not only that it is configured | P0 | SEC | AUTO |
| TC-NFR-08 | NFR-14 | Security Reviewer | | ASVS L2 checklist; L3 for authentication, prescribing and payment paths (R1: authentication) | Checklist complete, evidence per item | P0 | SEC | HUMAN (Security Reviewer) + AUTO |
| TC-NFR-09 | BR-35 | QA | | Scan seed and fixture files for real-identifier patterns; confirm no production data is in non-production | None found | P0 | SEC | AUTO |
| TC-NFR-10 | NFR-18, BR-36 | QA | Logs after all journeys | Scan logs, traces, error pages and analytics for names, DOB, phone, email, diagnoses, medicines, test names | None found | P0 | SEC | AUTO |
| TC-NFR-11 | NFR-19 | Owner/DevOps | | Show the signed BAA with the hosting provider and every vendor that touches health data | On file before go-live; US region. QA reads the evidence; it does not judge legal sufficiency | P0 | SEC | HUMAN |
| TC-NFR-12 | NFR-17 | QA | Public forms | Rate limit, bot protection, upload scanning (TC-BS-06, TC-DOC-03) | Hold | P1 | SEC | AUTO |
| TC-PEN-01 | NFR-16 | Independent tester | Candidate with the external surface | Independent penetration test before the production release | Report with no open high/critical findings. The independent tester is named. Absence of one is recorded, not waived (RA-R1-18) | P0 | SEC | HUMAN |
| TC-NFR-13 | RA-R1-18 | Owner | A claimed exception | Check the exception record | Only for allowed NFRs (NFR-1..11, 20..22); never NFR-12..19, safety rules or legal requirements. Written, with reason, compensating control, expiry, and the independent reviewer's acknowledgement — or, with no independent reviewer, recorded as **self-granted by the owner** | P0 | SEC | HUMAN |

## 12. Human-required register (all `Pending-human`)

These cases need a real person or an operations exercise. They stay **pending** until that person performs them. QA records the person's identity, the date and the evidence they supply, and never fills in a result for them. A written case is not an executed case.

| Person / role | Cases | What they must do |
| --- | --- | --- |
| Owner (product owner, Zain Naeem holds every gate role, PRD RK-5) | TC-SAF-07, TC-NFR-11, TC-NFR-13, TC-ID-07 (evidence) | Decide the R1 safety reviewer (D-12a), produce the BAA evidence, grant or refuse any NFR exception, provide the Workspace policy export |
| Licensed clinician (not yet named, D-12) | TC-SAF-07, TC-SAF-02 (timing), TC-CL-09 | Review the R1 safety rules and test results; judge wrong-patient risk. **If none exists, the PRD interim self-review route applies and is reported as self-review** |
| Accessibility tester with assistive technology | TC-A11Y-02, 03, 07, 08 (and the human part of 04, 05, 06) | Keyboard and screen-reader runs on real devices |
| Device testers | TC-ID-03, TC-ID-04, TC-ID-05, TC-PC-02, TC-TH-01, TC-XB-02, TC-NT-03 | Passkey/security key, 2SV on a real device, phone camera QR, audio and video, three calendar clients |
| Two named people (dual control) | TC-SEC-03 (physical key), TC-SEC-05, TC-SEC-11, TC-SEC-16, TC-SEC-23 | Bootstrap and enrolment under dual control; timed deprovisioning |
| DevOps / operations owner | TC-SEC-17, TC-SEC-19, TC-SEC-25, TC-AU-09, TC-NFR-02, TC-REC-01..05, TC-REC-07, TC-REC-08 | Restore tests, DR drill, policy exports, alert test with a named on-call person |
| Security Reviewer / Cybersecurity | TC-SEC-24, TC-NFR-08 | ASVS checklist and the path B spike review |
| Independent penetration tester | TC-PEN-01 | Independent test before the production release |
| Marketing user | TC-BS-03 | Edit and publish without developer help |
| Compliance officer | TC-PR-05, TC-AZ-11 | Real review decisions |

## 13. Blocked cases and open decisions

A blocked case is not waived. It keeps its criterion open until the decision exists.

| Decision | Blocks | State |
| --- | --- | --- |
| D-12a R1 safety reviewer (named clinician or recorded interim self-review) | RA-R1-07, RA-R1-08 acceptance (TC-SAF-01..07) | Open. R1 cannot go live without it |
| D-7 / G-07 proxy rules (age of consent, link, revocation) | RA-R1-20b (TC-PP-05) | Default applies to RA-R1-20a only |
| D-8 meaning of deletion | Deletion part of RA-R1-14 (TC-PR-03) | Open |
| D-2 operating states | Real state values in TC-TH-06..08; state privacy rules | Placeholder states used meanwhile |
| D-3, D-4, D-6, D-5 | TC-AD-03, TC-PC-11, visit summary (not built in R1), TC-MSG-03 | PRD defaults tested; rerun if changed |
| D-35 admin path | Path A or B tags in section 5 | **Path B in effect by default.** Rerun the A-only cases if the owner picks path A |
| G-10 assistant scope | TC-AZ-15 (prepare scope) | Refusal part testable now |
| BQ-1..BQ-4 (PM) | TC-AZ-04, TC-NT-01 (clinician name), TC-MG-02 (who merges and approves), attach rule | PM answers needed before G2 |
| BQ-3 roles with `patient.merge` | TC-MG-02..03 | Proposal only |
| D-26 region loss in scope | TC-REC-03 | Default in scope |
| D-25 / DEP-14 load environment | TC-PERF-* | Not provisioned; owner cost position |
| DEP-15 named on-call | TC-REC-08 | Open |
| Retention period (set at G2) | TC-AU-09, TC-DOC-07 | Open |
| UMLS licence account | TC-CL-04 (coded entry with a real terminology) | Open (HEAAA-12 UMLS) |
| Sandboxes: Google Workspace test tenant (with an admin OU and Directory API), email/SMS, video vendor | Many AUTO cases | Not confirmed to exist. A case that needs one stays blocked rather than being mocked |

## 14. R2 and R3 outline (reserved IDs; detail after the contracts exist)

These cases are written now only as outlines so that the R1 data model, audit and scope design do not make them hard to test later. They are not part of the R1 acceptance and will be expanded, reviewed and added to the plan when R2 and R3 enter the build.

| Reserved IDs | Release | PRD rows / AC | Intent |
| --- | --- | --- | --- |
| TC-RX-01..n | R2 | RA-R2-01, AC-13, AC-14; BR-15, BR-16 | Allergy, interaction, duplicate-therapy and dose checks per prescription against the certified vendor's real sandbox; override reasons; 100% coverage report; `uncoded` acknowledgement |
| TC-EPCS-01..n | R2 | RA-R2-02, AC-15, AC-16; BR-17 | Identity proofing missing refused; two-factor signing; assistant refused; EPCS audit report. Needs the vendor's real EPCS sandbox |
| TC-NET-01..n | R2 | RA-R2-03, 04; AC-17, AC-38; X-09 | Send through the certified network; network down leaves `Signed`, never `Sent`; retry visible |
| TC-PH-01..n | R2 | RA-R2-05..07, 10; AC-18..22 | Partner pharmacy isolation by pharmacy organisation; reject/query; refill routing; controlled-substance hand-over needs ID check; onboarding; partner realm MFA |
| TC-ACK-01..n | R2 | RA-R2-08, AC-19; BR-20 | Unacknowledged prescription alerts. Blocked on D-10 (meaning of acknowledged) |
| TC-PAY-01..n | R2 | RA-R2-09, AC-37; BR-30, BR-31 | Hosted fields/tokens; no card data stored or logged; refund approval above the threshold |
| TC-HR-01..n | R2 | RA-R2-11, F-PP-10 | Health record view |
| TC-DLV-01..n | R3 | RA-R3-01, AC-23..25; BR-24 | Delivery status by portal and API/webhook; duplicate and out-of-order events never move a delivery backwards |
| TC-LAB-01..n | R3 | RA-R3-02..06, AC-26..29; BR-25..27 | Order to result; unmatched result to reconciliation; normal vs abnormal release; critical-result escalation (window blocked on D-11); sample labels |
| TC-SEC-R2-01..n | R2 | C4 extension | Billing-admin role in the C4 rules; approver-set change checks |

## 15. Requirement-to-case matrix

### 15.1 Release acceptance rows (R1)

| PRD row | Cases | Blocked / pending parts |
| --- | --- | --- |
| RA-R1-01 | TC-ID-01..12 | TC-ID-07 evidence is OPS; D-12 interim only |
| RA-R1-02 | TC-BK-01..12 | |
| RA-R1-03 | TC-BK-13..18, TC-PERF-07 | |
| RA-R1-04 | TC-CAL-01..06 | Real Google test tenant needed |
| RA-R1-05 | TC-NT-01..08 | TC-NT-03 human |
| RA-R1-06 | TC-PC-01..09 | |
| RA-R1-07 | TC-SAF-01..04 | **Blocked until D-12a** |
| RA-R1-08 | TC-SAF-05..07 | **Blocked until D-12a** |
| RA-R1-09 | TC-CL-01..07 | |
| RA-R1-10 | TC-TH-01..05, TC-PERF-06 | Video vendor sandbox |
| RA-R1-11 | TC-AU-01..04, TC-AZ-10, TC-AZ-11 | |
| RA-R1-12 | TC-AU-05..10 | Retention set at G2 |
| RA-R1-13 | TC-DOC-01..08 | |
| RA-R1-14 | TC-PR-01..05 | **Deletion meaning blocked on D-8** |
| RA-R1-15 | TC-AD-01..07 | D-3 default |
| RA-R1-16 | TC-BS-01..07 | |
| RA-R1-17 | TC-AZ-01..15, TC-SEC-C7-01..07 | |
| RA-R1-18 | TC-PERF-01..08, TC-A11Y-01..08, TC-XB-01..03, TC-REC-01..09, TC-NFR-01..13, TC-PEN-01 | Load environment, penetration tester |
| RA-R1-19 | TC-PP-01..02 | |
| RA-R1-20a | TC-PP-03, TC-AZ-14 | |
| RA-R1-20b | TC-PP-04, TC-PP-05 | **Blocked on D-7** |
| RA-R1-21 | TC-PP-06..07 | |
| RA-R1-22 | TC-BK-19..22 | |
| RA-R1-23 | TC-DR-01..03 | |
| RA-R1-24 | TC-CL-08..09, TC-PC-07 | |
| RA-R1-25 | TC-MSG-01..04 | D-5 |
| RA-R1-26 | TC-AD-08..10, TC-BS-08 | |
| RA-R1-27 | TC-MG-01..14 | BQ-3 |
| RA-R1-28 | TC-TH-06..08 | Real states from D-2 |
| RA-R1-29 | TC-PC-10 | |
| RA-R1-30 | TC-PC-11..12 | |
| RA-R1-31 | TC-AD-11..15 | Sandboxes |
| RA-R1-32 | TC-SEC-01..25, TC-SEC-C7-01..07, TC-AD-05, TC-AD-10 | Path tags |

### 15.2 BA acceptance examples (AC)

| AC | Case | AC | Case |
| --- | --- | --- | --- |
| AC-01 | TC-BK-01, TC-CAL-01 | AC-02 | TC-BK-03 |
| AC-03 | TC-BK-08, TC-BK-16 | AC-04 | TC-BK-05 |
| AC-05 | TC-BK-19 | AC-06 | TC-NT-02 |
| AC-07 | TC-SAF-05, 06 | AC-08 | TC-SAF-01 |
| AC-09 | TC-PC-04 | AC-10 | TC-CL-02 |
| AC-11 | TC-CL-03 | AC-12 | TC-AZ-10 |
| AC-13..AC-29 | R2/R3 (section 14), except AC-26..29 R3 | AC-30 | TC-DOC-02 |
| AC-31 | TC-DOC-04 | AC-32 | TC-PP-05 (blocked) |
| AC-33 | TC-ID-09 | AC-34 | TC-AZ-01 |
| AC-35 | TC-AZ-02 | AC-36 | TC-AU-05 |
| AC-37, AC-38 | R2 (section 14) | | |

### 15.3 Safety-critical rules (PRD 7, 8.3) — R1 subset

| Rule | Cases |
| --- | --- |
| BR-09 | TC-SAF-05, 06, 07 |
| BR-10 | TC-SAF-01..04, 07 |
| BR-14 | TC-AZ-10, TC-AZ-11, TC-SAF-07 |
| BR-34 | TC-PC-07, TC-CL-08, TC-CL-09, TC-A11Y-03 |
| BR-37 | TC-MG-01..14, TC-SAF-07 |
| BR-15, 16, 17 (partly), 19, 20, 22, 24, 25, 26, 27 | R2/R3 (section 14). BR-17 re-authentication to sign is in TC-ID-08 |

Each has positive, negative and boundary cases as listed, and none can be waived by client acceptance.

## 16. Evidence and exit rules (for the later QA-REPORT)

1. A result identifies: case ID; candidate commit; configuration; environment; tool and version; assertion count; actual output; limitations; the executor (agent or named person) and the time.
2. Evidence is rejected when it is stale (older than the candidate), for the wrong revision, empty, skipped, malformed, a mock standing in for a required external service, or a tool badge without the report content.
3. Every failure becomes a finding with a stable ID, reproduction, severity, requirement, owner and acceptance, in the shared ledger. A fix needs an independent re-review and a rerun of the affected cases plus any case it could have affected.
4. **Acceptance cannot be proposed** while any P0 case is failed, skipped, blocked or pending without a recorded and valid reason. Required missing coverage is blocking. A client cannot accept it away.
5. Safety-critical, security, privacy and legal cases cannot be waived. The only NFR exceptions are the ones PRD RA-R1-18 allows, with the stated record.
6. Human-required cases are marked done only by the named person's recorded result.
7. The QA agent does not accept an implementation it authored, and does not approve any human gate.

## 17. Limitations, review state and next permitted action

**Limitations.**
- **Nothing has been executed.** No candidate exists. No test code, fixtures or generators were written, which is correct before valid G2.
- **Design inputs are incomplete.** HEAAA-13 (ERDs, API contracts, failure design), HEAAA-14 (screens) and HEAAA-16 (DEVOPS-PLAN: environments, CI, tools) were still in progress when this draft was written. Steps use PRD/boundary vocabulary. Names of screens, fields, endpoints, role lists, error codes beyond those in HEAAA-12, tools and environments must be re-bound at alignment (HEAAA-17), and this document revised and re-reviewed for the changed parts.
- **Path B is the default** (D-35) and path A is still possible. The cases are tagged; a change of path reopens the tagged cases.
- **HEAAA-12 section 7, 9.1 and 10** still need the Cybersecurity review. If it changes them, the section 5 cases and TC-AD-12/14 change with it.
- The load figures, thresholds and values marked **[G2 setting]** are PRD proposals; they become test values only when G2 decides them.
- Test automation tools (browser, API, load, accessibility, SAST, dependency, secret, container) are not chosen; DEVOPS-PLAN selects them. This plan names none.
- Third-party sandboxes (Google Workspace test tenant with Directory API access, SMS/email, video, malware scanning) are assumed to be needed and are not confirmed.
- Not legal or clinical advice. Rule text for safety-critical behaviour needs the licensed reviewer (D-12/D-12a).
- The seven SEC-D-19 conditions come from the Architecture text (C7 quoted from section 8.4). The Cybersecurity decision comment `e6414334` itself was not re-read for this draft; the Architecture's rendering of it is the source used.

**Review state.** Author: QA agent. Independent review: **not requested yet**; it needs a reviewer who is not the author, assigned by the Orchestrator. Review PASS would not be human approval.

**Cumulative review round for this artifact:** 0 of 3.

**Next permitted action.** The Orchestrator assigns an independent reviewer for the exact saved revision of this document. QA then revises on the reviewer's findings, and after HEAAA-13/14/16 align, re-binds names and values. The G2 package includes `TEST-CASES.md`; the human decision on the exact revision happens at G2. No test is executed before a candidate exists and valid G2 permits implementation.
