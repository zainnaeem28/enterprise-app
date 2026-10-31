# 05 — Security, Compliance and Quality Targets

> **Status: CONFIRMED** (AI-prepared 2026-10-31). Confirmed by: Zain Naeem (product owner) on 2026-10-31.
> Targets are starting proposals for the client and the human Architect to accept or change.

## 1. Compliance (depends on jurisdiction — see [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md))

| If operating in | Likely obligations |
| --- | --- |
| United States | HIPAA Privacy and Security Rules; Business Associate Agreements with vendors; patient access and information-blocking rules (21st Century Cures Act); DEA rules for electronic controlled-substance prescribing; state pharmacy and telehealth rules; 42 CFR Part 2 if substance-use treatment records are held |
| EU / UK | GDPR / UK GDPR (health data is special-category data); Data Protection Impact Assessment; data-processing agreements; national e-prescription and pharmacy rules; medical-device rules if any feature makes clinical decisions |
| Other countries | National health-data, pharmacy, telemedicine and data-residency laws, to be listed by the client's legal advisor |

The platform should also be ready for a **SOC 2 Type II** or **ISO 27001** audit, since enterprise healthcare customers usually ask for one.

## 2. Security requirements (proposed)

**Identity and access**
- MFA required for all staff; offered to patients and required for sensitive actions.
- Staff sign in through the organisation's SSO.
- Role-based access plus location and assignment rules: least privilege by default.
- Session timeout after ____ minutes idle on staff portals; re-authentication to sign prescriptions.
- Break-the-glass emergency access needs a reason, alerts compliance and is reviewed.

**Data protection**
- Encryption in transit (TLS 1.2+) and at rest, with keys in a managed key service and rotated.
- Health data kept out of logs, URLs, analytics, SMS and email bodies.
- Separate production data; tests use synthetic data, never real patients.
- Data residency in the region the client's law requires.

**Audit**
- An append-only audit trail of every view, create, change, export and print of patient data, with user, time, IP/device and reason where needed.
- Audit logs retained ____ years and protected from deletion by admins.

**Application security**
- OWASP ASVS Level 2 as the baseline; Level 3 for authentication, prescribing and payment paths.
- Static analysis, dependency and secret scanning, and container scanning in CI (GitHub Actions). Builds fail on blocking findings.
- An independent penetration test before each production release with new external surface.
- Rate limiting, bot protection on public forms, and file-upload scanning.

## 3. Reliability and recovery (proposed targets)

| Target | Proposed value |
| --- | --- |
| Availability (patient and doctor portals) | 99.9 % monthly |
| Recovery point objective (max data loss) | 15 minutes |
| Recovery time objective (max downtime after a disaster) | 4 hours |
| Backups | Automated, encrypted, cross-region copy, restore tested every ____ months |
| Deployments | Zero-downtime; rollback plan and database migration plan per release |
| Monitoring | Uptime, errors, latency, queue backlogs, integration failures, with on-call alerts |

## 4. Performance and scale (client to supply numbers)

| Item | Client value | Proposed design target |
| --- | --- | --- |
| Registered patients (year 1 / year 3) | ____ / ____ | — |
| Staff users | ____ | — |
| Clinics / pharmacies | ____ / ____ | — |
| Appointments per day (peak) | ____ | — |
| Prescriptions per day (peak) | ____ | — |
| Deliveries per day (peak) | ____ | — |
| Concurrent video visits (peak) | ____ | — |
| API response time | — | p95 under 500 ms for normal reads/writes |
| Page load | — | Largest Contentful Paint under 2.5 s on 4G |
| Slot search | — | p95 under 1 s across all locations |

## 5. Accessibility and usability

- **WCAG 2.2 AA** for all portals and the brand site.
- Works on current Chrome, Safari, Edge and Firefox, and on phones from 360 px width.
- Plain-language patient content; multilingual if required.

## 6. Quality gates (from the SDLC)

- Every feature has acceptance criteria and human-executable test cases before build (G2).
- Automated unit, integration and end-to-end tests run in GitHub Actions on every change.
- Patient-safety rules (allergies, interactions, critical results, wrong-patient prevention) get dedicated negative and boundary tests and an independent clinical review.
