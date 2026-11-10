# Discovery Security Assessment — EHR Platform

- Task: HEAAA-9 `[SDLC:discovery-security]` · Author: Cybersecurity agent · Date: 2026-11-04
- Source revision: intake pack revision 2 (commit `6ea01b5`, `docs/intake/01–07`)
- Type: **desk-based threat and control analysis. No scan, probe or penetration test was run; none is claimed.** There is no code, environment or target yet.
- Status: DRAFT for independent review. Review PASS is not human approval. Security assumptions go to the Solution Architect for incorporation into `ARCHITECTURE.md`; this document changes no approved trust model.

## 1. Decision: specialist security analysis is WARRANTED

| Trigger | Evidence in intake | Result |
| --- | --- | --- |
| Sensitive data | PHI for ~250k patients; possible 42 CFR Part 2 records; insurance/ID documents; card payments (R2) | Triggered |
| Tenancy/permissions | One org, 30+ clinics, location/assignment scoping; external pharmacy tenants; proxy/guardian access | Triggered |
| Payments | Stripe/Adyen, tokenised cards, refunds (R2) | Triggered |
| External exposure | Public brand site, public sign-up and booking forms, 6 internet-facing surfaces, pharmacy webhook API | Triggered |
| Integrations | ~15 vendors incl. e-prescribing network/EPCS, video, SMS, labs, calendar | Triggered |
| Consequence | Wrong-patient or wrong-medicine harm, controlled-substance diversion, HIPAA breach | Triggered |

All triggers fire, so the specialist lane is active. Basic security still applies to every deliverable regardless.

## 2. Assets and classification

| Class | Assets | Handling |
| --- | --- | --- |
| A — PHI, highest | Clinical notes, diagnoses, labs, medications, prescriptions, Part 2 records, ID documents | Encrypted, field/record-level access control, audit on every read |
| A+ — Regulated credentials | EPCS signing credentials/tokens, prescriber identity-proofing evidence, DEA numbers | Handled only by the certified EPCS vendor/module; never stored by us in custom code |
| B — PII/financial | Demographics, contacts, delivery address, insurance, payment tokens | Encrypted; card data never touches our systems (hosted fields/tokens, PCI SAQ A target) |
| C — Operational | Audit logs, config, integration secrets, keys | Integrity-protected; secrets in a managed secret store |
| D — Public | Brand-site content | CMS integrity only |

## 3. Trust boundaries (for the Architect)

- **TB1 Internet ↔ edge:** the brand site, the patient portal, the staff portals, the pharmacy portal, the webhook API and the video join. Everything outside is untrusted.
- **TB2 Patient ↔ staff ↔ pharmacy principals:** three identity populations with separate IdPs/realms: patients (managed CIAM), staff (Google Workspace SSO), pharmacy staff (own accounts with MFA).
- **TB3 Clinic/location scope inside the org:** staff see only assigned locations and patients.
- **TB4 Pharmacy tenant ↔ pharmacy tenant:** the pharmacy sees only prescriptions routed to its own pharmacy.
- **TB5 Platform ↔ third-party vendors:** BAA required, minimum data, signed or authenticated inbound messages.
- **TB6 App ↔ data/audit plane:** the app role cannot modify or delete audit records; admins cannot either.
- **TB7 Production ↔ non-production:** no real PHI outside production.
- **TB8 Public marketing/CMS ↔ PHI zone:** separate deployment and credentials; analytics sees no PHI.

## 4. Threats and required controls

Severity is inherent (before controls). IDs are stable (`SEC-D-nn`), tracked as discovery requirements, not findings against code.

