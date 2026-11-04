# PRD — Enterprise EHR Platform

| Field | Value |
| --- | --- |
| Task | HEAAA-6 `[SDLC:prd-draft]` |
| Author | Product Manager agent (`9e1cccef-0613-43d7-9a6e-6f0f83127f44`) |
| Version | **PRD draft 1** (frozen for parallel review; see section 17 for the revision manifest) |
| Baseline sources | Intake pack revision 2 (`docs/intake/`, commit `6ea01b5`); Intake-Readiness (HEAAA-3, 87.5 %); Research appendix (HEAAA-4 `research` rev `dc45ec56`); BA feature map (HEAAA-5 `ba-feature-map` rev `849217d2`, independently reviewed PASS with non-blocking notes R-01..R-06) |
| Status | **DRAFT. Not independently reviewed. Not human-approved. This is not G1.** Product Owner Reviewer (HEAAA-7) and Solution Architect (HEAAA-8) review this exact revision in parallel. |
| Review round | 0 of 3 (cumulative) |

## 0. How to read this PRD

Every statement carries one of these labels. Only **Confirmed** items enter acceptance.

| Label | Meaning |
| --- | --- |
| **Confirmed** | Stated in the intake pack as decided by Zain Naeem (product owner), with source tag, e.g. `[01 §6]` = `01-PRODUCT-BRIEF.md` section 6, `[07 A3]` = open-questions row A3. |
| **Derived** | Follows directly from confirmed text; I made no new product choice. |
| **Recommendation** | My proposal or a research/BA proposal. Not scope until a human adopts it at G1. |
| **Open** | A business decision nobody has made (section 13). Not in acceptance; the PRD states how the item is treated until decided. |

Feature, rule, state, journey, exception and acceptance IDs (`F-`, `BR-`, `ST-`, `J-`, `X-`, `AC-`, `G-`) come from the BA feature map (Appendix C) and are stable. This PRD adds `OUT-` (outcomes), `RA-` (release acceptance), `NFR-` (quality targets) and `D-` (decisions requested). Nothing in this PRD authorises a purchase, vendor contact, scaffolding or any implementation. Those wait for G1 and G2.

## 1. Problem and opportunity

**Confirmed** `[01 §1–2]`. A US multi-clinic healthcare network (30+ clinics) runs care across disconnected tools:

1. Booking over phone, spreadsheets and personal calendars causes double bookings, no-shows and long hold times.
2. Patient information is split across paper, lab PDFs and separate systems, so doctors search for history during consultations.
3. Prescriptions travel by paper or phone and are re-keyed by pharmacies, which risks errors and gives patients no status.
4. Patients cannot see where a medicine is after it leaves the doctor.
5. Lab orders and results move by fax or email, so abnormal results can be missed.
6. Leadership has no reliable view of capacity, revenue, turnaround or compliance.

**Product.** One secure web platform with six surfaces (brand site, patient portal, pre-consultation portal, doctor portal, partner pharmacy portal, system admin portal) on shared modules. Many external pharmacies fulfil prescriptions and run their own deliveries; the platform shows the patient what the pharmacy reports `[07 A3, B5]`.

**Differentiator (Recommendation, hypothesis H1, grade T/U in research).** None of the five compared products verifiably offers a partner-pharmacy portal with pharmacy-reported delivery tracking shown to patients. Treat this as a hypothesis, not a reason to widen scope.

## 2. Outcomes and success measures

**Confirmed** `[01 §3]`, agreed 2026-11-02, measured within 12 months of R1 production release. Baselines are not recorded anywhere in the sources (see D-14), so each target is an absolute level, not an improvement percentage.

| ID | Goal | Measure | Target | Measured from | Release that enables it |
| --- | --- | --- | --- | --- | --- |
| OUT-1 | Easier access | Share of appointments booked online | ≥ 60 % | Appointment records by booking channel | R1 |
| OUT-2 | Fewer missed visits | No-show rate after reminders | < 8 % | Appointment status No-show ÷ (Completed + No-show) | R1 |
| OUT-3 | Faster consultations | Median time a doctor spends finding history | < 1 min | Chart-open to first note/order event, sampled; method to be agreed (D-14) | R1 |
| OUT-4 | Safer prescribing | Prescriptions with interaction/allergy check | 100 % | Check outcome recorded on every signed prescription (BR-15) | R2 |
| OUT-5 | Faster medicines | Prescription sent to pharmacy acknowledgement, median | < 2 h | Sent → acknowledgement event; definition of "acknowledged" is **Open** (G-05) | R2 |
| OUT-6 | Visible delivery | Pharmacy deliveries with tracking status shown to patient | ≥ 95 % | Deliveries with ≥ 1 pharmacy-reported status visible ÷ deliveries; applies only to partner pharmacies | R3 |
| OUT-7 | Lab safety | Critical results acknowledged within policy window | 100 % | Critical-result alert → acknowledgement; window is **Open** (G-11) | R3 |
| OUT-8 | Patient satisfaction | Portal CSAT | ≥ 4.5 / 5 | In-portal survey; instrument and sampling to be set at G2 (D-14) | R1 onward |

Notes. OUT-5, OUT-6 and OUT-7 depend on open definitions and cannot be tested until G-05, G-02 and G-11 are decided. OUT-6 has an unavoidable limit: non-partner pharmacies report nothing `[02 §5]`, so the 95 % applies to partner-pharmacy deliveries.

## 3. Audiences

**Confirmed** `[01 §4]`; BA actor IDs in Appendix C §1.

| Audience | Surface | What they need to achieve | BA actors |
| --- | --- | --- | --- |
| Visitor | Brand site | Find services, doctors, locations; start booking | A-01 |
| Patient, guardian/proxy | Patient portal | Book, attend, view record, order medicines, pay | A-02, A-03 |
| Front desk, triage nurse, care coordinator | Pre-consultation portal | Prepare each patient before the doctor | A-04, A-05, A-06 |
| Doctor; nurse/assistant; trainee; on-call doctor | Doctor portal | Consult, document, prescribe, order and review labs | A-07, A-08, A-09, A-17 |
| Lab coordinator | Lab desk | Track samples and results | A-10 |
| Partner pharmacist / technician | Partner pharmacy portal | Receive, verify, fulfil; report pickup/delivery status | A-11 |
| Non-partner external pharmacy | None (network only) | Receives prescriptions via e-prescribing network | A-12 |
| Billing staff | Admin portal | Invoices, payments | A-13 |
| Marketing/content staff | Brand-site CMS | Edit public content | A-14 |
| Organisation / system admin | Admin portal | Configure clinics, users, roles, services, integrations | A-15 |
| Compliance officer | Admin portal (read-only audit) | Review access, consents, incidents, break-the-glass | A-16 |

Decision-makers: Zain Naeem holds every gate role `[07 A6, E]`. No independent clinical, security or QA reviewer exists (Open, D-12).

## 4. Scope

### 4.1 In scope (Confirmed `[01 §5]`)

- Six surfaces listed in section 1.
- Shared modules: appointment booking and scheduling; Google Calendar integration; telehealth video; clinical record; e-prescribing including EPCS to external pharmacies; delivery status visibility (pharmacy-reported); lab orders and results; document management; secure messaging and notifications; payments and invoicing; reporting; audit.
- Multiple clinics and locations under one organisation with per-location settings.
- Responsive web on desktop, tablet and phone browsers (Chrome, Safari, Edge, Firefox current versions; phones from 360 px) `[05 §5]`.
- United States only `[07 A1]`.

### 4.2 Out of scope (Confirmed `[01 §5]`, `[04 §5]`)

See section 12 for the full exclusion list. Nothing there is acceptance-tested.

### 4.3 Releases (Confirmed `[01 §6]`, agreed 2026-11-02)

| Release | Contents | Target |
| --- | --- | --- |
| **R1 Foundation and booking** | Identity, Google Workspace SSO for staff, roles, clinics/locations, brand site, patient portal (register, book, reschedule, cancel, reminders, telehealth join), doctor schedule and Google Calendar sync, pre-consultation forms and triage queue, basic clinical notes, document upload, system admin, audit log | Production by end of May 2027 |
| **R2 Prescribing and pharmacy network** | E-prescribing with interaction/allergy checks including EPCS; sending via a certified network; partner pharmacy portal; refills; patient medicine status; card payments | A later quarter after R1 (no date) |
| **R3 Delivery visibility and labs** | Pharmacy-reported delivery status and tracking links; lab orders, external lab interface, results inbox, critical-result alerts, patient result release | A later quarter after R2 (no date) |
| **R4 Enterprise extensions** | Insurance eligibility and claims, advanced analytics, warehouse export, AI scribe (if approved), native mobile apps | After R3 (no date). **Not committed**: outside the R1–R3 budget and all acceptance in this PRD. |

### 4.4 Scope control (Recommendation)

The R1 list is wide for roughly six months and a US$150–300k build budget covers R1–R3 `[01 §7, §8]`. The intake itself says to trim at G1 rather than mid-build. This PRD therefore keeps the agreed priorities untouched and gives, in section 13, the decisions that determine R1 size (D-1 build/buy, D-3 R1 fees/payments, D-4 R1 lab collection, D-5 R1 messaging, D-6 R1 visit summaries). Section 4.5 shows the **minimum R1 slice that the confirmed sources require** and the items whose R1 membership is contested.

### 4.5 R1 composition

**R1 confirmed (M priority, no conflict)**
- Brand site: F-BS-01..05, F-BS-07 (F-BS-06 multilingual is S and English-only until D-9).
- Patient portal: F-PP-01..08, F-PP-14, F-PP-16.
- Pre-consultation: F-PC-01..04, F-PC-06 and the S items F-PC-05 (manual) and F-PC-09.
- Doctor portal: F-DR-01, 02, 04, 05, 06, 12.
- Admin: F-AD-01..09 and S item F-AD-11.
- Shared: F-SH-01..05, F-SH-08, F-SH-10; F-SH-06 (R1 part: problems, allergies, medications, vitals, notes).
- S items in R1: F-PP-09 (patient secure messaging), F-PC-05 manual eligibility, F-PC-09, F-AD-11.

**R1 contested (BA conflicts; held from acceptance until decided)**
- Fees and deposits (G-03 → D-3). F-AD-04 booking policy ships in R1 as **block-only**; deposits and cancellation fees need payments (R2).
- Lab sample collection booking in F-PC-07 (G-04 → D-4). Held out of R1 unless the owner defines a non-integrated placeholder.
- Patient-visible visit summary (G-15 → D-6). Held out of R1 until decided; notes remain clinician-visible.
- Patient messaging scope (G-14 → D-5). F-DR-12 tasks and staff-to-staff messages are R1; patient-facing messaging is S priority and follows D-5.

## 5. Priorities

Priorities **M** (must for its release), **S** (should), **C** (could) are copied verbatim from `02-PORTALS-AND-FEATURES.md` and not re-ranked `[02 header]`. Full tables with IDs, priority and release: Appendix C §2. Summary counts from the BA map:

| Release | Must | Should | Could |
| --- | --- | --- | --- |
| R1 | all features listed in 4.5 marked M | F-BS-06, F-PP-09, F-PC-05 (manual), F-PC-09, F-AD-11 | none |
| R2 | F-PP-10, 11, 15; F-DR-07, 08; F-PH-01..06; F-SH-07 | F-DR-11, F-AD-10, F-SH-09 | F-BS-08 |
| R3 | F-PP-12, 13; F-PC-08; F-DR-09, 10; F-PH-07, 08 | F-PH-09 | F-BS-09 |
| R4 | none committed | none | F-DR-03, F-DR-13, F-AD-12, electronic eligibility and claims |

Within a release, any M item that cannot meet its acceptance criteria blocks that release; S and C items may slip without blocking.

## 6. Journeys

Full journey list with actors and sources: Appendix C §4 (J-01..J-22). Steps for J-01..J-18 are the numbered flows in `03-WORKFLOWS-AND-RULES.md` §1–§6, which are Confirmed and are hereby adopted as the PRD journeys. The exceptions in Appendix C §5 (X-01..X-21) are **Derived** and complete each journey with failure and recovery. Journey summaries below give the start condition, the happy path and the end state so a tester can follow each one.

