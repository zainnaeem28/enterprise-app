# 01 — Product Brief

> **Status: CONFIRMED.** AI-prepared 2026-10-31. All sections Agreed by Zain Naeem (product owner) on 2026-10-31, and updated with his decisions of 2026-11-02 03:26 PKT (UTC+05:00) recorded in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md).

## 1. Vision

One secure platform where patients book and attend care, doctors document and prescribe, external partner pharmacies receive and fulfil prescriptions, and labs and documents flow back into a single patient record. The platform serves a **US multi-clinic healthcare network** (30+ clinics), works with **many external pharmacies** that run their own deliveries, and presents a public brand site that turns visitors into booked patients.

## 2. Problems to solve (agreed)

- Booking happens across phone calls, spreadsheets and personal calendars. That causes double bookings, no-shows and long hold times.
- Patient information is split across paper forms, lab PDFs and separate systems. Doctors spend consultation time searching for history.
- Prescriptions travel by paper or phone, so pharmacies re-key them. That risks errors and gives patients no visibility of status.
- Patients can't see where their medicine is once it leaves the doctor: pharmacy status and delivery are invisible to them.
- Lab orders and results are faxed or emailed, so abnormal results can be missed.
- Leadership has no reliable view of capacity, revenue, turnaround times or compliance.

## 3. Goals and success measures (agreed 2026-11-02; measured within 12 months of R1)

| Goal | Measure | Target |
| --- | --- | --- |
| Easier access to care | Share of appointments booked online | 60 % |
| Fewer missed visits | No-show rate after reminders | under 8 % |
| Faster consultations | Median time a doctor spends finding history | under 1 min |
| Safer prescribing | Prescriptions with an interaction/allergy check | 100 % |
| Faster medicines | Prescription sent to pharmacy acknowledgement (median) | under 2 h |
| Visible delivery | Pharmacy deliveries with tracking status shown to the patient | 95 % |
| Lab safety | Critical results acknowledged within the policy window | 100 % |
| Patient satisfaction | Portal satisfaction score (CSAT) | 4.5 / 5 |

## 4. Users

| User | Portal | Summary |
| --- | --- | --- |
| Visitor | Brand site | Finds services, doctors and locations; starts booking |
| Patient (and guardian/proxy) | Patient portal | Books, attends, views records, orders medicines, pays |
| Pre-consultation staff (triage nurse, care coordinator, front desk) | Pre-consultation portal | Prepares each patient before the doctor sees them |
| Doctor (and nurse/assistant acting for them) | Doctor portal | Consults, documents, prescribes, orders and reviews labs |
| Pharmacist and pharmacy technician at an external partner pharmacy | Partner pharmacy portal | Receives, verifies and fulfils prescriptions; reports pickup and delivery status (their own delivery service) |
| Lab coordinator | Doctor/pre-consultation portals (lab desk) | Tracks samples and external lab results |
| Billing staff | Admin portal (billing) | Invoices, payments, insurance |
| Organisation admin / system admin | System admin portal | Configures clinics, users, roles, services, integrations; audits |
| Compliance officer | System admin portal (read-only audit) | Reviews access logs, consents, incidents |

Detailed permissions are in [02-PORTALS-AND-FEATURES.md](02-PORTALS-AND-FEATURES.md).

## 5. Scope

### In scope (agreed)

- Six surfaces: brand site, patient portal, pre-consultation portal, doctor portal, partner pharmacy portal (for external pharmacies), and system admin portal.
- Shared modules:
  - appointment booking and scheduling
  - Google Calendar integration
  - telehealth video
  - clinical record
  - e-prescribing (including EPCS) to external pharmacies
  - delivery status visibility (pharmacy-reported)
  - lab orders and results
  - document management
  - secure messaging and notifications
  - payments and invoicing
  - reporting
  - audit
- Multiple clinics and locations under one organisation, with per-location settings.
- Web, responsive on desktop, tablet and phone browsers.

### Out of scope for the first releases (agreed)

- Running our own pharmacy, delivery dispatch board or driver app. External pharmacies deliver; we show their status.
- Migrating data from an existing system. This is a new system.
- Native iOS/Android apps. The web portals are mobile-responsive; native apps can follow later.
- Full insurance claims processing (claims submission and remittance). Phase 4 candidate.
- Inpatient/hospital modules: wards, beds, operating theatres.
- Medical imaging storage (PACS). Only viewing linked reports and images, if needed.
- Building our own drug database or lab analyser software. These are licensed or integrated.
- AI diagnosis. Any AI assistance (for example a note-drafting scribe) is a separate decision.

## 6. Phased releases (agreed 2026-11-02)

| Release | Contents | Target |
| --- | --- | --- |
| **R1 — Foundation and booking** | Identity, Google Workspace SSO for staff, roles, clinics/locations, brand site, patient portal (register, book, reschedule, cancel, reminders, telehealth join), doctor schedule and Google Calendar sync, pre-consultation forms and triage queue, basic clinical notes, documents upload, system admin, audit log | Production by end of May 2027 |
| **R2 — Prescribing and pharmacy network** | E-prescribing with interaction/allergy checks, including EPCS for controlled substances; sending to external pharmacies via a certified network; partner pharmacy portal (receive, verify, fulfil, report status); refills; patient medicine status; card payments | Later quarter, after R1 |
| **R3 — Delivery visibility and labs** | Pharmacy-reported delivery status and tracking links for patients; lab orders, external lab interface, results inbox, critical-result alerts, patient result release (normal immediately, abnormal after review) | Later quarter, after R2 |
| **R4 — Enterprise extensions** | Insurance eligibility and claims, advanced analytics, data warehouse export, AI scribe (if approved), native mobile apps | After R3 |

## 7. Constraints and assumptions (agreed 2026-11-02)

- **United States.** HIPAA Privacy and Security Rules, BAAs with every vendor that touches health data, 21st Century Cures Act patient access, DEA rules for EPCS. Operating states are still open; they affect telehealth licensing and state pharmacy rules.
- **Scale:** designed for ~250,000 patients, ~1,000 staff and 30+ clinics at launch (see [05-SECURITY-COMPLIANCE-NFR.md](05-SECURITY-COMPLIANCE-NFR.md)).
- **Budget:** US$150,000–300,000 build for R1–R3; US$5,000–15,000 per month for hosting and third-party services.
- **Hosting:** a HIPAA-eligible US cloud region with a signed BAA (provider still open).
- **Staff identity and calendars:** Google Workspace.
- CI/CD on GitHub Actions; source in `zainnaeem28/enterprise-app`.
- Third-party services (drug database, certified e-prescribing/EPCS network, video, SMS) carry their own licence and usage costs. These are not covered by Claude Max.

## 8. Risks (initial)

| Risk | Impact | Mitigation to consider |
| --- | --- | --- |
| Budget is low for large-scale US-regulated scope with EPCS and labs | Scope or timeline cut late | Size R1 precisely in discovery; trim at G1 rather than mid-build |
| State-by-state telehealth and pharmacy rules | Rework, launch limits per state | Name operating states before G1 |
| Certification lead times (e-prescribing network, EPCS) | R2 delay | Start vendor onboarding during Plan & Design |
| Scope size | Budget/timeline overrun | Phase strictly; confirm R1 boundary at G1 |
| Patient-safety defects (wrong medicine, missed critical result) | Harm, liability | Independent clinical review of rules; mandatory QA cases |
