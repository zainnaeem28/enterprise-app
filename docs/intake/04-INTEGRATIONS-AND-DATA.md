# 04 — Integrations and Data

> **Status: CONFIRMED** (AI-prepared 2026-10-31). Confirmed by: Zain Naeem (product owner) on 2026-10-31.
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
| Pharmacy | Products, batches, stock levels, purchase orders, dispensing records, controlled-drug register |
| Delivery | Delivery zones, slots, orders, routes, drivers, proof of delivery, temperature logs |
| Labs | Lab orders, specimens, results, reference ranges, critical-result acknowledgements |
| Documents | Files, versions, classifications, signatures, retention holds |
| Billing | Invoices, payments, refunds, deposits, insurance eligibility |
| Communication | Messages, notifications, templates, delivery receipts |
| Audit | Access events, change history, break-the-glass events, exports |

## 2. Healthcare standards (proposed)

| Need | Standard |
| --- | --- |
| Data exchange with other systems | **HL7 FHIR R4** APIs; **SMART on FHIR** for third-party app access |
| Lab interfaces | **HL7 v2** order/result messages (ORM/ORU), or FHIR where the lab supports it |
| Lab test codes | **LOINC** |
| Diagnoses | **ICD-10** (or the local edition) |
| Clinical terms | **SNOMED CT** where licensed |
| Medicines | **RxNorm** (US) or the national medicines dictionary |
| Procedures / billing codes | **CPT/HCPCS** (US) or the local equivalent |
| E-prescribing | **NCPDP SCRIPT** (US) or the national e-prescription service |
| Imaging (optional) | **DICOM** viewing via a link to an external imaging system |

The jurisdiction decides which of these apply.

## 3. External integrations

| Area | Purpose | Candidates to evaluate | Rel |
| --- | --- | --- | --- |
| **Calendars** | Two-way busy-time sync for doctors; add-to-calendar for patients | Google Calendar API, Microsoft Graph (Outlook/365), CalDAV/iCloud, .ics files | R1 |
| Staff SSO | Single sign-on for staff | Microsoft Entra ID, Okta, Google Workspace (SAML/OIDC) | R1 |
| Patient identity | Sign-up, MFA, optional ID verification | Managed identity service (e.g. Auth0, AWS Cognito, Keycloak); ID check vendor if required | R1 |
| Telehealth video | Secure video visits | Video API offered with a health-data agreement (e.g. Zoom Video SDK, Vonage Video API, Daily, Amazon Chime SDK) | R1 |
| Email | Transactional email | SendGrid, Amazon SES, Postmark | R1 |
| SMS / WhatsApp | Reminders, OTP, delivery updates | Twilio, Vonage, local SMS gateway | R1 |
| Push | Browser push notifications | Web Push / Firebase Cloud Messaging | R1 |
| E-signature | Consents and forms | Built-in signature capture, or DocuSign / Dropbox Sign | R1 |
| Document OCR | Searchable scanned documents | AWS Textract, Azure Document Intelligence, Google Document AI | R1 |
| Maps and addresses | Address validation, zones, routing | Google Maps Platform, Mapbox, HERE | R3 |
| Payments | Cards, wallets, refunds | Stripe, Adyen, or a local acquirer | R2 |
| Drug database | Interactions, allergies, dosing, product data | First Databank, Medi-Span, Multum, or a national formulary | R2 |
| E-prescribing network | Send and receive prescriptions with external pharmacies | Surescripts (US) or the national e-prescription service | R2 |
| **Courier / last-mile delivery** | Third-party delivery when in-house drivers are unavailable | Uber Direct, DoorDash Drive, Onfleet (dispatch software), local couriers | R3 |
| Route optimisation | Efficient multi-stop routes | Google Route Optimization, Onfleet, OptimoRoute | R3 |
| Lab partners | Orders and results | Each partner lab's HL7/FHIR interface or an integration hub (e.g. Health Gorilla, Redox) | R3 |
| Insurance | Eligibility checks; later claims | Clearinghouse (e.g. Availity, Waystar) or local payer APIs | R4 |
| Analytics / BI | Reporting outside the app | Data warehouse export (e.g. BigQuery, Snowflake, Redshift) with de-identification | R4 |

## 4. Integration rules (proposed)

- Every external call has a timeout and retries with back-off, and a failure becomes visible in an operations dashboard. Failures are never silently dropped.
- Inbound messages (lab results, e-prescriptions, courier webhooks) are idempotent: a resent message never creates a duplicate.
- Vendors that receive health data must sign the required data-processing / Business Associate agreement before go-live.
- Calendar sync never sends patient names, reasons or diagnoses to external calendars; only "Busy" blocks.
- SMS and email never contain diagnoses, test names or medicine names, only a prompt to log in.

## 5. Data migration (to confirm)

If an existing system holds patients, appointments, records or stock, list it in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md). Migration needs its own mapping, test runs, reconciliation report and sign-off.