| ID | Journey | Start → end | Release | Key exits |
| --- | --- | --- | --- | --- |
| J-01 | Visitor finds a doctor and starts booking | Brand site → patient portal with service/doctor pre-selected | R1 | Not signed in → J-02 first |
| J-02 | Patient registers and enables MFA | Sign-up → verified account, MFA offered | R1 | OTP failure, ID check failure |
| J-03 | Guardian/proxy links a dependant | Request → verified active link | R1 | Age-out, revocation; proxy visibility is **Open** (D-7) |
| J-04 | Book, confirm, reminders | Slot chosen → Confirmed, email/SMS + .ics, Google "Busy" block | R1 | Hold expiry X-01, race X-02, payment only if D-3 says so |
| J-05 | Reschedule/cancel; waitlist | Change request → rebooked or slot offered to waitlist | R1 | Cut-off fee/block (BR-01) |
| J-06 | Arrival to queue | Check-in → forms checked → vitals → triage → queued | R1 | Missing consent X-07 |
| J-07 | Red-flag escalation | Red-flag answer → on-duty doctor alerted, emergency advice shown | R1 | Alert not acknowledged: on-call doctor (derived) |
| J-08 | Telehealth visit | Device check → waiting room → video with side-by-side notes | R1 | State licensing check is **Open** (G-19 → D-2) |
| J-09 | Consultation and documentation | Chart → note → signed and locked | R1 | Addenda only; trainee co-sign |
| J-18 | Break-the-glass | Out-of-assignment access with reason → compliance review | R1 | Review outcome justified / not justified |
| J-19 | Document upload | Upload → virus scan → classify → confirm → retain | R1 | Malware X-17, legal hold X-18 |
| J-21 | Privacy request | Request → identity verified → fulfilled or refused with reason | R1 | Meaning of "deletion" is **Open** (D-8) |
| J-22 | Staff sign-in | Google SSO + MFA → session; re-auth to sign; idle timeout | R1 | Idle X-20 |
| J-10 | Standard prescription | Draft → checks → signed → sent to chosen pharmacy | R2 | Network down X-09 |
| J-11 | EPCS | Identity-proofed prescriber, two-factor signing, audited | R2 | Proofing missing → refused (AC-15) |
| J-12 | Pharmacy fulfils; patient follows status | Received → accepted → in progress → ready/out for delivery → collected/delivered | R2 | Reject X-10 |
| J-13 | No acknowledgement in 2 h | Timer → care team and patient alerted | R2 | Definition **Open** (D-10) |
| J-15 | Refill | Request → prescriber → new Rx or denial | R2 | Pharmacy cannot extend (BR-19) |
| J-20 | Pharmacy onboarding | Organisation, locations, licence/DEA, accounts with MFA | R2 | Approval rule not defined (recommend admin approval, D-13) |
| J-14 | Delivery with failed attempt | Out for delivery → failed → new attempt or pickup | R3 | Out-of-order status X-12 |
| J-16 | Lab order to result | Order → sample → lab → result → review → release | R3 | Unmatched result X-14; sample rejected X-16 |
| J-17 | Critical result | Alert → acknowledge or escalate to on-call | R3 | Window **Open** (D-11) |

## 7. Business rules and states

Business rules BR-01..BR-36, states ST-01..ST-06 and exceptions X-01..X-21 are in Appendix C §3, §5 and §6. They are Confirmed unless Appendix C marks them Derived. This PRD adopts them as requirements. Rules that concern patient safety (**safety-critical**; each needs dedicated negative and boundary tests and independent clinical review `[05 §6]`): BR-09, BR-10, BR-14, BR-15, BR-16, BR-17, BR-19, BR-20, BR-22, BR-24, BR-25, BR-26, BR-27, BR-34.

Rules that apply across all surfaces: BR-23 (no diagnoses, test names or medicine names in SMS, email or push), BR-32 (organisation and location scoping, least privilege), BR-33 (timeouts, retries, idempotent inbound, visible failures), BR-35 (synthetic data in non-production), BR-36 (no health data in logs, URLs, analytics).

### 7.1 Permissions

The confirmed summary matrix is `[02 §8]`. The extended matrix with proxy, front desk, assistant, lab coordinator, billing and compliance is a **BA proposal** (Appendix C §1.1) and becomes final at G2. Hard rules that are already Confirmed and are acceptance-tested at R1/R2:

- Staff scope is limited to their organisation and assigned locations (BR-32, AC-34).
- Partner pharmacy staff see only prescriptions sent to, and patients of, their own pharmacy (BR-21, AC-18).
- Only doctors prescribe; EPCS signing needs an identity-proofed prescriber and two-factor signing and cannot be done by an assistant (BR-17, AC-15, AC-16).
- Admin cannot delete audit entries (AC-36).
- Patients see only their own record, and only released results (AC-35, AC-26, AC-27).

### 7.2 Recommended defaults for configurable settings (Recommendation, not Confirmed)

The intake makes these admin-configurable and assigns defaults to Plan & Design (G-12). So the PRD does not leave testers without values, these are **proposed starting values** for approval at G2; none is a decision. Clinical-safety values (critical-result window, release deadline) are deliberately **not** proposed here because they need a licensed clinician (D-11).

| Setting | Proposed default | Rationale |
| --- | --- | --- |
| Checkout slot hold | 10 minutes | Common booking practice; limits slot hoarding |
| Reminders | 2: 48 h and 4 h before (intake fixes the count of two) | Count is Confirmed; times are proposed |
| Pre-visit questionnaire and consents sent | 72 h before | Gives time to complete |
| Waitlist offer acceptance time | 30 minutes (15 minutes if visit is within 24 h) | Keeps freed slots from idling |
| No-show grace period | 15 minutes after start (video: 10) | Allows late arrival |
| Cancellation cut-off | 24 h per service | Matches BA example AC-04 only; per service in admin |
| Max future appointments per patient per service | 3 | Limits abuse |
| Calendar busy data stale threshold | 15 minutes | Slot search must not use old busy data silently |
| Staff idle session timeout | 15 minutes; re-auth to sign prescriptions always | Intake requires a timeout but not a value `[05 §2]` |
| Signed-note deadline | 24 h after visit end, then reminder to doctor | Prevents unsigned notes |

## 8. Functional requirements and acceptance

### 8.1 Requirement form

A feature requirement is "the system provides feature F-xx for the actors in 3 under the rules in 7". It is accepted when its release acceptance criteria (8.2) pass and the BA acceptance examples (Appendix C §8, AC-01..AC-38) mapped to it pass. Appendix C §2 lists every feature with priority and release.

### 8.2 Release acceptance criteria (measurable)

Each criterion is pass/fail. "Tested" means executed by QA against the integrated candidate with synthetic data. A criterion marked **blocked** cannot be tested until the named decision is made.

**R1 — Foundation and booking**

| ID | Criterion | Trace |
| --- | --- | --- |
| RA-R1-01 | A new patient completes sign-up with email/phone OTP and can enable MFA. A staff user signs in only through Google Workspace SSO with MFA. Local staff passwords do not exist. | F-PP-01, F-SH-01, J-02, J-22 |
| RA-R1-02 | A patient books, reschedules and cancels an appointment for each of in-person and video, from the doctor's template minus existing bookings minus Google busy time. AC-01..AC-06 pass. | F-PP-04..06, BR-02, BR-06, J-04, J-05 |
| RA-R1-03 | No double booking: under 100 parallel confirmations of one slot, exactly one succeeds and the others receive alternatives. | BR-02, AC-03, X-02 |
| RA-R1-04 | A doctor's Google Calendar receives a "Busy" block with no patient name, reason or diagnosis, and syncs a Google meeting back as unavailable time within the stale threshold. | F-DR-02, BR-07, AC-01, AC-02 |
| RA-R1-05 | A confirmation and two reminders are sent with an .ics attachment and a log-in prompt only; no message contains a diagnosis, test name or medicine name. Verified by inspecting rendered email/SMS/push templates in all configured languages. | BR-08, BR-23, AC-06 |
| RA-R1-06 | Check-in (desk and QR), questionnaire and consent review, vitals with out-of-range highlighting, triage category, and queue with wait time work end to end. | F-PC-01..04, 06, J-06, AC-09 |
| RA-R1-07 | A red-flag triage answer alerts the on-duty doctor and shows emergency advice. Alert time is recorded. | BR-10, AC-08, J-07 |
| RA-R1-08 | A consultation cannot start without required consents except by a recorded emergency exception. | BR-09, AC-07 |
| RA-R1-09 | A doctor writes a note from a template, signs it and it locks; later changes are addenda; trainee notes cannot be released without co-signature. | BR-11, BR-12, AC-10, AC-11 |
| RA-R1-10 | A telehealth visit runs with device check, waiting room and notes side by side, and shows both time zones when they differ. 250 concurrent video visits are sustained (NFR-9). | F-PP-08, F-DR-06, BR-05 |
| RA-R1-11 | Every chart view is logged. Out-of-assignment access is blocked until a reason is entered, alerts compliance and appears in the review queue. | BR-13, BR-14, AC-12 |
| RA-R1-12 | Audit entries cannot be deleted by any role, including admin. The audit viewer shows who, what, when, from where, and exports. | F-AD-07, AC-36 |
| RA-R1-13 | Uploads are virus-scanned before anyone can open them, classified and staff-confirmed. Infected files are quarantined. A deletion request under legal hold is refused with the reason recorded. | BR-28, BR-29, AC-30, AC-31 |
| RA-R1-14 | Patient can set notification preferences, request a data export and request account deletion; compliance sees the request. Meaning of deletion: **blocked on D-8**. | F-PP-16, F-AD-09, J-21 |
| RA-R1-15 | Admin configures clinics, rooms, hours, holidays, services, booking policies, message templates and roles. Booking policy supports block-only cancellation. Fee and deposit behaviour: **blocked on D-3**. | F-AD-01..05 |
| RA-R1-16 | Brand site pages for services, doctors (with next available slot), locations and contact exist; "Book" hands off with service/doctor pre-selected; a marketing user edits pages without developer help; analytics receive no health data. SEO metadata, sitemap and structured data are present. | F-BS-01..05, 07 |
| RA-R1-17 | A user in Clinic A cannot find a patient registered only in Clinic B; a patient cannot view another patient's data by URL manipulation. Both attempts are logged. | BR-32, AC-34, AC-35 |
| RA-R1-18 | All R1 NFR targets in section 9 pass or have an approved, dated exception; independent penetration test completed with no open high/critical findings. | NFR-1..NFR-22 |

**R2 — Prescribing and pharmacy network**

| ID | Criterion | Trace |
| --- | --- | --- |
| RA-R2-01 | 100 % of signed prescriptions record an allergy, interaction, duplicate-therapy and dose-range check from the licensed drug database. A serious alert cannot be signed without an override reason or a changed order; overrides are logged. | BR-15, BR-16, AC-13, AC-14, OUT-4 |
| RA-R2-02 | Signing a prescription requires re-authentication. A Schedule II–V prescription is refused without prescriber identity proofing and is signed only with two-factor authentication. Assistants cannot sign. Audit retained as DEA rules require. | BR-17, AC-15, AC-16 |
| RA-R2-03 | A signed prescription is sent through the certified e-prescribing network to the pharmacy the patient chose and the patient sees every status change. | ST-03, AC-17 |
| RA-R2-04 | If the network is unavailable the prescription stays Signed and unsent with visible retry state on the operations dashboard; it is never marked Sent. | X-09, AC-38 |
| RA-R2-05 | Partner pharmacist sees only own pharmacy's prescriptions; can accept, query or reject with a reason; every status change is attributed to a user. | BR-21, AC-18, AC-20, F-PH-02..04 |
| RA-R2-06 | The pharmacy cannot extend a prescription; refill requests reach the prescriber. | BR-19, AC-21 |
| RA-R2-07 | A controlled-substance Delivered/Collected update is refused without ID check and recipient recorded. | BR-22, AC-22 |
| RA-R2-08 | Unacknowledged prescriptions alert the care team and patient after the agreed window. Window clock and meaning of acknowledged: **blocked on D-10**. | BR-20, AC-19, OUT-5 |
| RA-R2-09 | Patient pays an invoice by card using the provider's hosted fields or tokens; no card number is stored or logged; refunds above the configured amount wait for approval. | BR-30, BR-31, AC-37 |
| RA-R2-10 | Partner pharmacy onboarding creates organisation, locations and MFA-protected staff accounts. Approval rule: **blocked on D-13**. | F-PH-01, J-20 |
| RA-R2-11 | Patient views health record (summaries, problems, allergies, medications, immunisations). | F-PP-10 |

