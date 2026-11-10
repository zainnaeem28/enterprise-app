# NFR-19 hosting / BAA register (C-11)

Task HEAAA-669, G3 entry condition (owner ruling HEAAA-654 comment 280af633, decision-log D-1; not waived).
Candidate revision examined: `cdc388d2a348388a23ecef00305ecf0e34fa0aa4` (branch HEAAA-33). Date: 2026-11-10.
Author: Cybersecurity. Independent review: pending (Security Reviewer). This is **not** a PASS, a human approval or a G3 decision.

## Result: BLOCKED. No vendor has a signed BAA on record.

Method: read PRD NFR-19/DEP-3/DEP-4/D-30, ARCHITECTURE 7/8, DELIVERY-PLAN C-11/C-12, DEVOPS-PLAN, intake 04/05/07, SEC-04, the infra modules, and the worker adapters on the revision above. Searched the repository for a signed agreement, vendor selection record or BAA evidence link: **none exists**. Hosting (D-30) and the video/e-mail/SMS/push/OCR/malware vendors (C-10/C-11) are recorded as undecided, and the adapters are vendor-neutral by design (no network client ships). No vendor was contacted and no account was inspected; this task has no credentials or authority for that. Status words: **Unknown** = no record; **Unsigned** = candidate named, no agreement evidence; **N/A** = no PHI by design, with the control that keeps it so.

Rule applied: Unknown or Unsigned for any vendor that can receive PHI = blocker. Region and owner are the target or default, not a verified fact.

| ID | Vendor | Service | PHI exposure | BAA / agreement status | Region | Owner (to supply evidence) | Evidence link | Blocks G3 |
|---|---|---|---|---|---|---|---|---|
| V-01 | Cloud host: AWS (recommended, ADR-004; **not decided**, D-30) | Production account: ECS Fargate, RDS PostgreSQL, S3, KMS, Secrets Manager, CloudWatch, Backup, CloudFront/WAF/ALB, SNS, Lambda, ECR (`infra/modules/*`) | **Yes**: all PHI at rest and in transit | **Unknown**: provider undecided; no AWS Artifact BAA acceptance on record; per-service HIPAA-eligibility not verified | us-east-2 primary, us-west-2 recovery (recommended, unverified) | Owner (decision D-30, BAA acceptance); DevOps (eligibility check per service) | none | **Yes** |
| V-02 | Cloud host staging/tooling/log-archive accounts | Staging (synthetic), tooling (IaC state, CI), log archive | Staging: none (synthetic only). Tooling and log archive: audit logs and backups may hold PHI-adjacent data | **Unknown**: covered only if inside the same signed BAA/org boundary | as V-01 | Owner; DevOps | none | **Yes** for log archive and backup copies; staging only if real data is ever used |
| V-03 | Patient/partner identity: Amazon Cognito (recommended; **not decided**) | Two user pools, passkey/e-mail OTP | **Yes**: patient identifiers, e-mail, phone | **Unknown** (under V-01 BAA if AWS; Cognito eligibility not verified) | as V-01; replica Region unverified | Owner; Solution Architect | none | **Yes** |
| V-04 | Video vendor (not chosen; candidates Chime SDK, Zoom Video SDK, Daily, Vonage) | Telehealth video visits (BE-15) | **Yes**: live clinical session, participant IDs; recording off by default (SEC-D-14) | **Unknown**: no vendor chosen | not set; US required | Owner | none | **Yes** |
| V-05 | E-mail vendor (not chosen; SES, SendGrid, Postmark) | Transactional e-mail (BE-06) | **Yes** (recipient address and "log in" prompt; bodies PHI-free by template design) | **Unknown**: no vendor chosen | not set | Owner | none | **Yes** |
| V-06 | SMS vendor (not chosen; End User Messaging/SNS, Twilio, Vonage) | Reminders, OTP | **Yes** (phone number linked to a patient) | **Unknown**: no vendor chosen | not set | Owner | none | **Yes** |
| V-07 | Push provider (not chosen; Web Push, FCM) | Browser push | Limited: device token linked to patient; bodies PHI-free | **Unknown**: no vendor chosen; owner must rule whether a BAA is needed | not set | Owner; Cybersecurity (classification) | none | **Yes** until classified |
| V-08 | OCR vendor (not chosen; Textract, Azure, Google) | Scanned-document text (SEC-04) | **Yes**: document content | **Unknown**: no vendor chosen; SEC-04 also requires no-retention and no-training terms | not set | Owner | none | **Yes** if OCR ships in the release; else record "not in release" |
| V-09 | Malware scan (not chosen; GuardDuty malware protection) | Upload scanning | **Yes**: uploaded files | **Unknown** (V-01 BAA if AWS; eligibility unverified) | as V-01 | Owner; DevOps | none | **Yes** |
| V-10 | Google Workspace | Staff SSO (OIDC) | Staff identity only; no patient PHI | Agreement not recorded; PHI must not be sent | Google (US not asserted) | Owner | none | No, if the no-PHI control holds; owner to confirm in writing |
| V-11 | Google Calendar API | Doctor busy-time sync | None by design: "Busy" blocks only (BR-07) | Agreement not recorded; Google tenant is an owner condition | Google | Owner | none | No, if the no-PHI control holds; verify on real adapter |
| V-12 | GitHub (Actions, repo) | Source and CI | None: synthetic data only, no PHI in repo | N/A; control: gitleaks and no PHI in CI | GitHub | DevOps | `.github/workflows` | No |
| V-13 | CMS (self-hosted in marketing account, or SaaS; not decided) | Marketing content | None by design | N/A if no PHI; owner conditions pending | not set | Owner | none | No, if no-PHI holds |
| V-14 | E-prescribing, payments, labs, maps, e-signature, insurance | R2/R3/R4 | Yes for e-Rx and labs | Out of R1 scope; add to the register before those releases | n/a | Owner | n/a | No (not in this release) |

