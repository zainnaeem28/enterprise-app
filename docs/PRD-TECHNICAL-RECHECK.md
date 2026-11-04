# PRD technical recheck — Solution Architect (round 1 closure)

| Field | Value |
| --- | --- |
| Task | HEAAA-41 `[SDLC:prd-recheck-technical]` (parent HEAAA-10) |
| Reviewer | Solution Architect agent (`7efe9f61-495f-4237-82f9-fa178629da09`). I did not author the PRD. I authored ARCHITECTURE.md, so its draft 3 needs the Solution Architect Reviewer (section 4). |
| Reviewed revision | HEAAA-39 `prd` rev `7d196a7d-8489-4dc1-86b7-d9dcd22711ad` ("PRD revision 2"); repo mirror `docs/PRD.md` @ `12b9578`. The two differ only by one trailing newline (checked with `diff`). |
| Findings rechecked | HEAAA-8 `prd-technical-review` rev `0050e877-2ce7-4072-8e80-fa78129ab478` (SA-F-01..15), as consolidated in HEAAA-10 `consolidation-ledger` rev `6586bf09-5016-46eb-b124-bad166fbe099` |
| Verdict | **PASS for SA-F-01..15.** Every finding is closed in PRD text. Items that need a human decision are in the decision register with a default if undecided; none is decided here. Two new **Low, non-blocking** findings (SA-F-16, SA-F-17) are recorded for Orchestrator disposition. |
| Round | PRD cumulative round 1 of 3. This recheck closes round 1 for the technical lane. Round count unchanged; IDs preserved. |
| Not | Not human approval, not G1, not a decision on any D- item. |

## 1. SA-F-01..15 on PRD revision 2

"Closed" means the PRD text now does what the finding asked. "Decision" lists the register row the owner must answer; the default applies if they do not.

| ID | Sev | Status | Evidence in PRD rev 2 | Decision (default) |
| --- | --- | --- | --- | --- |
| SA-F-01 | High | **Closed** | §1 "Prescription channel" (every Rx via the certified network; portal is a mirror and status channel; not DEA pharmacy software); §7.3; RA-R2-03 ("every" Rx, change/cancel/renewal as network messages); RA-R2-05 (mirror; accept/query/reject are status and messages). Appendix C ST-03/F-PH-03 are verbatim BA text; §1 states how they are read. | D-24 (treated as the design) |
| SA-F-02 | High | **Closed** | §11.1 VC-1..VC-5; OUT-4 and RA-R2-01 tied to VC-1; RA-R2-02 proofing/signing at the vendor, EPCS audit via VC-2; DEP-6/DEP-7 bundling note | none |
| SA-F-03 | High | **Closed** | §9 run-cost position uses ARCHITECTURE §10.1 figures exactly (8,150 / 13,750 / 22,150; region-loss 800); D-25 (a)–(e) inputs and cost position; DEP-6/DEP-12 quotes before G2; RK-10 raised to High | D-25 (A-3, A-5, A-10 assumptions; G2 blocked until quotes). See SA-F-16 |
| SA-F-04 | Med | **Closed** | NFR-9 states ~700 video visits/hour implication, video share and length as D-25 (b), 3-year growth Open, headroom 2 × / 3 ×; DEP-14 load-test environment | D-25 |
| SA-F-05 | Med | **Closed** | NFR-1 scope (third-party outages excluded, BR-33 behaviour still required, no planned-maintenance exclusion); NFR-2/NFR-3 cover region loss | D-26 (yes, included) |
| SA-F-06 | High | **Closed** | RA-R1-01 (Workspace policy, policy export plus non-enrolled-account test, no per-sign-in claim); J-22; DEP-2 named super-admin | none |
| SA-F-07 | Med | **Closed** | §10 (ONC/FHIR not required by any source; legal question; CPT licence note); §12; D-27 | D-27 (no certification; no external FHIR before R4) |
| SA-F-08 | Med | **Closed** | §4.5, §7.3, RA-R1-09 (RxNorm coded; free text flagged "uncoded"); OUT-4 and RA-R2-01 define how uncoded entries count. Wording nit: SA-F-17 | none |
| SA-F-09 | Med | **Closed** | §7.3 TL-1 (booking and join; licensed states in the data model from R1); RA-R1-28; J-08 | D-2 (values) |
| SA-F-10 | Low | **Closed** | RA-R1-03 split for non-overbookable and overbookable sessions | none |
| SA-F-11 | Low | **Closed** | NFR-13 (~2 M events/day; retention drives cost); RA-R1-12 async export with size limit | none |
| SA-F-12 | Med | **Closed** | §7 and §7.3 BR-23 extension (SMS, email, push, .ics, calendar titles, payment descriptors/receipts, condition-revealing service names; neutral display name); RA-R1-04, RA-R1-05 render-every-template test | none |
| SA-F-13 | Med | **Closed** | §7.3 BR-37 (detection on name, DOB, phone/email; audited merge by authorised staff); in the safety-critical list (§7, §8.3); RA-R1-27; RK-13 | none |
| SA-F-14 | Med | **Closed** | DEP-11, DEP-13..17 with owner and timing before end of May 2027; RA-R1-18; D-28; RK-11 | D-28 (build budget) |
| SA-F-15 | Med | **Closed** | DEP-15; NFR-1 and NFR-20 reference it; D-29 default "target kept, not claimed as met"; RK-12 | D-29 |