**R3 — Delivery visibility and labs**

| ID | Criterion | Trace |
| --- | --- | --- |
| RA-R3-01 | A partner pharmacy posts delivery status and a tracking link by portal and by API/webhook. The patient sees status, link and ETA and a notification. Duplicate events create one record. Late or out-of-order events never move a delivery backwards and are kept in history. | BR-24, BR-33, AC-23, AC-24, AC-25 |
| RA-R3-02 | A doctor orders a lab test; the order reaches the lab by HL7 v2 or FHIR or, if no interface, a requisition PDF; a result attaches to the order. | F-DR-09, X-21 |
| RA-R3-03 | An unmatched electronic result goes to the reconciliation queue and is never attached to a chart. | BR-27, AC-29 |
| RA-R3-04 | Normal results are released to the patient immediately; abnormal results are released only after the ordering doctor reviews, within the information-blocking limit, with a reminder before the limit. | BR-26, AC-26, AC-27 |
| RA-R3-05 | A critical result alerts the ordering doctor at once and escalates to the on-call doctor if not acknowledged within the window; every step is audited. Window: **blocked on D-11**. | BR-25, AC-28, OUT-7 |
| RA-R3-06 | Lab desk prints sample labels/barcodes and records collection and courier hand-off. | F-PC-08 |
| RA-R3-07 | Pharmacy performance report shows acknowledgement time, fulfilment time and failed deliveries. | F-PH-09 (S) |

R4 has no acceptance in this PRD (not committed).

### 8.3 Patient-safety acceptance

Every safety-critical rule in section 7 requires: (a) positive, negative and boundary tests, (b) review of the rule text and test results by a licensed clinician before go-live of the release that contains it (D-12), and (c) no waiver by client acceptance. Recommendation: a defect in a safety-critical rule is severity-high regardless of how rarely it occurs.

## 9. Non-functional requirements

All values **Confirmed** `[05 §3–5, 07 D6, D2]` unless marked.

| ID | Requirement | Target | Verification |
| --- | --- | --- | --- |
| NFR-1 | Availability, patient and doctor portals | 99.9 % monthly | Synthetic uptime monitor; monthly report |
| NFR-2 | Recovery point objective | ≤ 15 min | Restore test from backup timestamps |
| NFR-3 | Recovery time objective | ≤ 4 h | Timed disaster-recovery exercise before R1 go-live and before each later release |
| NFR-4 | Backups | Automated, encrypted, cross-region copy; restore-test cadence set at G2 | Restore evidence |
| NFR-5 | Deployments | Zero downtime; rollback and database migration plan per release | Release rehearsal |
| NFR-6 | API latency | p95 < 500 ms for normal reads/writes at peak load | Load test at the volumes in NFR-9 |
| NFR-7 | Page load | LCP < 2.5 s on 4G | Lab and field measurement |
| NFR-8 | Slot search | p95 < 1 s across all locations | Load test |
| NFR-9 | Capacity at launch (peak) | ~8,000 appointments/day; ~4,000 prescriptions/day; ~1,500 deliveries/day; ~250 concurrent video visits; ~250,000 patients; ~1,000 staff; 30+ clinics | Load test at ≥ 100 % of the stated values, with headroom factor set by Architect |
| NFR-10 | Accessibility | WCAG 2.2 AA on all portals and the brand site | Automated scan plus manual keyboard and screen-reader run on each portal |
| NFR-11 | Browsers/devices | Current Chrome, Safari, Edge, Firefox; phones from 360 px | Cross-browser matrix |
| NFR-12 | Encryption | TLS 1.2+ in transit; encryption at rest; managed key service with rotation | Configuration review and scan |
| NFR-13 | Audit | Append-only record of every view, create, change, export, print of patient data with user, time, IP/device, reason where needed; retention at least what HIPAA and DEA EPCS require | AC-36; retention set at G2 |
| NFR-14 | Application security | OWASP ASVS L2 baseline; L3 for authentication, prescribing and payment paths | Security Reviewer checklist |
| NFR-15 | CI security gates | SAST, dependency, secret and container scanning on every change; blocking findings fail the build | CI evidence |
| NFR-16 | Penetration test | Independent test before each production release with new external surface | Report with no open high/critical |
| NFR-17 | Public-form protection | Rate limiting, bot protection on public forms, upload scanning | Test |
| NFR-18 | Data handling | Health data absent from logs, URLs, analytics, SMS and email; synthetic data outside production | Log scan, test data review |
| NFR-19 | Hosting | HIPAA-eligible US region with signed BAA | BAA on file before go-live |
| NFR-20 | Monitoring | Uptime, errors, latency, queue backlogs, integration failures, with on-call alerts | Alert test |
| NFR-21 | Integration resilience | Every external call has a timeout and back-off retry; failure visible on an operations dashboard; inbound messages idempotent | AC-24, X-09 |
| NFR-22 | Time handling | Store UTC; show in the location time zone | BR-05 |

Not set by the sources (Open): 3-year growth, number of partner pharmacies, SOC 2 Type II audit timing (readiness is a **Recommendation**, `[05 §1]` says "should be ready"), and the exact audit retention period.

## 10. Compliance and legal constraints

**Confirmed** `[05 §1]`, `[07 A1]`: HIPAA Privacy and Security Rules; BAAs with every vendor that touches health data, signed before go-live; 21st Century Cures Act patient access and information-blocking; DEA EPCS rules; state telehealth licensing and state pharmacy rules for each operating state (**states Open, D-2**); 42 CFR Part 2 if substance-use treatment records are held (whether they are is Open, D-15). Neither this PRD nor the agents provide legal advice; each of these needs a qualified reviewer (D-12).

## 11. Dependencies

| ID | Dependency | Needed for | Owner and state |
| --- | --- | --- | --- |
| DEP-1 | Operating states named | Telehealth rules, pharmacy rules, proxy age rules | Product owner. **Open. Critical for G1** (D-2) |
| DEP-2 | Google Workspace tenant and admin contact | SSO, calendar sync (R1) | Product owner; state unknown |
| DEP-3 | Hosting provider with BAA | All releases | Architect recommends, owner decides (cloud provider Open) |
| DEP-4 | Video, SMS, email, OCR/virus-scan vendors under BAA | R1 | Chosen at G2 |
| DEP-5 | Brand files in `docs/intake/brand/` | Brand site, all UI work | Product owner. Not present in the repository at commit `6ea01b5` |
| DEP-6 | Certified e-prescribing/EPCS network vendor, onboarding and certification lead time | R2 | Owner not named (G-20). Start during Plan & Design |
| DEP-7 | Licensed drug database | R2 | Licence and cost not decided |
| DEP-8 | Payment provider | R2 | Chosen at G2 |
| DEP-9 | Named partner labs or integration hub | R3 | Labs not named (C3 Open) |
| DEP-10 | Partner pharmacies and their API/webhook readiness | R2–R3 | Count and names Open |
| DEP-11 | Licensed clinician for safety review | Before go-live of R2 and R3 at least | Not named (D-12) |
| DEP-12 | Third-party service costs (these are not covered by Claude Max) | All | Within US$5–15k/month run budget |

## 12. Exclusions

**Confirmed out of scope** `[01 §5]`, `[04 §5]`, `[07 B6]`: own pharmacy; own delivery dispatch, driver app or routing; data migration from an existing system (no migration R1–R3; if C1/C2 change it is a separately scoped change); native iOS/Android apps; full insurance claims and remittance (R4); inpatient/hospital modules; PACS imaging storage (viewing linked reports only, if needed); own drug database or lab analyser software; AI diagnosis. AI scribe is a separate decision and R4 candidate only (B7 Open).

**Excluded by this PRD until a human decides** (so they are not silently included): non-US operation; non-English languages (English only in R1, B8 Open); Microsoft/Outlook calendar sync (R4); EPCS ID check by non-partner pharmacies (the platform cannot record it, G-13); any medicine pricing or payment on the platform (G-17); R1 fees and deposits (G-03); R1 lab sample collection (G-04); R1 patient visit summaries (G-15).

## 13. Decisions requested from the product owner

These are the BA gaps G-01..G-21 plus intake gaps, consolidated. The PRD does not choose the answer. Each has my recommendation, **labelled Recommendation**, and says what is blocked. G-12 is answered in section 7.2.

| ID | Decision | BA/intake ref | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| **D-1** | Is the product a custom build, or may a buy/integrate/hybrid option be evaluated, and may vendors be contacted for quotes and EPCS/portal confirmation? | G-01; research R-A, H2 | Authorise a time-boxed vendor quote exercise before G1, because R1–R3 at US$150–300k is tight against buy alternatives (hypothesis, not proven) | Whole scope, budget feasibility. **G1** |
| **D-2** | Which US states at R1 and at R2? | G-18, G-19, A1 | Name them before G1; start with the fewest states that serve the first clinics | **Critical for G1**: telehealth, pharmacy and proxy rules |
| D-3 | Does R1 charge any fee or deposit? | G-03 | R1 is block-only for late cancellation; deposits and fees move to R2 with payments | R1 booking behaviour |
| D-4 | Lab sample collection booking in R1 when labs are R3 | G-04 | Remove from R1 | R1 scope |
| D-5 | Does R1 include patient-facing messaging (S) or only staff messaging (M)? | G-14 | Staff messaging in R1; patient messaging stays S and may slip | R1 scope |
| D-6 | Patient visit summary in R1 | G-15 | Defer to R2 with the health-record view | R1 scope |
| D-7 | Proxy rules: age thresholds, adolescent confidentiality by state, what a proxy sees, verification, revocation | G-07 | Define with the clinical safety reviewer once states are known; until then proxy sees appointments only | F-PP-03, AC-32 |
| D-8 | Meaning of "account deletion" versus record retention | G-16 | Deletion removes login and non-record data; medical records retained as law requires; requires legal advice | RA-R1-14 |
| D-9 | Languages at launch; AI features | B7, B8 | English only R1; AI scribe stays R4 | None for R1 |
| D-10 | What is "acknowledged" for the 2 h clock, and is the clock 24x7 or pharmacy hours; non-partner pharmacies | G-05 | Acknowledged = network receipt or first pharmacy status; clock 24x7; measured separately for partners and non-partners | OUT-5, J-13 |
| D-11 | Critical-result window, abnormal-result release deadline, definitions of abnormal vs critical, who sets them | G-11 | Licensed clinician sets values; PRD does not propose numbers | RA-R3-04, RA-R3-05, OUT-7 |
| D-12 | Independent licensed clinician, security reviewer and QA person; one person holds all roles today | G-21, G-04 intake | Name a clinician before R2 build and a security reviewer before any penetration test; accept the risk knowingly otherwise | Safety acceptance |
| D-13 | Partner pharmacy approval: who approves onboarding and on what evidence | G-20 related, J-20 | Platform admin approves after licence and DEA verification | RA-R2-10 |
| D-14 | Baselines and measurement method for OUT-3 and OUT-8 | Section 2 | Capture current baselines in the first clinics during R1 | Acceptance of outcomes |
| D-15 | Will the platform hold substance-use treatment records (42 CFR Part 2)? | `[05 §1]` | Decide at G1; affects consent and disclosure design | Compliance design |
| D-16 | Whether the controlled-substance ID check for non-partner pharmacies is accepted as the pharmacy's own process, or EPCS is limited to partner pharmacies | G-13 | Accept pharmacy's own process for non-partner pharmacies, with a clear patient-facing note; record decision | EPCS scope |
| D-17 | Prescription validity/expiry, cancel-after-send behaviour and urgent fallback when network is down | G-09 | Follow state law and network rules; decide with the clinician and Architect | ST-03, X-09 |
| D-18 | Assistant/nurse delegation: what may they prepare, sign or order (non-EPCS) | G-10 | Prepare only; doctor signs | A-08 |
| D-19 | Admin access to delivery address versus "audit only" and who owns the address | G-08 | Admin has no delivery-address access; address is on the patient profile and shown only to the pharmacy that holds the prescription | Least privilege |
| D-20 | R2/R3 boundary for pharmacy status | G-02 | R2: status events from the portal, shown in-app; R3: tracking links, API/webhook, ETA notifications | R2/R3 acceptance |
| D-21 | Whether any medicine pricing or payment is on the platform | G-17 | No; the pharmacy handles medicine payment `[02 §2]`; remove "pharmacy price list" from `03 §8` | R2 payments scope |
| D-22 | Is the budget/date/scope priority order: which gives first if R1–R3 does not fit | Intake Q-4 | Owner states a rank order | G1 trim |
| D-23 | Data migration finality: `04 §5` and README call it agreed; `07 C2` still says Open | Intake C-1 | Treat as final: no migration | None if confirmed |