| ID | Threat (STRIDE) | Sev | Required control | Rel |
| --- | --- | --- | --- | --- |
| SEC-D-01 | **Broken object-level/tenant authorization:** user reads another patient, location or pharmacy by changing an ID (IDOR) | Critical | Central deny-by-default policy enforcement on every API route, resolved server-side from the session. Row-level scoping by org/location/assignment/pharmacy in the data layer (e.g. Postgres RLS). Negative authorization tests for every role pair in the matrix. Non-guessable identifiers are not a control. | R1 |
| SEC-D-02 | **Proxy/guardian abuse:** stale or forged proxy relationship exposes a child's or adult's record; age transition leaks | High | Proxy grants are explicit, consented, time-bound and audited. Verification of the relationship. Automatic review at age thresholds. Sensitive categories can be restricted (minor confidentiality, Part 2). Separate proxy sessions that show whose record is open. | R1 |
| SEC-D-03 | **Account takeover** of patients (credential stuffing, SIM swap, OTP interception) | High | MFA offered and required for sensitive actions. Prefer passkeys/TOTP over SMS. Breached-password check, throttling, device/session management, notice on new device. Account recovery needs identity re-verification and never silently disables MFA. | R1 |
| SEC-D-04 | **Staff identity compromise / shared Google tenant risk:** a compromised Workspace account gives PHI access; Workspace admin becomes a super-admin by proxy | High | SSO only from the approved domain with enforced Google 2SV. App-side role mapping lives in the app, not in Google groups alone. Idle timeout, step-up for sensitive actions. Deprovisioning within one business day and a session kill-switch. Document the Workspace admin as a privileged principal with their own access review. | R1 |
| SEC-D-05 | **Insider snooping / VIP records** | High | Assignment-based access; break-the-glass needs a reason, alerts compliance, is reviewed in SLA. Proactive anomaly reports (volume, same-surname, co-worker lookups). Audit-view of audit logs is itself logged. | R1 |
| SEC-D-06 | **Audit tampering or gaps:** admin or attacker erases evidence; reads missing from log | High | Append-only store with write-once/object-lock retention, hash chaining or equivalent tamper evidence, separate account with no delete rights. Logs cover reads, exports and prints. Time-synced. Retention minimum six years (HIPAA documentation) unless Plan & Design sets longer. Audit export is itself audited. | R1 |
| SEC-D-07 | **PHI leakage via side channels:** logs, URLs, analytics, error trackers, SMS/email, calendar, OCR/AI vendors, CMS | High | Structured logging with allow-listed fields and redaction tests. No PHI in URLs or query strings. Analytics/error SDKs never loaded on authenticated pages unless a BAA covers them. Notifications and calendar carry no clinical content (agreed rule). Data-flow inventory maintained. | R1 |
| SEC-D-08 | **Uploaded-file attacks:** malware, polyglot files, SSRF/XXE via OCR or preview, path traversal, oversized files | High | Upload to quarantine, malware scan, type sniffing, size and count caps, re-encoding of images, no inline rendering of active content. Files in private storage, served by short-lived signed URLs after authorization. Documents are not available to anyone until the scan passes. | R1 |
| SEC-D-09 | **Webhook and API abuse (pharmacy status, SMS/email/payment/lab callbacks):** forged or replayed events change status, tracking links or results | High | Per-partner credentials with rotation. Signed requests (HMAC or mTLS) with timestamp and replay window. Idempotency keys. Schema validation. A partner can only update its own prescriptions. Rate limits. Tracking links are validated (HTTPS, allow-list/redirect interstitial) to stop phishing links shown to patients. | R2–R3 |
| SEC-D-10 | **EPCS compliance and diversion:** weak prescriber proofing, signing without two-factor, altered prescription after signing, pharmacy hand-over without ID | Critical | Use a DEA-certified EPCS solution/vendor (DoseSpot, DrFirst or similar) and do not build custom EPCS crypto. Identity proofing and two-person logical access control per DEA rules. Signed prescriptions immutable, with reissue as a new record. Application-level audit report required by DEA. Hand-over ID check recorded. Treat as ASVS Level 3. | R2 |
| SEC-D-11 | **Wrong-patient / wrong-medicine integrity attacks or errors** (security-relevant integrity) | High | Two-identifier patient confirmation on write paths; server-side validation of prescription content before the network call; interaction check failures block, never silently pass; tamper-evident clinical note signing. Clinical safety reviewer owns clinical rules. | R1–R2 |
| SEC-D-12 | **Payment fraud / PCI scope creep:** card testing on public forms, refund abuse, PAN stored accidentally | Medium–High | Processor-hosted fields or redirect so card data never touches our servers (SAQ A). Webhook signature checks. Bot protection and per-IP/per-account limits on payment endpoints. Refunds need staff permission and an audit trail, with dual control above a threshold. | R2 |
| SEC-D-13 | **Public-surface abuse:** bot booking floods, slot hoarding, enumeration of patients via sign-up/reset messages, scraping of the doctor directory, XSS in the CMS | Medium | CAPTCHA/bot management and rate limits. Generic responses on sign-up/reset to avoid account enumeration. Booking holds with expiry. CSP, output encoding, and a sanitising rich-text editor. CMS in a separate zone from PHI (TB8). WAF in front. | R1 |
| SEC-D-14 | **Telehealth exposure:** unauthorised join, link sharing, recording of PHI, vendor-side access | High | Per-visit, single-use, short-lived join tokens bound to the authenticated participant. Waiting room with clinician admit. Recording off by default. Vendor under BAA with E2E or encrypted transport. Participant list visible. | R1 |
| SEC-D-15 | **Third-party / supply chain:** vendor breach, malicious dependency, compromised CI | High | BAA register, with go-live blocked on a signed BAA per PHI vendor. Least-privilege vendor credentials in a secret manager. Lockfiles, SCA, secret and container scans in CI (already agreed). Pinned GitHub Actions by commit SHA, OIDC to cloud (no long-lived keys), protected branches, required reviews, signed artifacts. | R1 |
| SEC-D-16 | **Key and secret management failure:** secrets in repo, shared keys, no rotation | High | Managed KMS with envelope encryption and separate keys per environment, with rotation. Secret manager. Pre-commit and CI secret scanning. Credentials never in tickets or artifacts. Consider per-tenant or per-data-class keys for Part 2 data. | R1 |
| SEC-D-17 | **Availability attacks / ransomware:** DDoS, backup destruction | High | CDN/WAF/DDoS protection. Immutable cross-region backups under separate credentials. Restore tests on schedule. RPO/RTO as agreed (15 min / 4 h). Incident runbook with HIPAA breach-notification clock (60 days) and the DEA/vendor notification paths. | R1 |
| SEC-D-18 | **Data-subject and Cures Act actions misused:** export/deletion of another person's data; over-broad FHIR/SMART app grants | High | Re-verify identity before export or deletion. Delete/retention conflicts resolved by retention holds and legal rules (clinical records are usually not deletable). SMART on FHIR: scopes are minimal, patient-granted, revocable, apps registered and reviewed. Rate limits on the FHIR API. | R1–R3 |
| SEC-D-19 | **Admin-portal privilege abuse or misconfiguration:** role escalation, mass export, feature-flag misuse | High | Separate admin identity realm with step-up MFA. Role changes need a second approver for privileged roles. Admins can see audit data but not PHI by default. Export rate limits and alerts. Configuration changes audited. | R1 |
| SEC-D-20 | **Non-production data leakage:** developers or test environments carry real PHI | Medium | Synthetic data only (agreed). Prod credentials absent from non-prod. Production database access by break-glass with approval and logging. | R1 |
| SEC-D-21 | **Lab/result integration integrity:** result misattributed to patient, replay/duplicate, critical result silently dropped | High | Strict patient matching (multi-attribute, manual queue for ambiguity). Idempotent ingestion. Dead-letter queue visible in the ops dashboard. Critical-result escalation timer. Authenticated, encrypted transport (VPN/mTLS) with each lab or hub. | R3 |
| SEC-D-22 | **Calendar sync leaks or injects:** OAuth tokens stolen; events carry PHI; external edits alter bookings | Medium | Minimal OAuth scopes (free/busy where possible), tokens encrypted at rest, revocable. "Busy" only (agreed). Inbound calendar events are never trusted to create or change appointments without validation. | R1 |

