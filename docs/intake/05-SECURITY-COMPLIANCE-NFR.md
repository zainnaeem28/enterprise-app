# 05 — Security, Compliance and Quality Targets

> **Status: CONFIRMED.** AI-prepared 2026-10-31. All sections Agreed by Zain Naeem (product owner) on 2026-10-31, and updated with his decisions of 2026-11-02 03:26 PKT (UTC+05:00) recorded in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md).
> The reliability, performance and accessibility targets below were **agreed** by the product owner on 2026-11-02 (07, D6).

## 1. Compliance (agreed: United States)

- HIPAA Privacy and Security Rules; Business Associate Agreements with every vendor that touches health data.
- Patient access and information-blocking rules (21st Century Cures Act), including timely release of results.
- DEA rules for electronic prescribing of controlled substances (EPCS): certified solution, prescriber identity proofing, two-factor signing, audit.
- State pharmacy and telehealth licensing rules for each operating state (states to be named before G1).
- 42 CFR Part 2 if substance-use treatment records are held.

The platform should also be ready for a **SOC 2 Type II** audit, since enterprise healthcare customers usually ask for one.

## 2. Security requirements (agreed)

**Identity and access**
- MFA required for all staff; offered to patients and required for sensitive actions.
- Staff sign in through Google Workspace SSO; partner pharmacy staff use their own accounts with MFA.
- Role-based access plus location and assignment rules: least privilege by default.
- Idle session timeout on staff portals (exact minutes set in Plan & Design); re-authentication to sign prescriptions, two-factor signing for EPCS.
- Break-the-glass emergency access needs a reason, alerts compliance and is reviewed.

**Data protection**
- Encryption in transit (TLS 1.2+) and at rest, with keys in a managed key service and rotated.
- Health data kept out of logs, URLs, analytics, SMS and email bodies.
- Separate production data; tests use synthetic data, never real patients.
- Data stored and processed in HIPAA-eligible US cloud regions under a signed BAA.

**Audit**
- An append-only audit trail of every view, create, change, export and print of patient data, with user, time, IP/device and reason where needed.
- Audit logs protected from deletion by admins and retained for the period set in Plan & Design (at least what HIPAA and DEA EPCS rules require).

**Application security**
- OWASP ASVS Level 2 as the baseline; Level 3 for authentication, prescribing and payment paths.
- Static analysis, dependency and secret scanning, and container scanning in CI (GitHub Actions). Builds fail on blocking findings.
- An independent penetration test before each production release with new external surface.
- Rate limiting, bot protection on public forms, and file-upload scanning.

## 3. Reliability and recovery (agreed targets)

| Target | Agreed value |
| --- | --- |
| Availability (patient and doctor portals) | 99.9 % monthly |
| Recovery point objective (max data loss) | 15 minutes |
| Recovery time objective (max downtime after a disaster) | 4 hours |
| Backups | Automated, encrypted, cross-region copy; restore test schedule set in Plan & Design |
| Deployments | Zero-downtime; rollback plan and database migration plan per release |
| Monitoring | Uptime, errors, latency, queue backlogs, integration failures, with on-call alerts |

## 4. Performance and scale (agreed 2026-11-02: design for large scale at launch)

| Item | Agreed value |
| --- | --- |
| Registered patients (year 1) | ~250,000 (3-year growth: open) |
| Staff users | ~1,000 |
| Clinics | 30+ (number of partner pharmacies: open) |
| Appointments per day (peak) | ~8,000 |
| Prescriptions per day (peak) | ~4,000 |
| Pharmacy deliveries per day (peak, pharmacy-reported status) | ~1,500 |
| Concurrent video visits (peak) | ~250 |
| API response time | p95 under 500 ms for normal reads/writes |
| Page load | Largest Contentful Paint under 2.5 s on 4G |
| Slot search | p95 under 1 s across all locations |

## 5. Accessibility and usability

- **WCAG 2.2 AA** for all portals and the brand site.
- Works on current Chrome, Safari, Edge and Firefox, and on phones from 360 px width.
- Plain-language patient content; multilingual if required.

## 6. Quality gates (from the SDLC)

- Every feature has acceptance criteria and human-executable test cases before build (G2).
- Automated unit, integration and end-to-end tests run in GitHub Actions on every change.
- Patient-safety rules (allergies, interactions, critical results, wrong-patient prevention) get dedicated negative and boundary tests and an independent clinical review.