## 14. Risks

| ID | Risk | Impact | Likelihood (PM view) | Mitigation | Owner |
| --- | --- | --- | --- | --- | --- |
| RK-1 | R1–R3 scope, EPCS, labs and 30+ clinics exceed US$150–300k and the date | Late cut or overrun | High | D-1, D-22; size R1 first; trim at G1 not mid-build | Product owner, Architect |
| RK-2 | State rules for telehealth/pharmacy unknown | Rework, launch limits | High until D-2 | Name states before G1 | Product owner |
| RK-3 | EPCS/e-prescribing network certification lead time | R2 delay | Medium | Start onboarding in Plan & Design (DEP-6) | Product owner, DevOps |
| RK-4 | Patient-safety defects (wrong medicine, missed critical result, wrong patient) | Harm, liability | Medium impact severe | Section 8.3; clinician review; wrong-patient banner BR-34 | Product owner |
| RK-5 | One person holds all gates; AI-recorded decision provenance (Intake L-1) | Self-approval, unverified consent | Certain | D-12; at G1 the owner confirms in their own words that this PRD reflects their decisions | Product owner |
| RK-6 | Research is secondary-sourced and not independently reviewed | Weak build/buy evidence | Medium | Re-verify before G1; D-1 | PM, Researcher |
| RK-7 | Brand files missing | UI/UX blocked | Medium | DEP-5 before G2 | Product owner |
| RK-8 | Vendor BAAs unavailable or costly | Go-live blocked | Medium | Check BAA before vendor selection at G2 | Architect |
| RK-9 | Partner pharmacies slow to adopt API/webhook | OUT-6 missed | Medium | Portal manual status fallback in R2/R3 | Product owner |
| RK-10 | Third-party costs exceed US$5–15k/month at stated scale | Run budget overrun | Medium | Cost model per vendor at G2; research notes SaaS EHR prices alone could consume it | Architect, DevOps |

## 15. Handoff questions for the Solution Architect (technical review lane)

Routed through the Orchestrator; the PM does not decide them.

1. Feasibility of NFR-9 and NFR-6/8 on the budget; headroom factor.
2. Authentication model for partner pharmacy API/webhook and EPCS two-factor signing (DEP-6 vendor dependent).
3. Slot-hold and no-double-booking design (BR-02, X-02) at 8,000 appointments/day.
4. Clinical coding (SNOMED, RxNorm, LOINC, ICD-10, CPT) and the FHIR/SMART scope in R1 versus later `[04 §2]`.
5. Audit append-only design and retention; BTG alerting.
6. Whether R1 can stand without drug database and payments (yes per release split) and what shared contracts R2 needs so R1 does not need rework.
7. Security assumptions and trust boundaries belong in ARCHITECTURE.md, not this PRD.

## 16. Review checklist for the Product Owner Reviewer

The reviewer should verify: (a) every requirement traces to a source or is labelled; (b) no Open item has leaked into confirmed acceptance; (c) release acceptance criteria are measurable; (d) R1 contents match section 4.5; (e) exclusions are complete; (f) BA review notes R-01..R-06 are handled (below).

### 16.1 BA review notes R-01..R-06 disposition

| ID | Note | PRD handling |
| --- | --- | --- |
| R-01 | BA file path in the hand-off differs from the repository path | The BA document is embedded in Appendix C; repository path is `docs/intake/docs/ba/BA-FEATURE-MAP.md` on the BA branch (HEAAA-5); not moved by the PM |
| R-02 | AC-14 mixes interaction and duplicate-therapy cases | PRD acceptance RA-R2-01 states both checks separately; the BA map text is left unchanged (BA-owned) |
| R-03 | AC-32 and AC-36 type labels look swapped; AC-32 depends on G-07 values | RA-R1-12 uses AC-36 as a positive rule; AC-32 is **blocked on D-7** |
| R-04 | BA §10 release view omits some features | Section 4.5 and 5 of this PRD list R1–R3 explicitly, including F-SH-06..09, F-AD-06 (R1–R3), F-PC-05 (manual) and F-PH-08 |
| R-05 | BA §9 says A-01..A-17 but the table goes to A-18 | A-18 is "external systems"; section 3 here lists human actors only |
| R-06 | G-12 defaults should be carried in the PRD | Section 7.2 |

## 17. Traceability and revision manifest

### 17.1 Requirement-to-source trace

| PRD section | Source |
| --- | --- |
| 1 Problem | `[01 §2]`, `[01 §1]` |
| 2 Outcomes | `[01 §3]`, `[07 D6]` |
| 3 Audiences | `[01 §4]`, `[02 §8]`, Appendix C §1 |
| 4 Scope and releases | `[01 §5–6]`, `[07 B1–B6]` |
| 5 Priorities | `[02 §1–7]` |
| 6 Journeys | `[03 §1–8]`, Appendix C §4–§5 |
| 7 Rules, permissions | `[03]`, `[02 §8]`, `[05 §2]`, Appendix C §1.1, §3, §6 |
| 7.2 Defaults | **Recommendation** (PM), closes BA G-12 |
| 8 Acceptance | Appendix C §8 plus PM criteria derived from `[01]–[05]` |
| 9 NFRs | `[05 §2–5]`, `[07 D2, D6]` |
| 10 Compliance | `[05 §1]`, `[07 A1]` |
| 11 Dependencies | `[04 §3]`, `[07 C]`, research §5 |
| 12 Exclusions | `[01 §5]`, `[04 §5]` |
| 13 Decisions | BA §11, Intake-Readiness §5–6, research §4–§5 |
| 14 Risks | `[01 §8]`, `[07 D]` note, BA §12, research §4 |

### 17.2 Revision manifest

