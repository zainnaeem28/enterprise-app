# 07 — Open Questions and Client Decisions

> **Status: ANSWERED (critical sections A, D, E).** Decisions given by Zain Naeem (product owner, sole decision-maker) on 2026-11-02 03:26 PKT (UTC+05:00) in a structured question-and-answer session; recorded verbatim by the AI assistant. Rows marked *Open* are not yet decided and remain intake gaps.

## A. Critical: answer before discovery starts

| # | Question | Answer |
| --- | --- | --- |
| A1 | Which country/countries and states/regions will the platform operate in? | **United States.** HIPAA, Business Associate Agreements, US e-prescribing (NCPDP SCRIPT via a certified network such as Surescripts), 21st Century Cures Act patient-access rules. States: *Open* (affects telehealth licensing and state pharmacy rules). |
| A2 | What type of organisation runs it? | **Multi-clinic network:** one healthcare organisation with several clinics. |
| A3 | Is the pharmacy owned by the same organisation, a partner, or several external pharmacies? | **Many external pharmacies.** Prescriptions go to the patient's chosen pharmacy. Partner pharmacies use our pharmacy portal to receive and fulfil prescriptions; **each pharmacy runs its own delivery**, and we show the patient the delivery status the pharmacy reports. No in-house dispatch board or driver app. |
| A4 | What does "pre-consultant portal" mean? | **Agreed as drafted:** triage nurses, care coordinators and front desk preparing patients before the doctor. |
| A5 | Is controlled-substance prescribing and delivery in scope? | **In scope.** Requires DEA-compliant electronic prescribing of controlled substances (EPCS) through a certified solution, two-factor signing, identity proofing of prescribers, audit, and ID-checked hand-over by the dispensing pharmacy. |
| A6 | Who are the named human decision-makers? | **Zain Naeem holds every gate role** (see section E). He is the only person operating Paperclip. |

## B. Scope and priorities

| # | Question | Answer |
| --- | --- | --- |
| B1 | Do you agree with the R1–R4 release split? | **Agreed** (see [01-PRODUCT-BRIEF.md](01-PRODUCT-BRIEF.md), section 6, updated for external pharmacies). |
| B2 | Is telehealth video required in the first release? | **Yes**, as part of the agreed R1 contents. |
| B3 | Insurance (eligibility, claims) or self-pay? | **Self-pay and card payments first; insurance eligibility and claims in R4**, per the agreed release split. |
| B4 | Lab results: release immediately or after doctor review? | **Normal results released to patients immediately; abnormal results released after doctor review**, within the time US information-blocking rules allow. |
| B5 | Deliveries: in-house drivers, third-party couriers, or both? | **Neither: each external pharmacy handles its own delivery.** We display pharmacy-reported status and tracking links. |
| B6 | Native mobile apps needed? | **Not before R4**, per the agreed release split. |
| B7 | Any AI features wanted? | *Open.* AI scribe stays an R4 candidate "if approved". |
| B8 | Languages at launch? | *Open.* English assumed for R1 until decided. |

## C. Current systems and data

| # | Question | Answer |
| --- | --- | --- |
| C1 | Which systems are used today? | *Open.* |
| C2 | Must data be migrated? | *Open.* Until answered, R1 assumes no migration (new system). |
| C3 | Which partner labs and pharmacies must be connected? | *Open* (named partners). Pharmacies: external, via e-prescribing network and partner portal. Labs: via HL7/FHIR or an integration hub. |
| C4 | Which calendar systems do doctors use? | **Google Workspace (Google Calendar).** |
| C5 | Which staff identity system exists? | **Google Workspace.** Staff sign in with Google SSO plus MFA. |
| C6 | Preferred cloud and hosting region? | *Open.* Must be a HIPAA-eligible US region with a signed BAA. |

## D. Scale, budget and timeline

| # | Question | Answer |
| --- | --- | --- |
| D1 | Patients, staff, clinics and pharmacies at launch and in 3 years | **Design for large scale at launch:** ~250,000 patients, ~1,000 staff, 30+ clinics. Number of partner pharmacies and 3-year growth: *Open*. |
| D2 | Peak appointments, prescriptions and deliveries per day | **Peak ~8,000 appointments, ~4,000 prescriptions and ~1,500 pharmacy deliveries per day; ~250 concurrent video visits.** |
| D3 | Budget for build | **US$150,000–300,000** for R1–R3. |
| D4 | Monthly budget for hosting and third-party services | **US$5,000–15,000 per month.** |
| D5 | Target date for the first release | **R1 in production by end of May 2027** (about 6 months). R2–R3 follow in later quarters. |
| D6 | Availability and recovery targets | **Agreed as proposed** in [05-SECURITY-COMPLIANCE-NFR.md](05-SECURITY-COMPLIANCE-NFR.md): 99.9% availability, RPO 15 min, RTO 4 h, p95 API < 500 ms, LCP < 2.5 s, WCAG 2.2 AA. |

**Risk noted by the AI assistant (not a decision):** a US$150k–300k build budget is low for large-scale, US-regulated scope with EPCS, labs and 30+ clinics in 6 months. Discovery must confirm what fits, and G1 decides any trimming.

## E. Human owners (required for the SDLC gates)

| Role | Name | Gates |
| --- | --- | --- |
| Client / product owner | Zain Naeem | INTAKE, G1, G2, Build review, Acceptance |
| Human Solution Architect | Zain Naeem | G1, G2, Build review, Acceptance, G3 |
| UI/UX reviewer | Zain Naeem | G2, Build review |
| QA owner | Zain Naeem | G2, Acceptance |
| DevOps owner | Zain Naeem | G2, G3 |
| Security / compliance owner | Zain Naeem | Build review, Acceptance |
| Clinical safety reviewer (doctor/pharmacist) | Zain Naeem (interim) | G1, G2, Acceptance |
| Release owner | Zain Naeem | G3 |
| Business owner (go-live) | Zain Naeem | G3 |
| Operations owner | Zain Naeem | Operations receipt |

**Note from the AI assistant (not a decision):** one person holding every role is allowed by the SDLC, but there's no independent clinical reviewer yet. A licensed clinician should review patient-safety rules before go-live.

## F. Brand

*Open.* See [06-BRAND-AND-UX.md](06-BRAND-AND-UX.md), section 1.