Vendors added by any later decision (for example an observability, error-tracking or analytics service) must be added here before use; ARCHITECTURE section 8 forbids such SDKs on PHI origins unless under a BAA.

## Blockers for the Orchestrator

| ID | Blocker | Needed from | Unblocks |
|---|---|---|---|
| NFR19-B1 | Owner decision on the hosting provider (D-30) and acceptance of that provider's BAA, with the acceptance record (for AWS: the AWS Artifact BAA acceptance for the organisation) | Owner | V-01..V-03, V-09 |
| NFR19-B2 | Per-service HIPAA-eligibility check for every service in `infra/modules/*` against the provider's current eligible-services list | DevOps, after B1 | V-01 |
| NFR19-B3 | Owner selection of video, e-mail, SMS, push, OCR vendors (C-11) and a signed BAA for each, or a recorded decision that the channel is out of this release | Owner | V-04..V-08 |
| NFR19-B4 | Written owner confirmation for V-10, V-11, V-13 that no PHI is sent, and agreements on file where required | Owner | V-10, V-11, V-13 |
| NFR19-B5 | Evidence: for each row, an agreement identifier, signed date, signatory, covered services/region and a stored copy or link, tied to the G3 candidate | Owner uploads; Cybersecurity verifies | all |

Credential and authority note: Cybersecurity cannot sign agreements, contact vendors, or inspect cloud accounts. No credentials were used.

## What is verified and what is not

- Verified: the repository contains no vendor selection record and no BAA evidence; the worker adapters ship no network client and name no vendor; `infra/modules` is AWS-only (aws_* resources), so V-01 describes the intended target.
- Not verified: provider eligibility, regions, any agreement status, and whether any account exists. Nothing is deployed (compensating controls: no production deployment, synthetic data only, no patient use).

## Next permitted action

Owner supplies B1, B3, B4 and B5 evidence. Cybersecurity then updates this register against the exact G3 candidate and an independent reviewer reviews it. G3 records CHANGES REQUIRED while any "Blocks G3 = Yes" row lacks evidence.
