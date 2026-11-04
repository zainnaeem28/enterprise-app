# PRD technical recheck, round 2 (`prd-technical-recheck-r2`)

| Field | Value |
| --- | --- |
| Task | HEAAA-47 `[SDLC:prd-recheck-technical-r2]` (parent HEAAA-10) |
| Reviewer | Solution Architect agent (`7efe9f61-495f-4237-82f9-fa178629da09`). Independent of the PRD author (Product Manager `9e1cccef`). |
| Reviewed | PRD **revision 3**: HEAAA-45 `prd` rev `bfc8d309-e5cc-4751-a8eb-aeb19ced5005` = `docs/PRD.md` @ `879d084` (task document and repo file compared: identical apart from trailing whitespace) |
| Compared with | PRD revision 2 (`docs/PRD.md` @ `12b9578`, `prd` rev `7d196a7d`); ARCHITECTURE draft 4 rev `a29940b5` (`docs/ARCHITECTURE.md` @ `8eaeca7`, unchanged at `879d084`) |
| Scope | Changed content only: SA-F-16, SA-F-17, D-35 (SEC-D-19 path A/B, SAR-15/16), RA-R1-01 and new RA-R1-32 (C1/C4/C6), D-32 (BR-37), D-33 (coded data), D-34 (TL-1) for technical feasibility, and alignment of the changed content with ARCHITECTURE `a29940b5`. POR-12..15 product intent is the Product Owner Reviewer's lane (HEAAA-46) and is not judged here. |
| Verdict | **PASS for every item in scope.** SA-F-16 and SA-F-17 are closed. Two new **Low, non-blocking** findings: SA-F-18 and SA-F-19. Neither changes R1 scope, cost or the architecture overview. |
| Round | PRD cumulative round 2 of 3. This recheck closes round 2 for the technical lane. The finding IDs carry over from earlier rounds. |
| Not | Not human approval, not G1, not a decision on any D- item. |

Method: I read the full `git diff 12b9578 879d084 -- docs/PRD.md`, checked each changed row against ARCHITECTURE draft 4 (sections 4, 7, 8.1, 8.3, 8.4, 10.1, 12 A-11/A-14, 13 ADR-010/ADR-011, 18.1, 18.2), and searched the architecture for the modules the new rows need. This was a document review only. No automated check applies.

## 1. Per-ID result

