# Discovery Security Assessment — Enterprise EHR Platform

| Field | Value |
| --- | --- |
| Task | INV-9 `[SDLC:discovery-security]` |
| Author | Cybersecurity agent (`e7e1de31`) |
| Input revision | PRD-D1: Paperclip document `prd` on INV-6, revision `2f61190d-586d-47c4-a67c-930662631305`; intake pack rev 2 (`docs/intake/` @ `6ea01b5`) |
| Method | **Desk review only** (threat modelling against the PRD and intake). **No scan, penetration test or dynamic probe was run. No code exists yet.** |
| Status | Draft for independent review. Not approved. A review PASS is not human approval. |
| Audience | Solution Architect (INV-8) incorporates the decisions into `ARCHITECTURE.md`; affected requirements reach the PM through the Architect. |

## 1. Is specialist security analysis warranted? Yes

Triggers present (all from the intake/PRD, not assumed):

- **Sensitive data at scale:** PHI for ~250,000 patients, ~1,000 staff, 30+ clinics; possible 42 CFR Part 2 records (DEC-07). HIPAA applies.
- **Tenancy / permission boundaries:** clinic and location scoping (PERM-X1); *external* partner pharmacies in the same platform seeing only their own prescriptions (PERM-X2); proxies/guardians; break-the-glass.
- **Controlled-substance prescribing (EPCS):** DEA rules for identity proofing, two-factor signing, audit.
- **Payments (R2):** card data; refunds.
- **External exposure:** public brand site and registration forms, patient portal, partner pharmacy portal, webhook/REST API for pharmacy status (R3), FHIR/SMART APIs.
- **Integrations (7 in R1):** SSO, calendar, video, email/SMS/push, OCR, e-signature, maps; later e-prescribing network, labs, clearinghouse, BI export.

Basic security remains mandatory for everything; this document adds the specialist layer.

## 2. Assets and trust boundaries

| ID | Boundary | Crossing | Main concern |
| --- | --- | --- | --- |
| TB-1 | Internet → public surface (brand site, registration, booking, login) | Unauthenticated | Bots, enumeration, credential stuffing, injection, upload abuse |
| TB-2 | Patient/proxy session → patient data | Authenticated external | Horizontal access (other patients, non-dependents), account takeover |
| TB-3 | Staff session → PHI | Authenticated internal | Location/assignment bypass, snooping, over-broad roles |
| TB-4 | Partner pharmacy tenant ↔ platform ↔ other pharmacies | Authenticated external, different organisation | Cross-pharmacy data leak, excessive PHI exposure, weak pharmacy account hygiene |
| TB-5 | Platform ↔ third parties (SSO, calendar, video, SMS/email, OCR, e-Rx network, labs, payments) | Outbound/inbound | PHI leakage to vendors without BAA, forged inbound messages, replay, SSRF |
| TB-6 | Application ↔ data stores, object storage, backups, logs, analytics | Internal | Encryption/key misuse, PHI in logs, audit tamper, backup exposure |
| TB-7 | CI/CD and deployment ↔ production | Operational | Secrets in pipeline, supply chain, test data containing real PHI |
| TB-8 | Admin/compliance/support tooling ↔ audit log | Privileged | Admin deleting or altering audit trail; privileged misuse |

## 3. Threats and required controls

Severity is the likelihood×impact for a PHI platform if the control is absent. IDs are stable; later revisions append.