## 5. Baseline security requirements (apply to every ticket regardless of lane)

1. ASVS L2 baseline; L3 on authentication, EPCS/prescribing, payment and authorization-policy code (agreed).
2. Deny-by-default authorization enforced server-side; tests for every endpoint's role and tenant boundary.
3. TLS 1.2+ (prefer 1.3), HSTS, encryption at rest, KMS keys, secrets only in a secret manager.
4. Secure session design: HttpOnly/Secure/SameSite cookies, CSRF protection, short idle timeouts on staff portals, rotation on privilege change.
5. Input validation, output encoding, parameterised queries, and security headers (CSP, frame-ancestors, referrer policy).
6. Audit events on view/create/change/export/print with append-only storage.
7. CI gates: SAST, SCA, secret scanning, container/IaC scanning, with blocking severity thresholds fixed in `DEVOPS-PLAN.md`.
8. Synthetic data only outside production; PHI-free logs verified by test.
9. Independent penetration test before each release adding external surface (agreed) — the first one before R1 production, plus another before R2 (EPCS) and before R3 (webhook API).
10. A threat model addendum for each new integration (BAA, data fields sent, auth method, failure behaviour).

## 6. Recommendations to the Architect (decisions needed)

| # | Item | Why it matters |
| --- | --- | --- |
| R-1 | Choose the data-layer isolation mechanism (e.g. Postgres RLS + policy engine) up front, not in a later release. | SEC-D-01/04 are cheap to design and expensive to retrofit. |
| R-2 | Keep patient, staff and pharmacy identity populations in separate realms with distinct policies. | TB2; different MFA and lifecycle rules. |
| R-3 | Specify audit storage design (immutable store, retention, separate account). | SEC-D-06; DEA EPCS also requires audit reporting. |
| R-4 | Choose the EPCS/e-prescribing vendor early (certification lead time), buy not build. | SEC-D-10; also a schedule risk. |
| R-5 | Decide the Part 2 question (do we hold substance-use records?) before G1, as it adds segmentation and consent-redisclosure controls. | Open intake item. |
| R-6 | Decide the cloud provider and region (C6 open) with a BAA; confirm the services used are all on its HIPAA-eligible list. | Every control above depends on it. |
| R-7 | Define the CMS/marketing zone separately from the PHI zone. | TB8. |
| R-8 | Name operating states, since state laws can add stricter privacy rules (e.g. minors, mental health, reproductive health data). | Affects SEC-D-02 and consent design. |

