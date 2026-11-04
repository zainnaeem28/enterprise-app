# BA Feature Map — Enterprise EHR Platform (PRD appendix)

| Field | Value |
| --- | --- |
| Task | HEAAA-5 `[SDLC:business-analysis]` |
| Author | Business Analyst agent |
| Baseline | Intake pack revision 2 (2026-11-02), `docs/intake/`; research draft HEAAA-4 (`research` document rev 1) |
| Version | 0.1 (first draft) |
| Status | **DRAFT — awaiting independent review.** Not review-passed, not human-approved. Not scope approval (G1). |

## 0. How to read this

- **Source tags** point at the intake pack: `[01 §6]` = `01-PRODUCT-BRIEF.md` section 6; `[07 A3]` = open-questions row A3. Where a tag is missing, the item is a **BA derivation** (marked *derived*) and needs confirmation.
- **Label discipline.** *Confirmed* = stated in the intake pack. *Derived* = BA inference that follows from confirmed text. *Recommendation / hypothesis* = from research or BA judgement; never scope until a human adopts it. *Gap* = a business decision nobody has made (section 11). The BA does not pick answers for gaps.
- Priority M/S/C and release R1–R4 are copied from the intake pack. Time windows, fees and limits are admin-configurable settings; this map names the setting but not a value unless the intake gives one.
- Requirement IDs (`F-`, `BR-`, `ST-`, `J-`, `AC-`, `G-`) are stable. Later changes append new IDs or revisions and never reuse an ID.

## 1. Actors and authorization boundaries

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

### 1.1 Permission matrix (extended; extends [02 §8], **proposal** until confirmed at G2)

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

## 2. Feature inventory (prioritised, traced)

Priority and release are copied verbatim from `02-PORTALS-AND-FEATURES.md`. Release ordering conflicts are listed in section 11, not silently fixed.

### 2.1 Brand site [02 §1]
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

### 2.2 Patient portal [02 §2]
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

### 2.3 Pre-consultation portal [02 §3]
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

### 2.4 Doctor portal [02 §4]
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

### 2.5 Partner pharmacy portal [02 §5]
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

### 2.6 System admin portal [02 §6]
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

### 2.7 Shared modules [02 §7]
F-SH-01 Identity and access (R1) · F-SH-02 Scheduling engine (R1) · F-SH-03 Notifications (R1) · F-SH-04 Messaging (R1) · F-SH-05 Documents: upload, virus scan, OCR, classification, versioning, e-signature, retention (R1) · F-SH-06 Clinical record with standard terminologies (R1–R2) · F-SH-07 Payments (R2) · F-SH-08 Audit and compliance (R1) · F-SH-09 Reporting (R2) · F-SH-10 Integration reliability: timeouts, retries, idempotent inbound, operations dashboard (R1 onward, per [04 §4]).

## 3. Entity states and transitions

Terminal states are in **bold**. "Actor" is who may trigger the transition. Any transition not listed is not allowed and must be rejected and logged.

### ST-01 Appointment [03 §1]
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

### ST-02 Clinical note [03 §3]
Draft → Signed (locked) → Addended (addendum with author and time). Trainee: Draft → Pending co-sign → Signed. A signed note is never edited in place.

### ST-03 Prescription [03 §4]
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

### ST-04 Delivery (pharmacy-reported) [03 §5]
Out for delivery → Delivered, or → Failed attempt → New attempt scheduled (back to Out for delivery) / Changed to pickup (→ Ready for pickup). Rule: duplicate or out-of-order updates never move a delivery backwards (BR-24).

### ST-05 Lab order [03 §6]
Ordered → Sample collected → Sent to lab → Partial results → Final results → Reviewed → Released to patient. Exits: Cancelled, Sample rejected (recollect → Ordered). Normal-result shortcut: Final → Released to patient automatically (BR-26).

### ST-06 Other entities (derived, to be confirmed at PRD)
- **Waitlist offer:** Offered → Accepted / Declined / Expired (configurable time) → next patient.
- **Document:** Uploaded → Scanned (clean / quarantined) → Classified → Confirmed by staff → Retained; Deletion request → Legal-hold check → Deleted / Refused.
- **Consent:** Pending → Signed (signer, time, version) → Superseded / Withdrawn.
- **Proxy link:** Requested → Verified → Active → Revoked / Expired (age-out).
- **Break-the-glass event:** Opened (reason) → Compliance alerted → Reviewed (justified / not justified).
- **Refill request:** Requested → Sent to prescriber → Approved (new Rx) / Denied (reason) / Needs visit.
- **Privacy request:** Received → Identity verified → In progress → Fulfilled / Refused (reason).
- **Invoice:** Issued → Paid / Partially paid / Refunded / Written off (R2).

## 4. Journeys

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

## 5. Exception, failure and recovery behaviour

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

## 6. Business rules

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

## 7. Integration and data needs (BA view)

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

## 8. Acceptance examples

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

## 9. Requirement-to-source traceability (summary)

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

## 10. Prioritised release view (as agreed; no BA re-prioritisation)

- **R1 (production end May 2027):** F-BS-*, F-PP-01…09/14/16, F-PC-01…07/09, F-DR-01/02/04/05/06/12, F-AD-01…09/11, F-SH-01…05/08/10. Largest single risk: the R1 list is wide for about six months (see research H2 and [01 §8]); trimming is a G1 decision.
- **R2:** F-PP-10/11/15, F-DR-07/08/11, F-PH-01…06, F-AD-10, F-SH-07/09.
- **R3:** F-PP-12/13, F-PC-08, F-DR-09/10, F-PH-07…09.
- **R4:** F-DR-03/13, F-AD-12, F-PC-05 electronic, insurance eligibility and claims.

## 11. Gaps, contradictions and decisions needed

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

## 12. Limitations

- Built from intake revision 2 and the HEAAA-4 research draft, which is itself unreviewed and mostly secondary-sourced.
- No client interview, no existing-system observation, no vendor trial. Nothing here is observed product behaviour.
- Permission matrix, new states (ST-06), exception behaviours and acceptance examples marked derived are proposals for review.
- Not legal or clinical advice; clinical safety rules need a licensed clinician's review.
- Next permitted action: independent review of this exact revision; then Orchestrator routes G-01…G-21 to Intake/human and the document feeds the PRD draft (HEAAA-6). No human gate is requested by this task.