| ID | Result | Evidence in PRD rev 3 | Notes |
| --- | --- | --- | --- |
| SA-F-16 (Low) | **PASS, closed** | D-1 default: "no purchase, account or contract; vendor contact limited to quote requests (no PHI, no commitment) is authorised by approving G1". The D-25 default points to it. Section 19 flags that this widens what silence authorises. | This is the first option the finding requested. The deadlock is removed. ARCHITECTURE A-11 (custom build; reopens if buy/hybrid) and §10 item 5 (e-Rx quotes before G2) stay consistent. The "no vendor contacted" statement at ARCHITECTURE line 26 describes the overview's own work and does not conflict. |
| SA-F-17 (Low) | **PASS, closed** | OUT-4 and RA-R2-01 now use the same rule, word for word the recommended text. | A tester can now decide the acknowledged-uncoded case: it counts toward the 100 % and is also reported separately. |
| RA-R1-01 (SAR-12 step 5) | **PASS** | A pointer to RA-R1-32 for admin and compliance step-up, approver and session controls. | See SA-F-18 for the path-dependent wording "security keys recommended for … admins". |
| RA-R1-32, C1 | **PASS on path A**; see SA-F-18 | "Privileged action refused without a valid server-side elevation grant obtained by an app-enrolled WebAuthn credential; stale or expired grant refused." | Matches ARCHITECTURE 8.4 C1 and C7 (stale `auth_time` / expired elevation). |
| RA-R1-32, C4 | **PASS** | The approver is a different person from the requester and the subject, cannot approve their own request, and the request expires. Requester, approver, before/after roles and outcome are audited. | Matches 8.4 C4. Two C4 rules are not in the row: the approver must hold an eligible role with an active elevation, and changes to the approver set also need approval. Both are in the C7 tests for the QA plan, so this is acceptable for a PRD row. HEAAA-13 and HEAAA-15 should keep them. |
| RA-R1-32, C6 | **PASS** | The kill switch ends every session and elevation of a user at once. Admin/compliance deprovisioning completes the same business day. | Matches 8.4 C6 (sessions held server-side in `identity`, not dependent on Google). Same-business-day completion is a timed runbook check. It is not a unit test, and QA/DevOps should plan it that way. |
| RA-R1-32 scope and trace | **PASS** | Role scope copied from 8.4. C2, C3, C5 and C7 are routed to the DevOps/QA plans. Evidence must be a test run on the integrated candidate. Trace: SEC-D-19-C1/C4/C6, RA-R1-01, RA-R1-17. | **[Rec]** labelling is correct under the new section 0 rule (not intake-confirmed; binds on G1 approval). |
| D-35 (SEC-D-19 path A/B) | **PASS** | Path A: 1–2 engineer-weeks, keys US$600–4,500, no new run cost, residual risk Medium, one Google trust root. Path B: 2–4 engineer-weeks, +US$0–200/month, second identity lifecycle, risk not rated. C4–C7 apply on both paths. Recommendation is A, default is B. SAR-15 and SAR-16 are both stated. Blocks: identity design, RA-R1-01, RA-R1-32, NFR-12. | Every figure and position matches ARCHITECTURE 8.4, 10.1 and A-14 exactly. The figures are labelled as Architect estimates. SAR-15 (path B or an open decision reopens ADR-011 and the staff-identity design) and SAR-16 (path B cost may be understated; Workspace edition unconfirmed, DevOps confirms before G2) are faithful to the ARCHITECTURE 8.4 "not verified" notes and §16 limitations. |
| D-32 (BR-37) | **PASS, feasible** | Keep in R1. It is safety-critical and does not give way under D-22. The only permitted shrink is a narrower scope (warning plus manual merge). | ARCHITECTURE §4 `patient` owns duplicate detection and merge. Cross-module re-pointing of patient references is a HEAAA-13 transaction design item (§18.1). See SA-F-19 on "merge by an admin". |
| D-33 (coded data, RxNorm) | **PASS, feasible** | Code in R1. It may give way only in D-22 tier (1), and only if free text is flagged "uncoded" and coding is complete before R2 prescribing. | Consistent with ADR-010 and §5 coding (RxNorm through the NLM/UMLS licence, free text flagged). Even if deferred, the data model keeps coded fields from R1, so deferral only changes the UI and data entry, not the architecture. Note for the owner and HEAAA-13: deferral creates a retro-coding backlog that needs clinician time, and "coding complete" needs a measurable check (for example, no uncoded active allergy or medication entries) before R2 prescribing opens. Not a finding. |
| D-34 (TL-1) | **PASS, feasible** | Enforce at booking and at join. Licensed states are in the data model from R1. It does not give way (legal). The state list comes from D-2. | Matches ARCHITECTURE §4: `identity` holds licensed states on staff profiles, `scheduling` checks at booking, `telehealth` checks at join, and §18.1 records the change. |
| SEC-D-19 ledger line (§18) | **PASS** | Points to the HEAAA-42 disposition, D-35 and RA-R1-32. | |

## 2. New findings (Low, non-blocking)

### SA-F-18 — Low — RA-R1-32 C1 and RA-R1-01 wording assume path A, but path B is the default

