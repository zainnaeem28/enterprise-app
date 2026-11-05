# TEST-CASES — Enterprise EHR Platform (Stage 2 QA plan)

| Field | Value |
| --- | --- |
| Task | HEAAA-15 `[SDLC:qa-plan]` |
| Author | QA Engineer agent (`a2336f9b-c077-4b13-b5d3-393af748139b`) |
| Version | **Test cases draft 5, the single re-binding revision** (HEAAA-51; supersedes draft 4, `test-cases` rev `9d3f1ec1` = `docs/TEST-CASES.md` @ `39d881a`). Changes are limited to AL-05, AL-08 and SA-TC-06 plus the cases the Architect's banner/alert/release decisions require (section 20). Authority: human-accepted bounded cycle `a524dfdd` (HEAAA-17). Draft 4 history is kept in sections 18 and 19 |
| Status | **DRAFT 5. Awaiting independent review of the diff against draft 4 (Solution Architect `7efe9f61`, and Product Owner Reviewer `ba4f7e4a` for the new journey cases TC-PC-15, TC-PC-16, TC-CL-10, TC-API-10). Not human-approved. This is not G2.** Earlier review history: Product Owner Reviewer rounds 1–3 (CHANGES REQUIRED, CHANGES REQUIRED, PASS on draft 3); Solution Architect review of draft 3: CHANGES REQUIRED (SA-TC-01..05). Draft 4 was rechecked by the Solution Architect (SA-TC-01..05 closed; SA-TC-06 Low open, answered in draft 5). Nothing in this document has been executed. Every case is `Planned`. |
| Reviewer for this deliverable | Not the author. Product Owner Reviewer (AI) reviewed drafts 1–3 (rounds 1–3). Solution Architect (AI) reviewed draft 3 (`test-cases-sa-review` rev `41e7cd3f`). The Solution Architect rechecks only SA-TC-01..05 on draft 4 |
| Approved inputs (G1) | PRD revision 3: HEAAA-11 `prd` rev `bba336f3-e934-4dbb-9158-0909fda132d7` (`docs/PRD.md` @ `f8d3d6e`). ARCHITECTURE draft 4: HEAAA-11 `architecture` rev `f2d240e4-2f63-45a1-aaa1-16a1f8854c32` (`docs/ARCHITECTURE.md` @ `f8d3d6e`; HEAAA-41 rev `a29940b5`). Human acceptance of both on HEAAA-11, 2026-11-04 22:03Z |
| Design input | HEAAA-12 `shared-boundaries` rev `0fffc85d-c3cd-4bad-a7f3-4f774fbbbf5a` (draft 3; independent review PASS, `shared-boundaries-review` rev `80b898be`; sha256 of body `84ba3681…f680`). Cybersecurity review of its sections 7, 9.1 and 10 is still outstanding |
| Design inputs now bound (draft 5) | **ARCHITECTURE draft 8.1**: HEAAA-48 `architecture` rev `b276930a-20af-4433-a8f0-60843f5a3eaf` (`docs/ARCHITECTURE.md` @ `481f32a`; SA Reviewer PASS HEAAA-53). **UI-UX draft 6**: HEAAA-49 `ui-ux` rev `1fd76f7e-0356-46f9-bcd5-b94c5badf65e`, `mockup-manifest` rev `a0488c46` (HEAAA-57 review: CHANGES REQUIRED, Low only: UXR-09 residual, UXR-12a residual, UXR-13). **DEVOPS-PLAN draft 6**: HEAAA-50 `devops-plan` rev `3023afa1-5018-4f57-94c8-82a7a9703aa0` (`docs/DEVOPS-PLAN.md` @ `46781a0`; SA Reviewer PASS HEAAA-60; DevOps Reviewer HEAAA-61: DPR-36 PASS, DPR-35 residual DPR-37 Medium, DPR-38, DPR-39 open). None of the three is human-approved or frozen by the Orchestrator yet; QA binds to these exact revisions and rebinds if a later revision changes a name used here |
| Security routing carried | **SEC-D-19 condition C7** (ARCHITECTURE 8.4, ADR-011; Cybersecurity HEAAA-42 comment `e6414334`), see section 5. Also RA-R1-32 (C1, C4, C6) |

## 0. How to read this

**Release scope.** The cases cover R1 in full detail (target: production by end of May 2027). R2 and R3 are in section 14 as outline cases with reserved IDs. They are detailed at the milestone that builds them, because their contracts do not exist yet. R4 has no acceptance in the PRD and no cases.

**Decisions and defaults.** Where the PRD default applies unless the owner decides otherwise, the case tests the default and says so. Examples: D-3 block-only cancellation, D-4 no lab sample booking in R1, D-6 no patient visit summary in R1, D-7 proxy sees appointments only, and D-35 **path B** (separate admin pool) in effect. A case tagged `[G2 setting]` tests that the system follows the configured value. The PRD 7.2 proposals (10-minute hold, 48 h/4 h reminders, 15-minute idle timeout and so on) are provisional until G2. The expected results below use them as example values only.

**Blocked cases.** A case is `BLOCKED` when its decision is open (section 13). A blocked case is not skipped and not waived. It stays in the plan and blocks the criterion it covers.

**Execution status values.** `Planned` (written, not run), `Ready` (candidate, environment and data exist), `Passed`, `Failed`, `Blocked`, `Pending-human` (needs the named person; stays pending until that person performs it). This draft uses only `Planned`, `Blocked` and `Pending-human`.

**`PM-confirm`.** A case or expected value tagged `PM-confirm-n` rests on a rule the PRD does not state or marks as derived or recommended. The case is written so it can run, but the tagged assertion is **not asserted** until the PM (through the Orchestrator) answers; the list is in section 13. A test never decides scope.

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

### 0.3 Environments (bound to DEVOPS-PLAN draft 6 section 3.5, AL-05)

A result is valid only for the environment and candidate it names. **`ENV-INT` alone is no longer a valid binding** (DEVOPS-PLAN 3.5): every case names one of the sub-environments below. Nothing in this table is provisioned: DEVOPS-PLAN 3.5 is design, and no account, domain or vendor sandbox exists.

| ID | Bound to (DEVOPS-PLAN) | Data | Used for | Limits QA accepts |
| --- | --- | --- | --- | --- |
| `ENV-INT/ci` | `ci`: containerised PostgreSQL 17 with the roles created by the real migrations; API container and built portals | Synthetic, generated | Real database roles, RLS, trigger, grant, error-mapping and contract cases (TC-AU-*, TC-AZ-*, TC-API-09/10 PR run, TC-SEC-02 logic) | Not RDS. A case that depends on RDS behaviour (role-level `transaction_timeout`, DEVOPS-PLAN 5.2 **Unverified**) is rerun on `ENV-INT/staging` |
| `ENV-INT/staging` | `staging` (persistent, synthetic only), a **selected** candidate deployed by manual dispatch (DEVOPS-PLAN DPR-35, 4.2). Evidence is accepted only for the candidate commit named in the manifest | Synthetic only (BR-35) | Deployed-stack cases: SSE alert stream, document scan, Google Workspace **test tenant**, vendor sandboxes (TC-CAL-*, TC-SAF-*, TC-DOC-*, TC-API-01, TC-XB-*, fault injection) | Single-AZ database (failover not shown). Cases that need the test tenant or a vendor sandbox are `Blocked` until the owner creates them (DEVOPS-PLAN 3.5 table: tenant open, vendors not chosen, e-prescribing sandbox out of DevOps scope) |
| `ENV-INT/bootstrap` | A bootstrap rehearsal stack in the `staging` account, created from IaC and destroyed after (DEVOPS-PLAN 3.5, 16.2) | Synthetic persons and keys | TC-SEC-11 (first-admin bootstrap) | Needs two human custodians; with one it stays `Blocked` |
| `ENV-LOAD` | `loadtest` (DEVOPS-PLAN 3.4), production-equivalent. PRD DEP-14 | Generated synthetic volume (3.3) | NFR-6..9 load cases, with RLS and audit inserts on; generator **k6** | Not provisioned until the owner approves the cost (DEVOPS-PLAN 13.1): the cases are `Blocked`, never run smaller. k6 driving the SSE stream is **Unverified**; if it cannot, a small custom client is needed (DEVOPS-PLAN 14) |
| `ENV-DR` | The synthetic recovery-region rehearsal stack in `us-west-2`, in the `staging` account under the production SCP (DEVOPS-PLAN 3.5, 10.4). Region loss in scope unless D-26 says otherwise | Synthetic | TC-REC-03 and the timed rehearsal | **The monthly restore test of production backups runs in `restore-test` (PHI boundary) and is not `ENV-DR`.** QA does not receive its data. QA reviews only the PHI-free counts, hashes and timings in `OPERATIONS-HANDOFF.md` (case type `OPS`) |
| `ENV-A11Y` | `staging`, same build as `ENV-INT/staging` | Synthetic | Assistive-technology runs on real devices (section 11) | Real devices, extra browsers and screen readers (NVDA, JAWS, VoiceOver) are **not a DevOps provision**: QA and the owner. UX-O-08: no accessibility specialist named. TC-A11Y cases that need them stay `Pending-human` |

**Tools (DEVOPS-PLAN 5.1, 5.3, 14, AL-07).** Browser end-to-end and scripted API cases: **Playwright Test** (PR subset on `ci`, full `AUTO` suite on `staging`; Chromium, Firefox, WebKit builds only, so TC-XB-02 real devices stay with QA). API contract and negative cases: **Schemathesis** (never against production; not an authorised active security assessment). Load: **k6**. Accessibility: **`@axe-core/playwright`** and **Lighthouse CI** (automated only; the manual runs remain required). Static and supply-chain checks: Semgrep CE, OSV-Scanner, gitleaks, Trivy, Syft/cosign, OWASP ZAP baseline on `staging`. Versions are pinned at build; every result records the tool version. DEVOPS-PLAN selections are Recommendations until G2, and CodeQL, SonarQube, CodeRabbit and Strix are not selected (no QA case relies on them).