| ID | Threat (boundary) | Sev | Required control (for Architecture) | PRD trace |
| --- | --- | --- | --- | --- |
| SEC-T01 | Broken object-level authorization: a user reads/changes another patient, clinic or pharmacy record by changing an ID (TB-2/3/4) | Critical | Centralised, deny-by-default authorization enforced server-side on every request (policy: role + organisation + location + assignment + relationship). Row-level scoping at the data layer (e.g. tenant/organisation key plus RLS or equivalent), not only in UI. Opaque non-guessable IDs. Authorization negative tests per endpoint in CI. | RULE-SEC-02, PERM-X1..3, AC-SEC-04 |
| SEC-T02 | Partner pharmacy sees prescriptions or patient data beyond its own, or a pharmacy account is shared/compromised (TB-4) | Critical | Pharmacy as a distinct tenant type; field-level minimum-necessary projection (prescription details only); per-user accounts, MFA, no shared logins; pharmacy-admin-managed users with platform audit; session binding and anomaly alerts; onboarding approval by platform admin (J-17). Test: pharmacy Q reads pharmacy P's Rx by ID → 403/404 and audited. | RULE-RX-08, PERM-05, AC-RX-03, J-17 |
| SEC-T03 | Staff snooping / abuse of break-the-glass (TB-3) | High | Reason required, immediate compliance alert, review queue with SLA, reviewer cannot be the accessor, rate/pattern analytics on BTG and on high-volume viewing. | RULE-SEC-05, AC-CLN-03 |
| SEC-T04 | Account takeover of patients/staff/pharmacy users: phishing, credential stuffing, SIM swap, MFA fatigue (TB-1/2) | High | Managed identity provider (no home-grown auth); breached-password check; phishing-resistant factor (passkey/WebAuthn/TOTP) preferred over SMS OTP for staff, pharmacy and sensitive actions; number-matching or no push-approval prompts; rate limiting and lockout with safe error messages (no enumeration); step-up re-auth for sensitive actions (DEC-22 list); session revocation and new-device alerts. | RULE-SEC-01, DEC-22 |
| SEC-T05 | Staff SSO misconfiguration (Google Workspace): any Google account accepted, stale accounts retained, role escalation via group claims (TB-3) | High | Restrict to the organisation's Workspace domain (`hd` + verified server-side `iss`/`aud`/`nonce`), do not trust client-side claims; map roles inside the platform, not solely from IdP groups; deprovision on leaver within a defined time (SCIM or sync job); MFA enforced at platform for patient-data access regardless of IdP (AC-SEC-01). | PRD-AC-ADM-04, AC-SEC-01 |
| SEC-T06 | EPCS fraud: forged or coerced controlled-substance prescription; prescriber credential theft (TB-3/5) | Critical | Use a DEA-certified EPCS solution; do not build own signing. Identity proofing and logical access control per 21 CFR 1311; two-factor signing with a factor separate from login; signing events immutable and audited; sign-and-send atomic (failure blocks send); alerts on unusual EPCS volume/timing. ASVS L3 for this path. Vendor capability to be confirmed (Q-SA-09). | RULE-SEC-04, AC-SEC-03, Q-SA-09 |
| SEC-T07 | Audit trail tampering or deletion, including by admins; gaps from unlogged read paths (TB-6/8) | High | Append-only store (WORM/object-lock or hash-chained records) in a separate account/trust domain; application roles have insert-only rights; no admin delete; audit written synchronously for PHI reads (fail closed or alert if audit write fails); time sync; export of audit is itself audited; integrity check job. Retention per DEC-21. | NFR-19, RULE-SEC-06 |
| SEC-T08 | PHI leakage via logs, URLs, error pages, analytics, SMS/email, push, calendar (TB-5/6) | High | Central logging scrubber/allowlist schema; PHI banned from URLs and query strings; no third-party analytics/session-replay on authenticated pages; SMS/email/push templates contain no clinical terms (login prompt only); calendar events "Busy" only; PHI-detection tests on log samples and outbound payloads. | NFR-16, 04§4 |
| SEC-T09 | Encryption and key management failures (TB-6) | High | TLS 1.2+ (prefer 1.3) with HSTS; at-rest encryption for DB, object storage, backups and queues using managed KMS; separate keys per environment; rotation; envelope/field-level encryption for highest-risk fields (e.g. SSN if collected, EPCS artefacts, payment tokens); backups in second region under same controls. | NFR-15, NFR-04 |
| SEC-T10 | File upload abuse: malware, polyglot files, oversized/zip bombs, stored XSS via documents, public object URLs (TB-1/2) | High | Size/type allowlist, content sniffing, AV scanning in quarantine before availability, store outside web root, serve via short-lived signed URLs with `Content-Disposition: attachment` where possible, separate origin for user content, OCR sandboxed. | NFR-22 |
| SEC-T11 | Injection and web vulnerabilities (SQLi, XSS, CSRF, SSRF, IDOR, mass assignment) across 6 surfaces | High | Parameterised queries/ORM only; output encoding and strict CSP (no inline script); SameSite cookies + CSRF tokens; allowlisted egress for server-side fetches (SSRF) and metadata endpoint blocking; schema-validated DTOs rejecting unknown fields. ASVS L2 baseline, L3 on auth, prescribing, payments. | NFR-14 |
| SEC-T12 | Forged, replayed or duplicated inbound messages: pharmacy status webhooks, lab results, e-Rx responses (TB-5) | High | Authenticate every inbound channel (mTLS or HMAC-signed with timestamp and nonce; per-pharmacy secrets, rotatable); idempotency keys; reject stale timestamps; schema validation; status transition guard (a pharmacy may only change status on its own prescriptions; state machine rejects illegal transitions); lab results matched to order and patient with mismatch to human queue (wrong-patient prevention). | 04§4, ST-RX/ST-DLV |
| SEC-T13 | Vendor handling PHI without BAA, or vendor compromise (TB-5) | High | Vendor register with BAA status as a go-live gate per vendor; data minimisation to vendors; no PHI to maps/OCR/BI without BAA and de-identification (BI is R4); video vendor with E2E or HIPAA-eligible media path, no recording by default. | NFR-18, Q-SA-07 |
| SEC-T14 | Payment data exposure (R2) (TB-5/6) | High | Use hosted fields/redirect of a PCI-certified processor so card numbers never touch our systems (SAQ-A scope); store tokens only; webhook signature verification; refund approval separation of duties (DEC-25); ASVS L3 for payment path. | NFR-14, J-14 |
| SEC-T15 | Proxy/guardian abuse: unauthorised proxy added, access persists after custody/age change, minor confidentiality rules (TB-2) | High | Proxy relationship requires verification and patient/guardian consent; adding/removing proxy is a sensitive action (MFA step-up, notification to patient); scoped proxy permissions; automatic review at age thresholds (state rules Blocked (states)); proxy actions audited with acting identity. | AC-PROXY-01, DEC-22 |
| SEC-T16 | Patient-safety integrity: tampering or race on allergies, medications, results, wrong-patient writes (TB-3/6) | High | Signed/locked notes are versioned and amendments are additive; optimistic concurrency; two-identifier patient confirmation on writes of orders/results; server-side enforcement of interaction/override rules (not UI only); change history in audit. | NFR-25, 05§6 |
| SEC-T17 | Information blocking vs. over-release: results/notes released too early or withheld, release timer bypass (TB-2/3) | Medium | Release rules enforced server-side with auditable timers and role-restricted override; configuration changes to release windows audited and dual-approved. | DEC-02, DEC-26, Q-SA-10 |
| SEC-T18 | Availability/abuse: DoS on public booking, slot-scraping, SMS pumping (cost) (TB-1) | Medium | WAF + rate limits per IP/identity/phone; bot challenge on public forms; OTP/SMS send quotas and geo/prefix controls; queue back-pressure; cost alarms (NFR-27 budget). | NFR-22, NFR-27 |
| SEC-T19 | Break in tenant/environment separation: real PHI in non-prod, shared secrets across environments, over-privileged cloud roles (TB-7) | High | Synthetic data only outside prod; separate cloud accounts per environment; least-privilege IAM; short-lived CI credentials via OIDC; no secrets in repo/CI logs; secret scanning pre-commit and in CI; production access via audited just-in-time elevation. | NFR-17, NFR-20 |
| SEC-T20 | Software supply chain: vulnerable or malicious dependencies, base images, GitHub Actions (TB-7) | Medium | Lockfiles, dependency + container scanning, pinned Action SHAs, SBOM, signed artefacts, branch protection with required independent review. Build fails on blocking findings (define "blocking" in G2). | NFR-20 |
| SEC-T21 | Session handling: long-lived tokens, tokens in localStorage, unattended workstation exposing PHI (TB-2/3) | Medium | HttpOnly Secure SameSite cookies; short access sessions with rotation; idle and absolute timeouts (CFG-09, value set in G2); clear PHI from screen on timeout (DEC-15 item 4: recommend adopt); server-side revocation. | AC-SEC-02, CFG-09 |
| SEC-T22 | Insider/admin overreach: admins see patient data despite "audit only" intent; support access to prod data (TB-8) | Medium | Admin role excludes clinical data by default (DEC-19 direction); support access via time-boxed, patient-consented or incident-justified, audited elevation. | PERM-07, DEC-19 |
| SEC-T23 | Privacy rights (access, amendment, deletion, export) used to exfiltrate someone else's data (TB-2) | Medium | Verify requester identity and step-up MFA; exports delivered via authenticated portal download (not email), expire, and are audited. | J-16, DEC-22 |
| SEC-T24 | Video visit hijack/eavesdropping (TB-5) | Medium | Per-visit short-lived signed tokens bound to appointment and identity; waiting-room admit control; no guessable room URLs; no recording by default; participant list shown. | J-06, Q-SA-07 |