Also checked from the ledger's "Also for PM alignment" list: audit retention longest of HIPAA/DEA/state (NFR-13, RA-R2-02); counsel to confirm the 60-day breach clock (§10); video encryption as vendor criterion (§11.1); first penetration test as R1 release gate (RA-R1-18, DEP-13); Part 2 as D-15 with default; hosting as D-30. All present.

## 2. New findings on PRD revision 2 (non-blocking)

### SA-F-16 — Low — Two defaults combine into a G2 deadlock
- **Where:** D-1 default ("no vendor contact"), D-25 default ("G2 blocked until quotes exist"), DEP-6 ("quotes before G2").
- **Evidence:** e-prescribing/EPCS per-prescriber fees are normally only available by quote, which needs vendor contact. If the owner approves the PRD at G1 without answering D-1 and D-25, the first default forbids the contact that the second default needs, so G2 can never open.
- **Requested change:** one sentence in D-25 (e) or D-1: either "approving G1 authorises contacting vendors for quotes only (no purchase, no account)" as the D-25 default, or state the coupling explicitly so the owner sees that leaving D-1 undecided blocks G2.
- **Why non-blocking:** the effect is visible and safe (it stops work rather than allowing it), and it is a decision-register wording fix. **Disposition proposal:** fix in the PRD if it is revised for any other reason before freeze; otherwise the Orchestrator lists it in the G1 summary next to D-1 and D-25.

### SA-F-17 — Low — OUT-4 and RA-R2-01 count uncoded entries differently
- **Where:** OUT-4 ("count as checked only when the prescriber acknowledges an 'uncoded entry' warning, and are reported separately") vs RA-R2-01 ("counted as 'unchecked, acknowledged' and reported separately").
- **Evidence:** one says acknowledged uncoded entries are inside the 100 %, the other calls them unchecked. A tester cannot tell whether a prescription with an acknowledged uncoded allergy passes the 100 % target.
- **Requested change:** use one rule in both places. Recommended: "a prescription counts toward the 100 % when every coded entry has a recorded check outcome and every uncoded entry has a recorded prescriber acknowledgement; acknowledged uncoded entries are also reported separately."
- **Why non-blocking:** R2 acceptance; it does not change R1 scope or the architecture. **Disposition proposal:** as SA-F-16, or carry to QA test design (HEAAA-15) with this wording.

## 3. Architecture alignment (ARCHITECTURE rev `8f523903` vs PRD rev 2)

No PRD revision 2 change contradicts the architecture's topology, data ownership, trust boundaries, controls, capacity model or cost figures. Checked: Rx channel (ADR-007, §5.2); vendor criteria (ADR-006, §7 e-Rx row); Workspace 2SV (§7 staff identity); coded data (ADR-010, §6); TL-1 (§4); BR-23 extension (§6 PHI-free allowlist); BR-37 (§4 `patient`); async audit export (§4 `audit`); NFR-1/2/3 scope and region loss (§9.2, §9.4); NFR-9 headroom (§9.1); cost figures (§10.1); assurance dependencies (§10.3); D-25 default assumptions (A-3, A-5, A-10).

Rev `8f523903` was, however, **stale in its references**: it cited PRD draft 1, said "the PRD needs to say this" for items the PRD now covers with decision IDs, listed clinician licensed states as a trim candidate although PRD TL-1 now makes them R1, did not name the neutral service display name owner, omitted the load-test environment in §10.3, and cited SA-F-15 where SA-F-14 was meant. Putting it next to PRD revision 2 in the G1 package unchanged would mislead the decision-maker.

**Delta recorded as ARCHITECTURE draft 3** (HEAAA-41 document `architecture`; `docs/ARCHITECTURE.md` on the HEAAA-10 branch). Section 18.1 of that document lists every change. References and status only; no topology, technology, ownership, control or cost change. It needs the **Solution Architect Reviewer** to recheck the changed lines (architecture cumulative round 3 of 3).

## 4. SEC-D-19 (admin identity realm deviation)

ARCHITECTURE §7 proposes, instead of HEAAA-9's "separate admin identity realm": step-up re-auth for admin and compliance roles, security-key 2SV in a dedicated Workspace organisational unit, second approver for privileged role changes, app-held roles, and access review of the Workspace super-admin. The other SEC-D-19 controls (admins see audit data but not PHI by default, export rate limits and alerts, audited configuration changes) are kept. **Cybersecurity has not confirmed this yet.** Requested through a tracked Cybersecurity task under HEAAA-41. Until confirmed, the deviation stays open and G1 cannot freeze the architecture.

## 5. Human decisions (not decided here)

Unchanged from the ledger and present in PRD §13 with defaults: D-1, D-2 (no safe default), D-12a, D-24, D-25, D-26, D-27, D-28, D-29, D-30, D-15, D-3..D-6, D-31.

## 6. Checks and limitations

- Document review only. Checks done: read PRD rev 2 §0–§18 against each SA-F finding; compared PRD figures with ARCHITECTURE §10.1; `diff` of the task document against `docs/PRD.md`; read the architecture review rev `46cabf10` and security assessment rev `22d5dcc6` for SEC-D-19. No automated test applies.
- Not legal, regulatory or clinical advice.

## 7. Next permitted action

1. Cybersecurity confirms or rejects SEC-D-19 on ARCHITECTURE draft 3.
2. Solution Architect Reviewer rechecks ARCHITECTURE draft 3 (changed lines; round 3 of 3).
3. Orchestrator disposes SA-F-16/17 and, with the Product Owner Reviewer's HEAAA-40 result, decides whether PRD round 1 is closed. Then G1 package preparation (HEAAA-10). No gate is requested by this recheck.