**Test domain and sandboxes.** Staff accounts live in a Google Workspace test tenant with its own domain, an admin OU and Directory API access (owner's Workspace administrator creates it; DEVOPS-PLAN 3.5). Email/SMS/video sandboxes and the e-prescribing sandbox are not provisioned. TC-ID-01, TC-ID-05, TC-CAL-*, TC-NT-*, TC-TH-*, TC-DOC-* cases that need a vendor and every R2 case that needs one stay `Blocked`, naming the missing sandbox. A mock never stands in for them.

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

Staff accounts live in a **Google Workspace test domain** that mirrors the production layout: a dedicated admin organisational unit (OU) with security-key-only 2-step verification, and ordinary staff OUs (C2). Names are synthetic. Patient and proxy accounts are in the patient pool; partner accounts (R2) in the partner pool. Realms follow HEAAA-12 7.1. **Role keys** are bound to ARCH 27.3 in section 20.2.

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
| `STF-BILL-A` | `google` / staff | Billing staff (A-13) | LOC-A1 | **No R1 role exists** (ARCH 27.3: billing and lab coordinator are R2/R3). Used only as a no-role principal in negative cases; QA-AL-02 |
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
| TC-ID-05 | RA-R1-01 | Staff | `STF-NO2SV` | Attempt sign-in | **Cannot sign in.** Refusal comes from the Workspace 2SV enforcement policy only. The `hd` and `email_verified` claims cannot detect missing 2SV, so a passing claim check is not evidence for this case. No session cookie is issued | P0 | N, SEC | AUTO+H |
| TC-ID-06 | RA-R1-01 | Staff | ID token for a user outside the allowed domain; ID token with `email_verified=false` | Replay each token against the callback | Both are refused. Nothing is written except a `denied` audit event | P0 | N, SEC | AUTO |
| TC-ID-07 | RA-R1-01 | Operations owner | Workspace policy export for staff OUs, dated within 30 days of the run | Read the export: 2SV required for every staff OU; security keys recommended for prescribers and admins | Export shows 2SV required on all staff OUs. The report states: *the platform cannot prove per sign-in which second factor was used* (SA-F-06) and does not claim to | P0 | SEC | OPS + HUMAN (owner/DevOps provides; QA reads) |
| TC-ID-08 | BR-17 (R1 part), RA-R1-01 | Staff | `STF-DR-A1` with a draft note | 1. Sign the note<br>2. Observe that re-authentication is demanded<br>3. Cancel the re-auth<br>4. Retry | Signing requires fresh re-authentication every time. Cancelling re-auth leaves the note unsigned and the draft intact | P0 | N | AUTO+H |
| TC-ID-09 | AC-33, X-20 | Staff | `STF-DR-A1`, idle timeout set to 15 min **[G2 setting]**; a draft note with unsaved text | 1. Type in the draft<br>2. Stay idle until just before the timeout<br>3. Act (still signed in)<br>4. Stay idle past the timeout<br>5. Act | Before the timeout the action works and the timer resets. After it, the action is refused and re-authentication is demanded. The draft text is preserved after re-auth. Server-side session is gone (a replayed cookie gets `401`) | P0 | B, E | AUTO |
| TC-ID-10 | HEAAA-12 5.1, CN-05 | Any | A signed-in session on each host | 1. Replay a `staff.` cookie against `my.` and `pharmacy.`<br>2. Replay a patient cookie against `staff.`<br>3. Check cookie attributes | Each session is bound to one audience; cross-use gets `401` or `403` (`auth.forbidden`). Cookies are `__Host-` prefixed, `Secure`, `HttpOnly`, `SameSite` set | P0 | N, SEC | AUTO |
| TC-ID-11 | NFR-14 (L3 for authentication) | Attacker | `my.` sign-in | 1. Brute-force with rate limit active<br>2. Try user enumeration by timing and message<br>3. Session fixation: reuse a pre-login cookie after login<br>4. CSRF on a state-changing POST without the token | Rate-limited. Messages identical for known and unknown accounts. Session ID changes at login. CSRF POST refused | P0 | SEC, N | AUTO (tool and version recorded) |
| TC-ID-12 | J-22, RA-R1-01 | Staff | Two browsers, same user | 1. Sign in on both<br>2. Sign out of one | The other session is not silently extended. Sign-out is server-side (a replayed cookie is refused). One session per browser on `staff.` | P1 | P, N | AUTO |

## 5. SEC-D-19 admin and compliance controls (RA-R1-32, condition C7)

**Source.** ARCHITECTURE draft 4 section 8.4 and ADR-011 (rev `f2d240e4`), conditions C1–C7: the architecture answers are in ARCHITECTURE section 8.4 (rev `f2d240e4`); the Cybersecurity conditions are in HEAAA-42 comment `e6414334` (re-read for draft 2, see 5.5). "Admin and compliance roles" means every role that can assign roles, change configuration or policy, read audit data, export data, or approve break-the-glass. The exact role list is fixed in HEAAA-13; until then the cases use `ADM-*` and `CMP-*`.

**Path.** D-35 defaults to **path B** (separate `admin_pool` realm, HEAAA-12 section 7). Path A (staff realm + C1–C3) is still possible: ARCHITECTURE 26 and 26.4 keep the identity design Provisional (SAR-15) and describe what changes under path A. Cases are tagged `A`, `B` or `A+B`. A case tagged `A+B` runs on whichever path is built and must pass on it. If the owner switches path, the tags tell QA which cases to rerun. Known wording gaps SA-F-18 (RA-R1-32 names C1 on either path; C1's Google-OIDC part exists only on path A) are handled by testing the **server-side elevation grant** on both paths and the Google forced-re-auth/`auth_time` check on path A only.

**Evidence rule.** PRD RA-R1-32: C1, C4, C6 evidence is a test run on the integrated candidate, not a design statement. C2, C3 evidence comes from operations (DEVOPS-PLAN) and QA checks it (TC-SEC-16, TC-SEC-17). The seven C7 cases are TC-SEC-C7-01..07 and are `P0`. Failure of any C7 case is a security blocker and may not be relabelled optional.

### 5.1 C1 — step-up and elevation grant

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-01 | C1, RA-R1-32 | `ADM-1` | Signed in, no elevation. A privileged routes marked † in ARCH 29.4 (assign role, change policy, read audit, export, approve BTG) | 1. Call each privileged action directly (API and UI) with the session only | Each is refused: `403 auth.forbidden` (reason: elevation required). Nothing is changed. A `denied` audit event exists per attempt with outcome and reason | P0 | N, SEC | A+B | AUTO |
| TC-SEC-02 | C1 | `ADM-1` | Elevation window configured (Setting `elevation_minutes`, proposed 15, ARCH 26.3); test clock control or a short configured window; **binding: `ENV-INT/ci`** (timing logic) and rerun on `ENV-INT/staging` for the real WebAuthn assertion | 1. Obtain a grant with a real WebAuthn assertion<br>2. Perform a privileged action at window − 1 min<br>3. Perform it at window + 1 min | Step 2 succeeds. Step 3 is refused with `403 identity.elevation_required` (ARCH 30). The grant is not extendable by activity alone | P0 | B, SEC | A+B | AUTO |
| TC-SEC-03 | C1 | `ADM-1` | App-enrolled WebAuthn credential (security key, user verification required) | 1. Start elevation<br>2. Answer the challenge with a key that **fails user verification**<br>3. Answer with a key that is not enrolled<br>4. Replay a previous assertion | All three refused; no grant issued. Challenge is single-use and expires | P0 | N, SEC | A+B | AUTO+H (a physical key is needed for the positive control) |
| TC-SEC-04 | C1 (Arch 8.4 C1: grant "bound to the session"; C4: approver is a different person) | `ADM-1`, `ADM-2` | Two sessions for `ADM-1` (S1, S2); one for `ADM-2` | 1. Elevate S1<br>2. Use S1's grant identifier on S2<br>3. Use it from `ADM-2`'s session | Grant is bound to the session. S2 and `ADM-2` are refused | P0 | N, SEC | A+B | AUTO |
| TC-SEC-05 | C1 (Arch 8.4 C1: "Enrolment itself needs a fresh Google sign-in plus the second approver (C4)") | `ADM-3` (new admin) | Admin role, no credential yet | 1. Try to enrol a credential by self-service<br>2. Try via a stale Google/staff session only<br>3. Enrol with the required fresh sign-in **and** second approver | Steps 1–2 refused. Step 3 succeeds and is audited with both people. Path B: enrolment only by single-use token (see TC-SEC-18) | P0 | N, SEC | A+B | AUTO+H |
| TC-SEC-06 | C1 (Google part) | `ADM-1` | Path A. HEAAA-13 spike result on forced re-authentication | 1. Elevate and capture the OIDC request: `prompt=login` and/or `max_age` present<br>2. Return an ID token with old `auth_time`<br>3. Return one with wrong `hd`<br>4. Return one with `email_verified=false` | Old `auth_time`, wrong `hd`, unverified email: each refused, no grant. If the spike showed Google does not honour forced re-auth or return `auth_time`, this case is replaced by "WebAuthn alone issues the grant and the Google check is absent", and QA records which branch was tested | P0 | N, SEC | A | AUTO (real Google test tenant; mocks do not count) |

### 5.2 C4 — second approver enforced in code

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-07 | C4 | `ADM-1` (requester), `ADM-2` (approver), `STF-FD-A` (subject) | Both admins eligible and elevated | 1. `ADM-1` requests the admin role for `STF-FD-A`<br>2. `ADM-2` approves | Role is assigned only after step 2. Audit has requester, approver, before/after role sets, outcome. Until step 2 the subject holds no admin role | P0 | P, SEC | A+B | AUTO |
| TC-SEC-08 | C4 | Approver conditions | Request pending from `ADM-1` for a subject | Try to approve as (a) the requester; (b) the subject; (c) an eligible admin **without** an active elevation; (d) a non-eligible staff member; (e) a compliance officer without the approver role; (f) the same human holding a second principal (path B: same `person_id`) | All refused. Only an eligible, elevated, different person succeeds. (f) is refused because the rule compares `person_id` | P0 | N, SEC | A+B | AUTO |
| TC-SEC-09 | C4 | `ADM-1`, `ADM-2` | Request expiry planning value 24 h; controllable clock | 1. Create a request<br>2. Approve at expiry − 1 min<br>3. Create another and approve at expiry + 1 min | Step 2 works. Step 3 refused; the request is `expired`; no role change. Expiry is audited | P0 | B | A+B | AUTO |
| TC-SEC-10 | C4 | `ADM-1`, `ADM-2` | Approver set = {`ADM-1`, `ADM-2`} | 1. Request removal of `ADM-2` from the approver set by `ADM-1`<br>2. Self-approve it<br>3. Approve with the other admin | The change to the approver set itself needs a different eligible person (steps 1–2 end in refusal, step 3 completes). Audited. (Billing-admin role: add the same checks in R2.) | P0 | N, SEC | A+B | AUTO |
| TC-SEC-11 | C4 bootstrap | DevOps + two humans | **`ENV-INT/bootstrap`**: the bootstrap rehearsal stack in the `staging` account (DEVOPS-PLAN 3.5, 16.2), synthetic persons and keys. One human custodian means this case stays `Blocked` | Follow the dual-controlled bootstrap runbook in DEVOPS-PLAN: create the first two admins. Then try to repeat the bootstrap | Exactly two admins created, both people recorded in the audit. After bootstrap the in-app rule applies and a second bootstrap is impossible without the runbook. No code path lets a single person create an admin | P0 | SEC | A+B | HUMAN (two real people) + QA reviews evidence |
| TC-SEC-12 | C4, C5 | `ADM-1`, `CMP-1` | Audit viewer | After TC-SEC-07..10, query audit for role-change events | Each event has requester, approver, before/after role sets, outcome. `config_change` events show who/what/before/after and **no secret values** (version IDs only). Events cannot be edited or deleted | P0 | SEC | A+B | AUTO |

### 5.3 C6 — kill switch and deprovisioning

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-13 | C6 | `ADM-1`, `ADM-2` | `ADM-3` has two active elevated sessions on two browsers | 1. `ADM-2` (elevated) uses the kill switch for `ADM-3`<br>2. `ADM-3` repeats a privileged action and a normal action from both browsers | Both sessions and the elevation are gone at once. Next request on each: `401`. Alert goes to compliance (`kill switch used`). Audit has `session_revoke` | P0 | SEC | A+B | AUTO |
| TC-SEC-14 | C6 | `ADM-3` | Same | Remove the admin role from `ADM-3` while elevated | Elevation ends immediately, not at expiry. Privileged action refused on the next call | P0 | SEC | A+B | AUTO |
| TC-SEC-15 | C6 | `ADM-3` | Simulate Google (path A) or the managed pool (path B) as unreachable (block the egress to it on **`ENV-INT/staging`**) | Use the kill switch | It works because sessions live in our database. Property 4 of HEAAA-12 7.5: effective at once, also with the identity provider down | P0 | E, SEC | A+B | AUTO |
| TC-SEC-16 | C6 | HR/DevOps + human | A leaver scenario for an admin test person | 1. Record a deprovisioning request with a timestamp<br>2. Run the deprovisioning runbook<br>3. Record completion time | Completed the **same business day** for admin/compliance roles (one business day for other staff). Elapsed time is a measured fact in the evidence, not a statement | P0 | SEC | A+B | HUMAN + OPS |

### 5.4 C2, C3, C5 and path B properties

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-17 | C2 evidence | DevOps owner | Admin OU policy export | Read the export | Security-key-only 2SV for the admin OU; no SMS/TOTP fallback; no recovery bypass. Dated. Quarterly repeat is scheduled. Workspace edition that allows this is named (it was **Unverified** in ARCHITECTURE C2) | P0 | SEC | A (B: advisable) | OPS + HUMAN |
| TC-SEC-18 | C2 app check | System | `STF-OUT-OU`, `STF-SUSP` | 1. On **`ENV-INT/staging`** (Workspace test tenant) move `STF-OUT-OU`'s holder out of the admin OU (or suspend `STF-SUSP`)<br>2. Wait for the hourly job (or read the last two run records)<br>3. Read the job run log and the staff alerts | This ID **owns the hourly re-check** (Arch 8.4 C2); TC-SEC-C7-04 owns only the assignment-time refusal. Job ran at least hourly in the observed window; the mismatch produced elevation removal, role suspension and a staff alert | P0 | SEC | A | AUTO |
| TC-SEC-19 | C3 evidence | Security owner | Super-admin inventory | Read: exactly two named super-admins, no shared accounts, security keys only; a sealed break-glass account that alerts on use; alerts on super-admin and OU/policy changes; last quarterly access review done by a non-super-admin | All present with dates | P0 | SEC | A | OPS + HUMAN |
| TC-SEC-20 | C5 | `ADM-1`, `CMP-1` | `SEED-CHART-1` | 1. As admin, open audit metadata<br>2. Try to read patient clinical data<br>3. Open a BTG with a reason<br>4. Run repeated exports to hit the limit | Admin sees audit metadata, no PHI by default. Clinical access only through BTG with reason; compliance alerted. Export rate limit enforced and alerted. Every config change audited | P0 | SEC | A+B | AUTO |
| TC-SEC-21 | Path B property 1–3 | Admin | `admin_pool` | 1. Look for any password, OTP or SMS sign-in on the admin route<br>2. Try the admin route with a `google` session<br>3. Try a clinical route with an `admin_pool` session<br>4. Try self-service recovery or profile change | None of the first-factor alternatives exists. Admin routes need realm `admin_pool`; clinical routes refuse it; `google` principal cannot reach admin routes. No self-recovery | P0 | N, SEC | B | AUTO |
| TC-SEC-22 | Path B rule 4, 7.2 | Admin | Same browser | Sign in as staff, then as admin | Changing realm needs sign-out and sign-in again. There are never two concurrent sessions in one browser on `staff.` | P1 | SEC | B | AUTO |
| TC-SEC-23 | Path B P-4 | `ADM-1`, `ADM-2`, new admin | Enrolment token (planning: single-use, at most 30 minutes, bound to one person, out-of-band) | 1. Create a token under dual control<br>2. Use it once<br>3. Use it a second time<br>4. Use it after 30 minutes<br>5. Use it as a different person | Only step 2 succeeds. 3–5 refused. All steps audited | P0 | B, SEC | B | AUTO |
| TC-SEC-24 | Path B 7.5 spike | Security reviewer | HEAAA-13 spike report P-1..P-7 | Read the spike report; check which fallback (F-1) is in the build; rerun TC-SEC-03, 21, 23 on that exact build | The build matches the recorded fallback decision, and Cybersecurity has reviewed the spike before the identity ERD freeze | P0 | SEC | B | HUMAN (Cybersecurity) + AUTO |
| TC-SEC-25 | Path B 7.4, DEP-16 | DevOps | `ENV-DR` | 1. Wait until the DR drill has failed over (TC-REC-03 is the owner of the drill)<br>2. Try admin sign-in in the recovery region<br>3. Try an elevation with the WebAuthn credential | Result recorded: works, or admins cannot elevate during failover and DEVOPS-PLAN accepts that within the 4 h RTO. Not assumed | P1 | E | B | OPS |

### 5.5 C7 — authorization tests (extend RA-R1-17, negative authorization)

**Source check (draft 2, TC-RV-01).** Two texts exist and they are not identical. Both were read for this draft.

1. **ARCHITECTURE section 8.4 table row C7, rev `f2d240e4` (quoted exactly):** "Authorization tests for: role elevation without an approver; self-approval; a stale `auth_time` or an expired elevation; an account outside the OU holding an admin role; a Workspace super-admin identity given an app admin role; a Workspace group change that does not grant a role; the kill switch ending an active elevated session. These extend RA-R1-17 (negative authorization)."
2. **Cybersecurity HEAAA-42 comment `e6414334`, condition 7 (quoted exactly):** "Tests: QA authorization tests must cover role elevation without approver, stale `auth_time`, non-OU account with admin role, and Workspace group change not granting roles."

The comment lists four tests. The Architecture list has seven. It adds three items: *self-approval* (comment condition 4: "cannot self-approve"), *super-admin given an app admin role* (condition 3) and *kill switch ending an elevated session* (condition 6). It also widens *stale `auth_time`* to *or an expired elevation* (condition 1: "short elevation window"). So the Architecture's items cover the comment's four, and every addition traces to conditions 1, 3, 4 or 6 of the same comment. **These cases use the seven Architecture items as the scope and name the comment condition behind each.** They are not "verbatim" the comment's condition 7.

| C7 item (Architecture 8.4) | Comment `e6414334` basis | Case |
| --- | --- | --- |
| Role elevation without an approver | cond. 4, cond. 7 | TC-SEC-C7-01 |
| Self-approval | cond. 4 | TC-SEC-C7-02 |
| Stale `auth_time` or expired elevation | cond. 1, cond. 7 | TC-SEC-C7-03 |
| Account outside the OU holding an admin role | cond. 2, cond. 7 | TC-SEC-C7-04 |
| Workspace super-admin given an app admin role | cond. 3 | TC-SEC-C7-05 |
| Workspace group change that does not grant a role | cond. 4, cond. 7 | TC-SEC-C7-06 |
| Kill switch ending an active elevated session | cond. 6 | TC-SEC-C7-07 |

**Wording of items 4–6 (checked).** Item 4 ("outside the OU") and item 5 ("super-admin") are written for path A, where admins are Google identities. On path B there is no Google admin identity, so TC-SEC-C7-04 and -05 test the path B equivalent in a separate branch and say so. That equivalent is **QA's reading, not a Cybersecurity statement**: it is recorded as `SEC-confirm-1` (section 13) and asked through the Orchestrator. Item 6 ("group change that does not grant a role") matches the comment's "groups must never grant app roles (only app-side assignment)" and Architecture C4 ("Group sync ... can only make an account eligible").

The expected result is "refused, nothing changed, denial audited" unless stated.

| ID | C7 item | Role | Pre / data | Steps | Expected | Pri | Type | Path | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SEC-C7-01 | Role elevation **without an approver** | `ADM-1`, subject `STF-FD-A` | `ADM-1` elevated | 1. Request the admin role for `STF-FD-A`<br>2. Try to activate it without approval (direct API call, UI, replay of request ID, direct SQL as `app_api` role)<br>3. Try with a forged approval row | Role never takes effect. Subject holds no admin permission after any attempt. The `app_api` role cannot write approval rows except through the identity function (HEAAA-12 observation O-2: the worker/function must check approval evidence the `api` alone cannot forge). Audit shows the attempts | P0 | N, SEC | A+B | AUTO |
| TC-SEC-C7-02 | **Self-approval** | `ADM-1`, `ADM-2` | `ADM-1`, `ADM-2` both elevated; a pending admin-role request R1 from `ADM-1` for `STF-FD-A`; a pending request R2 from `ADM-2` for `ADM-2` (self-request) | Approve own request as (a) requester; (b) subject; (c) requester through a second principal of the same person (path B); (d) subject approves a request created by someone else for themselves | All refused. A request cannot be approved by requester, subject, or the same `person_id` | P0 | N, SEC | A+B | AUTO |
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
| TC-AZ-08 | HEAAA-12 6.7, SBR-14 | Compliance principal with only `privacy.request.manage` | Compliance principal `CMP-3` holding only `privacy.request.manage`; one audit event, one consent record, one incident exist; `PAT-01` has a privacy request | 1. Query audit events, consents, incidents by SQL under its settings<br>2. Same through the API<br>3. `patient.identity_label` without the `patient_label` key, without a referencing record, and in a loop | Sees none of them. `identity_label` refused without the key, refused without a visible referencing record, audited per call, rate-limited | P0 | N, SEC | AUTO |
| TC-AZ-09 | HEAAA-12 6.6, SBR-11 | Staff at LOC-A1 and LOC-A2 | Patient cared for only at LOC-A2 | Check the staff-scope invariant: drift check job after deliberately removing and adding a scope row | Drift check finds and corrects both; alerts raised | P0 | E, SEC | AUTO |
| TC-AZ-10 | AC-12, BR-14, X-19 | `STF-DR-A2` | `PAT-01` not assigned to `A2`; `CMP-1` | 1. `A2` opens the chart<br>2. Gives a reason and proceeds<br>3. Check compliance view | Blocked until a reason is entered. Access then granted. Compliance alert raised. Event appears in the review queue with reason | P0 | N, S | AUTO+H |
| TC-AZ-11 | AC-12, BR-14 | `CMP-2` | A BTG event from TC-AZ-10 | Review it as "justified" and as "not justified" | Outcome recorded and audited. Reviewer cannot be the person who opened it (same-`person_id` rule). Reviewer needs the compliance BTG permission and sees the minimum required | P0 | N | AUTO |
| TC-AZ-12 | HEAAA-12 6.1, RA-R1-16 | Public audience | `integrations./public/v1/*` | 1. GET each public route<br>2. Try POST, PUT, DELETE<br>3. Look for any patient, reservation or room identifier in responses<br>4. Exceed the rate limit | GET only; PHI-free; start times only; no other audience data. Mutating verbs refused; `429` with `Retry-After` over limit | P0 | N, SEC | AUTO |
| TC-AZ-13 | Permission matrix (BA 1.1) | Each role in section 2 | Matrix as confirmed at G2 | Run the **role × capability** grid: for every cell with "—" attempt the action and expect refusal; for every allowed cell expect success | Result matches the G2 matrix cell by cell. The grid is generated from the matrix, and any cell with no result fails the run | P0 | N, P | AUTO |
| TC-AZ-14 | Proxy (D-7 default), RA-R1-20a | `PRX-01` | `PAT-03` linked; `PAT-01` not linked | 1. Open `PAT-03` appointments<br>2. Open `PAT-03` chart, documents, notes<br>3. Open `PAT-01` | Proxy sees appointments only (default). All else `404`. Another patient's data never opens | P0 | N, SEC | AUTO |
| TC-AZ-15 | Assistant (G-10 open) | `STF-ASST-A` | `STF-ASST-A` signed in at LOC-A1; a draft note and a draft prescription-shaped order on `SEED-CHART-1` | Attempt sign, prescribe and EPCS actions | Assistant cannot sign (BR-17, AC-16). What the assistant may prepare follows the G2 decision. `BLOCKED` for prepare scope until G-10 is answered. The refusal part is testable now | P0 | N | AUTO |
| TC-AZ-16 | BR-14 (boundary) | `STF-DR-A2`, `CMP-1` | `PAT-01` not assigned to `A2`; `POST /patients/{patientId}/break-glass` reason rule: at least 10 characters (ARCH 29.3), maximum from ARCH 31.1 | 1. Open the chart; submit an empty reason<br>2. Submit spaces only<br>3. Submit one character<br>4. Submit exactly the minimum length<br>5. Submit the maximum length plus one<br>6. Submit the maximum length | Empty, spaces-only, below minimum and over maximum are refused and no access is granted. Minimum and maximum are accepted; each accepted access appears in the compliance review queue with the exact reason text | P0 | B, N | AUTO |

## 7. Booking, calendar and notifications

### 7.1 Booking and rescheduling (RA-R1-02, J-04, J-05, AC-01..04)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-BK-01 | RA-R1-02, AC-01 | `PAT-01` | `DOC-TPL-1`, `SVC-IN`, free 09:00 slot, email/SMS sandbox | 1. Search slots<br>2. Select 09:00<br>3. Confirm | Appointment is `Confirmed`. Email/SMS with `.ics` is sent. Doctor's calendar shows "Busy" with no patient name. Audit rows exist | P1 | P | AUTO+H |
| TC-BK-02 | RA-R1-02 | `PAT-01` | `SVC-VID` | Book a video visit | Same as above plus a telehealth link; both time zones shown when patient and clinic zones differ (BR-05) | P1 | P | AUTO |
| TC-BK-03 | RA-R1-02, AC-02, BR-06 | `PAT-01` | Doctor has a Google meeting 09:00–10:00 | Search slots | No slot in 09:00–10:00 offered. Availability = template − bookings − synced busy | P1 | N | AUTO (real Google test calendar) |
| TC-BK-04 | RA-R1-02, BR-02 | `PAT-01` | Slot booked by another patient | Try to book the same slot (stale search) | `409 scheduling.slot_taken` on `POST /holds` (ARCH 29.2, 30) with `alternatives`; the same code is returned when the database exclusion constraint (`23P01`) decides a race | P1 | N | AUTO |
| TC-BK-05 | RA-R1-02, AC-04, BR-01 **[G2 setting]** | `PAT-01` | Cut-off 24 h; visit in 10 h; D-3 default (block-only) | 1. Cancel within cut-off<br>2. Cancel a visit 25 h away | Within cut-off: cancel **blocked** with the reason, nothing charged (D-3 default). 25 h: free cancel. If D-3 later says fee, this case is rerun with that setting | P1 | N, B | AUTO |
| TC-BK-06 | RA-R1-02, J-05 | `PAT-01` | Confirmed appointment | Reschedule to another slot | Old slot released, new slot held and confirmed in one flow; reminders recomputed; Google block updated; audit rows | P1 | P | AUTO |
| TC-BK-07 | BR-04 **[G2 setting]** | `PAT-01` | Max future appointments per service = 3 | Book 3, then a 4th | 4th refused with a clear message; counts per patient per service | P2 | B | AUTO |
| TC-BK-08 | X-01, AC-03 | `PAT-01` | Hold = 10 min **[G2 setting]** | 1. Start checkout<br>2. Wait past expiry<br>3. Confirm | `POST /appointments/{reservationId}/confirm` returns `409 scheduling.hold_expired` with `alternatives` (ARCH 29.2, 30); UI shows the hold-expired inline banner and reloads the slots with the same service and doctor kept (UI-UX 7.2); no appointment | P1 | E, B | AUTO |
| TC-BK-09 | CN-06 | `PAT-01` | `PAT-01` signed in; an API client with the patient session; free slot `S1` and free slot `S2` | 1. Send the same hold request twice with the same `Idempotency-Key`<br>2. Same key, different body<br>3. Same key on another route | 1: one hold, same response. 2: `409 kernel.idempotency_conflict` (ARCH 28.3, 30). 3: treated as a different key (per route template). Each step of hold then confirm has its own key | P1 | E | AUTO |
| TC-BK-10 | RA-R1-02, BR-05 | `PAT-01` | LOC-B1 (Pacific) and a patient browser in Eastern time | Book near a daylight-saving change date | Stored UTC, displayed in the location zone; no off-by-one-hour | P2 | B | AUTO |
| TC-BK-11 | Front desk booking | `STF-FD-A` | `STF-FD-A` (assigned LOC-A1 only); free slots at LOC-A1 and LOC-B1; `PAT-01` | Book for `PAT-01` at LOC-A1 and at LOC-B1 | Allowed at assigned location only; at LOC-B1 refused | P1 | P, N | AUTO |
| TC-BK-12 | NFR-7, usability | `PAT-01` on 360 px phone | `PAT-01`; free 09:00 slot; a 360 px wide phone (or device-mode browser) on `ENV-INT/staging` | Complete TC-BK-01 on a phone | Journey is possible with no horizontal scroll; keyboard and touch work (see TC-A11Y-*) | P1 | P | AUTO+H |

### 7.2 No double booking (RA-R1-03, HEAAA-12 6.5)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-BK-13 | RA-R1-03 | 100 `PAT-*` sessions, one **non-overbookable** slot | `VOL-3` | 100 parallel confirmations (same patient account on 100 sessions) | Exactly one succeeds. 99 receive alternatives; exactly one appointment exists in the database | P0 | X | AUTO |
| TC-BK-14 | RA-R1-03, 6.5(c) | 100 **different** patients | `VOL-3` | Same as above with 100 distinct patients | Exactly one wins; the others see alternatives. No patient sees another's reservation | P0 | X | AUTO |
| TC-BK-15 | RA-R1-03, SA-F-10 | 100 patients, overbookable session cap 2 | Overbookable session cap 2 (`DOC-TPL-1`); `VOL-3` (100 distinct patient accounts) | 100 parallel confirmations | Exactly 2 succeed; no more. Ties are decided by the database constraint | P0 | X, B | AUTO |
| TC-BK-16 | 6.5(a) | Patients A, B, C | A holds a slot; hold expires | B and C race for the same slot after A's hold expired | Exactly one wins. Neither gets a false "taken" | P0 | X | AUTO |
| TC-BK-17 | 6.5(b), SAR-09 | A, B, C with a room | Same, but for a **room** | Same race on the room | Same result for the room | P0 | X | AUTO |
| TC-BK-18 | 6.5(d) | Patient and public API | Booked slots, held slots and a booked room exist for `PAT-01` and `PAT-02`; `PAT-03` has a hold in progress | Inspect slot-search and `/public/v1` responses for identifiers of other patients, reservations or rooms | None present | P0 | SEC | AUTO |
| TC-BK-19 | RA-R1-22, AC-05, BR-03 **[G2 setting]** | Waitlisted `PAT-01`, `PAT-02` | Slot frees; acceptance 30 min | 1. Free the slot<br>2. `PAT-01` ignores<br>3. After 30 min check | `PAT-01` is offered first. Offer lapses cleanly; `PAT-02` offered next | P1 | P, B | AUTO |
| TC-BK-20 | RA-R1-22 | `PAT-01`, `PAT-02` | Two offers at once | Both accept at once | Only the first is booked; the other sees a clean "no longer available" | P1 | X | AUTO |
| TC-BK-21 | RA-R1-22 | `PAT-01` (waitlisted), `PAT-02` (waitlisted) | Acceptance time = 15 min **[G2 setting]**; slot with start < 24 h away frees up; controllable clock; waitlist entries for `PAT-01` and `PAT-02` | 1. Cancel the booked appointment holding that slot so it frees<br>2. Observe the offer to `PAT-01` and note its stated expiry<br>3. Advance the clock by 14 min and let `PAT-01` accept (separate run: accept at 16 min)<br>4. In the 16-min run: observe the offer to `PAT-02` | Offer expiry is exactly 15 min after the offer (not 30 min). Accepting at 14 min books the slot; accepting at 16 min is refused ("offer expired") and the offer passes to `PAT-02`. Rerun with the final G2 value | P2 | B | AUTO |
| TC-BK-22 | RA-R1-22 | `PAT-04` (waitlisted, to be merged), `STF-MRO-A` | `SEED-DUP`: `PAT-04` waitlisted for a slot; merge of `PAT-04` into `PAT-05` approved | 1. Approve the merge (PAT-04 → PAT-05)<br>2. Free the slot<br>3. Run the waitlist offer job | Job resolves to the survivor (`on_merged: resolve`), no duplicate offer | P1 | E | AUTO |

### 7.3 Calendar sync (RA-R1-04, X-03)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-CAL-01 | RA-R1-04, BR-07 | `STF-DR-A1` | Google test calendar linked | Book a visit for `SVC-NEUTRAL` | A "Busy" block appears with no patient name, reason, or diagnosis | P0 | SEC | AUTO (real Google) |
| TC-CAL-02 | BR-23 extension | `STF-DR-A1` | Book `SVC-SENS` | Check the calendar block title and the `.ics` | Neutral label only. The internal condition-revealing service name does not appear anywhere | P0 | SEC | AUTO |
| TC-CAL-03 | RA-R1-04 | `STF-DR-A1` | A meeting created in Google | Run sync | Meeting is unavailable time for slot search within the sync delay | P1 | P | AUTO |
| TC-CAL-04 | RA-R1-04, X-03 **[G2 setting]** | `PAT-01` | Block Google API; stale threshold 15 min | 1. Search before the threshold<br>2. Search after it | Before: last-known busy times used. After: slot search does not silently use the stale data (flagged or restricted per design). Failure on operations dashboard | P0 | E, B | AUTO |
| TC-CAL-05 | RA-R1-04 | System (API client posting Google Calendar push notifications to `POST /webhooks/google/calendar`) | `STF-DR-A1` calendar linked with watch channel CH1 (channel ID, HMAC channel token T1 with `v.<key version>.<expiry>.<hmac>` format, ARCH 29.5); event E changed in the Google test calendar; sync token S1 held; headers `X-Goog-Channel-ID`, `X-Goog-Channel-Token`, `X-Goog-Resource-ID`, `X-Goog-Resource-State`, `X-Goog-Message-Number`, no body; **binding: `ENV-INT/staging` with the Google test tenant** (the HMAC steps 1–2 and 4 can also run on `ci`) | 1. Post message 5 with a token whose HMAC is wrong → record status<br>2. Post message 5 with a channel ID not matching the token (forged) and with an expired token → record status<br>3. Post message 5 with a valid token for CH1 (`X-Goog-Resource-State: exists`) → record status, busy-block count for E<br>4. Post message 5 again (replay) → record status, number of sync jobs and busy-block count<br>5. Post message 4 (lower message number, valid token) → record status and busy-block count<br>6. Post a validly signed token for a channel that has no active `watch_channel` row → record status and busy-block count<br>7. Post a valid token with `X-Goog-Resource-State: bogus`<br>8. Force the stored sync token S1 to be rejected by Google with `410 Gone` and post message 6 | 1, 2, 7: **`401`** (verification failed; not recorded, counted in metrics) or `400` for an unknown resource state (ARCH 29.5, 38.2 item 13); no job, no state change, no PHI. 3: `200` after recording; one incremental sync by sync token S1 (`calendar_sync.incremental_sync`); exactly 1 busy-block for E. 4: `200` and **no second job** (de-duplicated by `channel_id:message number`, so "no second fetch" is kept); count stays 1. 5: message 4 has a new de-duplication key, so one more **idempotent** incremental sync may run (this replaces draft 4's "ignored"); the assertion is that the busy-block count stays 1 and no data changes. 6: `200`, the worker marks it `handled` and ignores it; count unchanged. 8: **[ARCH-GAP QA-AL-01]** ARCH 22.9/33.1 keep `sync_token` and the 15-minute `incremental_sync` job but do not state what happens on `410 Gone`. The expected behaviour (discard S1, full resync, exactly 1 busy-block for E, none lost or duplicated) is the QA requirement. The step is `Blocked` until the Solution Architect states the rule. The push body is never the change source. | P1 | E | AUTO |
| TC-CAL-06 | RA-R1-04 | `ADM-1` and `STF-DR-A1` | `STF-DR-A1` calendar linked; `ENV-INT/staging` with the Google Workspace **test tenant** (DEVOPS-PLAN 3.5; stays `Blocked` until the owner creates the tenant) | 1. In the Google test tenant, revoke the app authorisation for `STF-DR-A1`<br>2. Wait for the next sync run (or trigger it)<br>3. Open the operations dashboard and the doctor's calendar page | Visible failure and alert, not silent; retry/back-off (BR-33) | P1 | E | AUTO |

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
| TC-NT-08 | Notification preferences (F-PP-16) | `PAT-01` | `PAT-01` signed in; SMS and email sandboxes; one appointment | 1. Open notification preferences<br>2. Turn SMS off and leave email on<br>3. Trigger a reminder for the appointment<br>4. Read the SMS and email sandboxes<br>5. Trigger a security message (sign-in code request) | Preferences respected: no SMS, email still sent. Whether security messages (sign-in code) are exempt from the preference is **PM-confirm-3** (not in the PRD); until answered the case asserts only the preference part | P2 | P | AUTO |

## 8. Pre-consultation, safety rules and clinical record

### 8.1 Pre-consultation portal (RA-R1-06, 29, 30; J-06)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-PC-01 | RA-R1-06, F-PC-01 | `STF-FD-A` | Appointment today | Check the patient in at the desk | Status moves to checked-in; patient appears in the queue | P1 | P | AUTO |
| TC-PC-02 | RA-R1-06 | `PAT-01` | QR code from the confirmation | Check in by QR on a phone | Same result; QR works once and expires; a QR for another patient's visit fails | P1 | P, N | AUTO+H |
| TC-PC-03 | RA-R1-06, F-PC-02 | `STF-FD-A` | Questionnaire and consent partly complete | Open the pre-visit checklist | Missing items flagged; front desk sees pre-visit items only (matrix), no clinical chart | P1 | P, N | AUTO |
| TC-PC-04 | AC-09, F-PC-04 | `STF-TRI-A` | SpO2 limit configured | Save vitals with SpO2 below the limit, then in range, then exactly at the limit | Below: value highlighted and triage-category prompt appears. In range: no highlight. At limit: behaves per the configured inequality (documented) | P1 | P, B | AUTO |
| TC-PC-05 | RA-R1-06 | `STF-TRI-A` | Four checked-in patients: P1 (arrived 08:00), P2 (08:05), P3 (08:10), P4 (08:15); categories not yet set; **PM-confirm**: PRD RA-R1-06 says "triage category, and queue with wait time"; the ordering rule is not stated (PM-confirm-2) | 1. Set category "urgent" on P3 and "routine" on P1, P2, P4<br>2. Open the queue<br>3. Record the order and the wait time shown for each | Wait time shown for each patient and equals now − arrival. **Ordering by category is PM-confirm (PM-confirm-2)**: until PM answers, the case asserts only that the category and wait time are displayed and that no patient is dropped from the queue; it asserts the order only after PM-confirm-2 is answered | P1 | P | AUTO |
| TC-PC-06 | RA-R1-06 | Two staff | `STF-TRI-A` and a second triage nurse `STF-TRI-A2` (LOC-A1) both open the same triage record R; each holds the current `ETag` | Two staff edit the same triage record | Second save gets `412` (stale `ETag`); no silent overwrite (CN-07) | P1 | X | AUTO |
| TC-PC-07 | BR-34 | `STF-TRI-A` | `PAT-01` checked in with a photo; triage record exists; clinical screens of UI-UX 4: DR-03 Chart summary and note editor, DR-04 Video + notes, DR-05 Sign dialog, DR-06 Addendum, PC-02 Check-in, the triage and vitals screens reached from PC-01 Arrivals board, SH-02 Document viewer | 1. Open each clinical screen for `PAT-01`<br>2. Check the header of each: name, date of birth and photo are present<br>3. Scroll to the bottom of a long screen and check again | Patient name, DOB and photo visible on every clinical screen | P0 | S | AUTO+H |
| TC-PC-08 | X-07 | `STF-FD-A` | Consent missing | Check-in a patient with missing consent | Flag raised (missing consent); consultation start blocked later (TC-SAF-05) | P1 | N | AUTO |
| TC-PC-09 | F-PC-09 (S) | `STF-FD-A` | Grace period 15 min **[G2 setting]**; appointment for `PAT-01` at 09:00; controllable clock; (F-PC-09 is S priority in R1) | 1. Do not check in `PAT-01`<br>2. Advance the clock to 09:14 and open the day list<br>3. Advance to 09:16 and open the day list<br>4. Mark the visit "no-show" | At 09:14 the appointment is still "waiting". At 09:16 the system flags it as late/no-show candidate per the grace period. After step 4 the status is "no-show", audited, and the slot is not reopened unless the clinic rule allows it (rule from HEAAA-13). Waitlist offers follow TC-BK-19 rules | P2 | P | AUTO |
| TC-PC-10 | RA-R1-29, F-PC-05 | `STF-FD-A` | Insurance card uploaded | Record verification status and date manually | Saved and audited; no electronic eligibility request leaves the system (verify no outbound call) | P2 | P | AUTO |
| TC-PC-11 | RA-R1-30 | `STF-COORD-A` | Chart | Book a follow-up; create a referral | Follow-up appears in slot rules (RA-R1-02); referral has referrer, target, status; both audited. **No lab sample collection booking exists in R1** (D-4 default). Referral record owner is HEAAA-13 note | P1 | P | AUTO |
| TC-PC-12 | RA-R1-30 | `STF-FD-A` | `STF-FD-A` without referral or follow-up permission; `SEED-CHART-1` | 1. Try to create a follow-up for `PAT-01`<br>2. Try to create a referral for `PAT-01`<br>3. Check the audit view | Refused; logged | P1 | N | AUTO |
| TC-PC-13 | BR-34 (negative) | `STF-TRI-A`, `STF-DR-A1`, QA | The route inventory (BD-07) entries marked `banner: true` (ARCH 28.2: patient, chart summary, problem/allergy/medication/immunisation lists, questionnaire responses, check-in, vitals, triage, encounter and note routes, documents) and the screens DR-01..DR-06, PC-02, SH-02 (UI-UX 4); `SEED-CHART-1`; **`ENV-INT/staging`** | 1. For every `banner: true` route, check the response contains `patientBanner` with `displayName`, `dateOfBirth`, `mrn` and `photoUrl` (or no photo)<br>2. For every clinical screen, open it directly by URL as an authorised user and find the banner element<br>3. Open the same route after switching patient in another tab (stale tab)<br>4. Open a route in the print view and in the document viewer (SH-02)<br>5. Call `GET /patients/{patientId}/banner` from the Arrivals board (PC-01) and Alert tray (DR-10) patient links | A route or screen with no banner showing name, date of birth and photo (or placeholder) fails. In the stale tab (step 3) the banner shows the patient the page data belongs to, or the page is refused with a reload prompt; never a different patient's banner with this patient's data. Print view keeps name and DOB (UI-UX 7.6). The banner comes with the screen's own call; a second call to fill the allergy block fails the case (UX-R1) | P0 | S, N | AUTO (route sweep) + HUMAN for TC-CL-09 |
| TC-PC-14 | BR-34 (boundary) | `STF-DR-A1` | Patients: `PAT-08` with no photo; `PAT-09` with a 120-character name; `PAT-04` and `PAT-05` (same name and DOB, different photos); a 360 px screen | 1. Open the chart of each patient<br>2. Check the banner at 360 px width and at 200% zoom<br>3. Open `PAT-04` then `PAT-05` and compare banners | No photo: a visible placeholder and name + DOB shown. Long name: wraps or truncates with the full name available, DOB never hidden. Same-name patients are distinguishable by DOB, MRN and photo (the banner carries `mrn`, ARCH 28.2); at 360 px the collapsed banner keeps avatar (photo or initials), name, DOB and the allergy flag, and expands on tap (UX-R1) | P0 | S, B | AUTO+H |
| TC-PC-15 | BR-34, UX-R1, AL-01 (ARCH 28.2, 38.2 item 18) | `STF-TRI-A`, `STF-FD-A` (both `clinical.chart.read_previsit`), `STF-DR-A1` (assigned), `STF-DR-A2` (under BTG), `STF-MRO-A` (`patient.read` only, no chart read) | `SEED-CHART-1` extended: `PAT-01` with 12 active allergies (2 severe, 1 uncoded), one `resolved`, one `entered_in_error`, one `inactive`; `PAT-08` with no allergy; **`ENV-INT/staging`** | 1. As each of the first four roles open every `banner: true` route and call `GET /patients/{patientId}/banner` for `PAT-01`<br>2. Same for `PAT-08`<br>3. As `STF-MRO-A` open the same patient<br>4. Read the audit row of step 1 and of step 3<br>5. As `PAT-01` open the patient portal screens | 1: `patientBanner.allergies.state = recorded`; at most 10 `items`, severe first, `moreCount` = 2, `uncodedCount` = 1; no `resolved`, `entered_in_error` or `inactive` allergy; the screen shows the block and "+2 more", and the chip "1 uncoded: needs review". 2: `state = none_recorded`, screen reads "No allergies recorded", never "No known allergies" (BQ-11). 3: `allergies = null` and the screen shows the chip "Allergies not available with your current access" (UX-R1, UXR-10), never an empty block that reads as "none". 4: the audit row names `allergy_summary` only when the block was filled. 5: no banner in the patient portal | P0 | S | AUTO+H (a person checks the red block and the chip text at 360 px and 1280 px) |
| TC-PC-16 | AL-02 (ARCH 32, 38.2 item 19), UX-A-04 | `STF-TRI-A` (creates the alert), `STF-DR-A1`, `STF-DR-A2` (two targets), `STF-FD-A` (not a target) | Red-flag alert with `red_flag_escalation_minutes` configured, a second red-flag configuration with none; alert stream (SSE) and `GET /alerts`, `GET /alerts/open-ids`; **`ENV-INT/staging`** | 1. Create the alert with escalation configured; read `escalatesAt` from `GET /alerts`, the SSE `alert` event and the acknowledge response<br>2. Create the alert with no escalation configured<br>3. `STF-DR-A1` and `STF-DR-A2` acknowledge at the same moment<br>4. Acknowledge again after the alert closed<br>5. Let the escalation job run after step 3 | 1: `escalatesAt` is set and equal in the three places; the UI countdown uses it with the `Date` header (UI-UX 7.4). 2: `escalatesAt = null`, the UI shows no countdown. 3: both get `200`, exactly one `acknowledged` event, `escalatesAt = null` after. 4: `409 notifications.alert_closed`. 5: the job does nothing after acknowledge (no `escalated` event) | P0 | S, X | AUTO |
| TC-CL-10 | AL-02 (ARCH 22.11 `clinical.vital_range`), UX-A-10 | `STF-TRI-A`, `ADM-1` (elevated; holds `clinical.vital_range.manage`) | `ENV-INT/ci`; no `vital_range` rows exist (the table ships empty; entries need the D-12a reviewer, so `[G2 setting]` and **PM/owner decision D-12a**) | 1. Record a vital with no range present<br>2. As `ADM-1` add an age/sex range with a reviewer note; record vitals at, below, above the bound, with a different unit, and for a patient of the other sex and across an age band (age taken at `measured_at`)<br>3. Add an overlapping active range<br>4. Retire the range and re-read the earlier vital | 1: `no_range`. 2: inclusive bounds; below/above give the out-of-range states; other unit gives `unit_mismatch`; a sex-specific range wins over `any`. 3: `409 clinical.vital_range_overlap`. 4: the stored `range_status` of the earlier vital is unchanged. No content of a range is asserted as clinically correct (D-12a): the test checks the mechanism only | P1 | B | AUTO |

### 8.2 Patient-safety rules (PRD 8.3: BR-09, BR-10, BR-14, BR-34, BR-37)

**`BLOCKED` until D-12a is decided:** TC-SAF-01..07 for RA-R1-07 and RA-R1-08. The PRD says RA-R1-07 and RA-R1-08 stay blocked, and R1 cannot go live, unless (i) a named licensed clinician reviews the R1 safety rules and their test results, or (ii) the owner records, dated, a knowing acceptance of **interim self-review**. Self-review is never independent review and is reported as such. PRD 8.3 (quoted): "If neither is recorded, RA-R1-07 and RA-R1-08 stay blocked and R1 cannot go live." The PRD blocks the *acceptance rows*. It does not say anything about writing or running tests, so this plan uses one definition: **what is blocked is acceptance of RA-R1-07/08 (and R1 go-live). Writing and running TC-SAF-01..06 before D-12a is permitted by QA as ordinary test evidence and never counts as the clinician review or the owner's recorded acceptance.** That reading is QA's; the PRD does not contradict it.

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SAF-01 | RA-R1-07, AC-08, BR-10 | `STF-TRI-A`, on-duty `STF-DR-A1` | Triage with red-flag question "chest pain" | 1. Answer "chest pain"<br>2. Save triage<br>3. Check doctor's alert and patient screen | On-duty doctor alerted at once (SSE and durable alert row). Patient sees emergency advice. Alert time recorded and audited | P0 | S | AUTO |
| TC-SAF-02 | RA-R1-07 | Same | Doctor does not acknowledge | Wait for the escalation timer (PRD J-07 labels the on-call step "derived": **PM-confirm-1**) | **PM-confirm-1** (escalation to on-call is Derived in PRD J-07/A-17, no timer value in the PRD): until answered, the case asserts only that an unacknowledged alert stays visible and is not lost. After PM confirms: alert goes to `STF-ONCALL` at the confirmed time and each step is audited. The clinical window needs the clinical reviewer | P0 | S, E | AUTO (+ HUMAN review of the timing once PM-confirm-1 is answered) |
| TC-SAF-03 | RA-R1-07, BR-10 | `STF-TRI-A` | Red-flag question list configured on the questionnaire template (ARCH 22.11, 29.3): at least "chest pain", "severe bleeding"; `PAT-01` in triage | 1. Answer each configured red flag "yes", saving after each<br>2. Answer a near-miss ("chest discomfort that is mild" if not configured) and a non-flag answer<br>3. Leave a required red-flag question blank and try to save | Every configured red flag alerts; non-red-flag answers do not; blank/invalid input is rejected, not treated as "no red flag" | P0 | S, B, N | AUTO |
| TC-SAF-04 | RA-R1-07 | `STF-TRI-A`, `STF-DR-A1`, operator for the alert stream | `PAT-01` in triage; alert stream (SSE) service stopped on `ENV-INT/staging` | 1. Stop the alert stream service<br>2. Save triage with "chest pain" = yes<br>3. Read the patient's screen<br>4. Read the durable alert table / alert list for `STF-DR-A1`<br>5. Restart the stream and reload the doctor's page | Alert row still exists and is delivered when the stream returns; failure visible; **the patient still sees the emergency advice** | P0 | S, E | AUTO |
| TC-SAF-05 | RA-R1-08, AC-07, BR-09 | `STF-DR-A1` | Service needs a signed consent; unsigned | Open the consultation | Cannot start. Message names the missing consent (no PHI) | P0 | S, N | AUTO |
| TC-SAF-06 | RA-R1-08, X-07 | `STF-DR-A1` | Same | Start with "emergency exception" and a reason; also try without a reason | With reason: starts; exception recorded and audited; compliance can see it. Without reason: refused | P0 | S, N | AUTO |
| TC-SAF-07 | RA-R1-08, PRD 8.3 (b) | Named licensed clinician **or** owner (interim self-review) | The above cases' rule text and results | The reviewer reads the rule text and results for BR-09, BR-10, BR-14, BR-34 and BR-37 and records a dated decision on the task | Either a named clinician's review, or the owner's dated knowing acceptance of interim self-review, recorded on the task **and** in the acceptance record, reported as **self-review (not independent)** where applicable. If neither exists, RA-R1-07/08 stay blocked and R1 cannot go live | P0 | S | HUMAN (never recorded by QA) |
| TC-SAF-08 | RA-R1-08, BR-09 (negative and boundary) | `STF-DR-A1` | Service `SVC-IN` requires two consents: C-A and C-B (current versions v2). `PAT-01`: C-A v2 signed, C-B not signed; `PAT-02`: C-A v1 (superseded) and C-B v2 signed; `PAT-03`: both v2 signed; controllable clock | 1. Open the consultation for `PAT-01`<br>2. Open it for `PAT-02`<br>3. Open it for `PAT-03`<br>4. Sign C-B for `PAT-01` and reopen at once (same second)<br>5. Withdraw C-A for `PAT-03` and reopen | 1: blocked, names C-B only. 2: blocked, names C-A (superseded version is not valid). 3: starts. 4: starts (no delay or race). 5: blocked again. Messages carry no PHI. This is the boundary set for BR-09: one of two present, old version, just signed, withdrawn | P0 | S, N, B | AUTO |

### 8.3 Clinical documentation (RA-R1-09, 11, 24; J-09)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-CL-01 | RA-R1-09, BR-11 | `STF-DR-A1` | Visit; note template | Write a note from a template, sign (re-auth), then edit | Note locks on signing. Edit attempt fails with "locked"; changes only via addendum | P0 | P, N | AUTO |
| TC-CL-02 | AC-10, BR-11 | `STF-DR-A1` | Signed note | Correct a dose through an addendum | Addendum has author and time; original unchanged; patient ID on the addendum is the survivor's if merged | P0 | P | AUTO |
| TC-CL-03 | AC-11, BR-12 | `STF-TRN-A`, `STF-DR-A1` | Trainee note | 1. Release without co-signature<br>2. Supervisor co-signs<br>3. Release | 1 refused. 3 allowed. Co-sign audited. A co-sign by a non-supervisor is refused | P0 | N | AUTO |
| TC-CL-04 | SA-F-08 | `STF-DR-A1` | `STF-DR-A1` with `SEED-CHART-1` open; the RxNorm test terminology available. Warning-requires-acknowledgement is in PRD 4.x ("shown with a warning that requires acknowledgement in R2 checks", **[Rec]** SA-F-08); the acknowledgement itself is an R2 check (outline TC-RX) | 1. Add allergy "Penicillin" by choosing the RxNorm code<br>2. Add a medication by choosing a code<br>3. Add an allergy as free text "synthetic reaction x"<br>4. Add a medication as free text<br>5. Read the saved chart | Coded items are saved with their codes. Free-text items are saved flagged `uncoded` and shown with a warning. **In R1 the test stops at the saved flag and the warning**; the acknowledgement step is R2 (TC-RX-*) | P1 | P, B | AUTO |
| TC-CL-05 | RA-R1-09 | `STF-DR-A1` | Two doctors | Two sessions edit the same draft | Second save `412`; draft recoverable | P1 | X | AUTO |
| TC-CL-06 | CL deadline **[G2 setting]** | `STF-DR-A1` | Signed-note deadline 24 h | Leave a visit unsigned 24 h | Reminder sent to the doctor; no PHI in the reminder | P2 | B | AUTO |
| TC-CL-07 | CN-07 | `STF-DR-A1` API client | A signed note and a signed addendum on `SEED-CHART-1` | 1. PUT/PATCH the signed note with a valid `If-Match`<br>2. DELETE the signed note<br>3. Edit a signed field through the addendum endpoint with the parent's ID<br>4. SQL as `app_api` role: UPDATE and DELETE on the note table | Steps 1–4 fail (refused; DB refuses UPDATE/DELETE). The note is unchanged (hash equal before/after). Only a new addendum can be created | P0 | N, SEC | AUTO |
| TC-CL-08 | RA-R1-24, BR-34 | `STF-DR-A1` | `SEED-CHART-1` | Open the chart summary | Problems, allergies, medications, vitals, history, documents visible with name, DOB, photo. `uncoded` items are marked | P1 | P | AUTO+H |
| TC-CL-09 | RA-R1-24, BR-34 | Clinician (human tester; D-12 clinician or owner) | `PAT-04` and `PAT-05` with the same name; both charts open in two browser tabs; clinician at LOC-A1 | 1. Open `PAT-04` in tab 1 and `PAT-05` in tab 2<br>2. Switch tabs three times; at each switch read the banner out loud and compare with the patient the chart belongs to<br>3. In tab 1, press Back and Forward through two patients<br>4. Judge: could a busy clinician mistake one patient for the other? | Each screen shows the right patient banner; no stale banner after switching; wrong-patient risk is a human usability check | P0 | S | HUMAN (clinician/usability) |
| TC-DR-01 | RA-R1-23, F-DR-01 | `STF-DR-A1` | `STF-DR-A1`; `DOC-TPL-1` template active | 1. Add leave on Friday 09:00–12:00<br>2. Add blocked time Wednesday 10:00–10:40<br>3. Search slots for those times as `PAT-01`<br>4. Remove the leave and search again | Slot search reflects it within one booking cycle | P1 | P | AUTO |
| TC-DR-02 | RA-R1-23 | `STF-DR-A1` | Existing bookings | Add leave over booked slots | Warns about conflicts; no silent cancellation | P1 | E | AUTO |
| TC-DR-03 | RA-R1-23 | `STF-DR-A2` | `STF-DR-A2` (doctor, same location); `STF-DR-A1`'s availability exists | 1. Open `A1`'s availability by URL/ID as `A2`<br>2. Try to change it through the API<br>3. Check the audit view | Refused | P1 | N | AUTO |

## 9. Telehealth, audit, documents and privacy

### 9.1 Telehealth (RA-R1-10, 28; J-08)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-TH-01 | RA-R1-10 | `PAT-01`, `STF-DR-A1` | Video vendor sandbox | Device check, waiting room, join, notes side by side | Visit runs; both can see/hear; notes pane available to the doctor only | P1 | P | AUTO+H (real devices, audio and video) |
| TC-TH-02 | BR-05 | `PAT-01` (browser in Eastern time), `STF-DR-B1` (LOC-B1, Pacific) | A video appointment between them at 09:00 Pacific | 1. Open the join page as `PAT-01`<br>2. Open the join page as `STF-DR-B1` | Each page shows the appointment time in the viewer's zone and the clinic's zone, labelled (12:00 Eastern / 09:00 Pacific) | P2 | P | AUTO |
| TC-TH-03 | X | `PAT-02` | Other patient's visit link | Join someone else's session | Refused; logged | P0 | N, SEC | AUTO |
| TC-TH-04 | BR-33 | `PAT-01`, `STF-DR-A1` | Video vendor sandbox switched to "unavailable" (vendor outage simulation); a video appointment starting now | 1. Both users click "Join"<br>2. Read the messages shown<br>3. Open the operations dashboard<br>4. Restore the vendor and rejoin | Visible failure, retry/fallback message, no data loss; operations dashboard | P1 | E | AUTO |
| TC-TH-05 | NFR | `PAT-01` | Join link L for a video appointment at 10:00 (window opens 10 min before; closes at the end); controllable clock | 1. Open L at 09:40<br>2. Open L at 09:55 and join<br>3. End the visit; open L again at 10:45 | 09:40: refused "too early" with the start time. 09:55: joins. 10:45: refused; no new session; event logged | P1 | N | AUTO |
| TC-TH-06 | RA-R1-28, TL-1 | `PAT-01` | Clinician's licensed states; D-2 not decided (states from D-2) | Book a video visit with a stated location outside the licensed states | Refused or flagged at booking. In-state: allowed. Cases use placeholder states; **real state values wait for D-2** (`BLOCKED` for production values) | P0 | N | AUTO |
| TC-TH-07 | RA-R1-28 | `PAT-01` | `PAT-01` with a booked video visit with `STF-DR-A1` (licensed in states X,Y); placeholder state list; join page open | 1. At join, answer "I am in Z" (outside X,Y)<br>2. Answer "I am in X" and join | Patient must confirm current location; outside licensed states refuses/flags | P0 | N | AUTO |
| TC-TH-08 | RA-R1-28 | `ADM-1` (elevated), `PAT-01` | `PAT-01` booked in state X with `STF-DR-A1` (licensed in X) | 1. Remove X from `STF-DR-A1`'s licensed states<br>2. `PAT-01` opens the join page<br>3. Re-add X and open again | Step 2: refused/flagged with a safe message (no PHI). Step 3: allowed. Both changes audited | P2 | E | AUTO |

### 9.2 Audit (RA-R1-11, 12; AC-36; NFR-13)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-AU-01 | RA-R1-11, BR-13 | `STF-DR-A1` | `SEED-CHART-1` | View, search, export, print the chart | Each creates an audit event with user, time, IP/device, reason where needed, and no clinical values | P0 | P | AUTO |
| TC-AU-02 | HEAAA-12 8.1 rule 1 | `STF-DR-A1` and DBA fault injector | `ENV-INT/ci` (PostgreSQL 17 container with the migration-created roles) with a fault-injection switch that makes the audit insert fail; `SEED-CHART-1` | 1. Enable the audit-failure injection<br>2. Open the chart of `PAT-01` as `STF-DR-A1`<br>3. Make a change to a draft note under the same injection<br>4. Disable the injection and repeat | The read fails and the business change rolls back. PHI is never accessed without an audit row | P0 | E, SEC | AUTO |
| TC-AU-03 | 8.1 rule 2 | `STF-FD-A` and fault injector | `PAT-06` is outside `STF-FD-A`'s scope; injection that fails the separate denial-write transaction | 1. Enable the denial-write failure injection<br>2. `STF-FD-A` opens `PAT-06` by ID<br>3. Check the response, the application error log and the alerts<br>4. Disable injection | Caller still gets the denial (fail closed); failure logged and alerted | P0 | E | AUTO |
| TC-AU-04 | 8.1 rule 3, SAR-10, ARCH 21.5 | DBA test role (not a production role) and the `app_owner` migration role | **`ENV-INT/ci`** (PostgreSQL 17 container with the roles created by the real migrations) for steps 1–4; the same four steps rerun on **`ENV-INT/staging` (RDS)** because role-level `transaction_timeout` on RDS is **Unverified** (DEVOPS-PLAN 5.2). An audit table with the trigger `audit.require_bounded_tx` (ARCH 21.5). Production bound = 60 s; test bound B (for example 5 s) so the positive control is quick | 1. Start a transaction with `transaction_timeout` unset (0) and insert an audit row<br>2. Start a transaction with `transaction_timeout` set **above the bound** (60 s in production, B in test), for example **B + 1 s**, and insert an audit row<br>3. As `app_owner` (the migration role), try to insert an audit row<br>4. **Positive control:** start a transaction with `transaction_timeout` set at or below the bound (60 s production, B in test) and insert an audit row | 1–2: refused by the trigger (SQLSTATE `PA001`), which checks the **setting** of `transaction_timeout`, not elapsed time; no audit row is written. The 2-minute value is the anchoring watermark, which the bound must stay below (SAR-10): it is not the bound being tested, and B + 1 s must already be refused. 3: refused with a **privilege error (SQLSTATE `42501`, no INSERT grant on the audit tables for `app_owner`)** raised before the trigger runs. A check that expects the trigger's error here is wrong. No audit row is written. 4: succeeds and the row is written, which shows the trigger is not refusing everything (SA-TC-06 closed) | P0 | SEC | AUTO |
| TC-AU-05 | RA-R1-12, AC-36 | `ADM-1` | `ADM-1` elevated; one audit entry E; a DB connection as each `app_*` role | Try to delete or edit audit entries via UI, API, and SQL as `app_*` roles | Not available / refused for every role including admin; the attempt is logged | P0 | N, SEC | AUTO |
| TC-AU-06 | RA-R1-12 | `CMP-1` | `CMP-1` signed in and elevated; audit events from TC-AU-01 and TC-SEC-12 exist | Use the audit viewer filters: who, what, when, from where | Shows the required fields; PHI not shown | P1 | P | AUTO |
| TC-AU-07 | SA-F-11 | `CMP-1` | Large result | Request an export over the size limit | Runs as an asynchronous job with a size limit; notification when ready; exported file audited; rate limit | P1 | B | AUTO |
| TC-AU-08 | SAR-10 | DBA test role (owner level) and `CMP-1` | `ENV-INT/ci`; audit anchoring job has run at least once | 1. Note the latest anchor value<br>2. As DB owner change one stored audit row<br>3. Run the anchor check job<br>4. Open the alerts of `CMP-1` | Mismatch detected, alert `audit anchor mismatch` raised | P0 | SEC | AUTO |
| TC-AU-09 | NFR-13 | Operations owner (provides) and QA (reads) | Retention period decided at G2 and set in configuration | 1. Read the configured retention value for audit and clinical records<br>2. Run the archive job on test data older than the retention value<br>3. Verify archived rows are still retrievable by `CMP-1` and that rows younger than the value are untouched | The configured value equals the G2 decision; archive moves only older rows; retrieval of archived rows works and is audited. `BLOCKED` until the retention value is decided | P1 | P | OPS |
| TC-AU-10 | 8.1 | Load generator | `ENV-LOAD`, `VOL-1` | 1. Duplicate of TC-PERF-04: not executed separately | Removed as a separate case: the audit write load is owned by **TC-PERF-04**. This ID is kept so references do not break, and carries no result of its own | P0 | L | n/a (owned by TC-PERF-04) |

### 9.3 Documents (RA-R1-13; J-19)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-DOC-01 | RA-R1-13 | `PAT-01` | `SEED-FILES` clean PDF | Upload; wait for scan | Not openable by anyone until scanned clean. Then classification by staff and confirmation, then retained | P1 | P | AUTO |
| TC-DOC-02 | AC-30, X-17 | `PAT-01` | EICAR file | Upload | Quarantined; uploader told; clinicians cannot open it; alert/ops record | P0 | N, SEC | AUTO |
| TC-DOC-03 | NFR-17 | `PAT-01` | `SEED-FILES` oversize file, mismatched-type file, double-extension file; limit from ARCH 31.2 | Upload each | Rejected with a safe error; no PHI in the message | P1 | N, B | AUTO |
| TC-DOC-04 | AC-31, X-18 | `CMP-1` | Document on legal hold | Request deletion | Refused with reason recorded | P0 | N | AUTO |
| TC-DOC-05 | CN-12 | `PAT-01` and `PAT-02` | `PAT-01` has an uploaded clean file F1 | 1. Request an upload URL and note it goes to the object store, not the API<br>2. Upload using it<br>3. Wait until the URL has expired and try again<br>4. Use `PAT-01`'s URL to read F1 as `PAT-02` | Uploads use pre-signed URLs and never pass through the API; URLs expire; one URL cannot read another's file | P0 | SEC | AUTO |
| TC-DOC-06 | AZ | `PAT-02` | Another patient's file ID | Download by ID | `404`; logged | P0 | N, SEC | AUTO |
| TC-DOC-07 | BR-29 | `CMP-1` | Document D1 older than the retention period with no hold; document D2 younger; D3 older with legal hold; controllable clock | 1. Request deletion of D2<br>2. Request deletion of D1<br>3. Request deletion of D3 | Allowed only after the legal period and no hold | P1 | B | AUTO |
| TC-DOC-08 | Scanner outage | `PAT-01` | Malware scanner service stopped on `ENV-INT/staging` | 1. Stop the scanner<br>2. Upload a clean PDF<br>3. Try to open it as `PAT-01` and as `STF-DR-A1`<br>4. Restart the scanner and wait for the scan | File stays unavailable; visible failure; no bypass | P0 | E, SEC | AUTO |

### 9.4 Privacy requests (RA-R1-14; J-21)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-PR-01 | RA-R1-14 | `PAT-01` | `PAT-01` signed in | 1. Open notification preferences<br>2. Turn SMS off, email on<br>3. Save and reload | Saved and respected (TC-NT-08) | P2 | P | AUTO |
| TC-PR-02 | RA-R1-14 | `PAT-01` | `PAT-01` signed in with MFA; chart `SEED-CHART-1` | 1. Request a data export<br>2. Pass the identity check<br>3. Observe the status<br>4. Open the finished export from the portal | Request recorded; identity verified; compliance sees it; export assembled asynchronously in chunks, each audited; delivered via the portal, no PHI in email | P1 | P | AUTO |
| TC-PR-03 | RA-R1-14 | `PAT-01` | `PAT-01` signed in; **D-8 open** | 1. Request account deletion<br>2. Confirm identity<br>3. Open the request as `CMP-1` | Request recorded and visible to compliance. No data is deleted. What deletion means is `BLOCKED` on D-8 | P1 | P | AUTO |
| TC-PR-04 | RA-R1-14 | `PAT-02` | `PAT-01` and `PAT-02` both have exports | 1. As `PAT-02` request the export belonging to `PAT-01` by its ID<br>2. As `PAT-02` download `PAT-01`'s export file | Refused | P0 | N, SEC | AUTO |
| TC-PR-05 | RA-R1-14 | `CMP-1` | `CMP-1`; a privacy request from `PAT-01` whose identity check is not complete | 1. Open the request<br>2. Try to process the export<br>3. Record the reason for refusal | Refused with reason recorded | P1 | N | AUTO+H |

## 10. Admin, brand site, patient portal, messaging, merge and API conventions

### 10.1 System admin (RA-R1-15, 26, 31)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-AD-01 | RA-R1-15, F-AD-01 | `ADM-1` (elevated) | `ADM-1` signed in and elevated (TC-SEC-02 grant) | Create clinics, rooms, hours, holidays | Saved; audited with before/after; appear in slot search | P1 | P | AUTO |
| TC-AD-02 | RA-R1-15 | `ADM-1` | `ADM-1` elevated; the internal name "synthetic HIV clinic" and a neutral display name | Create services, including `SVC-SENS` with a neutral display name | Neutral name is required where a service name reveals a condition; patient-visible name is the neutral one everywhere (TC-NT-01) | P0 | SEC | AUTO |
| TC-AD-03 | RA-R1-15, D-3 | `ADM-1` | `ADM-1` elevated; D-3 default (block-only) in effect | Set booking policy to block-only; try to set a fee | Block-only works. Fee/price fields are stored but nothing is charged in R1 (D-3 default). Rerun if D-3 changes | P1 | P | AUTO |
| TC-AD-04 | RA-R1-15 | `ADM-1` | `ADM-1` elevated; the template editor open; variable allowlist of the message template contract (ARCH 22.13) | Edit message templates | Template variables restricted to the allowlist; a template with a free-text binding is rejected | P0 | N, SEC | AUTO |
| TC-AD-05 | RA-R1-15 | `ADM-1` | `ADM-1` and `ADM-2` elevated; a new role definition | Create a role and assign it | Needs the second approver (C4); no role is effective before approval | P0 | SEC | AUTO |
| TC-AD-06 | RA-R1-15 | `STF-FD-A` | `STF-FD-A` signed in; admin route list | Open admin routes | Refused | P0 | N | AUTO |
| TC-AD-07 | BR-04 | `ADM-1` | `ADM-1` elevated; `PAT-01`; cap = 3 | Set the future-appointment cap; test at the boundary | Cap applied (TC-BK-07) | P2 | B | AUTO |
| TC-AD-08 | RA-R1-26, F-AD-11 | `ADM-1` | Feature flag per location | Turn a flag on for LOC-A1 only | Behaviour appears at LOC-A1 and not LOC-B1; audited | P2 | P | AUTO |
| TC-AD-09 | RA-R1-26 | `ADM-1` | `ADM-1` elevated; all three hosts open in browsers | Post a maintenance banner and remove it | Visible on all hosts, no PHI, removed cleanly | P3 | P | AUTO |
| TC-AD-10 | RA-R1-26 | `ADM-1` | `ADM-1` signed in with **no** active elevation | Change flags without elevation | Refused (C1) | P0 | N | AUTO |
| TC-AD-11 | RA-R1-31 | `ADM-1` | Sandboxes: Google, email, SMS, push, analytics | For each integration: save, test, view health | Health shows OK/failed correctly with a real failure injected | P1 | P, E | AUTO |
| TC-AD-12 | RA-R1-31, BD-11 | `ADM-1` | `ADM-1` elevated; a test SMS API secret value `SECRET-TEST-1` | Save a secret, then look for it in UI, API responses, logs, exports, audit | Secrets are write-only: never displayed, logged or exported. Audit has version IDs only | P0 | SEC | AUTO |
| TC-AD-13 | RA-R1-31 | `ADM-1` | `ADM-1` elevated; an existing integration setting | Change an integration setting | Audit: who, what, before, after (secret fields as version ID) | P0 | SEC | AUTO |
| TC-AD-14 | RA-R1-31, BD-11 O-2 | `ADM-1` | Admin-entered integration secret | Compromised-`api` scenario: write an approval row and enqueue a job directly | The worker-side check refuses without approval evidence the `api` alone cannot produce | P0 | SEC | AUTO |
| TC-AD-15 | RA-R1-31 | `ADM-1` | `ADM-1` elevated; email integration healthy; a booking to confirm | Disable an integration | Dependent features fail visibly, not silently | P1 | E | AUTO |

### 10.2 Brand site (RA-R1-16, 26; F-BS-01..07)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-BS-01 | RA-R1-16 | `VIS-01` | `VIS-01` (anonymous browser); published pages; `STF-DR-A1` with free slots | Open services, doctors (with next available slot), locations, contact | Pages exist and are correct. Next available slot may be up to 60 s old | P1 | P | AUTO |
| TC-BS-02 | RA-R1-16, J-01 | `VIS-01` | `VIS-01`; a doctor page for `STF-DR-A1` | Click "Book" from a doctor page | Hand-off to `my.` with service and doctor pre-selected; if not signed in, sign-in first | P1 | P | AUTO |
| TC-BS-03 | RA-R1-16 | `STF-MKT` | `STF-MKT` signed in to the CMS; an existing page | 1. Edit a page title and body text<br>2. Publish<br>3. Open the public page as `VIS-01`<br>4. Try to open the staff host and a patient URL with the marketing session | Change goes live without a developer; marketing user cannot reach patient data | P1 | P, N | AUTO+H |
| TC-BS-04 | RA-R1-16 | QA (browser dev tools / proxy) | `VIS-01` completes a booking hand-off; analytics sandbox receiving events | 1. Open the booking journey with network recording on<br>2. Record every analytics request after consent<br>3. Search the payloads for names, DOB, phone, email, service names flagged sensitive | No health data in analytics events | P0 | SEC | AUTO |
| TC-BS-05 | RA-R1-16 | QA | Published brand site | 1. Fetch the sitemap and robots files<br>2. Run a structured-data validator on the doctor and service pages<br>3. Check title and description on five pages | Present and valid | P2 | P | AUTO |
| TC-BS-06 | NFR-17 | `VIS-01` (script client) | Public contact form; rate limit value from ARCH 31.3 | 1. Submit the form 1 time<br>2. Submit it past the rate limit from one IP<br>3. Submit with the bot-protection token missing | Protected | P1 | SEC | AUTO |
| TC-BS-07 | F-BS-06 | `VIS-01` | D-9 not decided; English only | 1. Open the site and look for a language switch<br>2. Open each page | No language switch that leads to a broken or empty page | P3 | P | AUTO |
| TC-BS-08 | RA-R1-26, F-BS-07 | `VIS-01` | Cookie banner | 1. Before consent: observe network<br>2. Accept analytics | Before consent: no non-essential analytics requests. After: allowed. Choice remembered | P1 | P | AUTO |

### 10.3 Patient portal profile, proxy and pre-visit (RA-R1-19, 20, 21)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-PP-01 | RA-R1-19 | `PAT-01` | `PAT-01` signed in | 1. Edit demographics, emergency contact, preferred pharmacy, language<br>2. Upload an insurance card image<br>3. Save and reload<br>4. Open the audit view as `CMP-1` | Changes visible and audited | P1 | P | AUTO |
| TC-PP-02 | RA-R1-19 | `PAT-01` | `PAT-01`; `SEED-ATTACK` strings | Invalid input (dates in future, long strings, scripts from `SEED-ATTACK`) | Rejected or safely escaped; no stored script | P1 | N, SEC | AUTO |
| TC-PP-03 | RA-R1-20a | `PRX-01` | `PAT-03` | Default proxy view | Appointments only (see TC-AZ-14) | P0 | P | AUTO |
| TC-PP-04 | J-03 | `PRX-01` | `PRX-01` signed in; `PAT-03` not yet linked or linked pending | 1. Request a proxy link for `PAT-03`<br>2. Check the request status as `PRX-01`<br>3. Open the request as `STF-FD-A` | Request recorded; link needs verification (TC-PP-05 rules) | P1 | P | AUTO |
| TC-PP-05 | RA-R1-20b, AC-32 | `PRX-01` | `PAT-03` turns the age of consent | Age-out and revocation | **`BLOCKED` on D-7 / G-07**: rule values do not exist yet. Written when values are decided | P1 | E | BLOCKED |
| TC-PP-06 | RA-R1-21 | `PAT-01` | **[G2 setting]** 72 h before | Receive the request; complete the questionnaire; e-sign consents; upload insurance cards | Staff see completion status; consent versions stored with date | P1 | P | AUTO |
| TC-PP-07 | RA-R1-21 | `PAT-01` | Partial completion | Leave incomplete and check the staff view | Staff see "incomplete" and which items | P2 | P | AUTO |

### 10.4 Staff messaging and tasks (RA-R1-25)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-MSG-01 | RA-R1-25, F-DR-12 | `STF-DR-A1`, `STF-FD-A` | `STF-DR-A1` and `STF-FD-A` signed in at LOC-A1; email sandbox | Create a task; send a secure message | Delivered in the alert/task area; audited; no PHI in any email/SMS notice about it | P1 | P | AUTO |
| TC-MSG-02 | RA-R1-25 | Staff outside the org | `STF-FD-A` (ORG-1) and a user of `ORG-2` | 1. Try to send a secure message to the `ORG-2` user<br>2. Try to assign a task to the `ORG-2` user | Refused | P0 | N | AUTO |
| TC-MSG-03 | RA-R1-25, D-5 | `PAT-01` | D-5 decision known (retains F-PP-09 or not) | Patient messaging | Tested only if D-5 retains F-PP-09. Otherwise the case is `N/A` and recorded as such | P2 | P | AUTO |
| TC-MSG-04 | RA-R1-25 | `PAT-01` and `STF-FD-A` | `SEED-ATTACK` script string | 1. `PAT-01` sends a message containing the string<br>2. `STF-FD-A` opens it<br>3. Check page source and browser console | Script not executed; stored safely | P1 | SEC | AUTO |

### 10.5 Duplicate detection and merge (RA-R1-27, BR-37; HEAAA-12 9.2)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-MG-01 | RA-R1-27 | `STF-FD-A` | `SEED-DUP` | Register a patient with matching name, DOB and phone/email | Duplicate warning shown; user can proceed or cancel; the matching function returns no out-of-scope demographics | P0 | S | AUTO |
| TC-MG-02 | RA-R1-27, BQ-3 | `STF-MRO-A` | `SEED-DUP` | Request a merge of `PAT-04` into `PAT-05`; approve per the approval rule | After approval: survivor's chart shows both histories; merge audited with both IDs and counts | P0 | S | AUTO |
| TC-MG-03 | RA-R1-27 | `STF-FD-A` without `patient.merge` | `STF-FD-A` without `patient.merge`; `SEED-DUP` | Request a merge | Refused | P0 | N | AUTO |
| TC-MG-04 | 9.2 | Requester sees only one patient | Patients cared for at different locations | Merge | Whole merge completes; all rows of both patients handled (the job runs with the exact patient IDs, not the requester's scope) | P0 | S | AUTO |
| TC-MG-05 | 9.2 | `STF-FD-A` of the survivor's location | `SEED-DUP` merge completed; a signed note authored under `PAT-04` | 1. Open the survivor chart<br>2. Open the signed note originally written under `PAT-04`<br>3. Read the `patient_id` of the note through the audit/API view | Visible; original `patient_id` retained | P0 | S | AUTO |
| TC-MG-06 | 9.2 | `STF-MRO-A`, fault injector | `SEED-DUP`; an injected failure in one participant module (e.g. documents) | 1. Enable the injection<br>2. Approve the merge<br>3. Read both patients' data and the request status<br>4. Open the operations alerts | Everything rolls back; no partial merge; operations alert; request `failed` | P0 | E | AUTO |
| TC-MG-07 | 9.2 | Stale staff session and stale patient portal session | Two stale sessions opened before the merge: a staff session on `PAT-04`'s chart and a patient portal session of `PAT-04`; `SEED-DUP` merge then approved | 1. Merge `PAT-04` into `PAT-05`<br>2. In the stale staff session, save a note on `PAT-04`<br>3. In the stale portal session, book an appointment as `PAT-04` | `409 patient.merged`; nothing written | P0 | X | AUTO |
| TC-MG-08 | 9.2 | API client for `STF-MRO-A` and `PAT-04` | `SEED-DUP`; slot S1 free; controllable test hooks to order the transactions | 1. Run order A: place a hold for `PAT-04` on S1, then approve the merge<br>2. Reset; run order B: approve the merge, then place the hold using the merged ID<br>3. Count holds, occupancy and rows pointing to `PAT-04` | Hold first: counted and re-pointed. Merge first: hold refused and its occupancy rolled back. Never an orphan on the merged ID | P0 | X | AUTO |
| TC-MG-09 | 9.2 | API client for `STF-DR-A1` and `STF-MRO-A` | `SEED-DUP`; test hooks to order transactions | 1. Order A: insert a note on `PAT-04`, then merge<br>2. Reset; order B: merge, then insert the note on the merged ID<br>3. Count notes on the merged ID | Same as above | P0 | X | AUTO |
| TC-MG-10 | 9.2 | Operator (queue admin) and CI | `SEED-DUP`; one queued job typed `resolve` and one typed `fail` for `PAT-04`; one job type with no declared behaviour | 1. Merge `PAT-04` into `PAT-05`<br>2. Run the queue<br>3. Check the outcomes of the two jobs<br>4. Run the CI check that lists job types and their `on_merged` declaration | Each behaves as declared; undeclared job type fails the CI check | P0 | E | AUTO |
| TC-MG-11 | 9.2 | `STF-DR-A1` | `SEED-DUP` merged; a signed note under `PAT-04` | 1. Open the signed note<br>2. Create an addendum<br>3. Read the addendum's `patient_id` and parent reference | Carries the survivor's ID and refers to its parent | P0 | S | AUTO |
| TC-MG-12 | 9.2 | API clients for `STF-MRO-A` and `STF-MRO-A2` | `SEED-DUP`; a third patient `PAT-07`; merge requests M1 (PAT-04→PAT-05) and M2 (PAT-05→PAT-07) submitted at the same moment | 1. Submit M1 and M2 simultaneously<br>2. Read both request statuses<br>3. Read the database deadlock log | `patient.already_merged`; no deadlock | P0 | X | AUTO |
| TC-MG-13 | 6.6, 6.8 | `STF-FD-A`, `STF-DR-B1`, `STF-MRO-A` | `PAT-04`, `PAT-05`, a third patient `PAT-07`; `PAT-04` seen only at LOC-A1; `PAT-07` seen only at LOC-B1 | 1. Merge A (`PAT-04`) into B (`PAT-05`)<br>2. Merge B into C (`PAT-07`)<br>3. As staff of C's location open the chart and look for A's signed notes<br>4. Book the merged patient at a new location LOC-A2 and open the chart there<br>5. End the care relationship at LOC-A2 and open again | C's staff see A's immutable rows; new location sees merged history; ending a relationship removes the merged-ID rows at that location | P0 | S | AUTO |
| TC-MG-14 | 9.2 time bound | `STF-MRO-A`, operator | A synthetic patient chart 10× the largest expected (row counts from ARCH 35.3); merge target `PAT-05` | 1. Approve the merge<br>2. Time the merge transaction<br>3. If it exceeds 60 s, confirm rollback<br>4. Read the writer-wait metric | Completes inside the 60 s transaction bound or rolls back completely and is reported; writer wait time recorded | P1 | L | AUTO |

### 10.6 API conventions (HEAAA-12 5.2) — cross-cutting

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-API-01 | CN-03 | API client with `PAT-01` and `STF-DR-A1` sessions | `ENV-INT/staging`; the R1 modules and routes of ARCH 29 (module OpenAPI files per ADR-018 once the first build ticket publishes them) | 1. For each module send an invalid body (validation error)<br>2. Send a request without a session<br>3. Send a request with a session but without the right<br>4. Force a server error (fault injection endpoint)<br>5. Read every error body | Every body is `application/problem+json` with `code`, `status`, `title`, `requestId`; no field contains names, DOB, phone, email, diagnoses; validation errors list paths, not values | P0 | SEC | AUTO |
| TC-API-02 | CN-04 | API client; `PAT-01` session; `STF-FD-A` session | `PAT-06` exists but is outside `STF-FD-A`'s scope; a route requiring a right `STF-FD-A` lacks | 1. Call a protected route with no cookie<br>2. Call a route needing a right `STF-FD-A` lacks, with its session<br>3. Call `GET /patients/{patientId}` for `PAT-06` with `STF-FD-A` | 1: `401 auth.unauthenticated`. 2: `403 auth.forbidden`. 3: `404 kernel.not_found` (CN-04, ARCH 30) | P0 | N | AUTO |
| TC-API-03 | CN-05 | API client; `STF-FD-A` session | `PAT-01` exists; access logs and proxy logs available to QA | 1. Search for `PAT-01` by name, DOB and phone with `POST …/search`<br>2. Try the same search as `GET` with query parameters<br>3. Read the access and application logs for those requests | POST works. GET with PHI in the URL is refused (404/405). Logs contain no name, DOB or phone | P0 | SEC | AUTO |
| TC-API-04 | CN-07 | API client; `STF-DR-A1` session | A draft clinical note resource with current `ETag` E1; routes per ARCH 29.3 (`PATCH /notes/{id}` with `If-Match`, ARCH 28.2) | 1. Send the `PATCH` without `If-Match`<br>2. Send it with `If-Match: E0` (stale)<br>3. Send it with `If-Match: E1` | 1: **`428 kernel.precondition_required`** (ARCH 30, `application/problem+json`, no PHI); nothing written. 2: **`412 kernel.precondition_failed`** with the current `ETag`; nothing written. 3: success and a new `ETag`. (SA-TC-03 closed; the status is now bound to ARCH 30, draft 8.1) | P1 | N | AUTO |
| TC-API-05 | CN-08 | API client; `STF-FD-A` session | At least 300 appointments in the day list | 1. Request a list with `limit=1000`<br>2. Take a valid cursor and change one character<br>3. Request a PHI list with `offset=100` | 1: at most 100 items returned. 2: refused (`400`/`422`) and no data. 3: the parameter is rejected or ignored; the page follows the cursor | P1 | B | AUTO |
| TC-API-06 | CN-10 | API client; sessions of each audience | One route per module and `/partner/*` | 1. Call a route in each module (success, error, redirect)<br>2. Read the `Cache-Control` header of each response | `Cache-Control: no-store` on every `/api/*` and `/partner/*` response | P0 | SEC | AUTO |
| TC-API-07 | CN-11 | API client; `PAT-01` session and an anonymous client | Rate limits from ARCH 31.3 (per principal, per IP; `429 kernel.rate_limited` with `Retry-After`) | 1. Send requests above the per-principal limit with `PAT-01`<br>2. Send requests above the per-IP limit anonymously<br>3. Read the status and headers of the first refused response | `429` with `Retry-After`; the next call after that time succeeds | P1 | SEC | AUTO |
| TC-API-08 | CN-12 | API client; `PAT-01` session; partner test credential | A portal endpoint and an `integrations.` endpoint that accept JSON | 1. POST a body larger than 1 MB to each<br>2. POST a valid body with an extra unknown field to a portal endpoint<br>3. POST the same to an `integrations.` endpoint | 1: refused (`413`). 2: unknown field ignored (success). 3: rejected (`400`/`422`) | P1 | B | AUTO |
| TC-API-09 | CN-01 | CI contract test runner | OpenAPI documents of all R1 modules (`contracts/openapi/<module>.yaml`, ARCH 28.1; if they are not published this case is `Blocked`); tool: Schemathesis (DEVOPS-PLAN 5.1, 14); candidate on `ENV-INT/ci` (PR run) and `ENV-INT/staging` (full run) | 1. Run the contract test against every documented R1 endpoint<br>2. List all routes the server exposes and diff with the documents | Every response matches its schema; no undocumented endpoint exists | P1 | P | AUTO |
| TC-API-10 | AL-04 (ARCH 28.6, 30, 38.2 item 20; DEVOPS-PLAN 6.1/6.2; UI-UX 7.7) | API client with `PAT-01` and `STF-DR-A1` sessions; `ADM-1` | `min_client_release` = N-1 set in the environment; releases N-1, N and N+1 builds or a header value of each; `my.` and `staff.` hosts; **`ENV-INT/ci`** for steps 1–5 and **`ENV-INT/staging`** (CloudFront in front) for steps 6–7 | 1. Call a protected route with no `X-Client-Release`, a malformed value, and a number below `min_client_release`<br>2. Call it with N-1, N and N+1<br>3. Call the four navigation routes (`GET /api/v1/auth/sign-in`, `/auth/callback`, `/calendar-link/callback`, `/appointments/{id}/calendar.ics`), `/healthz`, `/readyz` and a `/public/v1/*` route without the header<br>4. Open `GET /api/v1/alerts/stream?clientRelease=<outdated>`<br>5. Read the session idle expiry and the idempotency table before and after step 1; read response headers on `my.` and `staff.`<br>6. Request `release.json` on each portal origin and check the API access log<br>7. In a browser open a form, make `release.json` newer, then send an outdated action | 1: `400 kernel.client_release_unsupported`, `retryable: false`, standard body, no PHI, `Cache-Control: no-store`; no session write (idle expiry unchanged), no idempotency row, no business effect. 2: accepted. 3: work without the header. 4: plain `400` before any event, so the browser stops reconnecting. 5: no `Access-Control-Allow-*` header on a portal-host response. 6: `release.json` is served from CloudFront with `no-cache`, forwards no cookie and **never appears in the API log**. 7: first the non-blocking "new version" bar with Reload and Remind me later and no automatic reload; after an outdated action the blocking dialog (UI-UX 7.7); a note draft is recovered (30 s autosave, ARCH 26.2); unsaved input on other forms is lost only when the user chooses Reload | P1 | N, E | AUTO + HUMAN for the prompts (UX wording) |
| TC-API-10 | CN-13 | API client; `PAT-01` session | Tracing and log search available | 1. Make one booking request and read its `X-Request-Id`<br>2. Search logs, traces and audit for that ID | The ID appears in the response header, the log, the trace and the audit event | P2 | P | AUTO |
| TC-API-11 | 8.2 | Operator, `PAT-01` | Outbox with a job J (send confirmation email) queued; worker running | 1. Queue J<br>2. Kill the worker while J is executing<br>3. Restart the worker<br>4. Count emails sent and read the job state<br>5. Configure a job that always fails; wait for retries to exhaust; open the dead-letter view | Job retried exactly once in effect (idempotent); exhausted jobs go to the dead-letter view | P1 | E | AUTO |

## 11. Non-functional cases

### 11.1 Accessibility (NFR-10, WCAG 2.2 AA) and browsers (NFR-11)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-A11Y-01 | NFR-10 | QA | Every portal and the brand site, each key page in the R1 journeys | Run the automated accessibility scan (tool and version recorded) | No WCAG 2.2 AA violations of serious/critical impact; known exceptions listed with reason and owner | P1 | A11Y | AUTO |
| TC-A11Y-02 | NFR-10 | Human tester | `ENV-A11Y` | Keyboard only: complete sign-in, booking, check-in, note writing, admin role request | Everything reachable and operable; visible focus; no keyboard trap; logical order; the session-timeout warning is operable | P1 | A11Y | HUMAN |
| TC-A11Y-03 | NFR-10 | Human tester using a screen reader (NVDA/JAWS on Windows, VoiceOver on macOS and iOS) | `ENV-A11Y`; `PAT-01`; a chart open for `STF-DR-A1`; screen readers NVDA, JAWS, VoiceOver | Complete booking and the patient banner reading (BR-34) | Labels, roles, errors, live regions announce correctly; banner (name, DOB) is announced on chart screens | P1 | A11Y | HUMAN |
| TC-A11Y-04 | NFR-10 | Human | 200% zoom and 400% reflow; 360 px width | Complete booking and a triage entry | No loss of content or function; no horizontal scroll at 360 px | P1 | A11Y | AUTO+H |
| TC-A11Y-05 | NFR-10 | Human | `ENV-A11Y`; vitals with a highlighted out-of-range value; alert severity colours; reduced-motion OS setting | 1. Open the vitals screen and the alert list<br>2. Remove colour (greyscale or forced-colours) and check the highlight remains recognisable<br>3. Run a contrast checker on text and controls<br>4. Enable reduced-motion and text spacing; reopen | Highlights have a non-colour cue; contrast passes | P1 | A11Y | AUTO+H |
| TC-A11Y-06 | NFR-10 | Human tester (keyboard + screen reader) | `ENV-A11Y`; forms for booking and sign-up | 1. Submit each form empty<br>2. Submit with invalid values<br>3. Read the error messages with the screen reader | Errors linked to fields, announced, no PHI in the message | P1 | A11Y | AUTO+H |
| TC-A11Y-07 | NFR-10 | Human tester (screen reader; also a colour-blind simulation) | `ENV-A11Y`; triage red-flag scenario from TC-SAF-01 | 1. Trigger the red-flag alert for the doctor<br>2. Perceive it with the screen reader only<br>3. Perceive it with sound off and in greyscale<br>4. Read the patient emergency advice with the screen reader | Perceivable with a screen reader and without colour or sound | P0 | A11Y, S | HUMAN |
| TC-A11Y-08 | NFR-10 | Human tester (screen reader) | `ENV-A11Y`; video appointment with sandbox vendor | 1. Open the device check, waiting room and join page<br>2. Operate mute, camera and leave controls by keyboard<br>3. Read each control's announced name | Operable | P2 | A11Y | HUMAN |
| TC-XB-01 | NFR-11 | QA | Current Chrome, Safari, Edge, Firefox | Run the booking, check-in, note, admin smoke journey on each | Same results on all four | P1 | P | AUTO |
| TC-XB-02 | NFR-11 | QA (real devices) | iPhone with Safari, Android phone with Chrome, a tablet; `ENV-INT/staging` | 1. Sign in as `PAT-01`<br>2. Complete TC-BK-01 on each device<br>3. Rotate the device and repeat the confirmation step | Usable; no layout break | P1 | P | AUTO+H |
| TC-XB-03 | NFR-11 | `VIS-01` | An unsupported old browser version (supported set from UI-UX 9: current Chrome, Safari, Edge, Firefox; phones from 360 px) | 1. Open `my.`<br>2. Try to sign in<br>3. Check that no partial page or error stack is shown | Clear unsupported message; no data corruption | P3 | N | AUTO |

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
| TC-REC-05 | NFR-3, DEP-16 | DevOps | `ENV-DR` | Reserved. The drill is owned by TC-REC-03 and the admin sign-in/elevation check by **TC-SEC-25**; this ID has no steps of its own | None (no duplicate result is recorded here; see TC-SEC-25) | P1 | E | n/a (owned by TC-REC-03 and TC-SEC-25) |
| TC-REC-06 | NFR-21, BR-33 | QA | Block each external service in turn: Google, SMS, email, video, malware scanner, directory | Run the matching journey | Timeout and back-off retry; failure visible on the operations dashboard; no silent drop; inbound messages idempotent | P0 | E | AUTO |
| TC-REC-07 | NFR-1 | QA/DevOps | Primary DB failure | Stop the primary during load | Standby takes over; clients retry; no committed data lost; brief errors only | P0 | E | OPS + AUTO |
| TC-REC-08 | NFR-20 | DevOps | Alert rules | Trigger uptime, error rate, latency, queue backlog, integration failure | Each alert reaches a **named on-call person** (DEP-15). If there is no named rota the case fails | P0 | E | OPS + HUMAN (the on-call person confirms receipt) |
| TC-REC-09 | 8.2 | QA | Worker crash with a backlog | Kill and restart | No lost or duplicate effects | P1 | E | AUTO |

### 11.4 Security and compliance NFRs (NFR-12..19)

| ID | Req | Role | Pre / data | Steps | Expected | Pri | Type | Auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-NFR-01 | NFR-12 | QA | Each host | TLS scan | TLS 1.2+ only; strong ciphers; HSTS | P0 | SEC | AUTO |
| TC-NFR-02 | NFR-12 | DevOps | Cloud console read access for QA; list of data stores from DEVOPS-PLAN | Review encryption at rest configuration and key rotation | Databases, object storage, backups, queues encrypted; managed key rotation enabled and evidenced | P0 | SEC | OPS |
| TC-NFR-03 | NFR-15 | CI | Candidate commit | Run SAST | Report is non-empty, for the right commit, with no open blocking finding. Tool and version recorded | P0 | SEC | AUTO |
| TC-NFR-04 | NFR-15 | CI | CI pipeline run on the candidate commit | Dependency scan | Same | P0 | SEC | AUTO |
| TC-NFR-05 | NFR-15 | CI | CI pipeline run on the candidate commit; full git history available | Secret scan (history and working tree) | No secrets | P0 | SEC | AUTO |
| TC-NFR-06 | NFR-15 | CI | CI pipeline run on the candidate image digest | Container image scan | No unwaived high/critical | P0 | SEC | AUTO |
| TC-NFR-07 | NFR-15 | CI | A throwaway branch (never merged) off the candidate | 1. Add a known vulnerable dependency, a test-pattern secret and a SAST-triggering code pattern in separate commits<br>2. Push and watch CI<br>3. Delete the branch | The build fails. Proves the gate works, not only that it is configured | P0 | SEC | AUTO |
| TC-NFR-08 | NFR-14 | Security Reviewer | ASVS 4/5 checklist template; the candidate; access to code and test results | ASVS L2 checklist; L3 for authentication, prescribing and payment paths (R1: authentication) | Checklist complete, evidence per item | P0 | SEC | HUMAN (Security Reviewer) + AUTO |
| TC-NFR-09 | BR-35 | QA | All seed and fixture files; scanner for names/emails/phones/SSN-like patterns | Scan seed and fixture files for real-identifier patterns; confirm no production data is in non-production | None found | P0 | SEC | AUTO |
| TC-NFR-10 | NFR-18, BR-36 | QA | Logs after all journeys | Scan logs, traces, error pages and analytics for names, DOB, phone, email, diagnoses, medicines, test names | None found | P0 | SEC | AUTO |
| TC-NFR-11 | NFR-19 | Owner/DevOps | Owner/DevOps hold the BAA documents; list of vendors that handle health data | Show the signed BAA with the hosting provider and every vendor that touches health data | On file before go-live; US region. QA reads the evidence; it does not judge legal sufficiency | P0 | SEC | HUMAN |
| TC-NFR-12 | NFR-17 | QA | Public forms | Rate limit, bot protection, upload scanning (TC-BS-06, TC-DOC-03) | Hold | P1 | SEC | AUTO |
| TC-PEN-01 | NFR-16 | Independent tester | Candidate with the external surface | Independent penetration test before the production release | Report with no open high/critical findings. The independent tester is named. Absence of one is recorded, not waived (RA-R1-18) | P0 | SEC | HUMAN |
| TC-NFR-13 | RA-R1-18 | Owner | A claimed exception | Check the exception record | Only for allowed NFRs (NFR-1..11, 20..22); never NFR-12..19, safety rules or legal requirements. Written, with reason, compensating control, expiry, and the independent reviewer's acknowledgement — or, with no independent reviewer, recorded as **self-granted by the owner** | P0 | SEC | HUMAN |

## 12. Human-required register (all `Pending-human`)

These cases need a real person or an operations exercise. They stay **pending** until that person performs them. QA records the person's identity, the date and the evidence they supply, and never fills in a result for them. A written case is not an executed case.

| Person / role | Cases | What they must do |
| --- | --- | --- |
| Owner (product owner, Zain Naeem holds every gate role, PRD RK-5) | TC-SAF-07, TC-NFR-11, TC-NFR-13, TC-ID-07 (evidence) | Decide the R1 safety reviewer (D-12a), produce the BAA evidence, grant or refuse any NFR exception, provide the Workspace policy export |
| Licensed clinician (not yet named, D-12) | TC-SAF-07, TC-SAF-02 (timing, after PM-confirm-1), TC-CL-09, TC-SAF-08 (rule text review) | Review the R1 safety rules and test results; judge wrong-patient risk. **If none exists, the PRD interim self-review route applies and is reported as self-review** |
| Accessibility tester with assistive technology | TC-A11Y-02, 03, 07, 08 (and the human part of 04, 05, 06) | Keyboard and screen-reader runs on real devices |
| Device testers | TC-ID-03, TC-ID-04, TC-ID-05, TC-PC-02, TC-TH-01, TC-XB-02, TC-NT-03 | Passkey/security key, 2SV on a real device, phone camera QR, audio and video, three calendar clients |
| Two named people (dual control) | TC-SEC-03 (physical key), TC-SEC-05, TC-SEC-11, TC-SEC-16, TC-SEC-23 | Bootstrap and enrolment under dual control; timed deprovisioning |
| DevOps / operations owner | TC-SEC-17, TC-SEC-19, TC-SEC-25, TC-AU-09, TC-NFR-02, TC-REC-01..05, TC-REC-07, TC-REC-08 | Restore tests, DR drill, policy exports, alert test with a named on-call person |
| Security Reviewer / Cybersecurity | TC-SEC-24, TC-NFR-08 | ASVS checklist and the path B spike review |
| Independent penetration tester | TC-PEN-01 | Independent test before the production release |
| Marketing user | TC-BS-03 | Edit and publish without developer help |
| Compliance officer | TC-PR-05, TC-AZ-11 | Real review decisions |
| UI/UX designer or owner | TC-PC-15 (red allergy block and chip legibility at 360 and 1280 px), TC-API-10 step 7 (prompt wording) | Judge what a script cannot |

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
| QA-AL-01 (ARCH gap) | TC-CAL-05 step 8 (`410 Gone` sync token) | Question to Solution Architect via Orchestrator; step blocked |
| QA-AL-02 (no billing role in R1) | `STF-BILL-A` negative uses only | Question to PM; no case depends on it |
| D-12a (vital ranges) | TC-CL-10 range content | Mechanism testable; clinical content not asserted |
| PM-confirm-1 | TC-SAF-02: escalation of an unacknowledged red-flag alert to the on-call doctor and its timer (PRD J-07/A-17 "derived") | Question to PM via Orchestrator; assertion withheld |
| PM-confirm-2  | TC-PC-05: order of the triage queue by category (PRD RA-R1-06 states category and wait time only) | Question to PM; ordering not asserted |
| PM-confirm-3 | TC-NT-08: security messages sent even if a channel is turned off (not in the PRD) | Question to PM; not asserted |
| SEC-confirm-1 | TC-SEC-C7-04/05: path B equivalent of "outside the OU" and "super-admin" (Architecture C7 is path A wording) | Question to Cybersecurity via Orchestrator |
| Sandboxes (DEVOPS-PLAN 3.5 bound): Google Workspace test tenant (with an admin OU and Directory API), email/SMS, video vendor | Many AUTO cases | Not confirmed to exist. A case that needs one stays blocked rather than being mocked |

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
| RA-R1-06 | TC-PC-01..09, TC-PC-13..15 (the last three serve BR-34 and UX-R1) | |
| RA-R1-07 | TC-SAF-01..04, TC-PC-16 (alert countdown and acknowledge mechanics) | **Blocked until D-12a** |
| RA-R1-08 | TC-SAF-05..08 | **Blocked until D-12a** |
| RA-R1-09 | TC-CL-01..07 | |
| RA-R1-10 | TC-TH-01..05, TC-PERF-06 | Video vendor sandbox |
| RA-R1-11 | TC-AU-01..04, TC-AZ-10, TC-AZ-11, TC-AZ-16 | |
| RA-R1-12 | TC-AU-05..09 (TC-AU-10 is a reserved ID owned by TC-PERF-04; not counted here) | Retention set at G2 |
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
| RA-R1-24 | TC-CL-08..10, TC-PC-07, TC-PC-13..15 | TC-CL-10 mechanism only; range content waits for D-12a |
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
| AC-13..AC-25, AC-26..AC-29 | AC-13..AC-22 are R2 and AC-23..AC-29 are R3 (section 14); no R1 case | AC-30 | TC-DOC-02 |
| AC-31 | TC-DOC-04 | AC-32 | TC-PP-05 (blocked) |
| AC-33 | TC-ID-09 | AC-34 | TC-AZ-01 |
| AC-35 | TC-AZ-02 | AC-36 | TC-AU-05 |
| AC-37, AC-38 | R2 (section 14) | | |

### 15.3 Safety-critical rules (PRD 7, 8.3) — R1 subset

| Rule | Positive | Negative | Boundary | Not covered / note |
| --- | --- | --- | --- | --- |
| BR-09 | TC-SAF-05 (consent present starts), TC-SAF-06 | TC-SAF-05, TC-SAF-06 (no reason refused), TC-PC-08 | TC-SAF-08 (one of two, old version, just signed, withdrawn) | Review by D-12a reviewer: TC-SAF-07 |
| BR-10 | TC-SAF-01 | TC-SAF-03 (non-flag, blank), TC-SAF-04 (channel down) | TC-SAF-03 (near-miss answers), TC-SAF-02 (timing, after PM-confirm-1) | Review: TC-SAF-07 |
| BR-14 | TC-AZ-10 | TC-AZ-10, TC-AZ-11 (reviewer cannot be the opener) | TC-AZ-16 (reason length limits) | |
| BR-34 | TC-PC-07, TC-CL-08, TC-PC-15 (allergy block, `null` chip) | TC-PC-13 (route sweep, stale tab) | TC-PC-14 (no photo, long name, same-name patients) | Human judgement of wrong-patient risk: TC-CL-09, TC-A11Y-03 |
| BR-37 | TC-MG-01, 02 | TC-MG-03, 06, 07 | TC-MG-14 (large chart) | Concurrency: TC-MG-08, 09, 12 |
| BR-15, 16, 17 (partly), 19, 20, 22, 24, 25, 26, 27 | R2/R3 (section 14). BR-17 re-authentication to sign: TC-ID-08 (positive and negative; no boundary case in R1) | | | |

None of these can be waived by client acceptance. A rule whose cell above is empty has no case; the table states actual coverage, not an intent.

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
- **Design inputs are bound in draft 5 but not frozen.** Names of screens, routes, role keys, error codes, tools and environments are bound to ARCHITECTURE draft 8.1, UI-UX draft 6 and DEVOPS-PLAN draft 6 (header, section 20). Those revisions have open Low/Medium findings (UXR-09, UXR-12a, UXR-13, DPR-37..39) and no Orchestrator frozen manifest yet. If a later revision renames anything used here, only the affected rows are rebound.
- **Path B is the default** (D-35) and path A is still possible. The cases are tagged; a change of path reopens the tagged cases.
- **HEAAA-12 section 7, 9.1 and 10** still need the Cybersecurity review. If it changes them, the section 5 cases and TC-AD-12/14 change with it.
- The load figures, thresholds and values marked **[G2 setting]** are PRD proposals; they become test values only when G2 decides them.
- Test automation tools are the DEVOPS-PLAN draft 6 Recommendations (0.3 "Tools"). They become selections only at G2; k6 against SSE and the licence of k6 (AGPL) are unverified.
- Third-party sandboxes: the Google Workspace test tenant is open (owner decision and a domain, DEVOPS-PLAN 16 item 19); email/SMS/video vendors are not chosen; the e-prescribing sandbox is out of DevOps scope; malware-scan test objects use the EICAR string and a synthetic receiver (in scope).
- Not legal or clinical advice. Rule text for safety-critical behaviour needs the licensed reviewer (D-12/D-12a).
- The Cybersecurity comment `e6414334` and ARCHITECTURE section 8.4 (git `f8d3d6e`) were both re-read for draft 2; the comparison and the difference between them are in 5.5. The PRD at `f8d3d6e` was used to check the PM-confirm items.

**Review state.** Author: QA agent. Product Owner Reviewer (AI): round 1 (draft 1) CHANGES REQUIRED, TC-RV-01..07; round 2 (draft 2) CHANGES REQUIRED, TC-DR2-01; round 3 (draft 3, rev `47525663`) PASS. Solution Architect (AI) on draft 3: CHANGES REQUIRED, SA-TC-01..05; on draft 4 (rev `9d3f1ec1`): SA-TC-01..05 closed, SA-TC-06 Low open. Draft 5 answers SA-TC-06 and AL-05/AL-08 (sections 19 and 20) and awaits review of the diff by the Solution Architect and, because journeys changed, the Product Owner Reviewer. A review PASS is not human approval.

**Cumulative review round for this artifact:** 3 of 3 used, plus the bounded fourth cycle (SA-TC-01..05), plus this single re-binding revision under HEAAA-17 cycle `a524dfdd`. Not reset. Any finding left open after this revision needs a new human decision.

**Next permitted action.** Independent review of the exact saved draft 5 revision (diff against `9d3f1ec1`). Then the Orchestrator re-joins the lanes and freezes the manifest. The G2 package includes `TEST-CASES.md`; the human decision on the exact revision happens at G2. No test is executed before a candidate exists and valid G2 permits implementation.


## 18. Review findings and how draft 2 answers them (round 1, Product Owner Reviewer)

| ID | Sev | Answer in draft 2 | Where |
| --- | --- | --- | --- |
| TC-RV-01 | High | C7 quoted from ARCHITECTURE 8.4 and from comment `e6414334`; "verbatim" dropped; the Architecture's seven items are a superset of the comment's four, each mapped to a comment condition; path B wording gap raised as SEC-confirm-1 | 5.5, 13, 17 |
| TC-RV-02 | Med | New cases TC-SAF-08 (BR-09 boundary), TC-PC-13 (BR-34 negative), TC-PC-14 (BR-34 boundary), TC-AZ-16 (BR-14 boundary). 15.3 rewritten as a per-rule table of actual coverage | 8.1, 8.2, 6, 15.3 |
| TC-RV-03 | Med | Every row with an empty Role or Pre cell now has both, and the named rows have numbered steps with concrete values (TC-BK-21, TC-PC-09, TC-AU-03/04/09, TC-CAL-05, TC-API-*, TC-MG-08..13, TC-TH-02/05/08). Rows that still describe one action are single-step by nature | 6–11 |
| TC-RV-04 | Med | One owner per check: DR drill = TC-REC-03, admin-during-failover = TC-SEC-25 (TC-REC-05 is a reserved pointer with no result); hourly re-check = TC-SEC-18, assignment refusal = TC-SEC-C7-04; audit load = TC-PERF-04 (TC-AU-10 kept as a reserved pointer and left out of the matrix) | 5.4, 5.5, 9.2, 11.3, 15.1 |
| TC-RV-05 | Med | TC-SAF-02, TC-PC-05, TC-NT-08 tagged PM-confirm-1..3 and the unsupported assertion withheld. TC-CL-04 now cites PRD (SA-F-08, [Rec]) and stops at the saved flag in R1. TC-SEC-04/05 cite Architecture 8.4 C1/C4. TC-SEC-04/05 specifics are architecture rules, not PRD rows | 7.4, 8.1, 8.2, 8.3, 13 |
| TC-RV-06 | Low | One definition: acceptance of RA-R1-07/08 is blocked until D-12a; running TC-SAF is permitted and never counts as review. TC-SAF-02 shown consistently as AUTO with human timing review after PM-confirm-1; register updated | 8.2, 12 |
| TC-RV-07 | Low | AC-13..AC-22 are R2 and AC-23..AC-29 are R3 | 15.2 |

The review round counter is 1 of 3. No new scope was added beyond the four cases that close TC-RV-02.


## 19. Solution Architect findings and how draft 4 answers them (bounded fourth cycle)

| ID | Sev | Answer in draft 4 | Where |
| --- | --- | --- | --- |
| SA-TC-01 | Med | Header, section 17 review state and cumulative round, and this footer now identify draft 4 and record the real review history | header, 17, 19 |
| SA-TC-02 | Med | TC-CAL-05 rewritten around Google channel ID and token validation, replay, stale message number and sync-token `410`, with checkable counts; no signature assumption | TC-CAL-05 |
| SA-TC-03 | Low | TC-API-04 no longer asserts `428`; the status is bound at HEAAA-17 | TC-API-04 |
| SA-TC-04 | Low | TC-ID-05 states the refusal comes from Workspace policy only | TC-ID-05 |
| SA-TC-05 | Low | TC-AU-04 checks the `transaction_timeout` setting and adds a positive control (step 4) | TC-AU-04 |

Only these five rows and the review-state text changed. Nothing was executed. This is not G2 and not human approval.


## 20. Draft 5: the single re-binding revision (HEAAA-51; AL-05, AL-08, SA-TC-06)

Nothing here was executed. Only the rows named below and the header, 0.3, 2, 15 and 17 changed.

### 20.1 Finding disposition

| ID | Sev | Answer in draft 5 | Where |
| --- | --- | --- | --- |
| SA-TC-06 | Low | (a) TC-AU-04 step 2 uses a value above the bound (B + 1 s; 60 s in production). The 2-minute value is the anchoring watermark, not the bound. (b) Step 3 expects a privilege error `42501` for `app_owner` (no INSERT grant), not a trigger error. Step 4 unchanged | TC-AU-04 |
| AL-05 | Med | 0.3 rewritten: `ENV-INT` split into `ci`, `staging`, `bootstrap`; `ENV-LOAD` = `loadtest`; `ENV-DR` = synthetic recovery-region rehearsal (not `restore-test`); `ENV-A11Y` = `staging`. Test tenant and sandboxes named with owner and status. 14 case rows bound to one sub-environment | 0.3, 14 rows |
| AL-08 | Low | Error codes, statuses, routes, screens, role keys, tool and environment names bound (20.2). TC-API-04 = `428 kernel.precondition_required` / `412 kernel.precondition_failed`. TC-CAL-05 rebound to ARCH 29.5 (steps split; step 5 no longer "ignored"; step 8 is an architecture gap). Values "from HEAAA-13/14" replaced by section pointers | rows in 20.2 |
| AL-01 (consumer) | High | TC-PC-13/14 rebound to the banner contract; new TC-PC-15 (allergies in the banner, null for read-only roles, audit); chart cases use `banner: true` routes | TC-PC-13..15 |
| AL-02 (consumer) | Med | New TC-PC-16 (`escalatesAt`, acknowledge, `409 notifications.alert_closed`) and TC-CL-10 (vital ranges; blocked on D-12a for content) | TC-PC-16, TC-CL-10 |
| AL-04 (consumer) | Med | New TC-API-10 (`X-Client-Release`, `400 kernel.client_release_unsupported`, exempt routes, SSE query parameter, no CORS, `release.json`) | TC-API-10 |

### 20.2 Binding table

| QA text in draft 4 | Bound to |
| --- | --- |
| Slot taken; hold expired | `409 scheduling.slot_taken` (`POST /holds`); `409 scheduling.hold_expired` (`POST /appointments/{reservationId}/confirm`), each with `alternatives` (ARCH 29.2, 30) |
| Stale edit; missing `If-Match` | `412 kernel.precondition_failed`; `428 kernel.precondition_required` (ARCH 28.2, 30) |
| No session; no right; out of scope | `401 auth.unauthenticated`; `403 auth.forbidden`; `404 kernel.not_found` (CN-04) |
| Elevation required | `403 identity.elevation_required` (ARCH 30) |
| Idempotency | `Idempotency-Key`; `400 kernel.idempotency_key_required`; `409 kernel.idempotency_conflict` |
| Client release | `400 kernel.client_release_unsupported` (ARCH 28.6, not 426) |
| Closed alert | `409 notifications.alert_closed` |
| Google push | `POST /webhooks/google/calendar`; `401` on failed verification; `<channel_id>:<message number>` de-duplication (ARCH 29.5) |
| Patient banner | `patientBanner` on every `banner: true` route; `GET /patients/{patientId}/banner` (ARCH 28.2, 29.3) |
| Role keys (ARCH 27.3) | `front_desk` (STF-FD-A), `front_desk_lead`, `medical_records` (STF-MRO-A), `triage_nurse` (STF-TRI-A), `care_coordinator` (STF-COORD-A), `doctor` (STF-DR-*, STF-ONCALL), `trainee_doctor` (STF-TRN-A), `assistant` (STF-ASST-A), `org_admin` (ADM-*), `compliance_officer` (CMP-1/2), `compliance_on_call`. Billing and marketing: no R1 role. The BQ-3 proposal for `STF-MRO-A` ("front-desk lead / medical records") is bound to `medical_records` with `patient.merge.approve` and `front_desk_lead` with `patient.merge.request` |
| Screens (UI-UX 4) | PC-01 Arrivals board, PC-02 Check-in, PC-06 Red-flag alert bar, DR-01..DR-09, DR-10 Alert tray, SH-01 Upload, SH-02 Document viewer, SH-03/SH-04 Sign-in, SH-05 Session warning, AD-01 Audit log, AD-02 BTG review, PP-12 Date & time, PP-13 Confirm. Cases keep role and action wording; where a case names a screen it uses these IDs |
| Tools; environments | 0.3 |

### 20.3 New findings raised by this revision (routed, not fixed here)

| ID | Sev | Finding | Owner |
| --- | --- | --- | --- |
| QA-AL-01 | Low | ARCH keeps `calendar_link.sync_token` and the `incremental_sync` job but states no behaviour for a `410 Gone` sync token. TC-CAL-05 step 8 is `Blocked` until the rule exists | Solution Architect |
| QA-AL-02 | Low | The intake and PRD actors include billing staff (A-13) but ARCH 27.3 has no R1 role for them. `STF-BILL-A` is used only as a no-role principal. If the owner wants a billing role in R1, cases are added | Product Manager / Solution Architect |
| QA-AL-03 | Info | DEVOPS-PLAN DPR-35 makes staging deploys manual and per selected candidate. QA evidence on `staging` is therefore valid only for the candidate named in the manifest; a result for another commit is rejected (section 16) | DevOps |

Review state of QA-AL-01..03: not yet reviewed. They are new IDs, not a reset of the round ledger.
