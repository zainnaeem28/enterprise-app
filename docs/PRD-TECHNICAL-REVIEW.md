# PRD technical review — Solution Architect

| Field | Value |
| --- | --- |
| Task | HEAAA-8 `[SDLC:architecture-overview]` (technical PRD review lane) |
| Reviewer | Solution Architect agent (`7efe9f61-495f-4237-82f9-fa178629da09`). I did not author the PRD. |
| Reviewed revision | HEAAA-6 `prd` rev `3b976598-cd2f-4b4f-9903-7b83b5417f2b` ("PRD draft 1") |
| Verdict | **CHANGES REQUIRED** before G1. 4 High, 9 Medium, 2 Low. No finding rejects the product direction. |
| Round | Consolidated PRD round 1 (pending Orchestrator consolidation in HEAAA-10) |
| Routing | PRD wording → PM (HEAAA-6 owner). Decisions marked **human** → product owner via Orchestrator. The Architect does not decide scope. |

Each finding has a stable ID. "Requested change" is a proposal; the PM owns the PRD text.

## High

### SA-F-01 — Partner portal cannot be the legal prescription channel
- **Where:** §1 product description, ST-03 (Appendix C §3), F-PH-02/03, RA-R2-03, RA-R2-05, J-12.
- **Evidence:** DEA rules (21 CFR 1311.205) require a pharmacy to receive, display and store controlled-substance e-prescriptions in a pharmacy application that a third-party audit or a DEA-approved certifier has verified (DEA pharmacy EPCS Q&A; certification lists by UL, Drummond and iBeta). For standard prescriptions, pharmacies dispense from their own pharmacy system, fed by the NCPDP SCRIPT network. The PRD reads as if partner pharmacies "receive" prescriptions in our portal and accept or reject them there.
- **Impact:** If the portal were the receipt channel, we would have to certify our portal as DEA pharmacy software. That is outside the budget and timeline, and would also make the portal the pharmacy's dispensing record.
- **Requested change:** State that **every** prescription, to partner or non-partner pharmacies, is transmitted through the certified network. The partner portal shows a **mirror** of the prescriptions sent to that pharmacy and is where the pharmacy reports fulfilment and delivery status. "Accept / query / reject" in the portal are status reports and messages; formal changes and cancellations use network messages (change, cancel, renewal). Add this as a confirmed constraint after owner acknowledgement (**human**).
- **Severity reason:** Changes the R2 design and the meaning of three acceptance criteria.

### SA-F-02 — EPCS signing, identity proofing and drug checks happen inside the certified vendor
- **Where:** RA-R2-01, RA-R2-02, OUT-4, BR-15/16/17, DEP-6, DEP-7.
- **Evidence:** Certified e-prescribing/EPCS vendors (intake candidates DoseSpot, DrFirst) provide identity proofing, two-factor signing and, usually, embedded drug databases. Our platform does not perform the regulated signing.
- **Impact:** OUT-4 ("100 % of signed prescriptions record the check") and RA-R2-01 can only be measured if the vendor returns the check outcomes and override reasons through its API. Part of the DEA audit trail (RA-R2-02) lives at the vendor.
- **Requested change:** Turn these into **vendor selection criteria**: (a) check results and overrides retrievable per prescription; (b) EPCS audit reports available to compliance; (c) whether the drug database is bundled (may remove DEP-7). Note in DEP-6 that one vendor may satisfy DEP-6 and DEP-7.

