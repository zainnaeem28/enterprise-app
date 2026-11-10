# Research appendix — comparable EHR products (draft for PRD appendix)

| Field | Value |
| --- | --- |
| Task | HEAAA-4 `[SDLC:research]` |
| Author | Researcher agent |
| Baseline | Intake pack revision 2 (2026-11-02), `docs/intake/` |
| Access date | 2026-11-04 |
| Status | DRAFT — awaiting independent review. Advisory only; not accepted scope. |

## 1. Decision: discovery is needed

The product is new, regulated (US HIPAA, EPCS) and spans six surfaces. A skip is not justified. Research is advisory: it does not authorise purchases, tools or scope changes.

## 2. Method and honest limits

- Comparables were chosen by audience (US multi-clinic ambulatory network), task (patient portal + scheduling + e-prescribing/EPCS + telehealth) and market fit. The set is not a universal "top five".
- Evidence grades: **O** = official vendor page fetched and read; **T** = third-party directory/review/health-system page (secondary); **U** = not verified.
- Many vendor pages returned HTTP 403/404 or carried no feature detail (athenahealth 403; NextGen 404). Only the Elation, eClinicalWorks and Epic home pages were read, and they were thin. Most capability claims below are therefore **T**. No product was trialled, so nothing here is *observed* behaviour.
- Pricing is dated 2026-11-04 and may be stale. Quotes were not requested.
- Fewer than five products have strong evidence. Five are listed; confidence is low-to-medium for all.

## 3. Comparison (advertised capabilities, as evidenced)

| # | Product | Fit to our audience | Portal / scheduling / telehealth | E-Rx / EPCS | Multi-site | Pricing evidence | Source (accessed 2026-11-04) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **athenahealth athenaOne** | Cloud EHR + PM for ambulatory groups | Patient portal, telehealth, multi-location scheduling listed (T) | E-Rx, EPCS, PDMP, medication history listed (T) | Listed (T), detail U | Not public (U) | Official page https://www.athenahealth.com/solutions/athenaone → 403, not read. Secondary: [SourceForge](https://www.sourceforge.net/software/product/athenaOne), [TechRadar](https://www.techradar.com/reviews/athenahealth) |
| 2 | **Elation Health** | Independent/small practices; smaller than our 30+ clinic scale | "Patient Passport" portal and integrated telehealth (O) | EPCS reported by reviews (T); not shown on official page (U) | U | Vendor product guide (via search snippet, T): Standard $425, Premium $500 per provider/month; telehealth +$25; AI scribe +$199. Pricing page itself shows no figures (O) | https://www.elationhealth.com/pricing (O); https://www.elationhealth.com/ehr-product-guide/ (T) |
| 3 | **eClinicalWorks (healow)** | Large ambulatory vendor, many specialties | healow portal, TeleVisits, check-in, AI contact centre "Genie" (O names; detail T) | E-Rx listed (T); EPCS U | U | Not stated (O) | https://www.eclinicalworks.com/products-services/ehr/ (O); [healow summary](https://chcanys.org/products/telehealth-platforms/healow-ecw) (T) |
| 4 | **NextGen Healthcare (Enterprise / Office)** | Enterprise line targets multi-specialty, multi-site groups | Portal (online scheduling, refills, bill pay, messaging) and telehealth (T); reviewers report portal enrolment problems (T, small sample) | E-Rx assumed; **EPCS not confirmed** (U) | Enterprise multi-site (T) | One aggregator: ~$549/provider/month for Office (T, unverified) | Official URL returned 404. [TechRadar](https://www.techradar.com/reviews/nextgen-healthcare), [Softwarefinder](https://softwarefinder.com/nextgen-enterprise-ehr) |
| 5 | **Epic (MyChart, Cadence ambulatory) via Community Connect** | Closest to a large multi-clinic network; typically bought via a host health system | MyChart: online scheduling, messaging, video visits, refill requests; Cadence scheduling (T, health-system pages) | Surescripts e-Rx; EPCS with two-factor (named by NewYork-Presbyterian) (T) | Yes by design (T) | No public pricing (O) | https://www.epic.com/software/ (O, no product detail); [NYP Community Connect](https://www.nyp.org/communityconnect), [Corewell Health](https://corewellhealth.org/community-connect) (T) |

## 4. Findings, labelled

### Confirmed client needs (from intake rev 2 — not research output)
US multi-clinic network (30+ clinics, ~250k patients); six surfaces; EPCS in R2; external partner pharmacies; Google Workspace SSO/calendar; R1 by end May 2027; US$150–300k build, US$5–15k/month run.

### Research-backed observations (grade T unless stated)
1. Commercial EHRs bundle portal, scheduling, telehealth and e-prescribing; EPCS is normally a second-factor/identity-proofing add-on to e-Rx, via the Surescripts network (Epic/NYP source).
2. Per-provider SaaS pricing in this market is roughly US$350–550/provider/month for small-practice products (Elation, NextGen Office). At ~1,000 staff, even a fraction of them as prescribers puts SaaS subscription cost in the same range as the run budget; enterprise tiers are unpublished.
3. None of the five verifiably offers a **partner-pharmacy portal with pharmacy-reported delivery tracking** shown to patients. This is a candidate differentiator, but absence of evidence on closed vendor sites is not proof of absence (U).
4. Portal enrolment friction is a recurring complaint (NextGen, small sample).

### Hypotheses (need testing, not recommendations)
- H1: Delivery-status visibility (R3) and a partner-pharmacy portal are real differentiators. Test: ask each vendor in a demo.
- H2: Building R1–R3 inside US$150–300k is tight against buy/integrate alternatives. Test: vendor quotes and an R1 sizing exercise in discovery.
- H3: Epic Community Connect-style hosting is unavailable to a standalone network. Not verified.

### Recommendations for human decision (via PM/Orchestrator)
- R-A: Obtain written quotes and official feature/EPCS confirmation from athenahealth, NextGen and eClinicalWorks before G1, so build-vs-buy is evidenced. This needs the product owner's approval to contact vendors; no accounts or purchases were made.
- R-B: Use a certified third-party e-prescribing/EPCS network rather than build certification (consistent with intake risks). Vendor and cost are open.
- R-C: Keep delivery visibility as pharmacy-reported status only (already agreed scope).

### Excluded from this research
Pricing negotiation, vendor accounts or trials, clinical-safety review, legal/HIPAA analysis, AI scribe evaluation (R4, unapproved), non-US products.

## 5. Gaps and adoption questions for BA/PM
1. Is a buy/integrate option (or hybrid with a commercial EHR core) in scope, or is a custom build already decided? Intake assumes build.
2. May the team contact vendors for quotes and EPCS/portal confirmation?
3. Which operating states apply (telehealth licensing, pharmacy rules)?
4. Which certified e-prescribing/EPCS network, and who owns onboarding?
5. Should partner-pharmacy integration with existing pharmacy software be researched separately?

## 6. Limitations
Secondary sources dominate; some claims came from search snippets, not full page reads. Vendor pages may differ by tier. Re-verify before G1. Independent review is pending; this draft is not review-passed or human-approved.
