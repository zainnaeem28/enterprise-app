# 04 — Integrations and Data

> **Status: CONFIRMED.** AI-prepared 2026-10-31. All sections Agreed by Zain Naeem (product owner) on 2026-10-31, and updated with his decisions of 2026-11-02 03:26 PKT (UTC+05:00) recorded in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md).
> Vendor names are **candidates for evaluation**, not decisions. Final choices, costs and contracts are made in Plan & Design (G2).

## 1. Main data domains

| Domain | Main records |
| --- | --- |
| Identity | Users, roles, permissions, sessions, MFA devices, SSO connections |
| Organisation | Organisation, clinics/locations, rooms, opening hours, services, price lists |
| Patient | Demographics, contacts, proxies/guardians, insurance, consents, preferences |
| Scheduling | Availability templates, slots, appointments, waitlist, check-ins, calendar sync links |
| Clinical | Encounters, notes, problems/diagnoses, allergies, vitals, immunisations, referrals |
| Medications | Prescriptions, medication list, refill requests, interaction-check outcomes |
| Pharmacy network | External pharmacies (NCPDP ID, DEA registration, locations), partner portal accounts, prescription routing and acknowledgements, fulfilment status events, EPCS hand-over records |
| Delivery status | Pharmacy-reported delivery events, tracking links, failed-attempt reasons |
| Labs | Lab orders, specimens, results, reference ranges, critical-result acknowledgements |
| Documents | Files, versions, classifications, signatures, retention holds |
| Billing | Invoices, payments, refunds, deposits, insurance eligibility |
| Communication | Messages, notifications, templates, delivery receipts |
| Audit | Access events, change history, break-the-glass events, exports |

## 2. Healthcare standards (agreed for the United States)

| Need | Standard |
| --- | --- |
| Data exchange with other systems | **HL7 FHIR R4** APIs (US Core); **SMART on FHIR** for third-party app access |
| Lab interfaces | **HL7 v2** order/result messages (ORM/ORU), or FHIR where the lab supports it |
| Lab test codes | **LOINC** |
| Diagnoses | **ICD-10-CM** |
| Clinical terms | **SNOMED CT** (US Edition) |
| Medicines | **RxNorm** |
| Procedures / billing codes | **CPT/HCPCS** |
| E-prescribing | **NCPDP SCRIPT**, with **EPCS** for controlled substances |
| Imaging (optional) | **DICOM** viewing via a link to an external imaging system |

## 3. External integrations

| Area | Purpose | Candidates to evaluate | Rel |
| --- | --- | --- | --- |
| **Calendars** | Two-way busy-time sync for doctors; add-to-calendar for patients | **Google Calendar API (decided: Google Workspace)**; .ics files for patients; Microsoft Graph later (R4) | R1 |
| Staff SSO | Single sign-on for staff | **Google Workspace (decided)**, via OIDC/SAML | R1 |
| Patient identity | Sign-up, MFA, optional ID verification | Managed identity service (e.g. Auth0, AWS Cognito, Keycloak); ID check vendor if required | R1 |
| Telehealth video | Secure video visits | Video API offered with a health-data agreement (e.g. Zoom Video SDK, Vonage Video API, Daily, Amazon Chime SDK) | R1 |
| Email | Transactional email | SendGrid, Amazon SES, Postmark | R1 |
| SMS | Reminders, OTP, pharmacy and delivery status prompts | Twilio, Vonage, Amazon SNS (vendor must sign a BAA) | R1 |
| Push | Browser push notifications | Web Push / Firebase Cloud Messaging | R1 |
| E-signature | Consents and forms | Built-in signature capture, or DocuSign / Dropbox Sign | R1 |
| Document OCR | Searchable scanned documents | AWS Textract, Azure Document Intelligence, Google Document AI | R1 |
| Maps | Clinic locations, pharmacy finder by distance | Google Maps Platform, Mapbox | R1–R2 |
| Payments | Cards, wallets, refunds (self-pay) | Stripe, Adyen | R2 |
| Drug database | Interactions, allergies, dosing, product data | First Databank, Medi-Span, Multum | R2 |
| **E-prescribing network and EPCS** | Send prescriptions to any US pharmacy; controlled substances with DEA-compliant signing | Surescripts via a certified e-prescribing vendor (e.g. DrFirst, DoseSpot) | R2 |
| **Partner pharmacy status API** | Partner pharmacies post fulfilment and delivery status and tracking links | Our own REST/webhook API (documented in Plan & Design) | R3 |
| Lab partners | Orders and results | Each partner lab's HL7/FHIR interface or an integration hub (e.g. Health Gorilla, Redox) | R3 |
| Insurance | Eligibility checks; later claims | Clearinghouse (e.g. Availity, Waystar) | R4 |
| Analytics / BI | Reporting outside the app | Data warehouse export (e.g. BigQuery, Snowflake, Redshift) with de-identification | R4 |

## 4. Integration rules (agreed)

- Every external call has a timeout and retries with back-off, and a failure becomes visible in an operations dashboard. Failures are never silently dropped.
- Inbound messages (lab results, e-prescription responses, pharmacy status webhooks) are idempotent: a resent message never creates a duplicate.
- Vendors that receive health data must sign the required data-processing / Business Associate agreement before go-live.
- Calendar sync never sends patient names, reasons or diagnoses to external calendars; only "Busy" blocks.
- SMS and email never contain diagnoses, test names or medicine names, only a prompt to log in.

## 5. Data migration (agreed: none)

This is a new system: no patient, appointment or record migration in R1–R3. If that changes, migration becomes a separate scoped change with its own mapping, test runs, reconciliation report and sign-off.