## 7. Budget and schedule notes

The agreed baseline items are costly in a US$150–300k build budget. Cheap items: authorization, audit, secrets and logging design. Costly items: the independent penetration tests (a typical external test is a five-figure sum each — estimate only, to be quoted), EPCS vendor fees, and SOC 2 readiness. The Architect/PM should size these at G1. I recommend not trimming SEC-D-01, -06, -07, -10 or the pen-test cadence. Trimming any of them is a human risk decision.

## 8. Items for PM via the Architect

- Add "authorization negative tests" and "PHI-free log verification" as acceptance criteria on every feature that touches PHI.
- Add proxy-access, break-the-glass and privacy-request flows to R1 acceptance (already in scope, high security impact).
- Add vendor BAA completion and pen-test completion as release-gate criteria.

## 9. Limitations and assumptions

- Desk analysis only; no tool, scan or dynamic test was executed. Nothing here is a verified or integrated result.
- Legal interpretations (HIPAA retention, breach-notification timing, DEA specifics, Part 2) are engineering guidance and need review by the human security/compliance owner or counsel.
- Cost figures are rough estimates, not quotes.
- Operating states, cloud provider, vendor selections, Part 2 applicability and language scope are open, so some controls may change.

## 10. Review state

- Independent review: **not yet performed.** Cumulative review rounds: 0 of 3.
- Next permitted action: independent reviewer inspects this exact revision; then Solution Architect incorporates the assumptions into `ARCHITECTURE.md`. No human gate is requested by this task.
