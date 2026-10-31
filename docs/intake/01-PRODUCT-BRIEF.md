# 01 — Product Brief

> **Status: CONFIRMED** (AI-prepared 2026-10-31). Confirmed by: Zain Naeem (product owner) on 2026-10-31.

## 1. Vision

One secure platform where patients book and attend care, doctors document and prescribe, pharmacies dispense and deliver medicines, and labs and documents flow back into a single patient record. The platform serves a healthcare organisation with one or more clinics and pharmacies, and presents a public brand site that turns visitors into booked patients.

## 2. Problems to solve (proposed)

- Booking happens across phone calls, spreadsheets and personal calendars. That causes double bookings, no-shows and long hold times.
- Patient information is split across paper forms, lab PDFs and separate systems. Doctors spend consultation time searching for history.
- Prescriptions travel by paper or phone, so pharmacies re-key them. That risks errors and gives patients no visibility of status.
- Medicine delivery is tracked manually, with no proof of delivery or temperature record.
- Lab orders and results are faxed or emailed, so abnormal results can be missed.
- Leadership has no reliable view of capacity, revenue, turnaround times or compliance.

## 3. Goals and success measures (proposed — client to set targets)

| Goal | Measure | Target |
| --- | --- | --- |
| Easier access to care | Share of appointments booked online | ____ % |
| Fewer missed visits | No-show rate after reminders | ____ % |
| Faster consultations | Median time a doctor spends finding history | ____ min |
| Safer prescribing | Prescriptions with an interaction/allergy check | 100 % |
| Faster medicines | Prescription-to-dispatch time (median) | ____ h |
| Reliable delivery | On-time delivery with proof of delivery | ____ % |
| Lab safety | Critical results acknowledged within the policy window | 100 % |
| Patient satisfaction | Portal satisfaction score / NPS | ____ |

## 4. Users

| User | Portal | Summary |
| --- | --- | --- |
| Visitor | Brand site | Finds services, doctors and locations; starts booking |
| Patient (and guardian/proxy) | Patient portal | Books, attends, views records, orders medicines, pays |
| Pre-consultation staff (triage nurse, care coordinator, front desk) | Pre-consultation portal | Prepares each patient before the doctor sees them |
| Doctor (and nurse/assistant acting for them) | Doctor portal | Consults, documents, prescribes, orders and reviews labs |
| Pharmacist and pharmacy technician | Pharmacy portal | Verifies, dispenses and manages stock |
| Delivery dispatcher and driver | Pharmacy portal (dispatch) and driver web app | Plans routes, delivers, captures proof |
| Lab coordinator | Doctor/pre-consultation portals (lab desk) | Tracks samples and external lab results |
| Billing staff | Admin portal (billing) | Invoices, payments, insurance |
| Organisation admin / system admin | System admin portal | Configures clinics, users, roles, services, integrations; audits |
| Compliance officer | System admin portal (read-only audit) | Reviews access logs, consents, incidents |

Detailed permissions are in [02-PORTALS-AND-FEATURES.md](02-PORTALS-AND-FEATURES.md).

## 5. Scope

### In scope (proposed)

- Six surfaces: brand site, patient portal, pre-consultation portal, doctor portal, pharmacy portal (including dispatch and a driver web app), and system admin portal.
- Shared modules:
  - appointment booking and scheduling
  - calendar integrations
  - telehealth video
  - clinical record
  - e-prescribing and medicines processing
  - delivery management
  - lab orders and results
  - document management
  - secure messaging and notifications
  - payments and invoicing
  - reporting
  - audit
- Multiple clinics and locations under one organisation, with per-location settings.
- Web, responsive on desktop, tablet and phone browsers.

### Out of scope for the first releases (proposed)

- Native iOS/Android apps. The web portals are mobile-responsive; native apps can follow later.
- Full insurance claims processing (claims submission and remittance). Phase 4 candidate.
- Inpatient/hospital modules: wards, beds, operating theatres.
- Medical imaging storage (PACS). Only viewing linked reports and images, if needed.
- Building our own drug database or lab analyser software. These are licensed or integrated.
- AI diagnosis. Any AI assistance (for example a note-drafting scribe) is a separate decision.

## 6. Proposed phased releases (recommendation, not agreed)

| Release | Contents | Why first |
| --- | --- | --- |
| **R1 — Foundation and booking** | Identity and SSO, roles, clinics/locations, brand site, patient portal (register, book, reschedule, cancel, reminders, telehealth join), doctor schedule and calendar sync, pre-consultation forms and triage queue, basic clinical notes, documents upload, system admin, audit log | Delivers patient access and doctor scheduling, and proves the security foundation |
| **R2 — Prescribing and pharmacy** | E-prescribing with interaction/allergy checks, pharmacy verification queue, dispensing, inventory, refills, patient medicine orders, payments | Closes the doctor-to-pharmacy loop |
| **R3 — Delivery and labs** | Delivery zones and slots, dispatch board, driver app, live tracking, proof of delivery, cold chain; lab orders, external lab interface, results inbox, critical-result alerts, patient result release | Adds operational depth |
| **R4 — Enterprise extensions** | Insurance eligibility and claims, advanced analytics, data warehouse export, AI scribe (if approved), native mobile apps | Optimisation once core flows are stable |

## 7. Constraints and assumptions (to confirm)

- **Jurisdiction is not yet known.** This draft assumes US-style requirements (HIPAA, e-prescribing networks, HL7/FHIR) as a worst case. Confirm the country before design: it changes compliance, e-prescribing and lab-result rules.
- Hosting on a cloud provider that signs the required health-data agreement (for example a HIPAA Business Associate Agreement, or the local equivalent).
- CI/CD on GitHub Actions; source in `zainnaeem28/enterprise-app`.
- Third-party services (drug database, e-prescribing network, video, SMS, couriers) carry their own licence and usage costs. These are not covered by Claude Max.

## 8. Risks (initial)

| Risk | Impact | Mitigation to consider |
| --- | --- | --- |
| Regulation differs by country | Rework of compliance and integrations | Confirm jurisdiction at intake |
| Third-party certification lead times (e-prescribing networks, controlled-substance prescribing) | Release delay | Start vendor onboarding during Plan & Design |
| Data migration from existing systems | Delay, data-quality issues | Inventory existing systems in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md) |
| Scope size | Budget/timeline overrun | Phase strictly; confirm R1 boundary at G1 |
| Patient-safety defects (wrong medicine, missed critical result) | Harm, liability | Independent clinical review of rules; mandatory QA cases |