### SA-F-03 — Missing inputs make the run budget unverifiable
- **Where:** §9 NFR-9, §11 DEP-12, RK-10.
- **Evidence:** ARCHITECTURE.md §10. Expected R1 run cost ≈ US$12.5k/month; high scenario ≈ US$19.9k, before any R2 e-Rx fees. Most of the spread comes from SMS share, video share, and (R2) per-prescriber fees.
- **Requested change:** Add decisions (**human**): (1) the number of prescribers at R2; (2) expected share of visits by video; (3) default reminder channel (email/push first with SMS by patient choice is the main cost lever and still meets BR-08's two reminders). Also add: vendor quotes for e-Rx/EPCS before G2 (links to D-1).

### SA-F-06 — Staff MFA cannot be proven per sign-in through Google SSO
- **Where:** RA-R1-01, `[05 §2]`, J-22, DEP-2.
- **Evidence:** Google's OIDC sign-in does not reliably tell the relying party which second factor was used. The platform can enforce re-authentication but cannot prove that 2-step verification took place on each staff sign-in.
- **Requested change:** Requirement and test become: "Google Workspace enforces 2-step verification for all staff organisational units (security keys recommended for prescribers and admins); evidence is the Workspace policy export plus a test that a non-enrolled account is blocked." Add a Workspace super-admin as a named dependency in DEP-2.

## Medium

### SA-F-04 — NFR-9 video concurrency needs a telehealth share
- **Where:** NFR-9, RA-R1-10.
- **Evidence:** 250 concurrent visits of ~20 min means ~700 video visits an hour at peak. That is consistent with 8,000 appointments a day only if video is a large share during peak hours.
- **Requested change:** Record the expected video share and average length (same input as SA-F-03 item 2), and the 3-year growth (still Open). Note that the Architect has set the load-test headroom: 2 × peak sustained and 3 × burst.

### SA-F-05 — Availability and recovery targets need a measurement scope
- **Where:** NFR-1, NFR-2, NFR-3.
- **Requested change:** Define (a) whether third-party outages (video, e-Rx network, Google) count against 99.9 %; recommended: they don't, but platform behaviour during the outage must meet BR-33; (b) planned maintenance treatment (zero-downtime means none planned); (c) that RPO 15 min / RTO 4 h apply also to loss of a whole cloud region. The architecture assumes they do (cost included).

### SA-F-07 — FHIR/SMART and ONC certification have no release or decision
- **Where:** `[04 §2]`, §10 compliance, PM question 4.
- **Requested change:** Add a decision (**human**, legal input): does the network need ONC-certified health IT (for example, for a payer programme) in R1–R3? Recommendation: no certification in R1–R3; internal coded model; FHIR R4 read API only when a real consumer exists, otherwise R4. Note that CPT needs a paid AMA licence and is not needed before billing codes (R4 claims).

### SA-F-08 — R1 must capture coded medications and allergies
- **Where:** F-SH-06 (R1 part), RA-R1-09, OUT-4.
- **Requested change:** In R1, allergies and the medication list are entered as coded items (RxNorm), with free text allowed but flagged "uncoded". The R2 checks cannot evaluate uncoded entries, so OUT-4 should define how uncoded entries count (recommend: shown as a warning that requires acknowledgement).

### SA-F-09 — Telehealth licensing needs enforcement points
- **Where:** J-08, D-2, G-19.
- **Requested change:** Even before states are named, state where the rule applies: at booking (patient's stated location vs clinician's licensed states) and at join (patient confirms current location). The data model will carry clinician licensed states from R1.

### SA-F-12 — BR-23 should cover every channel that leaves the platform
- **Where:** BR-07, BR-23, RA-R1-05, RA-R2-09.
- **Requested change:** Apply the "no diagnosis, test or medicine name" rule also to .ics files, push notifications, Google busy-block titles, payment descriptors and receipts, and **service or specialty names that reveal a condition** (for example "HIV clinic"). Test by rendering every template.

### SA-F-13 — Duplicate patient detection and merge is missing
- **Where:** F-PP-01, F-PC-01, BR-34; no current requirement.
- **Evidence:** Front desk can register or check in patients and patients self-register, so duplicates are certain at 250,000 patients. Split charts are a wrong-patient safety risk (allergies on one record, prescribing on the other).
- **Requested change:** Add a requirement: duplicate detection at registration (name, date of birth, phone/email) and a controlled, audited merge by authorised staff. Mark it safety-relevant.

### SA-F-14 — Required assurance activities have no budget or schedule
- **Where:** RA-R1-18, NFR-3, NFR-10, NFR-16, D-12.
- **Requested change:** List in dependencies, with owner and timing before end of May 2027: independent penetration test, timed DR rehearsal, manual accessibility audit, and clinician review. State whether they are paid from the build budget (**human**).

### SA-F-15 — 99.9 % with on-call alerts needs a named on-call rota
- **Where:** NFR-1, NFR-20, intake E (one operations owner).
- **Requested change:** Add a dependency: a named on-call rota with response times from R1 go-live, or accept a lower effective availability (**human**).

## Low

### SA-F-10 — RA-R1-03 conflicts with overbookable slots
- **Requested change:** "For a slot that is not overbookable, under 100 parallel confirmations exactly one succeeds; for an overbookable session, confirmations succeed up to the configured cap and no further."

### SA-F-11 — Audit volume and retention
- **Requested change:** Note that every chart view produces an event (~2 million a day at peak, ARCHITECTURE §9) and that the retention period set at G2 drives storage cost. The audit export in RA-R1-12 needs a size limit and runs as an asynchronous job.

## Items checked with no finding

- R1 can stand without a drug database or payments (PRD §15 Q6). Feasible; the R1 contracts R2 needs are listed in ARCHITECTURE §14.
- Booking invariants BR-02/X-01/X-02, idempotent inbound BR-24/BR-33, document scanning BR-28, BTG BR-14: technically feasible as written.
- NFR-6, NFR-7, NFR-8 targets: feasible (ARCHITECTURE §9).

## Limitations

Document review only; not legal, regulatory or clinical advice. The DEA statements in SA-F-01 come from DEA's pharmacy EPCS Q&A and certifier pages found by web search on 2026-11-04. The eCFR text was not read in full and needs qualified confirmation.
