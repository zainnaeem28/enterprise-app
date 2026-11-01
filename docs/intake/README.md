# Enterprise EHR Platform — Intake Pack

| Field | Value |
| --- | --- |
| Product | Enterprise EHR platform with patient, doctor, pharmacy, pre-consultation and system admin portals, plus a public brand site |
| Repository | `zainnaeem28/enterprise-app` (private) |
| Prepared | 2026-10-31 |
| Prepared by | AI assistant (Claude), from a short request by Zain Naeem |
| **Status** | **Confirmed by Zain Naeem (product owner).** Revision 2, 2026-11-02 03:26 PKT (UTC+05:00): critical questions answered (see Revision history). |

## How to use this pack

1. A human (client/product owner) reads every file and marks each section **Agreed**, **Changed** or **Rejected**, then fills the blanks in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md).
2. Record who agreed and when, at the top of each file. A file date alone is not approval.
3. Give the confirmed pack to Paperclip task **INV-1**. The Intake Agent then scores readiness and writes `Intake-Readiness.md`.

Any item still marked proposed, *Open* or blank is a **proposal or gap**, not a decision. Under the SDLC rules, proposals earn no readiness credit, and the Intake Agent must not treat them as client decisions.

## Contents

| File | Covers | Readiness area |
| --- | --- | --- |
| [01-PRODUCT-BRIEF.md](01-PRODUCT-BRIEF.md) | Vision, goals, users, scope, phased releases | Goals; scope/acceptance |
| [02-PORTALS-AND-FEATURES.md](02-PORTALS-AND-FEATURES.md) | Feature inventory for every portal and shared module | Users/permissions; scope |
| [03-WORKFLOWS-AND-RULES.md](03-WORKFLOWS-AND-RULES.md) | Step-by-step journeys, statuses and business rules | Journeys/rules |
| [04-INTEGRATIONS-AND-DATA.md](04-INTEGRATIONS-AND-DATA.md) | Data domains, healthcare standards, external integrations | Data/integrations |
| [05-SECURITY-COMPLIANCE-NFR.md](05-SECURITY-COMPLIANCE-NFR.md) | Privacy, security, compliance, performance and reliability targets | Traffic/reliability |
| [06-BRAND-AND-UX.md](06-BRAND-AND-UX.md) | Brand site, design system, accessibility | UX |
| [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md) | Decisions only the client can make: budget, timeline, owners, jurisdiction | Budget/timeline/owners |

## Revision history

| Revision | Date | Change |
| --- | --- | --- |
| 1 | 2026-10-31 | AI-prepared draft; confirmed by Zain Naeem (product owner). Scored 43.75% at intake (rev 1 of `Intake-Readiness.md`). |
| 2 | 2026-11-02 03:26 PKT (UTC+05:00) | Product owner answered the critical questions: United States; multi-clinic network; many external pharmacies with their own delivery; controlled substances (EPCS) in scope; large scale; budget US$150k–300k build and US$5k–15k/month; R1 by end of May 2027; Google Workspace; no migration; brand exists; R1–R4, pre-consultation meaning, lab release policy and reliability targets agreed. Files 01–06 updated to match. |

## Still open (non-critical)

Operating states, partner pharmacy count, 3-year growth, cloud provider, AI features, extra languages, brand files (to be added to `docs/intake/brand/`), and a licensed clinical safety reviewer. See [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md).
