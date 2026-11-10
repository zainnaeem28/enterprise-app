# TC-PEN-01 Penetration test: scope and rules of engagement (draft)

Task HEAAA-686 · author: Cybersecurity (`83cd0a46`) · reviewer stage: Security Reviewer · Requirements: NFR-16, DEP-13, RA-R1-18 · Builds on SEC-07 section 7
Status: **DRAFT, not an authorisation.** It authorises nothing until the owner fills the open fields and signs. No tester has been contacted by this ticket.

## 1. Owner input and what it does not settle

The owner replied on HEAAA-688: "Me I checked and approved from my side". That reply names no tester, firm, contact, budget, window or target. This draft therefore leaves those fields open. **Independence (NFR-16) is unconfirmed:** the reply does not say the tester is outside the build team and not the owner. If the owner performs the test, TC-PEN-01 is not met and the record must read "self-performed by the owner, not independent" (RA-R1-18 fallback wording), never PASS. The Security Reviewer confirms independence before G3 HEAAA-34.

## 2. Open fields (owner completes; do not invent)

| Field | Value |
| --- | --- |
| Tester (company or person), independent of build team and owner | OPEN |
| Tester contact and escalation phone | OPEN |
| Owner signatory and date of authorisation | OPEN |
| Budget / cost cap (D-28) | OPEN |
| Test window (start, end, time zone) | OPEN |
| Tester source IP addresses | OPEN |
| Target base URLs (staging only) | OPEN, depends on a deployed staging environment |
| Candidate revision under test (git SHA, image digests, manifest hash) | OPEN, the exact G3 candidate; a later change reopens scope |
| Build-side technical contact and on-call during window | OPEN |
| Report delivery channel | OPEN |

## 3. Preconditions

1. Staging runs the frozen G3 candidate from a signed build; the tester is given the SHA and image digests. A different revision invalidates the result.
2. Synthetic data only; no real patient data and no production target.
3. SEC07-F01, F02 and the SEC-05 G-1/G-2 items are closed or recorded as accepted, so known gaps are not retested at cost.
4. Credentials issued from the secret store at window start and revoked at end; never in task text, artifacts or screenshots. Delivered to the tester by the owner over a channel outside Paperclip.

## 4. In scope (staging only)

As SEC-07 section 7: public API and booking/intake forms (rate limit, bot protection, enumeration); inbound webhooks (signature, replay); the authenticated API (object-level, tenant/location RLS, role escalation, patient-proxy rules); identity (patient, staff, admin realm, WebAuthn, session revocation, step-up, second approver, kill switch); clinical safety paths (break-the-glass, banner allergies, red-flag alert, SSE alert stream authorisation); documents (upload, scan states, presigned URLs, download authorisation, PHI in output); web apps (patient, staff, admin, marketing site, CMS: XSS, CSRF, CSP, headers, clickjacking, redirects); edge (TLS, WAF/CloudFront, error pages, exposed storage or admin endpoints).

Accounts (synthetic): patient, proxy, front-desk, nurse, doctor, admin, compliance admin, second approver, cross-location staff, unauthenticated visitor.

## 5. Out of scope

Production and any real-data account; denial of service or load beyond the agreed rate; social engineering and physical access; third-party systems (Google, messaging, video vendors); build-team devices; the Paperclip platform and agent infrastructure.

## 6. Rules of engagement

- Test only the listed targets, from the listed addresses, inside the window, at or below the agreed request rate (OPEN: requests/second).
- **Stop and call the build contact** on: real personal data seen, a service-impacting action, a Critical finding, or leaving the agreed addresses.
- Report any Critical or High within the agreed notice time (OPEN, suggest 24 hours) outside the final report.
- No data exfiltration beyond minimal proof; no persistence; no destructive writes beyond synthetic records; delete created data at close.
- Findings are confidential to the owner, Cybersecurity and the Security Reviewer until fixed.
- The tester's own tooling, any AI or scanner use, and subcontractors are disclosed before the window.

## 7. Deliverables and exit

Report with method, evidence, reproduction, severity (CVSS plus business impact) and fix advice. Cybersecurity registers each finding with a stable ID in the common ledger and routes it to the owning engineer. Every Critical and High is fixed, independently reviewed, retested by the tester and integrated; none open at R1 production (DEP-13). Medium and below get an owner or a recorded acceptance with expiry. Fix validation by Cybersecurity is revision-specific and is not a substitute for the tester's retest. The final report is independently reviewed before any G3 PASS. This document is not G3, human approval or deployment approval.

## 8. Next permitted action

Owner fills section 2 and names an independent tester on HEAAA-686. Security Reviewer reviews this draft and confirms independence. Until then TC-PEN-01 stays pending-human and HEAAA-659 and G3 HEAAA-34 stay gated.
