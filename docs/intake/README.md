# Enterprise EHR Platform — Intake Pack

| Field | Value |
| --- | --- |
| Product | Enterprise EHR platform with patient, doctor, pharmacy, pre-consultation and system admin portals, plus a public brand site |
| Repository | `zainnaeem28/enterprise-app` (private) |
| Prepared | 2026-10-31 |
| Prepared by | AI assistant (Claude), from a short request by Zain Naeem |
| **Status** | **Confirmed by Zain Naeem (product owner) on 2026-10-31.** Open questions in 07 are still pending. |

## How to use this pack

1. A human (client/product owner) reads every file and marks each section **Agreed**, **Changed** or **Rejected**, then fills the blanks in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md).
2. Record who agreed and when, at the top of each file. A file date alone is not approval.
3. Give the confirmed pack to Paperclip task **INV-1**. The Intake Agent then scores readiness and writes `Intake-Readiness.md`.

Until a human confirms them, every item here is a **proposal**. Under the SDLC rules, proposals earn no readiness credit, and the Intake Agent must not treat them as client decisions.

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

## Expected intake result

Even after confirmation, these areas will remain gaps until the client answers [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md):

- jurisdiction and regulations (this changes compliance, e-prescribing and lab-result rules)
- traffic numbers, budget, deadline and named human owners
- the operating model of the pharmacy and delivery service

Expect the Intake Agent to report readiness below 80% until those are answered. At the INTAKE gate you can then either update the inputs or authorise provisional scope with stated assumptions.