## 4. Baseline security requirements (apply regardless of specialist scope)

1. All traffic over TLS 1.2+; data encrypted at rest; keys in managed KMS (NFR-15).
2. Server-side authorization on every endpoint; deny by default; no authorization decision only in the client.
3. Managed identity provider; MFA for all staff and pharmacy users; MFA step-up for sensitive patient actions.
4. Append-only audit of every view/create/change/export/print of PHI; admins cannot delete (NFR-19).
5. No PHI in logs, URLs, analytics, SMS/email bodies (NFR-16).
6. Synthetic test data only outside production (NFR-17); separate environments and credentials.
7. SAST, dependency, secret and container scanning in CI; blocking findings fail the build (NFR-20).
8. Rate limiting, bot protection, upload scanning on public surfaces (NFR-22).
9. BAA with every vendor receiving PHI before it receives any (NFR-18, SEC-T13).
10. Backups encrypted, cross-region, restore-tested (NFR-04); incident response and breach-notification procedure (HIPAA) defined before go-live.
11. Independent penetration test before each release adding external surface (NFR-21).

## 5. Requirements and clarifications to carry to Architecture and PM

Proposals only; none changes the approved trust model.

| ID | Item | To | PRD link |
| --- | --- | --- | --- |
| SEC-R01 | Add an explicit **tenancy model** decision to `ARCHITECTURE.md`: organisation → location scoping, pharmacy as a separate tenant type, enforcement at data layer (SEC-T01/T02). | Architect | PERM-X1/X2 |
| SEC-R02 | Choose the **audit store design** (WORM/separate trust domain) and fail-closed policy for PHI reads before G2 (SEC-T07). | Architect | NFR-19 |
| SEC-R03 | Prefer **phishing-resistant MFA** for staff/pharmacy/prescribers; SMS OTP only as patient fallback. Needs product owner awareness since patient UX and cost (SMS) are affected. | Architect, PM | RULE-SEC-01 |
| SEC-R04 | Recommend **adopting** DEC-15 item 4 (clear PHI from screen on idle timeout), DEC-22 sensitive-action list, and DEC-19 (admins audit-only for patient data). | PM | DEC-15/19/22 |
| SEC-R05 | Add acceptance criteria (G2) for: cross-pharmacy denial, webhook forgery/replay rejection, audit write failure behaviour, proxy add step-up, upload quarantine, PHI-in-log scan. | PM, QA | §7 |
| SEC-R06 | Select **EPCS and e-prescribing vendor** with 21 CFR 1311 evidence (Q-SA-09); make vendor selection part of G2, since certification lead time (RISK-03) drives security design. | Architect | DEP-03 |
| SEC-R07 | Payments: architecture must keep card data out of scope (hosted fields). If R2 payments are deferred (DEC-01), keep out of R1 security scope. | Architect | DEC-01 |
| SEC-R08 | **Compliance inputs needed from the product owner:** operating states (DEC-06), 42 CFR Part 2 applicability (DEC-07, would require segmented consent and redisclosure controls), retention periods (DEC-21), named security/compliance reviewer with independence from build (all gates are held by one person, RISK-06). | PM → owner | DEC-06/07/21 |
| SEC-R09 | Hosting provider/region not chosen (C6): BAA, HIPAA-eligible services list and customer-managed keys must be checked at selection. | Architect | NFR-18 |
| SEC-R10 | Budget note: ASVS L3, pen test, WORM audit, EPCS/KMS/WAF costs compete with the US$150–300k build and US$5–15k/month run budgets (RISK-01, RISK-08). Do not trim security controls T01, T02, T06, T07 to meet budget; trim scope instead. | Architect, PM | RISK-01 |

## 6. Findings ledger (discovery)

No code or environment exists, so there are **no validated vulnerability findings**. Items above are design requirements, not defects. The ledger starts empty and the first findings will be raised against a fixed candidate revision in Stage 4.

## 7. Limitations and what was not done

- No scan, SAST, dependency audit, dynamic probing or pen test (nothing to scan; none authorised).
- Compliance conclusions (HIPAA, DEA, state law, 42 CFR Part 2) are design inputs, not legal advice or sign-off; state rules are blocked until states are named.
- Based on PRD-D1, which is itself a draft; Appendix A permissions marked Recommendation were treated as proposals.
- This document has not had independent review.

## 8. Next permitted action

Independent review of this revision (not by the author), then consolidation in INV-10 and Architect incorporation. Human gates unchanged: G1 and later remain with the product owner.
