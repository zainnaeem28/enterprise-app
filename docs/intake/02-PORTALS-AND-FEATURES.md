# 02 — Portals and Features

> **Status: CONFIRMED** (AI-prepared 2026-10-31). Confirmed by: Zain Naeem (product owner) on 2026-10-31.
> Priority key: **M** = must have for its release, **S** = should have, **C** = could have. R1–R4 = proposed release (see [01-PRODUCT-BRIEF.md](01-PRODUCT-BRIEF.md)).

## 1. Brand site (public)

| Feature | Pri | Rel |
| --- | --- | --- |
| Home, about, services/specialties, locations with map, opening hours, contact | M | R1 |
| Doctor directory: profile, specialty, languages, locations, next available slot | M | R1 |
| "Book appointment" entry that hands off to the patient portal with service/doctor pre-selected | M | R1 |
| Content management for marketing staff (pages, blog, FAQs, banners) without developer help | M | R1 |
| SEO: metadata, sitemap, structured data for clinics and doctors, fast page loads | M | R1 |
| Multilingual content and right-to-left support if needed | S | R1 |
| Cookie consent; analytics that never receive health data | M | R1 |
| Careers, news, patient testimonials (with consent) | C | R2 |
| Website chat for non-clinical questions | C | R3 |

## 2. Patient portal

| Feature | Pri | Rel |
| --- | --- | --- |
| Sign-up with identity verification (email/phone OTP, optional ID document check); MFA | M | R1 |
| Profile: demographics, emergency contact, insurance cards, preferred pharmacy and language | M | R1 |
| **Family and proxy access:** guardian for a child, carer for an adult, with consent and age rules | M | R1 |
| **Appointment booking:** search by service, doctor, location, date, in-person or video; see real availability | M | R1 |
| Reschedule and cancel within policy; waitlist with automatic offers when slots free up | M | R1 |
| Reminders by email/SMS/push; add the appointment to Google/Outlook/Apple calendar (.ics) | M | R1 |
| Pre-visit questionnaire, consent forms with e-signature, insurance upload | M | R1 |
| Telehealth: device check, virtual waiting room, join video | M | R1 |
| Secure messaging with the care team (non-urgent), with attachments | S | R1 |
| Health record view: visit summaries, problems, allergies, medications, immunisations | M | R2 |
| Prescriptions: view, request refills, choose pickup or delivery | M | R2 |
| **Medicine orders:** cart, delivery slot, payment, live tracking, delivery history | M | R3 |
| Lab results with plain-language explanation and reference ranges, released per policy | M | R3 |
| Documents: upload and download (referrals, reports, insurance) | M | R1 |
| Payments: invoices, card/wallet payment, receipts, saved payment methods (tokenised) | M | R2 |
| Notification preferences; download my data; account deletion request | M | R1 |

## 3. Pre-consultation portal (triage and front desk)

| Feature | Pri | Rel |
| --- | --- | --- |
| Daily arrivals board by location, with check-in (front desk and self check-in QR) | M | R1 |
| Pre-visit questionnaire review; flag missing forms, consents and insurance | M | R1 |
| Triage: symptoms, urgency score/category, red-flag escalation to a doctor or emergency advice | M | R1 |
| Vitals capture (BP, pulse, temperature, SpO2, weight, height, BMI) with out-of-range warnings | M | R1 |
| Insurance eligibility check (manual in R1; electronic in R4) | S | R1 |
| Assign or reassign the patient to a doctor or room; queue and wait-time display | M | R1 |
| Book follow-ups, referrals and lab sample collection | M | R1 |
| Lab desk: sample labels/barcodes, collection status, courier hand-off to an external lab | M | R3 |
| No-show follow-up and waitlist filling | S | R1 |

## 4. Doctor portal

| Feature | Pri | Rel |
| --- | --- | --- |
| Schedule: day/week view across locations, availability templates, leave, blocked time | M | R1 |
| **Two-way calendar sync** with Google Calendar and Microsoft 365/Outlook (busy times only, no patient data) | M | R1 |
| Patient chart: summary, problems, allergies, medications, vitals trend, history, documents, labs | M | R1 |
| Clinical notes with templates (e.g. SOAP), favourites, sign and lock, addenda, co-sign for trainees | M | R1 |
| Telehealth consultation with notes side by side | M | R1 |
| **E-prescribing:** search medicines, dose/route/frequency, interaction/allergy/duplicate checks, send to pharmacy | M | R2 |
| Controlled-substance prescribing with extra authentication (if the jurisdiction allows it online) | S | R2 |
| Lab orders: panels, priority, clinical notes, specimen instructions | M | R3 |
| **Results inbox:** new and abnormal results, acknowledge, comment, release to patient, critical-result alerts | M | R3 |
| Referrals (internal and external), sick notes and letters from templates | S | R2 |
| Tasks and secure messages with staff and patients | M | R1 |
| AI note-drafting assistant | C | R4 |