| Item | Identifier |
| --- | --- |
| This document | Task HEAAA-6; Paperclip document key `prd`; repo path `docs/PRD.md` on branch `HEAAA-6-sdlc-prd-draft-write-prd-revision-for-parallel-reviews` (see task comment for the commit) |
| Intake pack | Revision 2, commit `6ea01b5` |
| Intake-Readiness | HEAAA-3 `intake-readiness`, rev `d7e6821d-7383-4286-83a9-35c315af2e7b` (87.5 %). Note: HEAAA-2's earlier rev (`19bedb25`) scored 75 % with operating states as a critical gap; the later HEAAA-3 revision lists operating states as non-critical but "must be resolved before G1". This PRD treats it as **critical for G1** (D-2). |
| Research | HEAAA-4 `research`, rev `dc45ec56-5023-4eeb-a684-11efd3caecf5` (draft; independent review state not recorded in my evidence) |
| BA feature map | HEAAA-5 `ba-feature-map`, rev `849217d2-53eb-4845-a718-34b4d5fbc197`; independently reviewed PASS 2026-11-04 with non-blocking notes (review not natively recorded, per the reviewer's own comment) |

### 17.3 Limitations

- Derived from documents only. No client interview; no observation of existing systems; no vendor trial. Decisions in the intake pack reach me through AI-authored text claiming the owner's agreement (Intake limitation L-1).
- Research is mostly secondary-sourced. No hypothesis in it is treated as a fact.
- No automated checks apply to a document. Checks done: cross-read of all intake files, the BA map and research for conflicts; every conflict is in section 13.
- Not legal or clinical advice.

### 17.4 Next permitted action

Independent review of this exact revision by Product Owner Reviewer (HEAAA-7) and Solution Architect (HEAAA-8). Orchestrator consolidates findings into one revision round. G1 requires the final PRD plus ARCHITECTURE.md and a real human decision; D-2 and D-1 must be answered first.

---

# Appendices

Appendices A and B are authored here; C (BA feature map) and D (research) embed those documents verbatim at the revisions in 17.2 so the G1 package stays exactly two files.

## Appendix A — Source and decision register

| ID | Source | Version | Time and identity | Approval status | Subject |
| --- | --- | --- | --- | --- | --- |
| S-1 | `docs/intake/01`–`06` | commit `6ea01b5` (rev 2; rev 1 commit `6ba3d71`) | Stated confirmed by Zain Naeem 2026-10-31 (time not given); rev 2 edits 2026-11-02 | Stated "Agreed" in every section; AI-recorded; no original transcript | Whole pack |
| S-2 | `docs/intake/07` sections A, B (B1–B6), C4–C5, D, E | commit `6ea01b5` | Zain Naeem, 2026-11-02 03:26 PKT (UTC+05:00); recorded by the AI assistant | Stated as the owner's answers | Jurisdiction, pharmacy model, EPCS, scale, budget, date, owners |
| S-3 | `README.md`, `docs/intake/README.md` | commit `6ea01b5` | — | Revision history | Pack index |
| S-4 | Intake-Readiness | HEAAA-3 rev `d7e6821d` (87.5 %); HEAAA-2 rev `19bedb25` (75 %) | Intake Agent, 2026-11-04 | Not human-approved here; INTAKE gate HEAAA-3 is `done` in Paperclip (decision content not in my evidence) | Readiness and gaps |
| S-5 | Research | HEAAA-4 rev `dc45ec56` | Researcher, 2026-11-04 | Advisory only | Comparable products |
| S-6 | BA feature map | HEAAA-5 rev `849217d2` | Business Analyst, 2026-11-04; reviewed PASS | Not human-approved | Features, rules, acceptance |
| S-7 | Brand files | **Absent** | — | — | Brand |

Supersession per subject: pharmacy model (S-2 A3/B5 supersedes rev 1's in-house pharmacy and dispatch assumption); EPCS (S-2 A5, previously open); lab release (S-2 B4); budget and date (S-2 D3–D5). Inconsistencies carried to section 13: migration wording (D-23), Google-only calendar in R1 (`03 §1` still says Google/Outlook; Outlook is R4 per `02 §4`; this PRD uses Google only in R1, **Derived**), insurance (`02 §3` manual in R1 versus `07 B3` insurance in R4; this PRD reads "manual" as staff verification outside the system, **Derived**, to confirm), pharmacy price list (D-21).

## Appendix B — Decisions, adoption and exclusions of research

| Research item | PRD treatment |
| --- | --- |
| Discovery needed (no skip) | Adopted: research ran |
| R-A: obtain vendor quotes and confirmations | **Not adopted, awaiting decision** D-1 (needs owner approval to contact vendors) |
| R-B: use a certified third-party e-prescribing/EPCS network | **Aligned with** confirmed `[04 §3]` candidates and `[01 §8]`; vendor open (DEP-6). Not adopted as a vendor choice |
| R-C: delivery visibility is pharmacy-reported only | Already Confirmed `[07 B5]` |
| H1 differentiator, H2 build vs buy, H3 Community Connect | Hypotheses; not scope. H2 drives D-1 |
| Pricing observations | Informational for D-1 and RK-10 only |

---

## Appendix C — BA feature map (verbatim, HEAAA-5 `ba-feature-map` rev `849217d2`)

> Embedded unchanged except heading levels. Section numbers cited in this PRD as "Appendix C §n" refer to the BA document's own section numbers.

### BA Feature Map — Enterprise EHR Platform (PRD appendix)

| Field | Value |
| --- | --- |
| Task | HEAAA-5 `[SDLC:business-analysis]` |
| Author | Business Analyst agent |
| Baseline | Intake pack revision 2 (2026-11-02), `docs/intake/`; research draft HEAAA-4 (`research` document rev 1) |
| Version | 0.1 (first draft) |
| Status | **DRAFT — awaiting independent review.** Not review-passed, not human-approved. Not scope approval (G1). |

#### 0. How to read this

- **Source tags** point at the intake pack: `[01 §6]` = `01-PRODUCT-BRIEF.md` section 6; `[07 A3]` = open-questions row A3. Where a tag is missing, the item is a **BA derivation** (marked *derived*) and needs confirmation.
- **Label discipline.** *Confirmed* = stated in the intake pack. *Derived* = BA inference that follows from confirmed text. *Recommendation / hypothesis* = from research or BA judgement; never scope until a human adopts it. *Gap* = a business decision nobody has made (section 11). The BA does not pick answers for gaps.
- Priority M/S/C and release R1–R4 are copied from the intake pack. Time windows, fees and limits are admin-configurable settings; this map names the setting but not a value unless the intake gives one.
- Requirement IDs (`F-`, `BR-`, `ST-`, `J-`, `AC-`, `G-`) are stable. Later changes append new IDs or revisions and never reuse an ID.

#### 1. Actors and authorization boundaries

| ID | Actor | Portal / surface | Authority boundary (confirmed unless marked) | Source |
| --- | --- | --- | --- | --- |
| A-01 | Visitor | Brand site | Public content only; no health data | [01 §4] |
| A-02 | Patient | Patient portal | Own record only; may act for self | [01 §4], [02 §8] |
| A-03 | Guardian / proxy (child, adult dependant) | Patient portal | Acts for a linked patient under consent and age rules; scope of proxy view is a **gap** (G-07) | [02 §2] |
| A-04 | Front desk | Pre-consultation portal | Check-in, scheduling for patients, missing-item flags; limited pre-visit data | [01 §4], [02 §3] |
| A-05 | Triage nurse | Pre-consultation portal | Triage notes, vitals, urgency category, red-flag escalation | [02 §3, §8] |
| A-06 | Care coordinator | Pre-consultation portal | Follow-ups, referrals, no-show and waitlist handling | [02 §3] |
| A-07 | Doctor | Doctor portal | Assigned patients only; prescribes (incl. EPCS if identity-proofed), orders labs, signs notes; break-the-glass (logged, reviewed) | [02 §4, §8] |
| A-08 | Nurse / assistant acting for a doctor | Doctor portal | Delegated tasks only; what they may prepare/sign is a **gap** (G-10). EPCS signing is restricted to the identity-proofed prescriber | [01 §4], [03 §4 rules] |
| A-09 | Trainee doctor | Doctor portal | Notes need supervising co-signature before release | [03 §3] |
| A-10 | Lab coordinator | Lab desk (doctor / pre-consultation portals) | Sample labels, collection status, courier hand-off, result reconciliation queue (derived) | [01 §4], [02 §3] |
| A-11 | Partner pharmacist / technician | Partner pharmacy portal | Only prescriptions sent to their own pharmacy; own pharmacy's patients' delivery address; own pharmacy profile | [02 §5, §8] |
| A-12 | Non-partner external pharmacy | None (e-prescribing network only) | Receives prescriptions via network; no portal visibility or status feed | [02 §5 intro] |
| A-13 | Billing staff | Admin portal (billing) | Invoices, payments, refunds under approval threshold; not in the permission matrix (G-06) | [01 §4] |
| A-14 | Marketing / content staff | Brand-site CMS | Edit public content; no patient data (derived from CMS feature) | [02 §1] |
| A-15 | Organisation admin / system admin | System admin portal | Configuration, users, roles, integrations; audit view only for clinical data; cannot delete audit logs | [02 §6, §8], [05 §2] |
| A-16 | Compliance officer | System admin portal (read-only audit) | Audit, consents, incidents; reviews break-the-glass | [01 §4], [03 §3] |
| A-17 | On-call doctor | Doctor portal | Receives escalated critical results and red-flag alerts (derived) | [03 §2, §6] |
| A-18 | External systems | — | Google Workspace/Calendar, e-prescribing network, labs, pharmacy status API, payment provider, video, SMS/email | [04 §3] |

##### 1.1 Permission matrix (extended; extends [02 §8], **proposal** until confirmed at G2)

C = create, R = read, U = update, S = sign, — = none. Every access is logged [05 §2]. Staff scope is always limited to the organisation and assigned locations.

| Capability | Patient | Proxy | Front desk | Triage / coordinator | Doctor | Assistant | Lab coord. | Pharmacist | Billing | Admin | Compliance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Book / cancel appointments | Own | Linked | For patients | For patients | Own schedule | Doctor's schedule (G-10) | — | — | — | CRU | — |
| View clinical chart | Own | Per proxy scope (G-07) | Pre-visit items only | Pre-visit + triage | Assigned (+BTG) | Doctor's patients (G-10) | Orders/results only | Rx details only | — | — | Audit only |
| Write notes | — | — | — | Triage notes | CRUS | Draft (G-10) | — | Notes on the Rx | — | — | — |
| Prescribe / EPCS | — | — | — | — | CRUS (EPCS needs proofing) | Prepare only (G-10) | — | — | — | — | — |
| Prescription status | Own, read | Linked, read | — | — | Own Rx | Doctor's Rx | — | U (own pharmacy) | — | — | Audit |
| Delivery address | Own | Linked | — | — | — | — | — | Own pharmacy's patients | — | **Listed ✓ in [02 §8] — question G-08** | — |
| Lab orders / results | Released only | Released only | — | — | CRUS | Per G-10 | Collection status, reconciliation | — | — | — | Audit |
| Invoices / payments | Own | Linked | — | — | — | — | — | — | CRU, refund ≤ threshold | Config | — |
| Configure system | — | — | — | — | — | — | — | Own pharmacy profile | — | CRUD | — |
| Break-the-glass | — | — | — | — | Yes, with reason | — | — | — | — | — | Reviews |
| Audit log | — | — | — | — | — | — | — | — | — | R (cannot delete) | R |

#### 2. Feature inventory (prioritised, traced)

Priority and release are copied verbatim from `02-PORTALS-AND-FEATURES.md`. Release ordering conflicts are listed in section 11, not silently fixed.

##### 2.1 Brand site [02 §1]
| ID | Feature | Pri | Rel |
| --- | --- | --- | --- |
| F-BS-01 | Home, about, services, locations with map and hours, contact | M | R1 |
| F-BS-02 | Doctor directory with next available slot | M | R1 |
| F-BS-03 | "Book appointment" hand-off to patient portal with service/doctor pre-selected | M | R1 |
| F-BS-04 | CMS for marketing staff (pages, blog, FAQ, banners) | M | R1 |
| F-BS-05 | SEO: metadata, sitemap, structured data, fast loads | M | R1 |
| F-BS-06 | Multilingual / RTL content | S | R1 (English only until B8 decided) |
| F-BS-07 | Cookie consent; analytics without health data | M | R1 |
| F-BS-08 | Careers, news, testimonials (with consent) | C | R2 |
| F-BS-09 | Website chat (non-clinical) | C | R3 |

##### 2.2 Patient portal [02 §2]
| ID | Feature | Pri | Rel |
| --- | --- | --- | --- |
| F-PP-01 | Sign-up with identity verification (email/phone OTP, optional ID check); MFA | M | R1 |
| F-PP-02 | Profile: demographics, emergency contact, insurance cards, preferred pharmacy and language | M | R1 |
| F-PP-03 | Family and proxy access with consent and age rules | M | R1 |
| F-PP-04 | Appointment booking: search by service, doctor, location, date, in-person/video | M | R1 |
| F-PP-05 | Reschedule, cancel within policy; waitlist with automatic offers | M | R1 |
| F-PP-06 | Reminders (email/SMS/push); add-to-calendar .ics | M | R1 |
| F-PP-07 | Pre-visit questionnaire, e-signed consents, insurance upload | M | R1 |
| F-PP-08 | Telehealth: device check, virtual waiting room, join | M | R1 |
| F-PP-09 | Secure messaging with care team, attachments | S | R1 |
| F-PP-10 | Health record view: visit summaries, problems, allergies, medications, immunisations | M | R2 |
| F-PP-11 | Prescriptions: view, request refills, choose external pharmacy, see pharmacy status | M | R2 |
| F-PP-12 | Medicine tracking: pharmacy-reported status, tracking link, history | M | R3 |
| F-PP-13 | Lab results with plain-language explanation and ranges, released per policy | M | R3 |
| F-PP-14 | Documents upload/download | M | R1 |
| F-PP-15 | Payments: invoices, card/wallet, receipts, tokenised saved methods | M | R2 |
| F-PP-16 | Notification preferences; download my data; account deletion request | M | R1 |

##### 2.3 Pre-consultation portal [02 §3]
| ID | Feature | Pri | Rel |
| --- | --- | --- | --- |
| F-PC-01 | Arrivals board per location; check-in (front desk, self check-in QR) | M | R1 |
| F-PC-02 | Questionnaire review; flag missing forms, consents, insurance | M | R1 |
| F-PC-03 | Triage: symptoms, urgency category, red-flag escalation | M | R1 |
| F-PC-04 | Vitals capture with out-of-range warnings | M | R1 |
| F-PC-05 | Insurance eligibility: manual (R1), electronic (R4) | S | R1 / R4 |
| F-PC-06 | Assign/reassign doctor or room; queue and wait time | M | R1 |
| F-PC-07 | Book follow-ups, referrals, lab sample collection | M | R1 (lab part conflicts, see G-04) |
| F-PC-08 | Lab desk: labels/barcodes, collection status, courier hand-off | M | R3 |
| F-PC-09 | No-show follow-up and waitlist filling | S | R1 |

##### 2.4 Doctor portal [02 §4]
| ID | Feature | Pri | Rel |
| --- | --- | --- | --- |
| F-DR-01 | Schedule: day/week, templates, leave, blocked time | M | R1 |
| F-DR-02 | Two-way Google Calendar sync (busy only) | M | R1 |
| F-DR-03 | Outlook / Microsoft 365 sync | C | R4 |
| F-DR-04 | Patient chart summary (problems, allergies, meds, vitals, history, documents, labs) | M | R1 |
| F-DR-05 | Clinical notes: templates, sign and lock, addenda, trainee co-sign | M | R1 |
| F-DR-06 | Telehealth consultation with notes side by side | M | R1 |
| F-DR-07 | E-prescribing with interaction/allergy/duplicate checks, send via certified network | M | R2 |
| F-DR-08 | EPCS: DEA-compliant two-factor signing, prescriber identity proofing | M | R2 |
| F-DR-09 | Lab orders | M | R3 |
| F-DR-10 | Results inbox: acknowledge, comment, release, critical alerts | M | R3 |
| F-DR-11 | Referrals, sick notes, letters | S | R2 |
| F-DR-12 | Tasks and secure messages with staff and patients | M | R1 |
| F-DR-13 | AI note-drafting assistant | C | R4 (unapproved, B7 open) |

##### 2.5 Partner pharmacy portal [02 §5]
| ID | Feature | Pri | Rel |
| --- | --- | --- | --- |
| F-PH-01 | Onboarding: organisation, locations, licence and DEA details, staff accounts with MFA | M | R2 |
| F-PH-02 | Incoming prescription queue with status and priority | M | R2 |
| F-PH-03 | Accept, query prescriber, or reject with reason | M | R2 |
| F-PH-04 | Fulfilment status updates (in progress, ready for pickup, out for delivery, delivered, failed) | M | R2 |
| F-PH-05 | Controlled-substance hand-over: ID check and recipient | M | R2 |
| F-PH-06 | Refill/renewal requests routed to prescriber | M | R2 |
| F-PH-07 | Delivery status reporting by portal or API/webhook, with tracking link | M | R3 |
| F-PH-08 | Patient-facing tracking link and ETA notifications | M | R3 |
| F-PH-09 | Pharmacy performance report | S | R3 |

##### 2.6 System admin portal [02 §6]
| ID | Feature | Pri | Rel |
| --- | --- | --- | --- |
| F-AD-01 | Organisation, clinics, rooms, hours, holidays | M | R1 |
| F-AD-02 | Users, roles, permissions; Google Workspace SSO | M | R1 |
| F-AD-03 | Services catalogue (duration, price, buffer, eligible doctors, mode) | M | R1 |
| F-AD-04 | Booking policies (lead time, cancellation window, fees, waitlist, overbooking) | M | R1 (fees conflict, see G-03) |
| F-AD-05 | Message templates per language | M | R1 |
| F-AD-06 | Integration settings | M | R1–R3 |
| F-AD-07 | Audit log viewer and export | M | R1 |
| F-AD-08 | Break-the-glass review | M | R1 |
| F-AD-09 | Consent and privacy request management | M | R1 |
| F-AD-10 | Reports and dashboards | S | R2 |
| F-AD-11 | Feature flags per location; maintenance banners | S | R1 |
| F-AD-12 | Warehouse/BI export | C | R4 |

##### 2.7 Shared modules [02 §7]
F-SH-01 Identity and access (R1) · F-SH-02 Scheduling engine (R1) · F-SH-03 Notifications (R1) · F-SH-04 Messaging (R1) · F-SH-05 Documents: upload, virus scan, OCR, classification, versioning, e-signature, retention (R1) · F-SH-06 Clinical record with standard terminologies (R1–R2) · F-SH-07 Payments (R2) · F-SH-08 Audit and compliance (R1) · F-SH-09 Reporting (R2) · F-SH-10 Integration reliability: timeouts, retries, idempotent inbound, operations dashboard (R1 onward, per [04 §4]).

#### 3. Entity states and transitions

Terminal states are in **bold**. "Actor" is who may trigger the transition. Any transition not listed is not allowed and must be rejected and logged.

##### ST-01 Appointment [03 §1]
| From | To | Actor / trigger | Guard |
| --- | --- | --- | --- |
| (new) | Requested | Patient, staff | Slot held for configurable checkout time |
| Requested | Confirmed | System | No payment needed, or deposit paid (G-03) |
| Requested | **Cancelled by patient** / expired | Patient / hold timeout | — |
| Confirmed | Checked-in | Front desk, patient QR | Same day, same location |
| Confirmed | **Rescheduled** | Patient, staff | Within policy; a new appointment is created and linked |
| Confirmed | **Cancelled by patient** | Patient | Within cut-off, else fee or block (per service) |
| Confirmed | **Cancelled by clinic** | Staff | Patient notified; rebook offered |
| Confirmed | **No-show** | Staff, system | After the grace period (G-12) |
| Checked-in | In consultation | Doctor | Required consents signed, or recorded emergency exception |
| In consultation | Completed | Doctor | Note signed or explicitly deferred (G-12) |

##### ST-02 Clinical note [03 §3]
Draft → Signed (locked) → Addended (addendum with author and time). Trainee: Draft → Pending co-sign → Signed. A signed note is never edited in place.

##### ST-03 Prescription [03 §4]
| From | To | Actor | Guard |
| --- | --- | --- | --- |
| Draft | Signed | Doctor | Safety checks done; serious alert overridden with reason (logged); re-authentication; EPCS two-factor |
| Signed | Sent | System | Pharmacy chosen; network accepted the message |
| Sent | Received by pharmacy | Network / pharmacy | Receipt message |
| Received | Query to prescriber (optional) | Pharmacist | Secure message; doctor must answer |
| Received / Query | Accepted | Pharmacist | — |
| Received / Query | **Rejected by pharmacy** | Pharmacist | Reason required; care team and patient alerted |
| Sent | **Not acknowledged (escalated)** | System | No acknowledgement within 2 h (G-05 defines "acknowledged" and clock) |
| Accepted | In progress | Pharmacist | — |
| In progress | Ready for pickup / Out for delivery | Pharmacist | — |
| Ready for pickup | **Collected** | Pharmacist | EPCS: ID check and recipient recorded |
| Out for delivery | **Delivered** | Pharmacist / pharmacy API | EPCS: ID check and recipient recorded |
| Draft / Signed / Sent | **Cancelled** | Doctor | Cancel message to pharmacy if already sent (G-09) |
| any pre-dispense | **Expired** | System | Validity period (G-09) |

##### ST-04 Delivery (pharmacy-reported) [03 §5]
Out for delivery → Delivered, or → Failed attempt → New attempt scheduled (back to Out for delivery) / Changed to pickup (→ Ready for pickup). Rule: duplicate or out-of-order updates never move a delivery backwards (BR-24).

##### ST-05 Lab order [03 §6]
Ordered → Sample collected → Sent to lab → Partial results → Final results → Reviewed → Released to patient. Exits: Cancelled, Sample rejected (recollect → Ordered). Normal-result shortcut: Final → Released to patient automatically (BR-26).

##### ST-06 Other entities (derived, to be confirmed at PRD)
- **Waitlist offer:** Offered → Accepted / Declined / Expired (configurable time) → next patient.
- **Document:** Uploaded → Scanned (clean / quarantined) → Classified → Confirmed by staff → Retained; Deletion request → Legal-hold check → Deleted / Refused.
- **Consent:** Pending → Signed (signer, time, version) → Superseded / Withdrawn.
- **Proxy link:** Requested → Verified → Active → Revoked / Expired (age-out).
- **Break-the-glass event:** Opened (reason) → Compliance alerted → Reviewed (justified / not justified).
- **Refill request:** Requested → Sent to prescriber → Approved (new Rx) / Denied (reason) / Needs visit.
- **Privacy request:** Received → Identity verified → In progress → Fulfilled / Refused (reason).
- **Invoice:** Issued → Paid / Partially paid / Refunded / Written off (R2).

#### 4. Journeys

| ID | Journey | Actors | Release | Source |
| --- | --- | --- | --- | --- |
| J-01 | Visitor finds a doctor and starts booking | A-01, A-02 | R1 | [03 §1], [06 §3] |
| J-02 | Patient registers, verifies identity, enables MFA | A-02 | R1 | [02 §2] |
| J-03 | Guardian/proxy links a dependant | A-03, A-02, A-15 | R1 | [02 §2] |
| J-04 | Book, pay if required, receive confirmation and reminders | A-02, A-18 | R1 (payment R2) | [03 §1] |
| J-05 | Reschedule/cancel; waitlist offer fills freed slot | A-02, A-06 | R1 | [03 §1] |
| J-06 | Arrival, check-in, forms, vitals, triage, queue | A-02, A-04, A-05 | R1 | [03 §2] |
| J-07 | Red-flag triage escalation | A-05, A-07, A-17 | R1 | [03 §2] |
| J-08 | Telehealth visit | A-02, A-07 | R1 | [02 §2, §4] |
| J-09 | Consultation and signed documentation | A-07, A-09 | R1 | [03 §3] |
| J-10 | Prescribe (standard), send to chosen pharmacy | A-07, A-11, A-12 | R2 | [03 §4] |
| J-11 | Prescribe controlled substance (EPCS) | A-07 | R2 | [03 §4], [07 A5] |
| J-12 | Pharmacy fulfils; patient follows status | A-11, A-02 | R2 | [03 §4] |
| J-13 | Pharmacy does not acknowledge in 2 h | System, A-07, A-02 | R2 | [03 §4] |
| J-14 | Delivery with failed attempt | A-11, A-02 | R3 | [03 §5] |
| J-15 | Refill request | A-02, A-07, A-11 | R2 | [03 §4] |
| J-16 | Lab order to released result, normal and abnormal | A-07, A-10, A-02 | R3 | [03 §6] |
| J-17 | Critical result escalation | A-07, A-17 | R3 | [03 §6] |
| J-18 | Break-the-glass and compliance review | A-07, A-16 | R1 | [03 §3] |
| J-19 | Document upload, scan, classify, retain | A-02, A-04 | R1 | [03 §7] |
| J-20 | Pharmacy onboarding | A-11, A-15 | R2 | [02 §5] |
| J-21 | Privacy request (access, correction, export, deletion) | A-02, A-15, A-16 | R1 | [02 §2, §6] |
| J-22 | Staff sign-in (Google SSO + MFA), session timeout, re-auth to sign | all staff | R1 | [05 §2] |

Steps for J-01 to J-18 follow the numbered flows in `03-WORKFLOWS-AND-RULES.md` §1–§6 and are not restated; section 5 adds the exceptions and recovery they do not specify.

#### 5. Exception, failure and recovery behaviour

| ID | Situation | Required behaviour | Basis |
| --- | --- | --- | --- |
| X-01 | Checkout hold expires before confirmation | Slot released; patient told and offered the next slots | derived from [03 §1.3] |
| X-02 | Two patients take the same slot | Second confirmation fails with a clear message and alternatives; no double booking | [03 §1 rules] |
| X-03 | Google Calendar API down | Slot search uses last-known busy times, flagged stale beyond a configured age (G-12); failure shown on the operations dashboard | [04 §4] |
| X-04 | SMS/email delivery fails | Retried; in-app notification still shown; failure visible to ops | [04 §4], [02 §7] |
| X-05 | Payment fails or is abandoned | Booking not confirmed (if deposit required); hold released; no card data stored | [03 §8] |
| X-06 | Red-flag answer in triage | Immediate on-duty doctor alert plus emergency advice to patient; escalation recorded | [03 §2] |
| X-07 | Required consent unsigned at consult start | Start blocked unless emergency; exception recorded with reason | [03 §2 rule] |
| X-08 | Serious drug alert | Prescriber must give an override reason or change the order; override logged | [03 §4.2] |
| X-09 | E-prescribing network unavailable | Prescription stays Signed (not Sent); prescriber sees it unsent; retry with visible backlog; no silent drop. Fallback for urgent cases is a **gap** (G-09) | [04 §4] |
| X-10 | Pharmacy rejects | Reason shown to prescriber and patient; patient can pick another pharmacy; prescriber re-sends or issues new Rx | [03 §4] |
| X-11 | No pharmacy acknowledgement in 2 h | Alert care team and patient to choose another pharmacy; status Not acknowledged | [03 §4 rule] |
| X-12 | Pharmacy status webhook replayed or out of order | Idempotent; a delivery never moves backwards; event kept in history | [03 §5], [04 §4] |
| X-13 | Failed delivery | Reason and next step shown to patient (new attempt or pickup) | [03 §5.4] |
| X-14 | Unmatched lab result | Goes to reconciliation queue, never auto-filed to a chart | [03 §6.4] |
| X-15 | Critical result not acknowledged in window | Escalates to on-call doctor; window set with clinical safety reviewer | [03 §6.6] |
| X-16 | Sample rejected | Order returns for recollection; patient notified without test names | [03 §6] |
| X-17 | Virus found in upload | File quarantined, uploader told, not shown to clinicians | [03 §7] |
| X-18 | Deletion request on record under legal hold | Refused with reason; request recorded | [03 §7.4] |
| X-19 | Access outside assignment | Blocked unless break-the-glass with reason; compliance alerted | [03 §3], [05 §2] |
| X-20 | Idle staff session | Auto sign-out; unsaved clinical draft preserved | [05 §2] |
| X-21 | Lab has no electronic interface | Requisition PDF generated and sent | [03 §6.3] |

#### 6. Business rules

| ID | Rule | Source |
| --- | --- | --- |
| BR-01 | Cancel/reschedule is free until a per-service cut-off; afterwards a fee applies or the change is blocked, as configured per service | [03 §1] |
| BR-02 | A doctor cannot be double booked unless the slot is overbookable, up to an admin maximum per session | [03 §1] |
| BR-03 | Waitlisted patients are offered freed slots in order, each with a configurable acceptance time | [03 §1] |
| BR-04 | Admins cap future appointments per patient per service | [03 §1] |
| BR-05 | Times stored in UTC, shown in the location time zone; video shows both zones when different | [03 §1] |
| BR-06 | Slot availability = template − bookings − synced busy time | [03 §1.2] |
| BR-07 | External calendars receive "Busy" only, never patient data | [04 §4] |
| BR-08 | Default two reminders before a visit, each with confirm/reschedule/cancel links | [03 §1.6] |
| BR-09 | Consultation cannot start without the service's required consents (emergency exception, recorded) | [03 §2] |
| BR-10 | Red-flag triage answer alerts the on-duty doctor immediately | [03 §2] |
| BR-11 | A signed note is locked; changes are addenda with author and time | [03 §3] |
| BR-12 | Trainee notes require supervisor co-signature before release | [03 §3] |
| BR-13 | Every chart view is logged | [03 §3] |
| BR-14 | Out-of-assignment access needs break-the-glass reason and compliance review | [03 §3] |
| BR-15 | Allergy, interaction, duplicate-therapy and dose checks run on every prescription (target: 100 %) | [03 §4], [01 §3] |
| BR-16 | Serious alerts need an override reason, logged | [03 §4] |
| BR-17 | Signing a prescription requires re-authentication; EPCS requires DEA-compliant two-factor signing by an identity-proofed prescriber | [03 §4], [05 §2] |
| BR-18 | Generic substitution allowed unless "dispense as written" | [03 §4] |
| BR-19 | Pharmacy cannot extend a prescription; refills and renewals go to the prescriber | [03 §4] |
| BR-20 | A prescription unacknowledged for 2 h alerts care team and patient | [03 §4] |
| BR-21 | Partner pharmacy staff see only prescriptions and patients of their own pharmacy | [02 §8] |
| BR-22 | Controlled substances are handed only to the named patient or authorised proxy with ID; pharmacy records ID check and recipient | [03 §5] |
| BR-23 | SMS, email and push never contain diagnoses, test names or medicine names; only a prompt to log in | [03 §5], [04 §4] |
| BR-24 | Duplicate or out-of-order pharmacy status updates never move a delivery backwards | [03 §5] |
| BR-25 | Critical results go to the ordering doctor immediately and escalate if unacknowledged | [03 §6] |
| BR-26 | Normal results are released to patients immediately; abnormal results after ordering-doctor review, within information-blocking limits | [07 B4], [03 §6.7] |
| BR-27 | Unmatched results never go to a chart automatically | [03 §6] |
| BR-28 | Uploads are virus-scanned before anyone can open them | [03 §7] |
| BR-29 | Retention follows legal periods; deletion is checked against legal holds | [03 §7] |
| BR-30 | Card data never touches our servers (hosted fields/tokens) | [03 §8] |
| BR-31 | Refunds above a configured amount need staff approval | [03 §8] |
| BR-32 | Staff access limited to organisation and assigned locations; least privilege | [02 §8], [05 §2] |
| BR-33 | Every external call has a timeout and back-off retry; failures are visible, never silent; inbound messages are idempotent | [04 §4] |
| BR-34 | Patient name, date of birth and photo are visible on every clinical screen (wrong-patient prevention) | [06 §2] |
| BR-35 | Tests and non-production environments use synthetic data only | [05 §2] |
| BR-36 | No health data in logs, URLs or analytics | [05 §2] |

#### 7. Integration and data needs (BA view)

Data domains and standards are as listed in [04 §1–§2]. The BA adds the business-facing needs below.

| ID | Need | Release | Open dependency |
| --- | --- | --- | --- |
| I-01 | Google Workspace SSO for staff (OIDC/SAML) | R1 | Workspace tenant and admin contact |
| I-02 | Google Calendar two-way busy sync; .ics for patients | R1 | Per-doctor consent to sync (derived) |
| I-03 | Video provider under a BAA | R1 | Vendor choice (G2) |
| I-04 | Email, SMS, push under BAA | R1 | Vendor choice (G2) |
| I-05 | OCR and virus scanning for documents | R1 | Vendor choice (G2) |
| I-06 | Payment provider (hosted fields) | R2 | Vendor choice; deposit timing G-03 |
| I-07 | Drug database | R2 | Licence and cost |
| I-08 | Certified e-prescribing/EPCS network and its onboarding | R2 | Network, owner and lead time (research gap 4) |
| I-09 | Pharmacy status API/webhook for partners | R3 (portal status R2) | Contract and authentication model (SA) |
| I-10 | Lab interfaces (HL7 v2 / FHIR / hub) | R3 | Named partner labs (C3 open) |
| I-11 | Insurance clearinghouse | R4 | — |
| I-12 | Data model coverage for all domains in [04 §1]; no migration in R1–R3 | R1–R3 | If C1/C2 change, migration becomes a scoped change |

Technical feasibility, contracts and vendor selection are routed to the Solution Architect through the Orchestrator; the BA does not decide them.

#### 8. Acceptance examples

Format: Given / When / Then. Type: P positive, N negative, E exception, S patient-safety (needs dedicated negative and boundary tests and clinical review per [05 §6]). Example values are illustrative; configurable values stay settings.

| ID | Type | Scenario | Trace |
| --- | --- | --- | --- |
| AC-01 | P | **Given** a doctor with a free 09:00 slot and no busy time, **when** a patient books it and confirms, **then** the appointment is Confirmed, an email/SMS with .ics is sent, and the doctor's Google Calendar shows "Busy" with no patient name. | F-PP-04, F-DR-02, BR-06/07 |
| AC-02 | N | **Given** a doctor's Google Calendar shows a meeting 09:00–10:00, **when** a patient searches slots, **then** no slot in that range is offered. | BR-06 |
| AC-03 | E | **Given** two patients hold the last slot in checkout, **when** the hold of the first expires and the second confirms, **then** exactly one appointment exists; the first sees "slot no longer available" plus alternatives. | X-01/02, BR-02 |
| AC-04 | N | **Given** a cancellation cut-off of 24 h and a visit in 10 h, **when** the patient cancels, **then** the configured fee is shown and must be accepted, or the cancel is blocked, per the service setting. | BR-01 |
| AC-05 | P | **Given** a waitlisted patient and a freed slot, **when** the slot frees, **then** the first waitlisted patient is offered it and the offer lapses to the next after the configured time. | BR-03 |
| AC-06 | P | **Given** a booked visit, **when** the second reminder is due, **then** the message contains a log-in prompt and confirm/reschedule/cancel links but no diagnosis, test or medicine name. | BR-08/23 |
| AC-07 | N | **Given** a service requiring a signed consent that is unsigned, **when** the doctor opens the consultation, **then** it cannot start; for an emergency the doctor records the exception and the system logs it. | BR-09 |
| AC-08 | S | **Given** a triage answer "chest pain", **when** triage is saved, **then** the on-duty doctor is alerted at once and the patient sees emergency advice; alert time is recorded. | BR-10 |
| AC-09 | P | **Given** vitals with SpO2 below the configured limit, **when** saved, **then** the value is highlighted and the triage category prompt appears. | F-PC-04 |
| AC-10 | P | **Given** a signed note, **when** the doctor corrects a dose, **then** an addendum with author and time is created and the original remains unchanged. | BR-11 |
| AC-11 | N | **Given** a trainee's note, **when** released without a co-signature, **then** release is refused. | BR-12 |
| AC-12 | N | **Given** a doctor not assigned to a patient, **when** they open the chart, **then** access is blocked until a reason is entered; compliance is alerted and the event appears in the review queue. | BR-14, F-AD-08 |
| AC-13 | S | **Given** a patient with a penicillin allergy, **when** the doctor selects amoxicillin, **then** a serious alert shows; the doctor cannot sign without an override reason or a changed order; the override is logged. | BR-15/16, X-08 |
| AC-14 | S | **Given** two interacting drugs on the medication list, **when** a third prescription creates a duplicate therapy, **then** a duplicate alert is shown before signing. | BR-15 |
| AC-15 | S | **Given** a Schedule II prescription, **when** the doctor lacks completed identity proofing, **then** EPCS signing is refused; with proofing, signing requires two factors and is audited. | BR-17, F-DR-08 |
| AC-16 | N | **Given** an assistant prepared an EPCS prescription, **when** the assistant tries to sign, **then** signing is refused. | A-08, BR-17 (pending G-10) |
| AC-17 | P | **Given** a signed prescription and chosen pharmacy, **when** it is sent, **then** status moves Sent → Received and the patient sees each change in the portal. | ST-03 |
| AC-18 | N | **Given** a pharmacist at Pharmacy A, **when** they search for Pharmacy B's prescription, **then** nothing is returned and the attempt is logged. | BR-21 |
| AC-19 | E | **Given** a Sent prescription unacknowledged for 2 h, **when** the timer passes, **then** care team and patient are alerted, status shows Not acknowledged, and the patient can choose another pharmacy. | BR-20, X-11 |
| AC-20 | P | **Given** a pharmacy rejection with reason "out of stock", **when** received, **then** the doctor and patient see the reason and the patient can select another pharmacy. | X-10 |
| AC-21 | N | **Given** a pharmacy requests 5 extra refills, **when** it submits, **then** the request is routed to the prescriber and the original prescription is unchanged. | BR-19 |
| AC-22 | N | **Given** a controlled-substance delivery, **when** the pharmacy marks Delivered without recording ID check and recipient, **then** the portal refuses the update. | BR-22 |
| AC-23 | E | **Given** Delivered has been recorded, **when** a late "Out for delivery" webhook arrives, **then** the status stays Delivered and the event is stored in history only. | BR-24, X-12 |
| AC-24 | E | **Given** the same webhook is sent twice, **when** processed, **then** one event exists. | BR-33 |
| AC-25 | P | **Given** a failed delivery with reason and "changed to pickup", **when** reported, **then** the patient sees the reason and the pickup status. | ST-04, X-13 |
| AC-26 | P | **Given** a normal result, **when** the lab returns Final, **then** it is released to the patient immediately. | BR-26 |
| AC-27 | S | **Given** an abnormal result, **when** it arrives, **then** it is not visible to the patient until the ordering doctor reviews it and is released within the information-blocking window; if the window nears, the doctor is reminded (G-11). | BR-26 |
| AC-28 | S | **Given** a critical result unacknowledged beyond the window, **when** the timer expires, **then** the on-call doctor is alerted and the escalation is audited. | BR-25 |
| AC-29 | S | **Given** an electronic result with no matching order or patient, **when** received, **then** it enters the reconciliation queue and is not attached to any chart. | BR-27 |
| AC-30 | N | **Given** an upload with malware, **when** scanned, **then** it is quarantined and cannot be opened by staff. | BR-28 |
| AC-31 | E | **Given** a deletion request for a document under legal hold, **when** processed, **then** it is refused with the reason recorded. | BR-29 |
| AC-32 | N | **Given** a patient with a proxy link as a guardian of a 17-year-old, **when** the child turns the configured age of consent, **then** proxy access follows the age rule and the guardian is notified (rule values G-07). | F-PP-03 |
| AC-33 | N | **Given** a staff member idle past the timeout, **when** they act, **then** re-authentication is required and drafts are preserved. | X-20 |
| AC-34 | N | **Given** a user in Clinic A only, **when** they search for a patient registered in Clinic B with no relationship, **then** no record is shown. | BR-32 |
| AC-35 | N | **Given** a patient, **when** they attempt any chart view of another patient by URL manipulation, **then** access is denied and logged. | BR-13/32 |
| AC-36 | P | **Given** an admin, **when** they try to delete audit entries, **then** the action is not available and any attempt is logged. | [05 §2] |
| AC-37 | P | **Given** a refund above the configured threshold, **when** billing staff submits it, **then** it waits for approval. | BR-31 |
| AC-38 | E | **Given** the e-prescribing network is down, **when** the doctor signs, **then** the prescription remains Signed (unsent) with visible retry state and appears on the operations dashboard; it is not marked Sent. | X-09 |

#### 9. Requirement-to-source traceability (summary)

| Intake source | Mapped items |
| --- | --- |
| [01 §3] goals | BR-15, BR-20, BR-26, AC-13, AC-19, AC-27, F-PP-04, F-PP-12 |
| [01 §4] users | A-01…A-17 |
| [01 §5–6] scope and releases | section 2 release column; out-of-scope items intentionally have no features |
| [02 §1–7] features | F-BS, F-PP, F-PC, F-DR, F-PH, F-AD, F-SH |
| [02 §8] permissions | section 1.1 |
| [03 §1–8] workflows | ST-01…ST-06, J-01…J-22, BR-01…BR-31, X-01…X-21 |
| [04] integrations | section 7, BR-07/33 |
| [05] NFR/security | BR-32…BR-36; NFR values stay in the PRD (not restated here) |
| [06] UX | BR-34, J-01 |
| [07] decisions | A1–A6, B1–B6, D1–D6 reflected; open rows listed in section 11 |

#### 10. Prioritised release view (as agreed; no BA re-prioritisation)

- **R1 (production end May 2027):** F-BS-*, F-PP-01…09/14/16, F-PC-01…07/09, F-DR-01/02/04/05/06/12, F-AD-01…09/11, F-SH-01…05/08/10. Largest single risk: the R1 list is wide for about six months (see research H2 and [01 §8]); trimming is a G1 decision.
- **R2:** F-PP-10/11/15, F-DR-07/08/11, F-PH-01…06, F-AD-10, F-SH-07/09.
- **R3:** F-PP-12/13, F-PC-08, F-DR-09/10, F-PH-07…09.
- **R4:** F-DR-03/13, F-AD-12, F-PC-05 electronic, insurance eligibility and claims.

#### 11. Gaps, contradictions and decisions needed

Items marked **Intake/human** are conflicts or missing business decisions; the BA has not resolved them. Items marked **SA** go to the Solution Architect via the Orchestrator.

| ID | Type | Issue | Impact | Route |
| --- | --- | --- | --- | --- |
| G-01 | Conflict | Intake assumes a custom build; research notes buy/integrate or hybrid is unevidenced and R1–R3 at US$150–300k is tight. Is buy/hybrid in scope? May vendors be contacted for quotes? | Whole scope | Intake/human (G1) |
| G-02 | Conflict | Pharmacy-status visibility: patient "pharmacy status" is R2 and portal statuses include "out for delivery/delivered" in R2, but tracking links, API/webhook and delivery notifications are R3. What exactly ships in R2 versus R3? | R2/R3 boundary | Intake/human |
| G-03 | Conflict | Booking rules include deposits and cancellation/no-show fees (R1, [02 §6], [03 §1.4]), but payments are R2 and self-pay card payments are "first" per B3. Can R1 charge any fee? If not, R1 policy is "block only" and deposits move to R2. | R1 booking behaviour | Intake/human |
| G-04 | Conflict | Pre-consultation can book "lab sample collection" in R1 but labs are R3. Remove from R1, or define a non-integrated placeholder? | R1 scope | Intake/human |
| G-05 | Gap | "Acknowledgement" is undefined: network receipt, pharmacy acceptance, or first status? For non-partner pharmacies only network messages exist. Is the 2 h clock 24x7 or pharmacy hours? | KPI, J-13, AC-19 | Intake/human; feasibility to SA |
| G-06 | Gap | Billing staff, lab coordinator, assistant, marketing/CMS, compliance and proxy are users but absent from the permission matrix; extended matrix in 1.1 is a proposal only. | Permissions | Intake/human (G2) |
| G-07 | Gap | Proxy rules: age thresholds, state-specific adolescent confidentiality, what a proxy may see (results, notes), verification evidence, revocation. Operating states still open. | F-PP-03, legal | Intake/human; clinical safety reviewer |
| G-08 | Gap | The matrix gives System Admin access to delivery address while admin is "audit only" for clinical data; is that intended? Where is the delivery address captured and who owns it (patient profile vs pharmacy)? | Privacy, least privilege | Intake/human |
| G-09 | Gap | Prescription validity/expiry periods, cancel-after-send behaviour (CancelRx), and fallback when the network is down (urgent case). | ST-03, X-09 | Intake/human; SA for network behaviour |
| G-10 | Gap | Delegation: what may an assistant or nurse prepare, sign, or order for a doctor (non-EPCS)? | A-08 | Intake/human; clinical safety reviewer |
| G-11 | Gap | Critical-result escalation window, abnormal-result release deadline, and who defines "abnormal vs critical"; no independent clinical reviewer exists yet (07 §E). | Patient safety | Intake/human |
| G-12 | Gap | Defaults not yet set: no-show grace period, hold time, reminder times, offer acceptance time, max future appointments, calendar-stale threshold, note-sign deadline. | Config | Plan & Design (PM/SA proposes) |
| G-13 | Gap | Controlled-substance ID check for non-partner pharmacies cannot be recorded by us. Is that accepted (pharmacy's own process) or is EPCS limited to partner pharmacies? | EPCS scope | Intake/human |
| G-14 | Conflict | Priority mismatch: doctor "tasks and secure messages with staff and patients" is M (R1) but patient messaging is S (R1). Does R1 messaging include patients? | R1 scope | Intake/human |
| G-15 | Gap | Patient visit summaries are released "per policy" in R1 ([03 §3.4]) but the patient health-record view is R2. Is there an R1 visit-summary view? | R1 scope | Intake/human |
| G-16 | Gap | Account deletion request ([02 §2]) versus mandatory medical-record retention: define what "deletion" means (account/login only, or data erasure where lawful). | Privacy, legal | Intake/human; legal advice |
| G-17 | Gap | Payment for medicines: [02 §2] says payment and delivery are handled by the pharmacy, yet [03 §8] mentions a "pharmacy price list". Is any pharmacy pricing or payment on our platform? | R2 payments scope | Intake/human |
| G-18 | Gap | Operating states, partner pharmacy count, partner labs, cloud provider, languages, AI features, existing systems (07 B7, B8, C1, C3, C6, A1). | Telehealth rules, vendors, sizing | Intake/human (already open) |
| G-19 | Gap | Telehealth eligibility: does booking need patient-location and clinician-licence checks per state? Unknown until states named. | R1 telehealth | Intake/human |
| G-20 | Gap | Who owns e-prescribing/EPCS network onboarding and certification lead time, and does R2 date depend on it. | R2 plan | Intake/human; SA |
| G-21 | Governance | One human holds all gate roles and clinical review is interim; no independent clinician for patient-safety rules. | Safety | Intake/human |

#### 12. Limitations

- Built from intake revision 2 and the HEAAA-4 research draft, which is itself unreviewed and mostly secondary-sourced.
- No client interview, no existing-system observation, no vendor trial. Nothing here is observed product behaviour.
- Permission matrix, new states (ST-06), exception behaviours and acceptance examples marked derived are proposals for review.
- Not legal or clinical advice; clinical safety rules need a licensed clinician's review.
- Next permitted action: independent review of this exact revision; then Orchestrator routes G-01…G-21 to Intake/human and the document feeds the PRD draft (HEAAA-6). No human gate is requested by this task.

---

## Appendix D — Research appendix (verbatim, HEAAA-4 `research` rev `dc45ec56`)

> Embedded unchanged except heading levels. Draft, advisory, not accepted scope.

### Research appendix — comparable EHR products (draft for PRD appendix)

| Field | Value |
| --- | --- |
| Task | HEAAA-4 `[SDLC:research]` |
| Author | Researcher agent |
| Baseline | Intake pack revision 2 (2026-11-02), `docs/intake/` |
| Access date | 2026-11-04 |
| Status | DRAFT — awaiting independent review. Advisory only; not accepted scope. |

#### 1. Decision: discovery is needed

The product is new, regulated (US HIPAA, EPCS) and spans six surfaces. A skip is not justified. Research is advisory: it does not authorise purchases, tools or scope changes.

#### 2. Method and honest limits

- Comparables were chosen by audience (US multi-clinic ambulatory network), task (patient portal + scheduling + e-prescribing/EPCS + telehealth) and market fit. The set is not a universal "top five".
- Evidence grades: **O** = official vendor page fetched and read; **T** = third-party directory/review/health-system page (secondary); **U** = not verified.
- Many vendor pages returned HTTP 403/404 or carried no feature detail (athenahealth 403; NextGen 404). Only the Elation, eClinicalWorks and Epic home pages were read, and they were thin. Most capability claims below are therefore **T**. No product was trialled, so nothing here is *observed* behaviour.
- Pricing is dated 2026-11-04 and may be stale. Quotes were not requested.
- Fewer than five products have strong evidence. Five are listed; confidence is low-to-medium for all.

#### 3. Comparison (advertised capabilities, as evidenced)

| # | Product | Fit to our audience | Portal / scheduling / telehealth | E-Rx / EPCS | Multi-site | Pricing evidence | Source (accessed 2026-11-04) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **athenahealth athenaOne** | Cloud EHR + PM for ambulatory groups | Patient portal, telehealth, multi-location scheduling listed (T) | E-Rx, EPCS, PDMP, medication history listed (T) | Listed (T), detail U | Not public (U) | Official page https://www.athenahealth.com/solutions/athenaone → 403, not read. Secondary: [SourceForge](https://www.sourceforge.net/software/product/athenaOne), [TechRadar](https://www.techradar.com/reviews/athenahealth) |
| 2 | **Elation Health** | Independent/small practices; smaller than our 30+ clinic scale | "Patient Passport" portal and integrated telehealth (O) | EPCS reported by reviews (T); not shown on official page (U) | U | Vendor product guide (via search snippet, T): Standard $425, Premium $500 per provider/month; telehealth +$25; AI scribe +$199. Pricing page itself shows no figures (O) | https://www.elationhealth.com/pricing (O); https://www.elationhealth.com/ehr-product-guide/ (T) |
| 3 | **eClinicalWorks (healow)** | Large ambulatory vendor, many specialties | healow portal, TeleVisits, check-in, AI contact centre "Genie" (O names; detail T) | E-Rx listed (T); EPCS U | U | Not stated (O) | https://www.eclinicalworks.com/products-services/ehr/ (O); [healow summary](https://chcanys.org/products/telehealth-platforms/healow-ecw) (T) |
| 4 | **NextGen Healthcare (Enterprise / Office)** | Enterprise line targets multi-specialty, multi-site groups | Portal (online scheduling, refills, bill pay, messaging) and telehealth (T); reviewers report portal enrolment problems (T, small sample) | E-Rx assumed; **EPCS not confirmed** (U) | Enterprise multi-site (T) | One aggregator: ~$549/provider/month for Office (T, unverified) | Official URL returned 404. [TechRadar](https://www.techradar.com/reviews/nextgen-healthcare), [Softwarefinder](https://softwarefinder.com/nextgen-enterprise-ehr) |
| 5 | **Epic (MyChart, Cadence ambulatory) via Community Connect** | Closest to a large multi-clinic network; typically bought via a host health system | MyChart: online scheduling, messaging, video visits, refill requests; Cadence scheduling (T, health-system pages) | Surescripts e-Rx; EPCS with two-factor (named by NewYork-Presbyterian) (T) | Yes by design (T) | No public pricing (O) | https://www.epic.com/software/ (O, no product detail); [NYP Community Connect](https://www.nyp.org/communityconnect), [Corewell Health](https://corewellhealth.org/community-connect) (T) |

#### 4. Findings, labelled

##### Confirmed client needs (from intake rev 2 — not research output)
US multi-clinic network (30+ clinics, ~250k patients); six surfaces; EPCS in R2; external partner pharmacies; Google Workspace SSO/calendar; R1 by end May 2027; US$150–300k build, US$5–15k/month run.

##### Research-backed observations (grade T unless stated)
1. Commercial EHRs bundle portal, scheduling, telehealth and e-prescribing; EPCS is normally a second-factor/identity-proofing add-on to e-Rx, via the Surescripts network (Epic/NYP source).
2. Per-provider SaaS pricing in this market is roughly US$350–550/provider/month for small-practice products (Elation, NextGen Office). At ~1,000 staff, even a fraction of them as prescribers puts SaaS subscription cost in the same range as the run budget; enterprise tiers are unpublished.
3. None of the five verifiably offers a **partner-pharmacy portal with pharmacy-reported delivery tracking** shown to patients. This is a candidate differentiator, but absence of evidence on closed vendor sites is not proof of absence (U).
4. Portal enrolment friction is a recurring complaint (NextGen, small sample).

##### Hypotheses (need testing, not recommendations)
- H1: Delivery-status visibility (R3) and a partner-pharmacy portal are real differentiators. Test: ask each vendor in a demo.
- H2: Building R1–R3 inside US$150–300k is tight against buy/integrate alternatives. Test: vendor quotes and an R1 sizing exercise in discovery.
- H3: Epic Community Connect-style hosting is unavailable to a standalone network. Not verified.

##### Recommendations for human decision (via PM/Orchestrator)
- R-A: Obtain written quotes and official feature/EPCS confirmation from athenahealth, NextGen and eClinicalWorks before G1, so build-vs-buy is evidenced. This needs the product owner's approval to contact vendors; no accounts or purchases were made.
- R-B: Use a certified third-party e-prescribing/EPCS network rather than build certification (consistent with intake risks). Vendor and cost are open.
- R-C: Keep delivery visibility as pharmacy-reported status only (already agreed scope).

##### Excluded from this research
Pricing negotiation, vendor accounts or trials, clinical-safety review, legal/HIPAA analysis, AI scribe evaluation (R4, unapproved), non-US products.

#### 5. Gaps and adoption questions for BA/PM
1. Is a buy/integrate option (or hybrid with a commercial EHR core) in scope, or is a custom build already decided? Intake assumes build.
2. May the team contact vendors for quotes and EPCS/portal confirmation?
3. Which operating states apply (telehealth licensing, pharmacy rules)?
4. Which certified e-prescribing/EPCS network, and who owns onboarding?
5. Should partner-pharmacy integration with existing pharmacy software be researched separately?

#### 6. Limitations
Secondary sources dominate; some claims came from search snippets, not full page reads. Vendor pages may differ by tier. Re-verify before G1. Independent review is pending; this draft is not review-passed or human-approved.