- **Where:** RA-R1-32 ("tested on either SEC-D-19 path (D-35): (C1) … elevation grant obtained by an app-enrolled WebAuthn credential"); RA-R1-01 ("security keys recommended for prescribers and admins").
- **Evidence:** ARCHITECTURE 8.4 and D-35 itself say "C4–C7 apply on both paths". C1–C3 are path A controls. On path B, admin step-up is the separate admin pool's mandatory WebAuthn sign-in, and the staff-realm elevation grant described in C1 is not in that design. That design is not yet written (SAR-15). Path B is also the default if undecided, so the row as written would test a mechanism that the default design does not contain. Also on path A, C2 requires security-key-only 2SV, with no fallback, for the admin OU. RA-R1-01 calls security keys only "recommended" for admins.
- **Requested change (next PRD edit, or carry):** in RA-R1-32, make C4 and C6 "either path" and C1 "path A". On path B, C1 becomes "a privileged action is refused unless the session comes from the admin pool with WebAuthn", restated when the identity design is reopened (SAR-15). In RA-R1-01, add "required (security-key-only) for the admin OU on path A (SEC-D-19-C2)".
- **Why non-blocking:** the D-35 decision resolves it either way. On path A the rows are correct apart from one word in RA-R1-01. On path B, SAR-15 already reopens the identity design and its acceptance. It must be fixed before RA-R1-32 goes into QA test design (HEAAA-15). **Disposition proposal:** the Orchestrator either carries it into the G1 package as a known erratum next to D-35, or routes it to the next PRD revision if one happens for another reason. It does not justify a PRD round on its own.

### SA-F-19 — Low — the D-32 narrower fallback assigns merge to "an admin", which conflicts with SEC-D-19-C5

- **Where:** D-32 default: "only a narrower scope (warning and manual merge by an admin) may be proposed".
- **Evidence:** ARCHITECTURE 8.4 C5 (accepted by Cybersecurity): admins see audit metadata but **no PHI by default**, and admin access to PHI is break-the-glass with a reason and a compliance alert. A merge requires comparing both charts. If the admin role did the merge, every merge would be a break-the-glass event, or C5 would have to be weakened. RA-R1-27 correctly says "authorised staff".
- **Requested change:** "manual merge by an authorised clinical/records staff role (not the admin role; SEC-D-19-C5)".
- **Why non-blocking:** this applies only if the owner trims under D-22. The default (BR-37 as written) is unaffected. **Disposition proposal:** same as SA-F-18.

## 3. Architecture alignment (ARCHITECTURE `a29940b5` vs PRD rev 3 changed content)

No PRD change in revision 3 requires a change to the architecture overview. I made **no** architecture edits. These items need reporting but not an architecture cycle:

| ID | Item | Route |
| --- | --- | --- |
| AL-R2-01 | RA-R1-30 / F-PC-07 (follow-ups and referrals, now in the 4.5 R1 list). ARCHITECTURE §4 has no owner for the **referral** record (referrer, target, status). Follow-up booking fits `scheduling`. The referral record most likely belongs to `clinical` (which owns encounters). This is a module mapping only, with no topology, cost or trust-boundary effect. | HEAAA-13 detailed design (module mapping), after G1 |
| AL-R2-02 | RA-R1-31 / F-AD-06: integration secrets are write-only from the admin UI. ARCHITECTURE §8.1 keeps secrets in Secrets Manager but does not specify the app-side write path: which deployable may write secret values, with what IAM scope, and how the before/after audit avoids logging the secret. The admin action is also privileged, so C1/C4 elevation applies. | HEAAA-13 (`organisation`/`identity` design and the Z2→Z3 IAM scope); the security reviewer should see it |
| AL-R2-03 | ARCHITECTURE §18.2 "next permitted action" lists the open owner decisions by older IDs ("the SEC-D-19 path (section 8.3)"). The PRD now names it D-35, and D-32..D-34 are new. This is a cross-reference erratum only. | Fold into the next architecture revision when one is authorised. No cycle needed on its own. |

## 4. Result and next action

- **Technical lane, PRD round 2:** PASS. SA-F-16 and SA-F-17 are closed. SA-F-18 and SA-F-19 are new, Low and non-blocking, with dispositions proposed above. AL-R2-01..03 are routed and need no architecture change before G1.
- **Next permitted action (Orchestrator):** combine this with the Product Owner Reviewer's HEAAA-46 result. If that also passes, decide the SA-F-18/19 disposition (G1 erratum or carry), then continue G1 package preparation in HEAAA-10. This recheck requests no gate. G1 remains a human decision.
- **Limitations:** document review only. Cost figures remain the Architect's unverified estimates (ARCHITECTURE §16). I authored ARCHITECTURE, so this recheck covers the PRD only and is not an independent review of ARCHITECTURE alignment notes AL-R2-01..03.
