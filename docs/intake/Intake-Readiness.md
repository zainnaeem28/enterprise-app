# Intake-Readiness — Enterprise EHR Platform

| Field | Value |
| --- | --- |
| Task | HEAAA-2 `[SDLC:intake]` |
| Author | Intake Agent (`d666697e-a98d-4ebd-a34a-75aca870520f`) |
| Assessed sources | `docs/intake/01`–`07` and `README.md` at commit `6ea01b5` (intake pack revision 2) |
| Assessment date | 2026-11-04 |
| Independent review | **Not yet done.** A reviewer other than the author must inspect this exact revision. |
| Human decision | **Not requested or given.** INTAKE is a human gate. |

## 1. Result

| | |
| --- | --- |
| **True readiness score** | **6.0 / 8 = 75.0 %** (below the 80 % threshold; not rounded up) |
| Previous score | 43.75 % (rev 1, commit `6ba3d71`; that document is not in the repository, so the figure is taken from `README.md`'s revision history and is unverified) |
| Critical gaps | **1** — operating states (G-01) |
| Proposed decision | **Provisional start with limited scope** (section 7). The alternatives are Update and Hold. |

## 2. Source and decision register

Originals preserved in git. Nothing below is inferred from file modification times.

| ID | Source | Version | Event time / zone | Identity | Approval status | Subject |
| --- | --- | --- | --- | --- | --- | --- |
| S-1 | `01`–`06` (AI-prepared draft) | commit `6ba3d71` | Commit Sat 2026-10-31 21:28 +05:00; the pack states confirmation on 2026-10-31 (no time given) | Prepared by an AI assistant; confirmed by Zain Naeem (product owner), as stated in the pack | Stated "Agreed" in every section. No original transcript or message from the owner is in the repository. | Whole pack rev 1 |
| S-2 | `07` section A, D, E answers | commit `6ea01b5` | **2026-11-02 03:26 PKT (UTC+05:00)**, as stated in the pack | Zain Naeem, sole decision-maker; "recorded verbatim by the AI assistant" | Stated as the owner's answers. The record is AI-written and the Q&A session is not preserved. | A1–A6, B1–B6, C4–C5, D1–D6, E |
| S-3 | Files 01–06, revision 2 | commit `6ea01b5` | Commit Mon 2026-11-02 03:32 +05:00 | AI assistant edited to match S-2 | Same as S-2 | Conforming edits |
| S-4 | Brand files | **Absent** | — | — | — | Brand (F) |

**Provenance limitation (L-1).** Every client decision reaches me only through AI-authored text that claims owner agreement. The commits carry the owner's git identity and an AI co-author line, so they don't prove who made the decision. I accept the pack as the client's decision record because the Orchestrator assigned it as the intake source and the pack names the owner and a time. I can't verify identity or consent beyond that. The INTAKE decision should have Zain Naeem confirm in his own words that the pack reflects his decisions.

### Per-subject authority and supersession

| Subject | Governing decision | Superseded / history | Conflict? |
| --- | --- | --- | --- |
| Pharmacy model | S-2 A3/B5: many external pharmacies, each with its own delivery, no dispatch board or driver app | Rev 1 assumed an in-house pharmacy with delivery dispatch (rev 1 text is in git history only) | No. Explicit owner answer supersedes the draft. |
| Release split R1–R4 | S-2 B1: agreed, updated for external pharmacies | Rev 1 split agreed on 2026-10-31 | No |
| Controlled substances | S-2 A5: in scope (EPCS in R2) | Open in rev 1 | No |
| Lab release | S-2 B4: normal immediately, abnormal after review | Open in rev 1 | No |
| Data migration | `04` §5 "agreed: none"; `07` C2 says *Open, R1 assumes none* | — | **Minor inconsistency (C-1):** `04` and `README` call it agreed, `07` C2 still calls it open. See Q-3. |
| Microsoft/Outlook | `03` §1 step 2 still says "Google/Outlook" busy times; `02` puts Outlook sync in R4 | — | **Minor inconsistency (C-2):** R1 reads Google only. |
| Insurance | `02` §3 has manual eligibility check in R1; `07` B3 says insurance in R4 | — | Consistent only if "manual" means staff look it up outside the system. Confirm (Q-9). |
| Patient-facing payment for medicine | `02` §2 says payment is handled by the pharmacy; `03` §8 says prices come from a "pharmacy price list" | — | **Inconsistency (C-3):** a pharmacy price list implies we hold pharmacy prices. |

## 3. Requirements status

- **Confirmed (client-decided, per S-1/S-2):** US operation; multi-clinic network; external pharmacies with own delivery; EPCS in scope; R1–R4 split and R1 contents; Google Workspace for SSO and calendars; no migration (with C-1); targets in `01` §3 and `05` §3–4; budget and date; brand exists; owner roles.
- **Proposed and agreed as written but not detailed:** feature inventory in `02`, workflows in `03`, standards in `04`. The owner agreed them, but they are AI proposals, so detail gaps below still count.
- **Proposed only, no credit:** vendor candidates (`04` §3), WCAG/OWASP baselines beyond the agreed table, SOC 2 readiness, 42 CFR Part 2, admin-configurable defaults.
- **Open:** operating states, partner pharmacy count, 3-year growth, cloud provider, AI features, languages beyond English, named labs/pharmacies, current systems, domains, photography, brand files.

## 4. Evidence scores

Scale: 1 sufficient, 0.5 partial, 0 missing or conflicting. Assumptions earn no credit.

| # | Area | Score | Evidence and reason |
| --- | --- | --- | --- |
| 1 | Goals | **1** | `01` §3 gives eight goals with numeric targets and a measurement window, agreed 2026-11-02 (S-2). |
| 2 | Users / permissions | **0.5** | Users and portals are defined (`01` §4, `02` §8). The matrix is a summary and says "final permission matrix is confirmed in Plan & Design". Patient-proxy age and consent rules, partner-pharmacy onboarding approval and the compliance officer's rights are not specified. |
| 3 | Journeys / rules | **1** | `03` has end-to-end journeys, statuses and rules for booking, triage, notes, prescribing, delivery, labs, documents and payments, agreed by the owner. Numeric windows are explicitly configurable (`03` header), so this is sufficient for discovery. The critical-result escalation window is a gap for Plan & Design (G-05); it doesn't lower the score because it is assigned there. |
| 4 | Scope / acceptance | **0.5** | Scope and out-of-scope are explicit and R1 contents are agreed. Per-feature acceptance criteria don't exist yet (assigned to G2). Whether R1 fits the budget and date is unverified (G-03). |
| 5 | Data / integrations | **0.5** | Data domains, standards and no-migration are agreed. All vendors are candidates; no lab or partner pharmacy is named; current systems (C1) are open; cloud provider is open; C-1 conflict on migration wording. |
| 6 | Traffic / reliability | **1** | `05` §3–4 and `07` D2/D6: peak volumes, concurrency, availability, RPO/RTO, latency, LCP, all agreed 2026-11-02. Open items (3-year growth, partner count) don't prevent sizing year 1. |
| 7 | UX | **0.5** | Experience principles and site structure are agreed. The brand exists, but no files are in `docs/intake/brand/` (S-4); domains, photography and non-English languages are open. |
| 8 | Budget / timeline / owners | **1** | Budget (US$150k–300k build, US$5k–15k/month), R1 date (end of May 2027) and a named owner for every gate role (`07` E). Feasibility is a risk (G-03), but evidence of the constraints is sufficient. Limitation: one person holds all roles (G-04). |

**Total 6.0 / 8 = 75.0 %.**

## 5. Gaps, consequences and severity

| ID | Gap | Severity | Consequence if unresolved | Blocks |
| --- | --- | --- | --- | --- |
| G-01 | **Operating states not named** (`07` A1) | **Critical** for telehealth and pharmacy scope | Telehealth is in R1. State licensing, consent and prescribing rules differ by state, so R1 telehealth rules, R2 pharmacy rules and the legal baseline can't be fixed. The pack itself says to name states before G1. | Telehealth rules, EPCS/pharmacy state rules, compliance baseline, G1 |
| G-02 | Brand files missing (S-4) | High for UX only | UI/UX can't apply the brand; the pack says they arrive before Plan & Design | UI/UX and brand brief, not discovery |
| G-03 | **Budget/timeline feasibility unproven.** Both the pack and I note US$150k–300k and 6 months look tight for 30+ clinics, EPCS, labs and telehealth, even though only R1 is due in 6 months | High | Late cut of scope or overrun | G1 scope trim; needs sizing in discovery |
| G-04 | No independent clinical, security or QA reviewer; one human holds every gate (`07` E) | High (governance) | Patient-safety rules get no clinical check before go-live; self-approval risk. Allowed by the SDLC but a real risk. | G1 clinical safety, Acceptance |
| G-05 | Critical-result escalation window and clinical thresholds undefined | Medium | Can't write safety acceptance tests | G2 |
| G-06 | Current systems (C1), named labs/pharmacies (C3), partner pharmacy count, 3-year growth, cloud provider (C6) open | Medium | Integration effort and hosting cost can't be estimated closely | Architecture detail |
| G-07 | AI features (B7) and languages (B8) open | Low | AI scribe stays R4; English assumed for R1 | None for R1 |
| G-08 | Decision provenance is AI-recorded (L-1) | Medium | Authority of every confirmed row rests on one unverified record | INTAKE gate wording |
| G-09 | Inconsistencies C-1, C-2, C-3 | Low | Rework risk in PRD | BA/PM |

## 6. Questions for the product owner

1. **Q-1 (G-01, critical):** In which US states will you operate at R1, and at R2?
2. **Q-2 (G-08):** Please confirm in your own words, in the INTAKE decision comment, that `07` and the revision 2 pack reflect your decisions, or point out what is wrong.
3. **Q-3 (C-1):** Is "no data migration" a final decision (`04` §5, `README`) or still an assumption (`07` C2)?
4. **Q-4 (G-03):** If discovery shows R1–R3 won't fit the budget, which gives first: scope, date or budget? A rank order is enough.
5. **Q-5 (G-04):** Will you name an independent licensed clinician for clinical safety review before G1 or before go-live, and is another person available for security review?
6. **Q-6 (G-02):** When will the brand files be added to `docs/intake/brand/`?
7. **Q-7 (G-06):** Which systems exist today, which labs must connect, and roughly how many partner pharmacies at launch?
8. **Q-8 (G-06):** Do you have a cloud provider preference, or should the Architect recommend one?
9. **Q-9 (C-3, C-2):** Confirm that (a) insurance checks in R1 are manual and outside the system, (b) R1 calendar sync is Google only, (c) whether we hold a pharmacy price list.
10. **Q-10 (G-05):** Who sets the critical-result escalation window, and by when?

## 7. Decision request

I request **one** of these, recorded by a human on the INTAKE gate:

- **Provisional start (recommended).** Discovery (Researcher, BA, PM) may begin on the confirmed requirements, limited to R1 apart from telehealth jurisdiction rules, plus the high-level R2–R3 shape needed for architecture. **Limits:** no telehealth-rule, state-pharmacy-rule or EPCS-state assumptions; no UI/brand work; no requirement may be drawn from proposed or open items; every open item above is carried as an assumption flagged in the PRD, and G1 can't pass until G-01 and G-03 are resolved. Provisional scope is bounded by this document's revision.
- **Update.** Hold discovery while the owner answers Q-1 to Q-10 and I re-score. I won't predict the new score.
- **Hold.** Stop discovery.

Start (full) isn't offered: the score is under 80 % and G-01 is critical.

## 8. Limitations and next permitted action

- Configured/executed: I read all eight pack files and the git history. I ran no external verification and have no access to original conversations.
- Not verified: owner identity, owner consent, the 43.75 % earlier score, the claim that files were confirmed on 2026-10-31.
- Review state: not independently reviewed; findings and review round: none yet (round 0 of 3).
- **Next permitted action:** independent review of this revision, then submission on the INTAKE gate. No downstream discovery dispatch until a human decides.