## 5. Pharmacy portal (including dispatch and driver app)

| Feature | Pri | Rel |
| --- | --- | --- |
| Incoming prescriptions queue (internal and external e-prescriptions), with status and priority | M | R2 |
| Pharmacist verification: clinical checks, interaction/allergy review, query back to the prescriber | M | R2 |
| Dispensing: pick, scan-verify barcode, label printing, counselling notes, final pharmacist check | M | R2 |
| Generic substitution and stock alternatives within rules | S | R2 |
| **Inventory:** stock per location, batch and expiry tracking, reorder levels, purchase orders, receiving, transfers, recalls | M | R2 |
| Controlled-drug register with balance checks and witness steps | M | R2 |
| Refill and renewal requests routed to the prescriber | M | R2 |
| Point of sale for walk-in orders; payments and receipts | S | R2 |
| **Delivery management:** delivery zones, fees, time slots, capacity per slot | M | R3 |
| Dispatch board: batch orders, assign drivers or a third-party courier, route optimisation | M | R3 |
| **Driver web app:** route, navigation hand-off, status updates, proof of delivery (signature, photo, OTP), ID check for restricted items | M | R3 |
| Cold-chain items: temperature-controlled packaging flags and temperature log | S | R3 |
| Failed delivery, return-to-pharmacy and redelivery flow | M | R3 |
| Live tracking link and ETA notifications for patients | M | R3 |

## 6. System admin portal

| Feature | Pri | Rel |
| --- | --- | --- |
| Organisation, clinics/locations, rooms, opening hours, holidays | M | R1 |
| Users, roles and permissions; staff SSO (Microsoft Entra ID / Okta / Google Workspace) | M | R1 |
| Services catalogue: duration, price, buffer times, eligible doctors, in-person/video | M | R1 |
| Booking policies: lead time, cancellation window, fees, waitlist rules, overbooking limits | M | R1 |
| Message templates (email/SMS/push) per language | M | R1 |
| Integrations settings: calendar, video, SMS, payments, labs, e-prescribing, couriers | M | R1–R3 |
| Audit log viewer: who viewed/changed which record, when, from where; export | M | R1 |
| Break-the-glass access review | M | R1 |
| Consent and privacy request management (access, correction, deletion, export) | M | R1 |
| Reports and dashboards: bookings, no-shows, utilisation, turnaround times, revenue, delivery SLAs | S | R2 |
| Feature flags per location; maintenance banners | S | R1 |
| Data export to a warehouse/BI tool | C | R4 |

## 7. Shared platform modules

| Module | Key capabilities | Rel |
| --- | --- | --- |
| Identity and access | Patient accounts, staff SSO, MFA, role- and location-based access, session timeout, device management | R1 |
| Scheduling engine | Availability rules, slot generation, conflict checks, overbooking rules, time zones | R1 |
| Notifications | Email, SMS, push, in-app; quiet hours; delivery receipts; no health details in SMS | R1 |
| Messaging | Secure threads, attachments, routing, response-time policy | R1 |
| Documents | Upload, virus scan, OCR, classification, versioning, e-signature, retention | R1 |
| Clinical record | Problems, allergies, medications, vitals, notes, immunisations, coded with standard terminologies | R1–R2 |
| Payments | Card/wallet payments, refunds, invoices, deposits/no-show fees | R2 |
| Audit and compliance | Immutable access and change log, consent records, retention rules | R1 |
| Reporting | Operational dashboards, scheduled reports, export | R2 |

## 8. Roles and permissions (summary)

| Capability | Patient | Pre-consult | Doctor | Pharmacist | Driver | Admin |
| --- | --- | --- | --- | --- | --- | --- |
| Book/cancel own appointments | ✓ | ✓ (for patients) | ✓ (own schedule) | — | — | ✓ |
| View full clinical chart | Own only | Limited (pre-visit) | Assigned patients | Medication-relevant | — | — (audit only) |
| Write clinical notes | — | Triage notes | ✓ | Pharmacy notes | — | — |
| Prescribe | — | — | ✓ | — | — | — |
| Verify and dispense | — | — | — | ✓ | — | — |
| See delivery address and items | Own | — | — | ✓ | Assigned stops only | ✓ |
| Configure system | — | — | — | — | — | ✓ |
| Break-the-glass emergency access | — | — | ✓ (logged, reviewed) | — | — | — |

The final permission matrix is confirmed in Plan & Design. Access is always restricted to the user's organisation and assigned locations.
