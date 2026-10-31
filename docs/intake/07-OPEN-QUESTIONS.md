# 07 — Open Questions and Client Decisions

> **Status: TO BE COMPLETED BY THE CLIENT.** The AI has not answered any of these; guessing them would create false agreement.
> Reviewed by: Zain Naeem (product owner) on 2026-10-31. **Answers pending**; blank rows are open gaps for Intake.

## A. Critical: answer before discovery starts

| # | Question | Answer |
| --- | --- | --- |
| A1 | Which country/countries and states/regions will the platform operate in? (Decides compliance, e-prescribing, lab-release and data-residency rules.) | |
| A2 | What type of organisation runs it: a single clinic, a multi-clinic network, a hospital group, a pharmacy chain, or a software product sold to many healthcare providers (multi-tenant SaaS)? | |
| A3 | Is the pharmacy owned by the same organisation, a partner, or several external pharmacies? | |
| A4 | What does "pre-consultant portal" mean for you? This draft assumes triage nurses, care coordinators and front desk preparing patients before the doctor. | |
| A5 | Is controlled-substance prescribing and delivery in scope? | |
| A6 | Who are the named human decision-makers? (One person may hold several roles.) | See section E |

## B. Scope and priorities

| # | Question | Answer |
| --- | --- | --- |
| B1 | Do you agree with the proposed R1–R4 release split in [01-PRODUCT-BRIEF.md](01-PRODUCT-BRIEF.md)? What must be in the first release? | |
| B2 | Is telehealth video required in the first release? | |
| B3 | Is insurance needed (eligibility checks, claims), or is the service self-pay? | |
| B4 | Lab results: release to patients immediately, or only after doctor review? Any test types that always need review? | |
| B5 | Deliveries: in-house drivers, third-party couriers, or both? Which delivery area at launch? Any cold-chain medicines? | |
| B6 | Native mobile apps needed? When? | |
| B7 | Any AI features wanted (e.g. note drafting, symptom checker)? | |
| B8 | Languages at launch? | |

## C. Current systems and data

| # | Question | Answer |
| --- | --- | --- |
| C1 | Which systems are used today (EHR, booking, pharmacy, lab, billing, website)? | |
| C2 | Must data be migrated? Roughly how many patients and years of records? | |
| C3 | Which partner labs, pharmacies and couriers must be connected? | |
| C4 | Which calendar systems do doctors use (Google, Microsoft 365, other)? | |
| C5 | Which staff identity system exists (Microsoft Entra ID, Google Workspace, Okta, none)? | |
| C6 | Preferred cloud and hosting region (AWS, Azure, GCP)? Any existing contracts? | |

## D. Scale, budget and timeline

| # | Question | Answer |
| --- | --- | --- |
| D1 | Patients, staff, clinics and pharmacies at launch and in 3 years | |
| D2 | Peak appointments, prescriptions and deliveries per day | |
| D3 | Budget for build | |
| D4 | Monthly budget for hosting and third-party services (video, SMS, drug database, couriers…) | |
| D5 | Target date for the first release; any fixed external deadlines | |
| D6 | Availability and recovery targets: accept the proposals in [05-SECURITY-COMPLIANCE-NFR.md](05-SECURITY-COMPLIANCE-NFR.md)? | |

## E. Human owners (required for the SDLC gates)

| Role | Name | Email | Gates |
| --- | --- | --- | --- |
| Client / product owner | | | INTAKE, G1, G2, Build review, Acceptance |
| Human Solution Architect | | | G1, G2, Build review, Acceptance, G3 |
| UI/UX reviewer | | | G2, Build review |
| QA owner | | | G2, Acceptance |
| DevOps owner | | | G2, G3 |
| Security / compliance owner | | | Build review, Acceptance |
| Clinical safety reviewer (doctor/pharmacist) | | | G1, G2, Acceptance |
| Release owner | | | G3 |
| Business owner (go-live) | | | G3 |
| Operations owner | | | Operations receipt |

## F. Brand

See [06-BRAND-AND-UX.md](06-BRAND-AND-UX.md), section 1.
