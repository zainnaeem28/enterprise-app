# TICKETS — Enterprise EHR Platform, Release 1 (Stage 2, post-alignment)

| Field | Value |
| --- | --- |
| Task | HEAAA-18 `[SDLC:delivery-plan]` |
| Author | Delivery Planner `452babff` |
| Date | 2026-11-05 |
| Version | **Draft 3 (corrects SA-DP-01..09; changed content needs re-review). Not human-approved. These are NOT approved G2 scope until a human G2 decision on the exact revisions.** Every ticket is blocked on G2 and nothing here authorises any work before it. |
| Source and design revisions | The manifest in `DELIVERY-PLAN.md` section 2 (PRD rev `bba336f3`, ARCHITECTURE rev `b276930a`, UI-UX rev `1fd76f7e`, BRAND-BRIEF rev `eb5307f6`, mockup manifest rev `a0488c46`, TEST-CASES rev `4ecc71c0`, DEVOPS-PLAN rev `3023afa1`, SHARED-BOUNDARIES rev `0fffc85d`, alignment manifest rev `ea043d8d`) |
| Native records | 83 Paperclip child tickets; the Paperclip task is canonical, this file is its readable copy. Identifier column below. |

## 1. How to read a ticket

Stable ID (`F-`, `BE-`, `FE-`, `DO-`, `SEC-`, `INT-`, `QA-`, plus `ID-FREEZE`); never reused. Each ticket states: release, milestone, size, one owner, ordered independent reviewer stages, conditions (DELIVERY-PLAN section 4), requirement rows, source sections of the frozen revisions, technical prerequisites, gate prerequisites, scheduling prerequisites, allowed write paths, observable acceptance, required checks. **Tickets that cite a condition carry it or are held; none is marked Ready on the assumption that the condition is resolved.** Status at creation is `blocked` (waiting for prerequisites that Paperclip starts automatically) or `backlog` (held for an Orchestrator decision).

Sizes: S=1, M=2, L=3, XL=5 relative effort points. They are estimates, not commitments, and carry no dates.

## 2. Index

| ID | Paperclip | Title | Parent | Owner | Reviewers | Size | MS | Technical prerequisites | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | HEAAA-65 | Cybersecurity review of identity, trust-boundary and secret-handling design (SEC-1..3, O-2, O-5) | HEAAA-25 | Cybersecurity | Security Reviewer | M | M0 | — | Backlog |
| ID-FREEZE | HEAAA-66 | Architecture erratum 8.2: freeze identity tables and fold carried notes (docs only) | HEAAA-25 | Solution Architect | Solution Architect Reviewer | S | M0 | SEC-01, F-00 | Blocked |
| F-00 | HEAAA-64 | Commit the approved design documents to the repository (byte-identical, with hash manifest) | HEAAA-20 | DevOps Engineer | DevOps Reviewer | S | M1 | G2 | Blocked |
| F-01 | HEAAA-67 | Repository scaffold, pinned toolchain and frozen-lockfile install | HEAAA-20 | DevOps Engineer | DevOps Reviewer → Backend Reviewer | M | M1 | F-00 | Blocked |
| F-02 | HEAAA-68 | Pull-request CI pipeline: required checks, SHA-pinned actions, least-privilege permissions | HEAAA-20 | DevOps Engineer | DevOps Reviewer → Backend Reviewer | L | M1 | F-01 | Blocked |
| F-03 | HEAAA-69 | Database foundation: PostgreSQL 17 roles, grants, kernel schema, migration runner and rules | HEAAA-20 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M1 | F-01 | Blocked |
| F-04 | HEAAA-72 | Kernel library: transaction and scope setter, idempotency, outbox/queue, config, redacting logger, error mapping | HEAAA-20 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M1 | F-03 | Blocked |
| F-08 | HEAAA-71 | Transcribe the R1 API catalogue to OpenAPI 3.1 and generate shared types | HEAAA-20 | Backend Engineer | Backend Reviewer → Solution Architect | XL | M1 | F-01 | Blocked |
| F-05 | HEAAA-74 | API and worker platform layer: app shell, guard hook, release-contract check, limits, health | HEAAA-20 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M1 | F-04, F-08 | Blocked |
| F-06 | HEAAA-73 | Frontend slice: staff app shell calling the API same-origin through generated types | HEAAA-20 | Frontend Engineer | Frontend Reviewer | M | M1 | F-01, F-08 | Blocked |
| F-09 | HEAAA-79 | CI jobs that need application code: integration-db, migration-check, contract, a11y smoke, e2e smoke, bundle budget | HEAAA-20 | DevOps Engineer | DevOps Reviewer → Backend Reviewer | M | M1 | F-02, F-03, F-05, F-06, F-08 | Blocked |
| F-07 | HEAAA-81 | Foundation proof: clean frozen install, production builds, container image, UI-API-database journey on CI | HEAAA-20 | DevOps Engineer | DevOps Reviewer → Backend Reviewer | M | M1 | F-09, F-05, F-06 | Blocked |
| BE-01 | HEAAA-76 | audit module: append-only events, anchors, BTG grants, denial path, export job | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M2 | F-05 | Blocked |
| BE-02 | HEAAA-80 | integration-core: vendor call wrapper, inbound log and dispatch, circuit state, write-only secret references | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M2 | BE-01 | Blocked |
| BE-03 | HEAAA-78 | organisation: configuration data model, settings, directory views and `directory_ro` role | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | XL | M2 | BE-01 | Blocked |
| BE-04 | HEAAA-82 | identity core: staff (Google) and patient realms, sessions, roles, scope builder, authorization guard | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | XL | M2 | BE-01, BE-02, BE-03, ID-FREEZE | Blocked |
| BE-05 | HEAAA-104 | identity admin realm: API-run WebAuthn, elevation, enrolment, second-approver role changes, kill switch | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | XL | M5 | BE-04, SEC-01, ID-FREEZE | Blocked |
| BE-06 | HEAAA-84 | notifications core: PHI-free templates, send and dedupe, preferences, receipts, recipient resolution | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M2 | BE-04, BE-02 | Blocked |
| BE-07 | HEAAA-98 | staff alerts: durable alerts, escalation timers, SSE stream, acknowledge | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M3 | BE-06, BE-04 | Blocked |
| BE-08 | HEAAA-86 | patient core: registration, matching, care relationships, `staff_scope`, consents, preferences, proxy-grant use | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | XL | M3 | BE-04, BE-06, BE-03 | Blocked |
| BE-09 | HEAAA-88 | patient merge: request, approval, execute job, participant registry, write guards | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M3 | BE-08 | Blocked |
| BE-10 | HEAAA-92 | documents: pre-signed upload, scan, OCR suggestion, classification, legal holds, export part | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M3 | BE-08, BE-09, BE-02 | Blocked |
| BE-11 | HEAAA-90 | scheduling core: occupancy, holds, confirm, cancel, reschedule, overlap rule | HEAAA-23 | Backend Engineer | Backend Reviewer | XL | M3 | BE-08, BE-09, BE-03, BE-06 | Blocked |
| BE-12 | HEAAA-94 | scheduling availability: templates, leave, blocked time, roster, slot search | HEAAA-23 | Backend Engineer | Backend Reviewer | L | M3 | BE-11 | Blocked |
| BE-13 | HEAAA-100 | scheduling flow: check-in, queue, arrivals, no-show, waitlist offers, pre-visit send | HEAAA-23 | Backend Engineer | Backend Reviewer | L | M3 | BE-12, BE-06 | Blocked |
| BE-14 | HEAAA-106 | calendar-sync: Google busy-only two-way sync | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M3 | BE-12, BE-02 | Blocked |
| BE-15 | HEAAA-112 | telehealth: sessions, join tokens, device check, licensing check | HEAAA-23 | Backend Engineer | Backend Reviewer | M | M3 | BE-11, BE-02, BE-03 | Blocked |
| BE-16 | HEAAA-96 | clinical chart: problems, allergies, medications (coded), vitals and ranges, banner and chart summary | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | XL | M4 | BE-08, BE-09, BE-10, BE-11 | Blocked |
| BE-17 | HEAAA-108 | clinical notes: encounters, SOAP notes, sign and lock, addenda, co-sign | HEAAA-23 | Backend Engineer | Backend Reviewer | L | M4 | BE-16 | Blocked |
| BE-18 | HEAAA-102 | clinical front-door: questionnaires, consents gate, vitals, triage, red-flag rule, referrals and follow-ups | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | XL | M4 | BE-16, BE-07, BE-13 | Blocked |
| BE-19 | HEAAA-116 | messaging: staff threads and tasks (patient messaging behind flag D-5) | HEAAA-23 | Backend Engineer | Backend Reviewer | M | M4 | BE-08, BE-06, BE-09 | Blocked |
| BE-20 | HEAAA-110 | privacy: requests, export assembly, legal-hold checks, incident register | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M4 | BE-10, BE-16, BE-09 | Blocked |
| BE-21 | HEAAA-130 | reporting: operations read models and dashboard feed | HEAAA-23 | Backend Engineer | Backend Reviewer | M | M4 | BE-02, BE-06, BE-11 | Blocked |
| BE-22 | HEAAA-114 | integrations host and public directory routes | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | M | M3 | BE-02, BE-03, BE-12, BE-14, BE-06 | Blocked |
| BE-23 | HEAAA-118 | admin API: organisation configuration routes | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M5 | BE-03, BE-05 | Blocked |
| BE-24 | HEAAA-120 | admin API: users and roles, audit viewer and export, BTG review, privacy decisions, integration settings | HEAAA-23 | Backend Engineer | Backend Reviewer → Security Reviewer | L | M5 | BE-05, BE-01, BE-20, BE-02 | Blocked |
| FE-01 | HEAAA-75 | Design system: tokens, shared components, accessibility tests | HEAAA-22 | Frontend Engineer | Frontend Reviewer → UI/UX Designer | L | M2 | F-06 | Blocked |
| FE-02 | HEAAA-77 | App shell: API client, session and realm handling, idle warning, release prompts, error pages | HEAAA-22 | Frontend Engineer | Frontend Reviewer | L | M2 | FE-01, F-08 | Blocked |
| FE-03 | HEAAA-91 | Patient portal: sign-up, verification, passkey/MFA, sign-in | HEAAA-22 | Frontend Engineer | Frontend Reviewer | M | M3 | FE-02, BE-04 | Blocked |
| FE-04 | HEAAA-107 | Patient portal: book, reschedule, cancel, waitlist | HEAAA-22 | Frontend Engineer | Frontend Reviewer → UI/UX Designer | L | M3 | FE-03, BE-12 | Blocked |
| FE-05 | HEAAA-127 | Patient portal: profile, proxies, notification preferences, privacy, messages (flagged) | HEAAA-22 | Frontend Engineer | Frontend Reviewer | L | M4 | FE-03, BE-08, BE-20 | Blocked |
| FE-06 | HEAAA-105 | Shared documents UI: upload with scan state, classification, list and viewer | HEAAA-22 | Frontend Engineer | Frontend Reviewer | M | M4 | FE-02, BE-10 | Blocked |
| FE-07 | HEAAA-128 | Patient portal: pre-visit forms, consents, insurance upload, waiting room, device check and join | HEAAA-22 | Frontend Engineer | Frontend Reviewer → UI/UX Designer | L | M4 | FE-04, FE-06, BE-18, BE-15 | Blocked |
| FE-08 | HEAAA-93 | Staff portal: Google sign-in, session shell, role navigation | HEAAA-22 | Frontend Engineer | Frontend Reviewer | M | M4 | FE-02, BE-04 | Blocked |
| FE-17 | HEAAA-121 | Staff portal: administrator sign-in, security-key elevation dialog, realm banner and realm switch | HEAAA-22 | Frontend Engineer | Frontend Reviewer → UI/UX Designer | M | M5 | FE-08, BE-05 | Blocked |
| FE-09 | HEAAA-119 | Pre-consultation desk: arrivals board, check-in, forms review, triage panel, red-flag bar, queues, duplicate and merge | HEAAA-22 | Frontend Engineer | Frontend Reviewer → UI/UX Designer | XL | M4 | FE-08, FE-06, BE-18, BE-09, BE-13 | Blocked |
| FE-10 | HEAAA-125 | Doctor portal: schedule, patient list, chart summary, note editor, sign, addenda, co-sign, alert tray, BTG dialog | HEAAA-22 | Frontend Engineer | Frontend Reviewer → UI/UX Designer | XL | M4 | FE-08, FE-06, BE-17, BE-18, BE-07 | Blocked |
| FE-11 | HEAAA-123 | Doctor portal: availability templates, leave and blocked time, Google Calendar connection | HEAAA-22 | Frontend Engineer | Frontend Reviewer | M | M4 | FE-08, BE-12, BE-14 | Blocked |
| FE-12 | HEAAA-131 | Staff tasks and secure messages | HEAAA-22 | Frontend Engineer | Frontend Reviewer | M | M4 | FE-08, BE-19 | Blocked |
| FE-13 | HEAAA-132 | Admin portal: audit log, BTG review, users and roles with approvals, privacy requests | HEAAA-22 | Frontend Engineer | Frontend Reviewer → UI/UX Designer | L | M5 | FE-17, BE-24 | Blocked |
| FE-14 | HEAAA-134 | Admin portal: clinics, services, policies, templates, integrations, flags, banners, vital ranges | HEAAA-22 | Frontend Engineer | Frontend Reviewer | L | M5 | FE-17, BE-23 | Blocked |
| FE-15 | HEAAA-129 | Brand site: pages, directory, booking hand-off, SEO, cookie consent | HEAAA-22 | Frontend Engineer | Frontend Reviewer | L | M4 | FE-01, BE-22 | Blocked |
| FE-16 | HEAAA-136 | CMS configuration: editor, marketing sign-in, branding of login and preview | HEAAA-22 | Frontend Engineer | Frontend Reviewer | M | M4 | FE-15 | Backlog |
| DO-01 | HEAAA-83 | IaC baseline: state backend, accounts and OU structure files, network, KMS | HEAAA-24 | DevOps Engineer | DevOps Reviewer → Security Reviewer | L | M5 | F-07 | Blocked |
| DO-02 | HEAAA-99 | IaC data tier: RDS PostgreSQL 17 Multi-AZ, buckets, audit archive, backup vault, cross-region copy | HEAAA-24 | DevOps Engineer | DevOps Reviewer → Security Reviewer | L | M5 | DO-01, F-03 | Blocked |
| DO-03 | HEAAA-85 | IaC compute and edge: ECS Fargate services, ALB, CloudFront and WAF, portal hosts | HEAAA-24 | DevOps Engineer | DevOps Reviewer | L | M5 | DO-01, F-05 | Blocked |
| DO-04 | HEAAA-87 | IaC identity, secrets and CI trust: Cognito pools, secret store, OIDC roles denied by default, approval-by-apply | HEAAA-24 | DevOps Engineer | DevOps Reviewer → Security Reviewer | L | M5 | DO-01 | Blocked |
| DO-05 | HEAAA-89 | build-release workflow: build once, sign, SBOM, provenance, release manifest and release numbering | HEAAA-24 | DevOps Engineer | DevOps Reviewer | L | M5 | F-07, F-09 | Blocked |
| DO-06 | HEAAA-97 | Deploy workflows (authored, disabled): staging, production, marketing; migration task; smoke and observation jobs | HEAAA-24 | DevOps Engineer | DevOps Reviewer → Security Reviewer | XL | M5 | DO-05, DO-03, DO-04 | Blocked |
| DO-07 | HEAAA-103 | Observability as code: telemetry, dashboards, alarms, synthetic checks, PHI scrubbing | HEAAA-24 | DevOps Engineer | DevOps Reviewer | L | M5 | DO-03, F-05 | Blocked |
| DO-08 | HEAAA-111 | Backup, restore and DR automation: restore-test workflow, PITR procedure, DR rehearsal stack | HEAAA-24 | DevOps Engineer | DevOps Reviewer | L | M6 | DO-02, DO-06 | Blocked |
| DO-09 | HEAAA-113 | Operational workflows: infra, nightly, dependency updates | HEAAA-24 | DevOps Engineer | DevOps Reviewer | M | M6 | DO-04, DO-06 | Blocked |
| DO-10 | HEAAA-138 | Dual-control workflows: audit archive and first-admin bootstrap | HEAAA-24 | DevOps Engineer | DevOps Reviewer → Security Reviewer | M | M6 | DO-04, BE-05, BE-01 | Blocked |
| DO-11 | HEAAA-117 | Load-test environment and k6 harness plumbing | HEAAA-24 | DevOps Engineer | DevOps Reviewer | L | M6 | DO-02, DO-03, F-09 | Backlog |
| SEC-02 | HEAAA-135 | Security assessment: identity, sessions, admin realm and secrets (code review) | HEAAA-25 | Cybersecurity | Security Reviewer | M | M5 | BE-05, BE-02 | Blocked |
| SEC-03 | HEAAA-101 | Security assessment: RLS, scope, merge and patient-data isolation (code and SQL review) | HEAAA-25 | Cybersecurity | Security Reviewer | M | M3 | BE-09, BE-11 | Blocked |
| SEC-04 | HEAAA-122 | Security assessment: documents, notifications and PHI-in-output controls | HEAAA-25 | Cybersecurity | Security Reviewer | M | M3 | BE-10, BE-06, BE-14 | Blocked |
| SEC-05 | HEAAA-137 | Security assessment: alerts, audit, BTG and stream authorization | HEAAA-25 | Cybersecurity | Security Reviewer | M | M5 | BE-07, BE-01, BE-24 | Blocked |
| SEC-06 | HEAAA-115 | Security assessment: IaC, CI trust and release controls | HEAAA-25 | Cybersecurity | Security Reviewer | M | M6 | DO-04, DO-06 | Blocked |
| SEC-07 | HEAAA-142 | Pre-candidate security assessment: scan results, residual risk and penetration-test scope | HEAAA-25 | Cybersecurity | Security Reviewer | M | M6 | INT-05 | Blocked |
| SEC-08 | HEAAA-126 | Security assessment: clinical access, banner allergies, break-the-glass and the red-flag alert path | HEAAA-25 | Cybersecurity | Security Reviewer | M | M4 | BE-16, BE-18, BE-07 | Blocked |
| INT-01 | HEAAA-95 | Integrate M2 platform: audit, integration-core, organisation, identity core, notifications; first real authentication slice | HEAAA-26 | Integrator | QA Engineer | M | M2 | BE-01, BE-02, BE-03, BE-04, BE-06, FE-02, F-09 | Blocked |
| INT-02 | HEAAA-124 | Integrate M3 booking slice: patient, merge, scheduling, calendar, telehealth, documents, patient booking UI, brand site shell | HEAAA-26 | Integrator | QA Engineer | L | M3 | INT-01, BE-07, BE-08, BE-09, BE-10, BE-11, BE-12, BE-13, BE-14, BE-15, BE-22, FE-03, FE-04, SEC-03, SEC-04 | Blocked |
| INT-03 | HEAAA-133 | Integrate M4 clinical and front desk: clinical, messaging, privacy, reporting, staff and patient portals, brand site | HEAAA-26 | Integrator | QA Engineer | L | M4 | INT-02, SEC-08, BE-16, BE-17, BE-18, BE-19, BE-20, BE-21, FE-05, FE-06, FE-07, FE-09, FE-10, FE-11, FE-12, FE-15 | Blocked |
| INT-04 | HEAAA-139 | Integrate M5 administration and controls: admin realm, admin API and portal, IaC and pipelines authored so far | HEAAA-26 | Integrator | QA Engineer | M | M5 | INT-03, BE-05, BE-23, BE-24, FE-17, FE-13, FE-14, SEC-02, SEC-05, DO-05, DO-06, DO-07 | Blocked |
| INT-05 | HEAAA-141 | Integrate R1 release candidate and run the complete combined check set | HEAAA-26 | Integrator | QA Engineer | M | M6 | INT-04, FE-16, DO-08, DO-09, DO-10, SEC-06 | Blocked |
| QA-01 | HEAAA-70 | Test errata revision: TC-API duplicate ID, TC-AU-04 step 2, POR-02..04, SA-TC-07..10 (document only) | HEAAA-29 | QA Engineer | Solution Architect Reviewer → Product Owner Reviewer | S | M1 | F-00 | Blocked |
| QA-02 | HEAAA-109 | Automation harness: Playwright, Schemathesis, synthetic data generators, test accounts for `ENV-INT/ci` | HEAAA-29 | QA Engineer | Frontend Reviewer → Backend Reviewer | L | M3 | INT-01, QA-01 | Backlog |
| QA-03 | HEAAA-144 | Automated cases: identity, authorization and security (TC-ID, TC-AZ, TC-SEC, TC-SEC-C7) | HEAAA-29 | QA Engineer | Backend Reviewer | L | M5 | QA-02, INT-04 | Backlog |
| QA-04 | HEAAA-140 | Automated cases: booking, calendar, notifications, pre-consultation, safety mechanics, clinical | HEAAA-29 | QA Engineer | Backend Reviewer → Frontend Reviewer | XL | M4 | QA-02, INT-03 | Backlog |
| QA-05 | HEAAA-143 | Automated cases: telehealth, audit, documents, privacy, admin, brand site, messaging, merge, API conventions | HEAAA-29 | QA Engineer | Backend Reviewer → Frontend Reviewer | XL | M5 | QA-02, INT-04 | Backlog |
| QA-06 | HEAAA-145 | Automated accessibility and browser matrix (TC-A11Y, TC-XB automated parts) | HEAAA-29 | QA Engineer | Frontend Reviewer | M | M5 | QA-02, INT-04 | Backlog |
| QA-07 | HEAAA-146 | Load, resilience and recovery scripts (TC-PERF, TC-REC automated parts) | HEAAA-29 | QA Engineer | Backend Reviewer | M | M6 | QA-02, DO-11 | Backlog |

## 3. Common checks and definition of done (apply to every ticket)

- Frozen-lockfile install on a clean checkout; lint and type check; unit tests; the integration tests of the ticket's module on PostgreSQL 17 where it touches data; secret scan; dependency scan; SAST; container scan where an image exists. No skipped or empty suite; a missing, malformed or wrong-revision report fails the check.
- No PHI or synthetic-PHI canary in logs, URLs, object keys, telemetry or analytics payloads.
- Every new route declares a permission (route inventory check); every new table has `FORCE ROW LEVEL SECURITY` and role-targeted policies; no migration contains DML; every job type that carries patient IDs declares `on_merged`.
- Evidence comment on submission: candidate commit, tool versions, commands, links to raw reports, results, limitations, conditions touched. "Done" in Paperclip means execution finished and submitted, not reviewed, integrated, approved or deployed.
- Dependencies added are listed with licence and reason; credentials never appear in code, tests, evidence or screenshots.

## 4. Shared-path and contract rules

See `DELIVERY-PLAN.md` section 9. In short: one owner for the lockfile, migrations (one numbered range per ticket, listed in each card), contracts (frozen after F-08), CI and infrastructure; a ticket never edits outside its allowed paths; a needed change elsewhere is a request through the Orchestrator.

## 5. Review ledger and correction ticket templates

`review-ledger` document on each ticket (created by the owner at first submission):

```
ticket: <ID>   candidate revision: <commit/digest>   cumulative consolidated rounds: <n of 3>
findings: <ID | severity | source reviewer/tool | revision | evidence | requirement/contract | owner | disposition>
logical state: Ready | In Progress | Review | Changes Required | Verified | Integrated | Done   (native status is separate)
```

Correction ticket `COR-<finding ID>`: same lane master as the repaired ticket; owner and reviewer per the same rules; prerequisites are its own, never the repaired ticket; the repaired ticket and its consumers are blocked by it; acceptance names the finding, the failing reproduction and the rerun checks; the cumulative ledger of the parent continues (no reset).

## 6. Tickets

### Foundation lane (HEAAA-20)

#### F-00 — Commit the approved design documents to the repository (byte-identical, with hash manifest)  (HEAAA-64)

**Ticket F-00** · release R1 · milestone M1 · size S (1 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) |
| Conditions | C-13 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: G2-approved revisions in docs/MANIFEST (DELIVERY-PLAN section 2); DEVOPS-PLAN 4.3 (`docs/`), CODEOWNERS rule.

**Technical prerequisites.** none

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/SHARED-BOUNDARIES.md`
- `docs/UI-UX.md`
- `docs/BRAND-BRIEF.md`
- `docs/TEST-CASES.md`
- `docs/DEVOPS-PLAN.md`
- `docs/DELIVERY-PLAN.md`
- `docs/TICKETS.md`
- `docs/QUALITY-RELEASE-PLAN.md`
- `docs/design/mockups/**`
- `docs/MANIFEST.sha256`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Each file equals the approved Paperclip document revision named in MANIFEST (sha256 shown, command and result recorded).
- Mockup PNGs and SVG sources carry the hashes of the mockup manifest rev `a0488c46`.
- Nothing but `docs/` is touched. No application, test, migration, configuration or CI file.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- sha256sum -c docs/MANIFEST.sha256
- git diff --stat shows only docs/
- Common checks of TICKETS.md section 3 also apply.


#### F-01 — Repository scaffold, pinned toolchain and frozen-lockfile install  (HEAAA-67)

**Ticket F-01** · release R1 · milestone M1 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Backend Reviewer (`472e0e86`) |
| Conditions | C-13, C-22 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 4.3, 5.1; ARCHITECTURE 7 (language, framework, front ends); PRD NFR-15.

**Technical prerequisites.** HEAAA-64 (`F-00`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `package.json`
- `<lockfile>`
- `tsconfig.base.json`
- `.nvmrc`
- `.editorconfig`
- `eslint/prettier configs`
- `apps/*/package.json (stubs)`
- `packages/*/package.json (stubs)`
- `.github/CODEOWNERS`
- `README.md (developer section)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- One lockfile at the root, committed; clean `--frozen-lockfile` install works on a clean checkout; node and package-manager versions pinned.
- Workspace layout `apps/{api,worker,site,cms,patient,staff}`, `packages/{contracts,kernel,ui,app-shell}`, `db/migrations`, `infra`, `.github`, `docs` exists with compiling stubs. `pharmacy` is not scaffolded (R2).
- Import-boundary lint rule (ARCHITECTURE 4, BD-02) is present with a failing fixture proving it rejects an upward import.
- The versions chosen are written to `docs/DEPENDENCIES.md` with licence and the reason; the k6 AGPL decision (C-22) is not assumed.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Frozen install on a clean checkout (log kept)
- lint, tsc, build of every stub
- import-boundary failing fixture
- Common checks of TICKETS.md section 3 also apply.


#### F-02 — Pull-request CI pipeline: required checks, SHA-pinned actions, least-privilege permissions  (HEAAA-68)

**Ticket F-02** · release R1 · milestone M1 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Backend Reviewer (`472e0e86`) |
| Conditions | C-13 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 4.1, 4.2 (`ci.yml`), 5.1, 14; NFR-15.

**Technical prerequisites.** HEAAA-67 (`F-01`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-66 (`ID-FREEZE`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `.github/workflows/ci.yml`
- `.github/ACTIONS-ALLOWLIST.md`
- `.github/dependabot.yml`
- `scripts/ci/**`
- `semgrep/gitleaks/OSV/Trivy/Syft configs`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `ci.yml` runs lint-types, unit, build, SAST (Semgrep CE, pinned ruleset), secret scan, dependency scan, container scan, SBOM and workflow hygiene (actionlint plus a script that fails any `uses:` that is not a 40-character SHA or not on the allow-list; `permissions` declared).
- No `continue-on-error`, no `|| true`; an empty or skipped suite fails; reports are uploaded as artifacts. No cloud credentials exist on pull requests.
- The GitHub plan, ruleset, required-check and environment-protection state actually found is recorded (DEVOPS-PLAN 4.1). Where the plan does not enforce a control, the ticket says "procedural only".
- Jobs that need application code (integration-db, migration-check, contract, a11y smoke, e2e smoke, bundle budget) are listed as pending in F-09 and are NOT reported as passing.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Workflow run on a branch, links to artifacts
- a seeded failing change for each job proves the job fails the workflow
- actionlint
- Common checks of TICKETS.md section 3 also apply.


#### F-03 — Database foundation: PostgreSQL 17 roles, grants, kernel schema, migration runner and rules  (HEAAA-69)

**Ticket F-03** · release R1 · milestone M1 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-15 |
| Requirements / rows | NFR-5, NFR-12, NFR-13 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 21.1, 21.2, 21.7, 22.1; SHARED-BOUNDARIES 4.1, 6.2 (M-1..M-5), BD-03; DEVOPS-PLAN 5.2.

**Technical prerequisites.** HEAAA-67 (`F-01`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `db/migrations/0001-0099_*`
- `db/roles/**`
- `db/tools/** (runner, DML ban)`
- `packages/kernel/src/db/migrate/**`
- `docker/compose.ci.yml (PostgreSQL 17 service)`
- Migration numbers reserved for this ticket: `0001`-`0099` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- All roles of 21.2 exist after migrations from empty: `app_owner`, `app_api`, `app_worker`, `reporting_ro`, `audit_archiver`, the `NOLOGIN` function-owner roles, `identity_signin_ro`, `directory_ro` (with the 8.1 `SET`-only `app_owner` membership). No application role has BYPASSRLS or owns a table.
- `kernel` schema (4 tables of 22.1) with `FORCE ROW LEVEL SECURITY`; role-level `transaction_timeout = 60s` on every audit-writing role.
- The runner rejects an out-of-order version (a migration numbered below one already applied) instead of applying it silently; a fixture proves it. Migrations are DDL only: a migration file containing DML fails the runner (SBR-17). Expand/contract rule fixtures exist (DEVOPS-PLAN 8.1).
- Spike-style checks of 38.1 that a single PostgreSQL 17 container can run are repeated as tests; items that need RDS are listed as Unverified for staging (C-01).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Migrations from empty on PostgreSQL 17 container
- TC-AU-04 steps 1, 3, 4 (step 2 per the SA-TC-06 residual; do not copy the draft 5 text)
- catalog checks M-1..M-5 as a script
- Common checks of TICKETS.md section 3 also apply.


#### F-04 — Kernel library: transaction and scope setter, idempotency, outbox/queue, config, redacting logger, error mapping  (HEAAA-72)

**Ticket F-04** · release R1 · milestone M1 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-15 |
| Requirements / rows | NFR-13, NFR-18 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 21.3, 21.5, 21.8, 25, 28.3, 28.4, 30, 33; SHARED-BOUNDARIES 6.1, 8.2, 8.4.

**Technical prerequisites.** HEAAA-69 (`F-03`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-71 (`F-08`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `packages/kernel/src/**`
- `db/migrations/0100-0149_*`
- `packages/kernel/test/**`
- Migration numbers reserved for this ticket: `0100`-`0149` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `withScope(...)` sets the transaction settings of 21.3 and nothing outside it can run a patient-data query; a handler calling a `patient_scope_owner` function without `lockPatients` first fails a static check (38.2 item 4).
- Idempotency store: concurrent duplicate keys give one write and one replay; same key with a different body gives `409 kernel.idempotency_conflict` (38.2 item 5).
- Queue is the outbox (ADR-020): a job is enqueued in the same transaction as the business change; the chosen queue library passes the acceptance test on `FORCE`d tables (SBR-17).
- Every SQLSTATE of section 30 maps to its error code with no PHI in the body (38.2 item 10). The logger redacts a synthetic-PHI canary.
- Participant registries exist before any consumer (ARCHITECTURE 22.16, 24): `registerMergeParticipant({module, tables, repointPatient, conflictRules})` and `registerExportContributor({module, exportPart})` in `packages/kernel`, each refusing a duplicate module, with a fixture module for each. The patient merge job (BE-09) and the privacy export (BE-20) consume these registries and own no per-module logic.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit + integration-db on PostgreSQL 17
- static lock-order check
- PHI canary test
- registry fixture test (register, duplicate refused, listed in a stable order)
- Common checks of TICKETS.md section 3 also apply.


#### F-08 — Transcribe the R1 API catalogue to OpenAPI 3.1 and generate shared types  (HEAAA-71)

**Ticket F-08** · release R1 · milestone M1 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Solution Architect (`7efe9f61`) |
| Conditions | C-02, C-15 |
| Requirements / rows | ADR-018, CN-03, CN-06 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 28 (ADR-018), 29.1-29.5, 30, 31; UI-UX section 12; TEST-CASES TC-API-*.

**Technical prerequisites.** HEAAA-67 (`F-01`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-69 (`F-03`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `packages/contracts/openapi/openapi.yaml`
- `packages/contracts/openapi/common.yaml`
- `packages/contracts/openapi/<module>.yaml (one per module)`
- `packages/contracts/src/** (generated types)`
- `scripts/contracts/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Every route of sections 29.1-29.5 appears with method, path, host, permission, resolver, idempotency and If-Match requirements, request/response schemas, and the module error codes of section 30. Count of routes in the document equals count in the file (script check recorded).
- No route, field or status is added that is not in ARCHITECTURE draft 8.1; a difference is a finding to the Solution Architect, not an edit.
- `common.yaml` carries the headers (`X-Client-Release`, `Idempotency-Key`, `If-Match`, `X-Request-Id`), error envelope and pagination; module files are split so later tickets edit only their own module file.
- The file validates (Spectral or equivalent) and the generated types compile. Routes marked Provisional (session and admin auth) are flagged `x-provisional: true` until ID-FREEZE.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- OpenAPI lint
- route-count script
- type generation and tsc
- Common checks of TICKETS.md section 3 also apply.

**Note.** Single owner of `common.yaml` and the root index. Later tickets change only their module file; changes to a Fixed route need an architecture change request.


#### F-05 — API and worker platform layer: app shell, guard hook, release-contract check, limits, health  (HEAAA-74)

**Ticket F-05** · release R1 · milestone M1 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-15 |
| Requirements / rows | NFR-6, NFR-12, NFR-14, CN-13 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 3.1, 27.1, 28.2, 28.6, 31.1-31.3, 32.1 (stream shell), 38.2 items 9, 20; SHARED-BOUNDARIES 5.1, BD-07, BD-12.

**Technical prerequisites.** HEAAA-72 (`F-04`), HEAAA-71 (`F-08`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/platform/**`
- `apps/api/src/main.ts`
- `apps/worker/src/**`
- `apps/api/test/platform/**`
- `db/migrations/0150-0199_*`
- Migration numbers reserved for this ticket: `0150`-`0199` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- NestJS API and worker boot against PostgreSQL 17; `/healthz` and `/readyz` answer without a client-release header.
- Route guard framework (deny by default; every route declares `{permission, resolver, elevation?, realm?}`); CI route inventory fails on a route without a declared permission (38.2 item 9). The permission catalogue is data, filled by identity later.
- Client-release check before any session lookup: no header, malformed header and a number below `min_client_release` each get `400 kernel.client_release_unsupported` with no session write, no idempotency row, no business effect; exempt routes work without the header; no `Access-Control-Allow-*` header on portal hosts (38.2 item 20).
- Request limits, validation, rate-limit counters and `Cache-Control: no-store` on every API response (31.1-31.3, 28.2).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit + integration-db
- TC-API-11 (the release-gate case that draft 5 numbered TC-API-10 a second time; see C-15) executable form on `ci`
- route-inventory CI check
- Common checks of TICKETS.md section 3 also apply.


#### F-06 — Frontend slice: staff app shell calling the API same-origin through generated types  (HEAAA-73)

**Ticket F-06** · release R1 · milestone M1 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 3.1, 7.1, 12; ARCHITECTURE 3.1 (same-origin `/api/*`), 28.6; DEVOPS-PLAN 5.1 (a11y smoke, bundle budget).

**Technical prerequisites.** HEAAA-67 (`F-01`), HEAAA-71 (`F-08`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-70 (`QA-01`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/**`
- `packages/app-shell/** (initial)`
- `packages/ui/** (initial token and primitive set)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `apps/staff` builds for production; a page calls `/api/v1/healthz`-class route through a client generated from F-08, same origin, no CORS.
- Sends `X-Client-Release` on every call; shows the blocking and non-blocking release prompts as specified in UI-UX 7.7 (components only, strings from the content rules).
- Placeholder visual identity is used and marked as placeholder (UX-O-01). axe smoke passes on the shell.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- production build
- axe smoke on the built shell
- unit tests for the client and prompts
- Common checks of TICKETS.md section 3 also apply.


#### F-09 — CI jobs that need application code: integration-db, migration-check, contract, a11y smoke, e2e smoke, bundle budget  (HEAAA-79)

**Ticket F-09** · release R1 · milestone M1 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Backend Reviewer (`472e0e86`) |
| Conditions | C-13, C-22 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 5.1, 5.2, 14; TEST-CASES 0.2, 0.3 (`ENV-INT/ci`).

**Technical prerequisites.** HEAAA-68 (`F-02`), HEAAA-69 (`F-03`), HEAAA-74 (`F-05`), HEAAA-73 (`F-06`), HEAAA-71 (`F-08`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `.github/workflows/ci.yml (the jobs added here only)`
- `scripts/ci/migration-check/**`
- `tests/e2e/smoke/**`
- `lighthouserc.*`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `integration-db` runs migrations from empty and from the previous release tag on PostgreSQL 17 and fails on every rule listed in DEVOPS-PLAN 5.2 (RLS/FORCE, `TO PUBLIC`, `security_invoker`, merge write guard, definer inventory and fixed `search_path`, role `transaction_timeout`, DML in a migration, expand/contract, N-1 test suite, function-owner NOLOGIN, `BYPASSRLS`, RDS master user in config).
- `contract` runs Schemathesis against the API container; `a11y-smoke`, `e2e-smoke` (Playwright PR subset) and `bundle-budget` (Lighthouse CI) run on the built shell.
- Each job is proved to fail on a seeded violation. An empty suite fails.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Workflow run with artifacts
- seeded-violation run per job
- Common checks of TICKETS.md section 3 also apply.


#### F-07 — Foundation proof: clean frozen install, production builds, container image, UI-API-database journey on CI  (HEAAA-81)

**Ticket F-07** · release R1 · milestone M1 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-20 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Backend Reviewer (`472e0e86`) |
| Conditions | C-13 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: WORKFLOW Stage 3 (foundation); HEAAA-20 objective; DEVOPS-PLAN 5.1.

**Technical prerequisites.** HEAAA-79 (`F-09`), HEAAA-74 (`F-05`), HEAAA-73 (`F-06`)

**Gate prerequisites.** HEAAA-19

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/evidence/foundation/** (evidence only)`
- `docker/Dockerfile.* (api, worker)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Evidence document records the candidate commit, lockfile hash, tool versions, commands and results of: clean frozen install; production build of every app; container build and scan; the journey browser shell -> same-origin API -> PostgreSQL with scope setter and RLS -> rendered result.
- States what is NOT proven: real authentication (no identity module yet; first real auth slice is INT-01), cloud, RDS, vendors.
- No deploy job ran against any live environment.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Evidence read by the DevOps Reviewer and Backend Reviewer from raw reports
- Common checks of TICKETS.md section 3 also apply.


### Security lane and design maintenance (HEAAA-25)

#### SEC-01 — Cybersecurity review of identity, trust-boundary and secret-handling design (SEC-1..3, O-2, O-5)  (HEAAA-65)

**Ticket SEC-01** · release R1 · milestone M0 · size M (2 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Cybersecurity (`83cd0a46`) |
| Independent reviewer stages (in order) | Security Reviewer (`074b2525`) |
| Conditions | C-02 |
| Requirements / rows | SEC-D-19, RA-R1-32, NFR-12..NFR-19 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: SHARED-BOUNDARIES 7, 9.1, 10; ARCHITECTURE 21.2-21.4, 21.6, 22.5.1 (`directory_ro`), 25.9, 26, 31.3, 32.2 pt 5; design-align section 2.

**Technical prerequisites.** none

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/security/SEC-01-identity-boundary-review.md (new, docs only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Written verdict per item: variant B2 (API-run WebAuthn) vs B1, the T-SIGNIN / T-SIGNIN-CLAIM pre-verification read, `identity_signin_ro`, the complete `anonymous` and `public` read lists, `directory_ro` grants (TDR-15/16), O-2 transaction signing, O-5, the two definer functions of 21.6, the sign-in rate limits and the 60 s stream-closure bound.
- Each recommendation is ACCEPT, ACCEPT-WITH-CONDITIONS (conditions named) or REJECT with the replacement control; open items carry an owner.
- States plainly whether the D-35 path A/B choice and variant B2 can freeze, and which architecture text changes (input to ID-FREEZE).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Independent Security Reviewer read of the exact document revision
- No code, no configuration, no scan is claimed
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Orchestrator decision: promote before G2 is decided (recommended, design-only) or after G2. Any architecture change it forces reopens the affected G2 document.


#### ID-FREEZE — Architecture erratum 8.2: freeze identity tables and fold carried notes (docs only)  (HEAAA-66)

**Ticket ID-FREEZE** · release R1 · milestone M0 · size S (1 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Solution Architect (`7efe9f61`) |
| Independent reviewer stages (in order) | Solution Architect Reviewer (`338c0bb5`) |
| Conditions | C-02, C-15 |
| Requirements / rows | SAR-15, SEC-D-19 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 20.3, 22.4, 26, 40.4; design-align section 2 (N-3..N-5, N-9..N-11, QA-AL-01 / SA-AR-01, DEV-1 N-8).

**Technical prerequisites.** HEAAA-65 (`SEC-01`), HEAAA-64 (`F-00`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/ARCHITECTURE.md (sections 22.4, 26, 29.5, 33.1 and the errata table only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- 22.4 and 26 change from Provisional to Fixed, or the owner-chosen path (A, or B1 with the cloud spike) is written in; the D-35 answer is cited.
- QA-AL-01 rule for a `410 Gone` calendar sync token (full resync through `scheduling.replaceBusyBlocks`, as proposed in the TEST-CASES SA review) is stated, or kept as an explicit open item.
- N-3..N-5 and N-9..N-11 are each closed or carried by name. The diff against draft 8.1 touches only those sections.
- The new revision is saved as `architecture` on the native gate task `ID-FREEZE-GATE` with a `human_only` request_confirmation bound to that revision (diff against revision `b276930a` attached). BE-04 and BE-05 are natively blocked by that gate task, so an agent PASS on this ticket does not release identity work; only the human decision does. Nobody but the human accepts it.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Diff-only review by the Solution Architect Reviewer
- sha256 of the new revision recorded in the ticket evidence
- Common checks of TICKETS.md section 3 also apply.

**Note.** Changes an approved G2 document. Per WORKFLOW this reopens the architecture decision for the changed sections; it is a bounded Provisional-to-Fixed change, not a new design.


#### SEC-02 — Security assessment: identity, sessions, admin realm and secrets (code review)  (HEAAA-135)

**Ticket SEC-02** · release R1 · milestone M5 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Cybersecurity (`83cd0a46`) |
| Independent reviewer stages (in order) | Security Reviewer (`074b2525`) |
| Conditions | none beyond G2 |
| Requirements / rows | RA-R1-32 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 26, 8.4, 25.9; SHARED-BOUNDARIES 7, 9.1; TEST-CASES 5.

**Technical prerequisites.** HEAAA-104 (`BE-05`), HEAAA-80 (`BE-02`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-126 (`SEC-08`) (agent), HEAAA-134 (`FE-14`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/security/SEC-02-identity-assessment.md (docs only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Review of the implemented B2 flow, session handling, secret write-only behaviour and C1..C7 evidence against the reviewed design; findings with reproduction.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Independent Security Reviewer read of the exact document revision
- Every finding routed with stable ID, severity, owner and parent; no code is changed by this ticket
- Common checks of TICKETS.md section 3 also apply.


#### SEC-03 — Security assessment: RLS, scope, merge and patient-data isolation (code and SQL review)  (HEAAA-101)

**Ticket SEC-03** · release R1 · milestone M3 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Cybersecurity (`83cd0a46`) |
| Independent reviewer stages (in order) | Security Reviewer (`074b2525`) |
| Conditions | none beyond G2 |
| Requirements / rows | RA-R1-17 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: SHARED-BOUNDARIES 6, 9.2; ARCHITECTURE 21, 22.16; TEST-CASES 6.

**Technical prerequisites.** HEAAA-88 (`BE-09`), HEAAA-90 (`BE-11`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-65 (`SEC-01`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/security/SEC-03-rls-assessment.md (docs only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Policies read against the templates; role grants against 21.2; merge guard and lock order against 25.2; negative cross-clinic and cross-patient tests reviewed for sufficiency.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Independent Security Reviewer read of the exact document revision
- Every finding routed with stable ID, severity, owner and parent; no code is changed by this ticket
- Common checks of TICKETS.md section 3 also apply.


#### SEC-04 — Security assessment: documents, notifications and PHI-in-output controls  (HEAAA-122)

**Ticket SEC-04** · release R1 · milestone M3 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Cybersecurity (`83cd0a46`) |
| Independent reviewer stages (in order) | Security Reviewer (`074b2525`) |
| Conditions | none beyond G2 |
| Requirements / rows | RA-R1-05, RA-R1-13 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 25.10, 6 (PHI minimisation); PRD BR-23, BR-36; TEST-CASES 7.4, 9.3.

**Technical prerequisites.** HEAAA-92 (`BE-10`), HEAAA-84 (`BE-06`), HEAAA-106 (`BE-14`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-101 (`SEC-03`) (agent), HEAAA-107 (`FE-04`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/security/SEC-04-phi-output-assessment.md (docs only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Upload and scan path, object keys, email/SMS/push/.ics/calendar content and logs reviewed for PHI; findings routed.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Independent Security Reviewer read of the exact document revision
- Every finding routed with stable ID, severity, owner and parent; no code is changed by this ticket
- Common checks of TICKETS.md section 3 also apply.


#### SEC-05 — Security assessment: alerts, audit, BTG and stream authorization  (HEAAA-137)

**Ticket SEC-05** · release R1 · milestone M5 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Cybersecurity (`83cd0a46`) |
| Independent reviewer stages (in order) | Security Reviewer (`074b2525`) |
| Conditions | none beyond G2 |
| Requirements / rows | RA-R1-11, RA-R1-12 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.2, 32; TEST-CASES 9.2, 5.3.

**Technical prerequisites.** HEAAA-98 (`BE-07`), HEAAA-76 (`BE-01`), HEAAA-120 (`BE-24`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-135 (`SEC-02`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/security/SEC-05-alerts-audit-assessment.md (docs only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Audit immutability, anchoring, BTG flow, alert target resolution and stream authorization reviewed; findings routed.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Independent Security Reviewer read of the exact document revision
- Every finding routed with stable ID, severity, owner and parent; no code is changed by this ticket
- Common checks of TICKETS.md section 3 also apply.


#### SEC-06 — Security assessment: IaC, CI trust and release controls  (HEAAA-115)

**Ticket SEC-06** · release R1 · milestone M6 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Cybersecurity (`83cd0a46`) |
| Independent reviewer stages (in order) | Security Reviewer (`074b2525`) |
| Conditions | none beyond G2 |
| Requirements / rows | NFR-15 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 4.1, 7, 15.3.

**Technical prerequisites.** HEAAA-87 (`DO-04`), HEAAA-97 (`DO-06`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-137 (`SEC-05`) (agent), HEAAA-145 (`QA-06`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/security/SEC-06-iac-ci-assessment.md (docs only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Trust policies, approval-by-apply, role denial, workflow permissions and Actions policy reviewed; the GitHub-side enforcement state is stated as found.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Independent Security Reviewer read of the exact document revision
- Every finding routed with stable ID, severity, owner and parent; no code is changed by this ticket
- Common checks of TICKETS.md section 3 also apply.


#### SEC-07 — Pre-candidate security assessment: scan results, residual risk and penetration-test scope  (HEAAA-142)

**Ticket SEC-07** · release R1 · milestone M6 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Cybersecurity (`83cd0a46`) |
| Independent reviewer stages (in order) | Security Reviewer (`074b2525`) |
| Conditions | none beyond G2 |
| Requirements / rows | NFR-15, NFR-16 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: WORKFLOW Stage 4; DEVOPS-PLAN 5, 14.4; PRD DEP-13.

**Technical prerequisites.** HEAAA-141 (`INT-05`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-115 (`SEC-06`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/security/SEC-07-candidate-assessment.md (docs only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Reads raw SAST, dependency, secret and container reports of the integrated candidate; classifies findings; proposes the scope of the independent penetration test (a human-required item, TC-PEN-01). No finding is relabelled optional to continue.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Independent Security Reviewer read of the exact document revision
- Every finding routed with stable ID, severity, owner and parent; no code is changed by this ticket
- Common checks of TICKETS.md section 3 also apply.


#### SEC-08 — Security assessment: clinical access, banner allergies, break-the-glass and the red-flag alert path  (HEAAA-126)

**Ticket SEC-08** · release R1 · milestone M4 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-25 |
| Owner (one) | Cybersecurity (`83cd0a46`) |
| Independent reviewer stages (in order) | Security Reviewer (`074b2525`) |
| Conditions | none beyond G2 |
| Requirements / rows | RA-R1-11, RA-R1-17 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 27.4, 28.2, 25.5, 32; SHARED-BOUNDARIES 6.3, 6.6; PRD BR-13, BR-14, BR-34, 8.3; TEST-CASES 6, 8.2.

**Technical prerequisites.** HEAAA-96 (`BE-16`), HEAAA-102 (`BE-18`), HEAAA-98 (`BE-07`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-122 (`SEC-04`) (agent), HEAAA-130 (`BE-21`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/security/SEC-08-clinical-access-assessment.md (docs only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Assignment rules (BQ-5), BTG, `allergies: null` for read-only roles, audit of allergy summary reads and alert target resolution reviewed against the implementation; findings routed.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Independent Security Reviewer read of the exact document revision
- Every finding routed with stable ID, severity, owner and parent; no code is changed by this ticket
- Common checks of TICKETS.md section 3 also apply.


### Backend lane (HEAAA-23)

#### BE-01 — audit module: append-only events, anchors, BTG grants, denial path, export job  (HEAAA-76)

**Ticket BE-01** · release R1 · milestone M2 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-15, C-20 |
| Requirements / rows | RA-R1-11, RA-R1-12, NFR-13 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.2, 24 (`audit`), 25, 33.1 (`audit.*`), 38.2 items 2, 8; SHARED-BOUNDARIES 8.1, 9.2; PRD BR-13, BR-14.

**Technical prerequisites.** HEAAA-74 (`F-05`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-73 (`F-06`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/audit/**`
- `apps/worker/src/jobs/audit/**`
- `db/migrations/0200-0299_*`
- Migration numbers reserved for this ticket: `0200`-`0299` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `audit.record(envelope)` writes the SHARED-BOUNDARIES 8.1 envelope in the caller's transaction; `recordDenied` writes in a separate transaction; unbounded transactions are refused (SAR-10 trigger).
- No application, admin or support role can UPDATE or DELETE an audit row (privilege error `42501` for `app_owner`; trigger for the rest); partition archive and drop only through `audit_archiver` after verified read-back (design only here; the dual-control workflow is DO-09b).
- Anchoring and verification jobs run; a tampered row is detected and raises `audit_anchor_mismatch`.
- BTG grant tables and `activeBtgGrants` exist; export job is chunked, size limited, and itself audited.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-AU-01..09 automated parts that run on `ENV-INT/ci`
- TC-AU-04 corrected per SA-TC-06
- Common checks of TICKETS.md section 3 also apply.


#### BE-02 — integration-core: vendor call wrapper, inbound log and dispatch, circuit state, write-only secret references  (HEAAA-80)

**Ticket BE-02** · release R1 · milestone M2 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-02, C-15 |
| Requirements / rows | RA-R1-31, NFR-21, BR-33 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.3, 24, 25.7, 25.9, 33.1, 34; SHARED-BOUNDARIES 3.2 rule 6, 9.1 (BD-11).

**Technical prerequisites.** HEAAA-76 (`BE-01`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-78 (`BE-03`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/integration-core/**`
- `apps/worker/src/jobs/integration-core/**`
- `db/migrations/0400-0499_*`
- Migration numbers reserved for this ticket: `0400`-`0499` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `callVendor` applies timeouts, back-off and circuit state and records every call; an adapter interface exists per connection kind (email, SMS, push, video, calendar, OCR); adapters are added by their own tickets.
- Inbound webhook transaction records the message under the vendor event ID and enqueues the dispatch job together; a duplicate enqueues nothing (38.2 item 13).
- Secret references are write-only: values never returned, logged or exported; secret requests need an approver different from the requester and the worker verifies approval evidence (O-2 handling is per SEC-01 outcome).
- Health check job and connection events feed the operations alerts.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-API-* parts for webhooks on `ci`
- secret-in-log canary
- Common checks of TICKETS.md section 3 also apply.


#### BE-03 — organisation: configuration data model, settings, directory views and `directory_ro` role  (HEAAA-78)

**Ticket BE-03** · release R1 · milestone M2 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-07, C-08, C-15 |
| Requirements / rows | RA-R1-15, RA-R1-05, RA-R1-16 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.5, 22.5.1, 24 (`organisation`), 21.2 (`directory_ro`), 31.4, 38.2 item 17; PRD F-AD-01..05, 7.2.

**Technical prerequisites.** HEAAA-76 (`BE-01`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/organisation/**`
- `db/migrations/0300-0399_*`
- Migration numbers reserved for this ticket: `0300`-`0399` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- The 34 tables of 22.5 exist with their policies; settings of 31.4 are stored with the PRD 7.2 defaults marked `[G2 setting]` and are read by the service interface; no value is hard-coded.
- Nine C0 views are created by a non-superuser migration and owned by `directory_ro`; `app_api`/`app_worker` cannot `SET ROLE directory_ro`; column grants equal the 22.5.1 list; the M-5 check fails if a `public` policy exists outside T-DIRECTORY (38.2 item 17).
- Booking policy is block-only by default (D-3); fee fields are stored but never charged.
- Neutral patient-visible service display names exist for condition-revealing services (BR-23).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-AD-* data-level cases on `ci`
- view/grant catalog tests
- Common checks of TICKETS.md section 3 also apply.


#### BE-04 — identity core: staff (Google) and patient realms, sessions, roles, scope builder, authorization guard  (HEAAA-82)

**Ticket BE-04** · release R1 · milestone M2 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-02, C-10, C-15 |
| Requirements / rows | RA-R1-01, RA-R1-17, BR-32 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.4 (non-admin tables), 26.1 (google, patient), 26.2, 27, 29.1, 38.2 items 7, 9, 12, 14; SHARED-BOUNDARIES 6.1, 7; PRD RA-R1-01, RA-R1-17.

**Technical prerequisites.** HEAAA-76 (`BE-01`), HEAAA-80 (`BE-02`), HEAAA-78 (`BE-03`), HEAAA-66 (`ID-FREEZE`)

**Gate prerequisites.** HEAAA-147, HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-77 (`FE-02`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/identity/**`
- `apps/worker/src/jobs/identity/**`
- `db/migrations/0500-0599_*`
- `packages/contracts/openapi/identity*.yaml (only to drop `x-provisional` after ID-FREEZE)`
- Migration numbers reserved for this ticket: `0500`-`0599` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Google OIDC sign-in for staff with `prompt`/`max_age` re-authentication (BQ-8), first sign-in provisioning and pre-registered email binding exactly once (38.2 item 12); the patient realm session works against the patient identity service adapter interface.
- Server-side sessions with token hash only, `__Host-` cookies, audience binding, idle timeouts (15 min staff, per audience), no session cache; revocation is immediate (ADR-021). Idle timeout holds with passive traffic (38.2 item 14).
- The guard enforces permission, realm and scope on every route; the default role-to-permission mapping of 27.3 is loaded as data and marked Proposal until G2 settings are confirmed; assignment resolver (BQ-5) implemented.
- `identity.proxy_grant` (ARCHITECTURE 4, 22.4) is owned here with its RLS and the appointments-only scope contribution (D-7 default, RA-R1-20a); the patient module reads it only through the identity interface.
- `identity.repointPatient` is registered with the 22.16 rules for its tables, the 38.2 item 11 count test passes for them (found = re-pointed + resolved + kept), and `exportPart` is published for export.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-ID-* and TC-AZ-* automated parts on `ci` with a local OIDC conformance IdP
- TC-ID-01 against the real Workspace test tenant stays BLOCKED (C-10)
- Common checks of TICKETS.md section 3 also apply.


#### BE-05 — identity admin realm: API-run WebAuthn, elevation, enrolment, second-approver role changes, kill switch  (HEAAA-104)

**Ticket BE-05** · release R1 · milestone M5 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-02, C-13, C-15 |
| Requirements / rows | RA-R1-32, SEC-D-19-C1, SEC-D-19-C4, SEC-D-19-C6 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 26.1 (variant B2), 26.3, 8.4 (C1..C7), 29.1 (admin auth), 38.2 item 8; PRD RA-R1-32.

**Technical prerequisites.** HEAAA-82 (`BE-04`), HEAAA-65 (`SEC-01`), HEAAA-66 (`ID-FREEZE`)

**Gate prerequisites.** HEAAA-147, HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-130 (`BE-21`) (agent), HEAAA-136 (`FE-16`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/identity/admin/**`
- `db/migrations/2200-2299_*`
- `packages/contracts/openapi/identity*.yaml (only to drop `x-provisional` after ID-FREEZE)`
- Migration numbers reserved for this ticket: `2200`-`2299` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Sign-in options and verify, elevation options and verify and enrolment follow the B2 design as reviewed; counter regression, wrong origin or RP ID, UV not set, replayed challenge, unknown handle (indistinguishable), expired or used enrolment token and approver = requester are each refused (38.2 item 8).
- C1: a privileged action is refused without a valid elevation grant; a stale one is refused. C4: approver differs from requester and subject, cannot approve their own request, request expires; all audited. C6: kill switch ends every session and elevation at once and the stream closes within 60 s; deprovisioning completes the same business day.
- If SEC-01 or the owner (D-35) selects B1 or path A, this ticket is re-planned by the Delivery Planner before any work starts.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-SEC-01..25 automated parts on `ci`
- TC-SEC-03/05/11/16/23 stay Pending-human
- Common checks of TICKETS.md section 3 also apply.


#### BE-06 — notifications core: PHI-free templates, send and dedupe, preferences, receipts, recipient resolution  (HEAAA-84)

**Ticket BE-06** · release R1 · milestone M2 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-08, C-10, C-11, C-15 |
| Requirements / rows | RA-R1-05, BR-08, BR-23 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.13, 24, 33.1, 25.7; SHARED-BOUNDARIES 8.3 (BD-10), 3.2 rule 7; PRD BR-08, BR-23, BR-36.

**Technical prerequisites.** HEAAA-82 (`BE-04`), HEAAA-80 (`BE-02`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/notifications/**`
- `apps/worker/src/jobs/notifications/**`
- `db/migrations/0600-0699_*`
- Migration numbers reserved for this ticket: `0600`-`0699` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `send` binds only allowlisted non-clinical variables; a template that binds a service, diagnosis or medicine name cannot be saved (BQ-2: clinician name excluded).
- Every rendered template and artefact (email, SMS, push, .ics body) is generated for all configured languages and contains no condition-revealing text (RA-R1-05 test).
- `notifications.repointPatient` (receipts, preferences, per the 22.16 rules) is published for the merge job and its count test passes for those tables; `exportPart` is published for the privacy export; delivery receipts attach to the survivor ID after a merge; dedupe keys prevent double sends; vendor adapters implement the interface from BE-02 (real providers are C-10/C-11).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-NT-01..08 automated parts
- render-every-template test
- Common checks of TICKETS.md section 3 also apply.


#### BE-07 — staff alerts: durable alerts, escalation timers, SSE stream, acknowledge  (HEAAA-98)

**Ticket BE-07** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-03, C-08, C-15 |
| Requirements / rows | RA-R1-07 (mechanics), AL-02 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.13, 32.1-32.4, 33.1 (`notifications.escalate_alert`), 38.2 items 6, 19; PRD BR-10 (mechanics only).

**Technical prerequisites.** HEAAA-84 (`BE-06`), HEAAA-82 (`BE-04`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-94 (`BE-12`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/notifications/alerts/**`
- `apps/api/src/modules/notifications/stream/**`
- `db/migrations/1200-1299_*`
- Migration numbers reserved for this ticket: `1200`-`1299` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `GET /alerts`, `/alerts/open-ids`, the SSE `alert` event and acknowledge carry `escalationLevel` and `escalatesAt` with the stated null rules; two simultaneous acknowledgements both succeed with one `acknowledged` event; a closed alert gives `409 notifications.alert_closed` (38.2 item 19).
- The stream refuses an outdated `clientRelease`, replays missed alerts on reconnect, drops a slow consumer instead of buffering, and closes within 60 s of a kill switch (38.2 item 6).
- Alert targets are resolved to principals at creation and escalation; admin-realm alerts never carry a patient ID (ADR-022).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-PC-16 mechanics (runnable now; rule content waits on C-03)
- SSE behind CloudFront/ALB is Unverified (staging, C-01)
- Common checks of TICKETS.md section 3 also apply.


#### BE-08 — patient core: registration, matching, care relationships, `staff_scope`, consents, preferences, proxy-grant use  (HEAAA-86)

**Ticket BE-08** · release R1 · milestone M3 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-04, C-08, C-15 |
| Requirements / rows | RA-R1-17, RA-R1-20a, RA-R1-21, RA-R1-27 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.6, 24 (`patient`), 25.3, 29.2-29.3 (patient routes), 33.1 (`patient.*`); SHARED-BOUNDARIES 6.3, 6.6, 9.3; PRD BR-32, BR-37.

**Technical prerequisites.** HEAAA-82 (`BE-04`), HEAAA-84 (`BE-06`), HEAAA-78 (`BE-03`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-80 (`BE-02`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/patient/**`
- `apps/worker/src/jobs/patient/**`
- `db/migrations/0700-0799_*`
- Migration numbers reserved for this ticket: `0700`-`0799` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `patient.staff_scope` is derived only through `patient_scope_owner` functions; the daily drift check reports zero drift on the test data (6.6).
- A clinic A user cannot find or read a patient registered only in clinic B; a patient cannot read another patient by URL manipulation; both attempts are logged (RA-R1-17).
- Duplicate-match warning on registration; attach rule per BQ-4 default; proxy access uses the `identity.proxy_grant` table and scope rule owned by BE-04 through the identity interface (D-7 default, RA-R1-20a), with no table of its own.
- Consent capture with signed templates; preferences; `lockPatients`.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db RLS suite of SHARED-BOUNDARIES 6.8 for this module
- TC-AZ-*, TC-PP-03, TC-AZ-14 on `ci`
- Common checks of TICKETS.md section 3 also apply.


#### BE-09 — patient merge: request, approval, execute job, participant registry, write guards  (HEAAA-88)

**Ticket BE-09** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-08, C-15 |
| Requirements / rows | RA-R1-27, BR-37 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.16, 25.2, 25.4, 33.1 (`patient.execute_merge`), 38.2 items 1, 2, 11; SHARED-BOUNDARIES 9.2 (BD-14); PRD BR-37.

**Technical prerequisites.** HEAAA-86 (`BE-08`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/patient/merge/**`
- `db/migrations/0800-0899_*`
- Migration numbers reserved for this ticket: `0800`-`0899` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Merge needs a second staff approver (BQ-3 default roles `front_desk_lead`, `medical_records`); the merged state is terminal; unmerge is not built (BQ-6).
- The execute job uses the participant registry from F-04: L1 modules (identity, notifications, documents) are called downward through their published `repointPatient`; higher modules register theirs in their own tickets (BE-11, BE-13, BE-15..BE-19). The CI check fails a job type that carries patient IDs without `on_merged`; the job fails the merge if a module with Merge class R or R/K has no registered participant.
- Race test with real concurrency: a transaction writing both patients while a merge locks them serialises or retries whole (38.2 item 1, patient-only lock order). The booking-confirm-versus-merge race is NOT asserted here (no scheduling occupancy exists yet); it is in BE-11 and INT-02.
- Conflicting rows resolve by 22.16 into `merge_residue` and counts add up for the participants registered so far (38.2 item 11); a K-state row cannot be updated by any role including a `data_repair` job.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db with real concurrency (two connections)
- TC-MG-01..14 automated parts
- Common checks of TICKETS.md section 3 also apply.


#### BE-10 — documents: pre-signed upload, scan, OCR suggestion, classification, legal holds, export part  (HEAAA-92)

**Ticket BE-10** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-10, C-20, C-15 |
| Requirements / rows | RA-R1-13, BR-28, BR-29 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.7, 24 (`documents`), 25.10, 33.1 (`documents.*`), 29.2-29.3 (documents); PRD BR-28, BR-29, J-19.

**Technical prerequisites.** HEAAA-86 (`BE-08`), HEAAA-88 (`BE-09`), HEAAA-80 (`BE-02`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-90 (`BE-11`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/documents/**`
- `apps/worker/src/jobs/documents/**`
- `db/migrations/1000-1099_*`
- Migration numbers reserved for this ticket: `1000`-`1099` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- No one can open an upload until it is scanned clean; an infected file is quarantined; a document whose version is `scanning` at merge time is re-pointed and served after the retried scan (38.2 item 11).
- Object keys, URLs and logs contain no PHI; downloads use short-lived URLs; classification is staff-confirmed; a deletion request under legal hold is refused with the reason recorded.
- Scanner and OCR adapters implement the BE-02 interface; the scan result tag and timing are Unverified until staging (C-01, C-10).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-DOC-01..08 automated parts
- EICAR-style fixture through the scanner stub is NOT proof of the real scanner
- Common checks of TICKETS.md section 3 also apply.


#### BE-11 — scheduling core: occupancy, holds, confirm, cancel, reschedule, overlap rule  (HEAAA-90)

**Ticket BE-11** · release R1 · milestone M3 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | C-07, C-08, C-15 |
| Requirements / rows | RA-R1-02, RA-R1-03, BR-02, X-02 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 5.1, 22.8, 23.1, 25.1, 25.2, 25.6 (hold part), 29.2, 38.2 items 1, 15; SHARED-BOUNDARIES 6.5 (SBR-01); PRD RA-R1-02, RA-R1-03.

**Technical prerequisites.** HEAAA-86 (`BE-08`), HEAAA-88 (`BE-09`), HEAAA-78 (`BE-03`), HEAAA-84 (`BE-06`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-109 (`QA-02`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/scheduling/core/**`
- `db/migrations/0900-0999_*`
- Migration numbers reserved for this ticket: `0900`-`0999` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Under 100 parallel confirmations of one non-overbookable slot exactly one succeeds and the others get alternatives; overbookable sessions stop at the cap (RA-R1-03).
- Exclusion constraints on doctor and room; stale holds expire before insert; the deferred foreign key twin of occupancy and reservation is enforced; updating a reservation after `cancelled_*` or `no_show` is refused.
- Two concurrent holds for one patient with overlapping times: exactly one succeeds, the other gets `422 scheduling.overlapping_appointment` (38.2 item 15, BQ-9 default).
- Cancel and reschedule store `cancel_reason` and `late_change` and use the configured cut-off; fee behaviour is block-only (D-3 default).
- Merge participant: `scheduling.repointPatient` for its R and R/K tables is registered through the F-04 registry with the 22.16 rules and lock order 25.2; the 38.2 item 11 count test passes for them; a booking confirm racing a merge serialises or retries whole (38.2 item 1); `exportPart` is registered for the privacy export.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db with real concurrency
- TC-BK-01..18
- TC-PERF-07 is ENV-LOAD and stays BLOCKED (C-17)
- Common checks of TICKETS.md section 3 also apply.


#### BE-12 — scheduling availability: templates, leave, blocked time, roster, slot search  (HEAAA-94)

**Ticket BE-12** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | C-15 |
| Requirements / rows | RA-R1-23, RA-R1-02, NFR-8 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.8, 29.2-29.3 (availability), 35.2 (NFR-8 budget); PRD F-DR-01, RA-R1-23.

**Technical prerequisites.** HEAAA-90 (`BE-11`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-92 (`BE-10`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/scheduling/availability/**`
- `db/migrations/1100-1199_*`
- Migration numbers reserved for this ticket: `1100`-`1199` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Slot search = doctor template minus bookings minus external busy; busy data older than the stale threshold is never used silently [G2 setting].
- A doctor edits only their own template and blocked time (403 for another doctor); a front-desk lead edits the roster at their location only (38.2 item 12).
- Leave and blocked time show affected appointments before saving (API support).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-DR-01..03, TC-BK-* search cases
- search latency measured on the ci volume set is informational only
- Common checks of TICKETS.md section 3 also apply.


#### BE-13 — scheduling flow: check-in, queue, arrivals, no-show, waitlist offers, pre-visit send  (HEAAA-100)

**Ticket BE-13** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | C-08, C-15 |
| Requirements / rows | RA-R1-06, RA-R1-22, F-PC-09 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.8, 25.5 (check-in), 25.6, 33.1 (`scheduling.*`), 29.3 (arrivals, queue); PRD RA-R1-06, RA-R1-22.

**Technical prerequisites.** HEAAA-94 (`BE-12`), HEAAA-84 (`BE-06`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-98 (`BE-07`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/scheduling/flow/**`
- `apps/worker/src/jobs/scheduling/**`
- `db/migrations/1300-1399_*`
- Migration numbers reserved for this ticket: `1300`-`1399` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Desk and QR check-in, queue with wait time and triage ordering as the PRD states (ordering by category is PM-confirm-2 and is not asserted).
- Waitlist: a freed slot produces an offer; the first acceptance inside the window [G2 setting] wins; the offer lapses cleanly; offers go through `scheduling.hold`.
- No-show sweep marks only where the setting allows it, otherwise flags for staff; pre-visit send skips cancelled bookings.
- Merge participant: `repointPatient` for the check-in, queue, waitlist and pre-visit tables is registered through the F-04 registry with the 22.16 rules and the 38.2 item 11 count test passes for them (an open waitlist offer on the merged ID resolves, not duplicates); `exportPart` for them is registered.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-BK-19..22, TC-PC-01..06 API parts
- Common checks of TICKETS.md section 3 also apply.


#### BE-14 — calendar-sync: Google busy-only two-way sync  (HEAAA-106)

**Ticket BE-14** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-10, C-15 |
| Requirements / rows | RA-R1-04 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.9, 24, 29.5 (Google push), 33.1 (`calendar_sync.*`), 38.2 item 13; PRD RA-R1-04, BR-07.

**Technical prerequisites.** HEAAA-94 (`BE-12`), HEAAA-80 (`BE-02`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-100 (`BE-13`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/calendar-sync/**`
- `apps/worker/src/jobs/calendar-sync/**`
- `db/migrations/1400-1499_*`
- Migration numbers reserved for this ticket: `1400`-`1499` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Busy event title is "Busy" with no patient, reason, service name or diagnosis; a Google meeting syncs back as unavailable time through `scheduling.replaceBusyBlocks`.
- A push with a valid HMAC token is accepted without the API reading `watch_channel`; wrong or expired tokens get `401`/`400`; repeated message numbers are duplicates.
- `410 Gone` sync token follows the rule fixed in ID-FREEZE (QA-AL-01); until then that step stays Blocked.
- First API path that writes secrets (SA-DP-06): the OAuth link callback stores each doctor's refresh token only as an `outbound` secret reference through BE-02 (ARCHITECTURE 22.9, BD-11, 25.9); no token, code or state value appears in a log, response, job payload or audit row (canary test); the Security Reviewer inspects this path at the second stage.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db with a Google API contract stub
- TC-CAL-01..16; real Google evidence needs the test tenant (C-10) and stays BLOCKED until it exists
- Common checks of TICKETS.md section 3 also apply.


#### BE-15 — telehealth: sessions, join tokens, device check, licensing check  (HEAAA-112)

**Ticket BE-15** · release R1 · milestone M3 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | C-06, C-10, C-11, C-15 |
| Requirements / rows | RA-R1-10, RA-R1-28 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.10, 24, 29.2-29.3 (video-session), 33.1 (`telehealth.*`); PRD RA-R1-10, RA-R1-28, TL-1.

**Technical prerequisites.** HEAAA-90 (`BE-11`), HEAAA-80 (`BE-02`), HEAAA-78 (`BE-03`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-106 (`BE-14`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/telehealth/**`
- `apps/worker/src/jobs/telehealth/**`
- `db/migrations/1500-1599_*`
- Migration numbers reserved for this ticket: `1500`-`1599` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- A video booking is refused or flagged when the patient's stated location is outside the clinician's licensed states and joining needs the patient's location confirmation; real state values come from D-2 (placeholder states are marked).
- Single-use short-lived join tokens; the waiting room admit by the clinician; recording off by default.
- Merge participant: `telehealth.repointPatient` for session and join-token tables is registered through the F-04 registry with the 22.16 rules and the 38.2 item 11 count test passes for them; `exportPart` is registered.
- The video adapter implements the BE-02 interface; vendor selection and its sandbox are C-11/C-10 and the real-vendor cases stay BLOCKED.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-TH-06..08 with placeholder states
- TC-TH-01..05 need the vendor sandbox (BLOCKED)
- Common checks of TICKETS.md section 3 also apply.


#### BE-16 — clinical chart: problems, allergies, medications (coded), vitals and ranges, banner and chart summary  (HEAAA-96)

**Ticket BE-16** · release R1 · milestone M4 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-03, C-08, C-09, C-15 |
| Requirements / rows | RA-R1-09, RA-R1-24, RA-R1-11, BR-34 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.11, 24 (`clinical`), 27.2-27.4, 28.2 (banner), 29.3, 33.1 (`clinical.terminology_load`), 38.2 items 7, 18, 19 (vitals); PRD RA-R1-09, RA-R1-24, BR-34.

**Technical prerequisites.** HEAAA-86 (`BE-08`), HEAAA-88 (`BE-09`), HEAAA-92 (`BE-10`), HEAAA-90 (`BE-11`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-114 (`BE-22`) (agent), HEAAA-122 (`SEC-04`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/clinical/chart/**`
- `apps/worker/src/jobs/clinical/**`
- `db/migrations/1600-1699_*`
- Migration numbers reserved for this ticket: `1600`-`1699` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Every `banner: true` route and `GET /patients/{id}/banner` return active allergies, severe first, at most 10 with `moreCount`, excluding `entered_in_error`, `resolved`, `inactive`; `state: none_recorded` when none; `allergies: null` for a caller with `patient.read` only; audit names `allergy_summary` only when filled (38.2 item 18).
- Allergies and medications are coded (RxNorm); free text is saved flagged `uncoded`; chart access is assignment-bound (BQ-5 rules) with BTG as the exception, and out-of-assignment access is logged and alerts compliance.
- Vital ranges: `no_range`, `unit_mismatch`, inclusive bounds, sex-specific range wins, age at `measured_at`, overlap refused `409 clinical.vital_range_overlap`; the table ships empty (clinical content is BQ-12/D-12a, not asserted).
- Terminology load job is chunked; real UMLS content needs the licence account (C-09).
- Merge participant: `clinical.repointPatient` for the chart tables (problems, allergies, medications, vitals) is registered through the F-04 registry with the 22.16 rules, including the allergy and medication conflict rules; the 38.2 item 11 count test passes for them; `exportPart` for them is registered.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-CL-01..10, TC-PC-13..15 API parts, TC-AZ-04..11
- Common checks of TICKETS.md section 3 also apply.


#### BE-17 — clinical notes: encounters, SOAP notes, sign and lock, addenda, co-sign  (HEAAA-108)

**Ticket BE-17** · release R1 · milestone M4 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | C-08, C-15 |
| Requirements / rows | RA-R1-09 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.11, 24, 25.5, 33.1 (`clinical.note_sign_reminder`); BQ-8; PRD RA-R1-09, BR-11, BR-12.

**Technical prerequisites.** HEAAA-96 (`BE-16`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-102 (`BE-18`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/clinical/notes/**`
- `db/migrations/1800-1899_*`
- Migration numbers reserved for this ticket: `1800`-`1899` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- A note is written from a template, signed and locked; later changes are addenda; trainee notes go to `pending_cosign` and cannot be released without co-signature; assistants cannot sign.
- Signing refuses with `401 auth.reauth_required` when the sign-in is older than `note_sign_max_auth_age` (12 h, G2 setting); `PATCH /notes/{id}` needs `If-Match` (`412`/`428`).
- An unsigned-note reminder alert is raised 24 h after the encounter.
- Merge participant: `repointPatient` for the encounter and note tables (signed notes are K-state: re-point the patient reference only through the 22.16 rule, never edit content) is registered through the F-04 registry and the 38.2 item 11 count test passes for them; `exportPart` for them is registered.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-CL-01..07
- Common checks of TICKETS.md section 3 also apply.


#### BE-18 — clinical front-door: questionnaires, consents gate, vitals, triage, red-flag rule, referrals and follow-ups  (HEAAA-102)

**Ticket BE-18** · release R1 · milestone M4 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-03, C-07, C-08, C-15 |
| Requirements / rows | RA-R1-06, RA-R1-29, RA-R1-30, RA-R1-07, RA-R1-08 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.11, 25.5, 24 (`clinical`), 29.3 (previsit, triage, referrals); PRD RA-R1-06, RA-R1-07, RA-R1-08, RA-R1-29, RA-R1-30, PRD 8.3.

**Technical prerequisites.** HEAAA-96 (`BE-16`), HEAAA-98 (`BE-07`), HEAAA-100 (`BE-13`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/clinical/frontdoor/**`
- `db/migrations/1700-1799_*`
- Migration numbers reserved for this ticket: `1700`-`1799` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Mechanics work now: vitals with out-of-range flags, triage category, red-flag alert creation by a triage nurse who is not a target (38.2 item 16), follow-up and referral records with referrer, target and status, manual insurance verification record, consent status gate with a recorded emergency exception.
- RA-R1-07 and RA-R1-08 acceptance, and any red-flag rule text or timing, stay BLOCKED until D-12a names the safety reviewer; the escalation timer for an unacknowledged red flag is PM-confirm-1 and is configurable, not asserted.
- Lab sample collection booking is not built (D-4 default).
- Merge participant: `repointPatient` for the questionnaire, triage, referral and follow-up tables is registered through the F-04 registry with the 22.16 rules and the 38.2 item 11 count test passes for them; `exportPart` for them is registered.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-PC-01..12, TC-SAF-* mechanics
- TC-SAF-01..08 acceptance BLOCKED (C-03)
- Common checks of TICKETS.md section 3 also apply.


#### BE-19 — messaging: staff threads and tasks (patient messaging behind flag D-5)  (HEAAA-116)

**Ticket BE-19** · release R1 · milestone M4 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | C-07, C-15 |
| Requirements / rows | RA-R1-25 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.12, 24 (`messaging`), 29.3; PRD RA-R1-25, F-DR-12, F-PP-09 (S).

**Technical prerequisites.** HEAAA-86 (`BE-08`), HEAAA-84 (`BE-06`), HEAAA-88 (`BE-09`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-110 (`BE-20`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/messaging/**`
- `db/migrations/2000-2099_*`
- Migration numbers reserved for this ticket: `2000`-`2099` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- A thread creator becomes owner and adds participants; a principal cannot insert itself as owner or member of a thread it did not create (38.2 item 16).
- Patient messaging is behind a feature flag and ships off unless D-5 retains it.
- Tasks can be created and completed; correction requests from privacy become tasks.
- Merge participant: `messaging.repointPatient` for thread participants and patient-linked tasks is registered through the F-04 registry with the 22.16 rules and the 38.2 item 11 count test passes for them; `exportPart` is registered (patient messaging stays flagged off).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-MSG-01..06
- Common checks of TICKETS.md section 3 also apply.


#### BE-20 — privacy: requests, export assembly, legal-hold checks, incident register  (HEAAA-110)

**Ticket BE-20** · release R1 · milestone M4 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-05, C-20, C-15 |
| Requirements / rows | RA-R1-14 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.14, 24 (`privacy`), 33.1 (`privacy.*`); SHARED-BOUNDARIES 6.7; PRD RA-R1-14, J-21.

**Technical prerequisites.** HEAAA-92 (`BE-10`), HEAAA-96 (`BE-16`), HEAAA-88 (`BE-09`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-108 (`BE-17`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/privacy/**`
- `apps/worker/src/jobs/privacy/**`
- `db/migrations/1900-1999_*`
- Migration numbers reserved for this ticket: `1900`-`1999` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- A patient can request an export and an account deletion; compliance sees the request; export is assembled in chunks through contributors; accounting of disclosures is included.
- The meaning of deletion is not decided (D-8): the request is recorded and routed; no data is deleted by this ticket.
- Export assembly consumes the contributor registry from F-04 and writes no per-module code (this ticket's paths are `privacy/**` only): the export includes a part from every registered contributor (notifications, documents, scheduling, telehealth, clinical, messaging, identity) and fails the job if a module that holds patient data has no contributor, with a test that proves both.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-PR-01..08
- Common checks of TICKETS.md section 3 also apply.


#### BE-21 — reporting: operations read models and dashboard feed  (HEAAA-130)

**Ticket BE-21** · release R1 · milestone M4 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | C-15 |
| Requirements / rows | NFR-21 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 22.15, 33.1 (`reporting.refresh_ops`); DEVOPS-PLAN 11; PRD NFR-21.

**Technical prerequisites.** HEAAA-80 (`BE-02`), HEAAA-84 (`BE-06`), HEAAA-90 (`BE-11`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-116 (`BE-19`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/reporting/**`
- `db/migrations/2100-2199_*`
- Migration numbers reserved for this ticket: `2100`-`2199` (single Backend owner; ordered; do not use another range).

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `reporting_ro` reads only the C0/C1 views (M-4); read models refresh every minute; the operations feed shows dead letters, circuit state and alert backlog.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- M-4 catalog check
- Common checks of TICKETS.md section 3 also apply.


#### BE-22 — integrations host and public directory routes  (HEAAA-114)

**Ticket BE-22** · release R1 · milestone M3 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-15 |
| Requirements / rows | RA-R1-16 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 29.5; SHARED-BOUNDARIES 5.1 (`integrations.`), 10.2; UI-UX BS-03; PRD RA-R1-16.

**Technical prerequisites.** HEAAA-80 (`BE-02`), HEAAA-78 (`BE-03`), HEAAA-94 (`BE-12`), HEAAA-106 (`BE-14`), HEAAA-84 (`BE-06`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-112 (`BE-15`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/integrations-host/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `/public/v1/services|locations|clinicians` return only the C0 rows; nothing for inactive services or locations, unlisted or disabled clinicians, or a clinician without an active template at the asked location.
- The `integrations.` host accepts no cookies; token and signature auth only; vendor webhooks verify signatures and answer idempotently.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-BS-* API parts
- TC-API-* for webhooks
- Common checks of TICKETS.md section 3 also apply.


#### BE-23 — admin API: organisation configuration routes  (HEAAA-118)

**Ticket BE-23** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-15 |
| Requirements / rows | RA-R1-15, RA-R1-26 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 29.4 (organisation, vital ranges, flags, banners); PRD RA-R1-15, RA-R1-26.

**Technical prerequisites.** HEAAA-78 (`BE-03`), HEAAA-104 (`BE-05`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-140 (`QA-04`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/organisation/admin/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Every admin route requires the admin realm and an elevation grant; changes are audited with before and after; feature flags per location and maintenance banner work; secrets are never returned.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-AD-01..10
- Common checks of TICKETS.md section 3 also apply.


#### BE-24 — admin API: users and roles, audit viewer and export, BTG review, privacy decisions, integration settings  (HEAAA-120)

**Ticket BE-24** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-23 |
| Owner (one) | Backend Engineer (`19109d44`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Security Reviewer (`074b2525`) |
| Conditions | C-15 |
| Requirements / rows | RA-R1-12, RA-R1-31, RA-R1-32 |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 29.4 (identity, audit, privacy, integration routes), 25.8; PRD RA-R1-11, RA-R1-12, RA-R1-31, RA-R1-32.

**Technical prerequisites.** HEAAA-104 (`BE-05`), HEAAA-76 (`BE-01`), HEAAA-110 (`BE-20`), HEAAA-80 (`BE-02`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-118 (`BE-23`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/api/src/modules/admin-routes/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Role changes follow request and different-approver flow (C4); audit export is asynchronous, size limited and itself audited; BTG review decisions are elevation-gated; integration settings save, test and show health; secrets are write-only and any secret change is audited.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- integration-db
- TC-SEC-C7-01..07, TC-AD-11..15 API parts
- Common checks of TICKETS.md section 3 also apply.


### Frontend lane (HEAAA-22)

#### FE-01 — Design system: tokens, shared components, accessibility tests  (HEAAA-75)

**Ticket FE-01** · release R1 · milestone M2 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) → UI/UX Designer (`1ddacad6`) |
| Conditions | C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: BRAND-BRIEF; UI-UX 2, 6, 8, 10, 12 (component inventory); mockups desktop and mobile.

**Technical prerequisites.** HEAAA-73 (`F-06`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-81 (`F-07`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `packages/ui/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Components listed in UI-UX 12 exist with all states of the state catalogue (UI-UX 6): loading, empty, error, forbidden, stale, offline-draft, session warning.
- Safety-critical patterns of UI-UX 8 (allergy block, alert bar and tray, destructive confirm) implemented as shared components with the specified copy hooks.
- Tokens meet WCAG 2.2 AA contrast; every component has an axe test and keyboard test; the visual identity is the placeholder until brand files exist (UX-O-01) and swapping tokens needs no component change.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit + axe per component
- visual comparison against the mockups by the UI/UX Designer (actual screenshots)
- Common checks of TICKETS.md section 3 also apply.


#### FE-02 — App shell: API client, session and realm handling, idle warning, release prompts, error pages  (HEAAA-77)

**Ticket FE-02** · release R1 · milestone M2 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 3.1, 7.1, 7.7, 6; ARCHITECTURE 26.2, 28.6.

**Technical prerequisites.** HEAAA-75 (`FE-01`), HEAAA-71 (`F-08`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `packages/app-shell/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Session warning dialog at 13 minutes with 2:00 countdown, focus and announcement; draft preserved on sign-out (X-20); extend calls `POST /auth/session/extend` only from the prompt.
- Release prompt: non-blocking bar, blocking dialog and confirm-reload as UI-UX 7.7; half-completed forms are saved or the user is warned.
- Generated client from F-08 only; no hand-written URL strings.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- TC-API-11 UX part is human (prompt wording)
- Common checks of TICKETS.md section 3 also apply.


#### FE-03 — Patient portal: sign-up, verification, passkey/MFA, sign-in  (HEAAA-91)

**Ticket FE-03** · release R1 · milestone M3 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 3.1, 4 (J-02: PP-01..05); PRD RA-R1-01.

**Technical prerequisites.** HEAAA-77 (`FE-02`), HEAAA-82 (`BE-04`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-95 (`INT-01`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/patient/src/features/auth/**`
- `apps/patient/src/app/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- PP-01..PP-05 work end to end against the real API on `ci`; OTP fields accept paste and autofill; passkey and security-key paths are offered first; no cognitive test.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- Playwright PR subset
- axe
- Common checks of TICKETS.md section 3 also apply.


#### FE-04 — Patient portal: book, reschedule, cancel, waitlist  (HEAAA-107)

**Ticket FE-04** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) → UI/UX Designer (`1ddacad6`) |
| Conditions | C-07, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (J-04, J-05: PP-10..19), 7.2; mockup desktop 2, phone 2; PRD RA-R1-02, RA-R1-22.

**Technical prerequisites.** HEAAA-91 (`FE-03`), HEAAA-94 (`BE-12`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-101 (`SEC-03`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/patient/src/features/booking/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- PP-10..PP-14 and PP-15..PP-19 work against the real API; slot-taken error shows alternatives; hold countdown follows 7.2; add-to-calendar produces a valid .ics.
- Cancellation text uses the configured policy (block-only default); no fee is shown or charged.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- Playwright PR subset (booking race UI part)
- axe
- Common checks of TICKETS.md section 3 also apply.


#### FE-05 — Patient portal: profile, proxies, notification preferences, privacy, messages (flagged)  (HEAAA-127)

**Ticket FE-05** · release R1 · milestone M4 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-04, C-05, C-07, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (PP-06..09, PP-24, PP-35..37); PRD RA-R1-14, RA-R1-19, RA-R1-20a.

**Technical prerequisites.** HEAAA-91 (`FE-03`), HEAAA-86 (`BE-08`), HEAAA-110 (`BE-20`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-125 (`FE-10`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/patient/src/features/profile/**`
- `apps/patient/src/features/privacy/**`
- `apps/patient/src/features/messages/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Profile edits are shown and audited; proxy sees appointments only (D-7 default); preferences cannot switch off safety-critical notices; privacy request and deletion request screens record the request without promising deletion (D-8).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- Playwright PR subset
- axe
- Common checks of TICKETS.md section 3 also apply.


#### FE-06 — Shared documents UI: upload with scan state, classification, list and viewer  (HEAAA-105)

**Ticket FE-06** · release R1 · milestone M4 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (SH-01, SH-02, J-19); PRD RA-R1-13.

**Technical prerequisites.** HEAAA-77 (`FE-02`), HEAAA-92 (`BE-10`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-107 (`FE-04`) (agent), HEAAA-124 (`INT-02`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `packages/app-shell/src/documents/**`
- `apps/staff/src/features/documents/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Upload with progress and scan states; a file cannot be opened before clean; quarantined file shown with reason; classification confirm by staff.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Playwright PR subset
- Common checks of TICKETS.md section 3 also apply.


#### FE-07 — Patient portal: pre-visit forms, consents, insurance upload, waiting room, device check and join  (HEAAA-128)

**Ticket FE-07** · release R1 · milestone M4 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) → UI/UX Designer (`1ddacad6`) |
| Conditions | C-03, C-06, C-10, C-11, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (PP-21..23, PP-25..27; J-06, J-07, J-08), 8; mockup phone 3; PRD RA-R1-21, RA-R1-10.

**Technical prerequisites.** HEAAA-107 (`FE-04`), HEAAA-105 (`FE-06`), HEAAA-102 (`BE-18`), HEAAA-112 (`BE-15`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-127 (`FE-05`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/patient/src/features/previsit/**`
- `apps/patient/src/features/telehealth/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Questionnaire, e-signed consents and insurance card upload show per-item status; a required consent not signed keeps the consultation gate closed; emergency advice screen PP-22 shown on red-flag answers.
- Device check and join; both time zones shown when they differ; location confirmation before joining.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- TC-TH-01..05 need the video sandbox and stay BLOCKED (C-10, C-11)
- Common checks of TICKETS.md section 3 also apply.


#### FE-08 — Staff portal: Google sign-in, session shell, role navigation  (HEAAA-93)

**Ticket FE-08** · release R1 · milestone M4 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 3.1, 3.2, 4 (SH-03, SH-05, SH-06), 7.1; PRD RA-R1-01.

**Technical prerequisites.** HEAAA-77 (`FE-02`), HEAAA-82 (`BE-04`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-105 (`FE-06`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/src/features/auth/**`
- `apps/staff/src/app/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- "Continue with Google" is the only staff sign-in; a non-enrolled account sees the plain contact-IT message; role-based navigation follows the navigation map; idle warning and signed-out screens work; no PHI in URLs.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Playwright PR subset against the local OIDC conformance IdP
- Common checks of TICKETS.md section 3 also apply.


#### FE-17 — Staff portal: administrator sign-in, security-key elevation dialog, realm banner and realm switch  (HEAAA-121)

**Ticket FE-17** · release R1 · milestone M5 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) → UI/UX Designer (`1ddacad6`) |
| Conditions | C-02, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 3.1, 4 (SH-04), 7.1; ARCHITECTURE 26.1; PRD RA-R1-32.

**Technical prerequisites.** HEAAA-93 (`FE-08`), HEAAA-104 (`BE-05`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-136 (`FE-16`) (agent), HEAAA-120 (`BE-24`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/src/features/admin-auth/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Separate "Administrator sign-in" with security key; fixed admin banner "Administrator sign-in. Clinical data is not available here."; elevation dialog names the action, target and approver and shows the "Elevated until" chip; realm switch signs out and in and keeps drafts where the screen supports them.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Playwright PR subset
- physical-key cases are Pending-human
- Common checks of TICKETS.md section 3 also apply.


#### FE-09 — Pre-consultation desk: arrivals board, check-in, forms review, triage panel, red-flag bar, queues, duplicate and merge  (HEAAA-119)

**Ticket FE-09** · release R1 · milestone M4 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) → UI/UX Designer (`1ddacad6`) |
| Conditions | C-03, C-08, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (PC-01..PC-08), 7.3, 7.4, 8; mockup desktop 3; PRD RA-R1-06, RA-R1-07, RA-R1-27, RA-R1-29, RA-R1-30.

**Technical prerequisites.** HEAAA-93 (`FE-08`), HEAAA-105 (`FE-06`), HEAAA-102 (`BE-18`), HEAAA-88 (`BE-09`), HEAAA-100 (`BE-13`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-129 (`FE-15`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/src/features/preconsult/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- The red-flag bar reads "Red flag raised. The on-duty doctor has been alerted." (UXR-08 option B as in draft 6) and offers no action; allergy block in the banner follows 8 including `null` states.
- Duplicate warning at registration and the merge request/approval screens follow 7.3; unauthorised users do not see merge actions.
- Arrivals, check-in (including QR), forms review, triage with vitals and out-of-range highlighting, queue with wait time, follow-up and no-show queues work against the real API.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Playwright PR subset
- TC-PC-15 legibility is human
- Common checks of TICKETS.md section 3 also apply.


#### FE-10 — Doctor portal: schedule, patient list, chart summary, note editor, sign, addenda, co-sign, alert tray, BTG dialog  (HEAAA-125)

**Ticket FE-10** · release R1 · milestone M4 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) → UI/UX Designer (`1ddacad6`) |
| Conditions | C-03, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (DR-01..DR-10), 7.1, 7.4, 8; mockup desktop 4, phone 6; PRD RA-R1-09, RA-R1-11, RA-R1-24, RA-R1-25.

**Technical prerequisites.** HEAAA-93 (`FE-08`), HEAAA-105 (`FE-06`), HEAAA-108 (`BE-17`), HEAAA-102 (`BE-18`), HEAAA-98 (`BE-07`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-119 (`FE-09`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/src/features/doctor/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Chart summary shows name, DOB and photo (BR-34) and the allergy block; note editor with sign dialog re-authenticating when the server answers `401 auth.reauth_required`; addenda and co-sign queue; alert tray with paused-stream state.
- BTG reason dialog; out-of-assignment access is refused until a reason is entered.
- Video plus notes side by side (DR-04) against the video adapter interface only.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Playwright PR subset
- Common checks of TICKETS.md section 3 also apply.


#### FE-11 — Doctor portal: availability templates, leave and blocked time, Google Calendar connection  (HEAAA-123)

**Ticket FE-11** · release R1 · milestone M4 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-10, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (DR-11..DR-13); PRD RA-R1-04, RA-R1-23.

**Technical prerequisites.** HEAAA-93 (`FE-08`), HEAAA-94 (`BE-12`), HEAAA-106 (`BE-14`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-128 (`FE-07`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/src/features/availability/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Weekly templates, leave and blocked time show affected appointments before saving; calendar connect shows consent text and connected/disconnected/error states and the busy-only note.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Common checks of TICKETS.md section 3 also apply.


#### FE-12 — Staff tasks and secure messages  (HEAAA-131)

**Ticket FE-12** · release R1 · milestone M4 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-07, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (DR-08, PP-37 staff side); PRD RA-R1-25.

**Technical prerequisites.** HEAAA-93 (`FE-08`), HEAAA-116 (`BE-19`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-123 (`FE-11`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/src/features/messages/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Create and complete tasks; send secure staff messages; thread list and thread views meet the list-detail pattern.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Common checks of TICKETS.md section 3 also apply.


#### FE-13 — Admin portal: audit log, BTG review, users and roles with approvals, privacy requests  (HEAAA-132)

**Ticket FE-13** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) → UI/UX Designer (`1ddacad6`) |
| Conditions | C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (AD-01, AD-02, AD-03, AD-05); mockup desktop 6; PRD RA-R1-11, RA-R1-12, RA-R1-14, RA-R1-32.

**Technical prerequisites.** HEAAA-121 (`FE-17`), HEAAA-120 (`BE-24`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/src/features/admin-compliance/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Audit table with filters and export (async job state and notification); BTG review panel; role change request and approval screens enforce different-approver in the UI messages (server enforces).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Playwright PR subset
- Common checks of TICKETS.md section 3 also apply.


#### FE-14 — Admin portal: clinics, services, policies, templates, integrations, flags, banners, vital ranges  (HEAAA-134)

**Ticket FE-14** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (AD-04, AD-06..AD-10); PRD RA-R1-15, RA-R1-26, RA-R1-31.

**Technical prerequisites.** HEAAA-121 (`FE-17`), HEAAA-118 (`BE-23`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-132 (`FE-13`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/staff/src/features/admin-config/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Configuration screens save with audit; secrets fields are write-only; integration test and health shown; booking policy supports block-only cancellation; neutral display name for condition-revealing services.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- axe
- Playwright PR subset
- Common checks of TICKETS.md section 3 also apply.


#### FE-15 — Brand site: pages, directory, booking hand-off, SEO, cookie consent  (HEAAA-129)

**Ticket FE-15** · release R1 · milestone M4 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-19, C-16 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: UI-UX 4 (BS-01..BS-07); BRAND-BRIEF; ARCHITECTURE 3.1 (`site`); PRD RA-R1-16.

**Technical prerequisites.** HEAAA-75 (`FE-01`), HEAAA-114 (`BE-22`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-93 (`FE-08`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/site/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Pages for services, doctors (with next available slot), locations and contact; "Book" hands off to `my.` with service and doctor pre-selected by opaque ID; analytics receive no health data and load only after cookie consent; SEO metadata, sitemap and structured data present.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- Lighthouse CI
- axe
- TC-BS-01..12 automated parts
- Common checks of TICKETS.md section 3 also apply.


#### FE-16 — CMS configuration: editor, marketing sign-in, branding of login and preview  (HEAAA-136)

**Ticket FE-16** · release R1 · milestone M4 · size M (2 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-22 |
| Owner (one) | Frontend Engineer (`2d280e70`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | C-19 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: ARCHITECTURE 3.1 (`cms`), 7 (CMS row); UI-UX 4 (Brand-site CMS), UX-O-02; PRD RA-R1-16.

**Technical prerequisites.** HEAAA-129 (`FE-15`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-131 (`FE-12`) (agent), HEAAA-126 (`SEC-08`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `apps/cms/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- A marketing user edits and publishes pages without developer help; CMS admins sign in through a separate OAuth client limited to a marketing group; the CMS has no path or credential to the production database.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- unit
- TC-BS-03 is Pending-human (marketing user)
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Needs the owner decision on CMS runtime vs SaaS CMS (C-19) before any work; Orchestrator promotes after the decision.


### DevOps lane (HEAAA-24)

#### DO-01 — IaC baseline: state backend, accounts and OU structure files, network, KMS  (HEAAA-83)

**Ticket DO-01** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Security Reviewer (`074b2525`) |
| Conditions | C-12, C-21 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 3.1-3.3, 7.5; ARCHITECTURE 7 (hosting), 9.4.

**Technical prerequisites.** HEAAA-81 (`F-07`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-104 (`BE-05`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `infra/bootstrap/**`
- `infra/modules/network/**`
- `infra/modules/kms/**`
- `infra/accounts/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Authored and validated only; nothing is applied. State is versioned and replicated in a tooling account; one root per account.
- The `us-east-1` exemption list and SCP owner are stated as assumptions pending C-12 and C-21.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- terraform/opentofu fmt, validate, tflint, Checkov or Trivy config scan, plan output as artifact (no apply anywhere)
- Common checks of TICKETS.md section 3 also apply.


#### DO-02 — IaC data tier: RDS PostgreSQL 17 Multi-AZ, buckets, audit archive, backup vault, cross-region copy  (HEAAA-99)

**Ticket DO-02** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Security Reviewer (`074b2525`) |
| Conditions | C-01, C-12 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 3.2, 5.2, 8, 10.1; ARCHITECTURE 9.3, 9.4; SHARED-BOUNDARIES 8.1.

**Technical prerequisites.** HEAAA-83 (`DO-01`), HEAAA-69 (`F-03`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-97 (`DO-06`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `infra/modules/database/**`
- `infra/modules/storage/**`
- `infra/modules/archive/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Parameter group sets role-level `transaction_timeout` readably (Unverified until proven on a real RDS instance in staging, C-01); quarantine and clean buckets; Object Lock in the log-archive account; production roles cannot delete from the archive.
- The RDS master user appears in no application configuration.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- terraform/opentofu fmt, validate, tflint, Checkov or Trivy config scan, plan output as artifact (no apply anywhere)
- Common checks of TICKETS.md section 3 also apply.


#### DO-03 — IaC compute and edge: ECS Fargate services, ALB, CloudFront and WAF, portal hosts  (HEAAA-85)

**Ticket DO-03** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) |
| Conditions | C-01, C-12 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 3.2, 6.2, 12; ARCHITECTURE 3.1 (hosts, `/api/*` behaviour, `integrations.`), 32.3 (SSE).

**Technical prerequisites.** HEAAA-83 (`DO-01`), HEAAA-74 (`F-05`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `infra/modules/compute/**`
- `infra/modules/edge/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `/api/*` caching disabled with cookies and `Authorization` forwarded; `release.json` behaviour forwards no cookie and never reaches the API; the `integrations.` host accepts no cookies; SSE idle/timeouts are set as 32.3 requires (Unverified until staging).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- terraform/opentofu fmt, validate, tflint, Checkov or Trivy config scan, plan output as artifact (no apply anywhere)
- Common checks of TICKETS.md section 3 also apply.


#### DO-04 — IaC identity, secrets and CI trust: Cognito pools, secret store, OIDC roles denied by default, approval-by-apply  (HEAAA-87)

**Ticket DO-04** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Security Reviewer (`074b2525`) |
| Conditions | C-12, C-13, C-14 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 4.1 (A1, A2), 7.1-7.5; ARCHITECTURE 7 (identity rows).

**Technical prerequisites.** HEAAA-83 (`DO-01`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-85 (`DO-03`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `infra/modules/identity/**`
- `infra/modules/secrets/**`
- `infra/modules/ci-trust/**`
- `infra/approvals/** (structure only)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Every `gh-*` role is denied until an approved-release record is applied by a human platform admin; role trust conditions carry repository, environment, ref and workflow ref; DPR-37 (staging apply role) and DPR-38 (named creator of loadtest, bootstrap and ENV-DR stacks) are resolved in the code and the plan text correction is routed to the Solution Architect Reviewer.
- Where GitHub plan features are absent the evidence says procedural only (C-13).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- terraform/opentofu fmt, validate, tflint, Checkov or Trivy config scan, plan output as artifact (no apply anywhere)
- Common checks of TICKETS.md section 3 also apply.


#### DO-05 — build-release workflow: build once, sign, SBOM, provenance, release manifest and release numbering  (HEAAA-89)

**Ticket DO-05** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) |
| Conditions | C-13, C-01 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 4.2 (`build-release.yml`), 6.1, 6.2 (DEV-1 producer side).

**Technical prerequisites.** HEAAA-81 (`F-07`), HEAAA-79 (`F-09`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-87 (`DO-04`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `.github/workflows/build-release.yml`
- `scripts/release/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Release manifest lists image digests, bundle hashes, lockfile hash, migrations and `releaseNumber`; `r<n>.<sha12>` is embedded in bundles and `release.json`; `min_client_release` is the previous release number; an older build finishing late fails the `release_number` check by design.
- Runs only to build and publish artifacts to the build registry authorised for it; no deploy step.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- actionlint
- dry-run on a branch with artifacts inspected
- refusal-path CI test for the client release (with F-05)
- Common checks of TICKETS.md section 3 also apply.


#### DO-06 — Deploy workflows (authored, disabled): staging, production, marketing; migration task; smoke and observation jobs  (HEAAA-97)

**Ticket DO-06** · release R1 · milestone M5 · size XL (5 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Security Reviewer (`074b2525`) |
| Conditions | C-01, C-14 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 4.2, 6.2, 7.4, 8, 9, 15.3; DPR-35, DPR-37, DPR-39.

**Technical prerequisites.** HEAAA-89 (`DO-05`), HEAAA-85 (`DO-03`), HEAAA-87 (`DO-04`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `.github/workflows/deploy-staging.yml`
- `.github/workflows/deploy-production.yml`
- `.github/workflows/deploy-marketing.yml`
- `scripts/deploy/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `deploy-production.yml` is manual dispatch only and verifies the digest against the approved-release record read from the production account; concurrency group `production-release` with no cancel; the observation job is read-only.
- DPR-37, DPR-38, DPR-39 (task definitions pinned by ARN, gate-check read actions, `gh-nightly-staging` row) are done before the staging workflow is enabled. Workflows are committed with no environment secrets and are not enabled for any environment (C-01).
- Credentials for any environment are not provided to agents before the matching authorisation (WORKFLOW Stage 5).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- actionlint
- policy scan
- dry-run against a local stub of the release manifest
- Common checks of TICKETS.md section 3 also apply.


#### DO-07 — Observability as code: telemetry, dashboards, alarms, synthetic checks, PHI scrubbing  (HEAAA-103)

**Ticket DO-07** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) |
| Conditions | C-12, C-18 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 11.1-11.4, 12; PRD NFR-1..4, NFR-20, NFR-21.

**Technical prerequisites.** HEAAA-85 (`DO-03`), HEAAA-74 (`F-05`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-99 (`DO-02`) (agent), HEAAA-137 (`SEC-05`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `infra/modules/observability/**`
- `apps/api/src/telemetry/** (only the OpenTelemetry wiring)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Every alert has owner, impact, first diagnostic step and runbook link; SLO table matches the approved targets; telemetry contains no synthetic PHI canary values; synthetic canary writes in production stay off until DEVOPS-PLAN 16 item 12 is decided.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- terraform/opentofu fmt, validate, tflint, Checkov or Trivy config scan, plan output as artifact (no apply anywhere)
- PHI canary test over telemetry output
- Common checks of TICKETS.md section 3 also apply.


#### DO-08 — Backup, restore and DR automation: restore-test workflow, PITR procedure, DR rehearsal stack  (HEAAA-111)

**Ticket DO-08** · release R1 · milestone M6 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) |
| Conditions | C-01, C-12, C-21 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 10.1-10.5; ARCHITECTURE 9.4; PRD NFR-2, NFR-3.

**Technical prerequisites.** HEAAA-99 (`DO-02`), HEAAA-97 (`DO-06`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-103 (`DO-07`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `.github/workflows/restore-test.yml`
- `infra/modules/dr/**`
- `scripts/restore/**`
- `docs/runbooks/restore.md`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- The restore-test procedure is scripted and runs only in the `restore-test` boundary; QA receives only PHI-free counts, hashes and timings; the DR rehearsal stack is created from IaC in the staging account and destroyed after.
- RPO 15 min and RTO 4 h are targets here, not claims; evidence comes from later rehearsals (DEP-16).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- terraform/opentofu fmt, validate, tflint, Checkov or Trivy config scan, plan output as artifact (no apply anywhere)
- script lint
- Common checks of TICKETS.md section 3 also apply.


#### DO-09 — Operational workflows: infra, nightly, dependency updates  (HEAAA-113)

**Ticket DO-09** · release R1 · milestone M6 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) |
| Conditions | C-12, C-14 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 4.2 (`infra.yml`, `nightly.yml`, `dependabot.yml`), DPR-39.

**Technical prerequisites.** HEAAA-87 (`DO-04`), HEAAA-97 (`DO-06`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-111 (`DO-08`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `.github/workflows/infra.yml`
- `.github/workflows/nightly.yml`
- `.github/dependabot.yml (extends F-02)`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `infra.yml` plans on PR and applies only per protected environment role; `nightly.yml` is read-only and uses `gh-nightly-staging`; Dependabot covers npm, Docker, Actions SHA pins and Terraform providers.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- actionlint
- policy scan
- Common checks of TICKETS.md section 3 also apply.


#### DO-10 — Dual-control workflows: audit archive and first-admin bootstrap  (HEAAA-138)

**Ticket DO-10** · release R1 · milestone M6 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) → Security Reviewer (`074b2525`) |
| Conditions | C-13, C-02 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 4.2 (`audit-archive.yml`, `bootstrap.yml`), 16.2; ARCHITECTURE 6, 26.3, 33.1 (`identity.bootstrap_admins`).

**Technical prerequisites.** HEAAA-87 (`DO-04`), HEAAA-104 (`BE-05`), HEAAA-76 (`BE-01`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-113 (`DO-09`) (agent), HEAAA-115 (`SEC-06`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `.github/workflows/audit-archive.yml`
- `.github/workflows/bootstrap.yml`
- `scripts/bootstrap/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Roles are enabled only by approval-by-apply with two distinct human approvals; token retrieval follows 16.2 (a custodian never reads their own token); the job refuses if any admin exists.
- With one human in the project this cannot run; the ticket records "authored, cannot execute" rather than faking dual control (RK-5, C-13).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- actionlint
- policy scan
- runbook walk-through on `ENV-INT/bootstrap` is BLOCKED until a second human exists
- Common checks of TICKETS.md section 3 also apply.

**Note.** Authoring does not need a second human; execution does (DEVOPS-PLAN 16 item 2, RK-5).


#### DO-11 — Load-test environment and k6 harness plumbing  (HEAAA-117)

**Ticket DO-11** · release R1 · milestone M6 · size L (3 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-24 |
| Owner (one) | DevOps Engineer (`021d733c`) |
| Independent reviewer stages (in order) | DevOps Reviewer (`fe9b5f91`) |
| Conditions | C-17, C-22, C-12 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: DEVOPS-PLAN 3.4, 5.3, 13.1, 14; TEST-CASES 0.3 (`ENV-LOAD`), 11.2.

**Technical prerequisites.** HEAAA-99 (`DO-02`), HEAAA-85 (`DO-03`), HEAAA-79 (`F-09`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-138 (`DO-10`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `infra/modules/loadtest/**`
- `tests/load/harness/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- `loadtest` is production-equivalent and created from IaC with generated synthetic volume; k6 driving SSE is verified or a small custom client is proposed.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- terraform/opentofu fmt, validate, tflint, Checkov or Trivy config scan, plan output as artifact (no apply anywhere)
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Blocked until the owner approves the load-environment cost (DEP-14/D-25) and the k6 licence use (C-22).


### Integration lane (HEAAA-26)

#### INT-01 — Integrate M2 platform: audit, integration-core, organisation, identity core, notifications; first real authentication slice  (HEAAA-95)

**Ticket INT-01** · release R1 · milestone M2 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-26 |
| Owner (one) | Integrator (`6c8729d5`) |
| Independent reviewer stages (in order) | QA Engineer (`a2336f9b`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: WORKFLOW Stage 3 (integrated journeys); HEAAA-20 closure note (auth slice deferred here).

**Technical prerequisites.** HEAAA-76 (`BE-01`), HEAAA-80 (`BE-02`), HEAAA-78 (`BE-03`), HEAAA-82 (`BE-04`), HEAAA-84 (`BE-06`), HEAAA-77 (`FE-02`), HEAAA-79 (`F-09`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `integration branch only (merge commits, conflict resolution of lockfile by re-resolution)`
- `docs/evidence/integration/<milestone>/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Merged in dependency order with reviewed branches only; the journey browser -> same-origin API -> OIDC conformance IdP -> session -> scoped read -> audit event runs on the combined revision.
- Real Google Workspace sign-in remains BLOCKED (C-10) and is stated as such.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Combined candidate built from a clean frozen install; relevant CI jobs rerun on the merged revision
- Evidence read by the QA Engineer from raw reports
- Common checks of TICKETS.md section 3 also apply.


#### INT-02 — Integrate M3 booking slice: patient, merge, scheduling, calendar, telehealth, documents, patient booking UI, brand site shell  (HEAAA-124)

**Ticket INT-02** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-26 |
| Owner (one) | Integrator (`6c8729d5`) |
| Independent reviewer stages (in order) | QA Engineer (`a2336f9b`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: WORKFLOW Stage 3.

**Technical prerequisites.** HEAAA-95 (`INT-01`), HEAAA-98 (`BE-07`), HEAAA-86 (`BE-08`), HEAAA-88 (`BE-09`), HEAAA-92 (`BE-10`), HEAAA-90 (`BE-11`), HEAAA-94 (`BE-12`), HEAAA-100 (`BE-13`), HEAAA-106 (`BE-14`), HEAAA-112 (`BE-15`), HEAAA-114 (`BE-22`), HEAAA-91 (`FE-03`), HEAAA-107 (`FE-04`), HEAAA-101 (`SEC-03`), HEAAA-122 (`SEC-04`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `integration branch only (merge commits, conflict resolution of lockfile by re-resolution)`
- `docs/evidence/integration/<milestone>/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- The booking journey (register, book, reminder, reschedule, cancel, waitlist) runs end to end on the combined revision against PostgreSQL 17 including the 100-parallel-confirmation race and a merge-versus-booking race, and a merge across every registered participant asserts found = re-pointed + resolved + kept for each (38.2 item 11).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Combined candidate built from a clean frozen install; relevant CI jobs rerun on the merged revision
- Evidence read by the QA Engineer from raw reports
- Common checks of TICKETS.md section 3 also apply.


#### INT-03 — Integrate M4 clinical and front desk: clinical, messaging, privacy, reporting, staff and patient portals, brand site  (HEAAA-133)

**Ticket INT-03** · release R1 · milestone M4 · size L (3 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-26 |
| Owner (one) | Integrator (`6c8729d5`) |
| Independent reviewer stages (in order) | QA Engineer (`a2336f9b`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: WORKFLOW Stage 3.

**Technical prerequisites.** HEAAA-124 (`INT-02`), HEAAA-126 (`SEC-08`), HEAAA-96 (`BE-16`), HEAAA-108 (`BE-17`), HEAAA-102 (`BE-18`), HEAAA-116 (`BE-19`), HEAAA-110 (`BE-20`), HEAAA-130 (`BE-21`), HEAAA-127 (`FE-05`), HEAAA-105 (`FE-06`), HEAAA-128 (`FE-07`), HEAAA-119 (`FE-09`), HEAAA-125 (`FE-10`), HEAAA-123 (`FE-11`), HEAAA-131 (`FE-12`), HEAAA-129 (`FE-15`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `integration branch only (merge commits, conflict resolution of lockfile by re-resolution)`
- `docs/evidence/integration/<milestone>/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Arrival, triage, red-flag alert mechanics, consultation, note signing and co-signing, documents, messaging and privacy request journeys run on the combined revision; red-flag rule content remains BLOCKED on D-12a where stated. A merge across all registered participants (clinical, messaging, telehealth included) asserts found = re-pointed + resolved + kept, and a privacy export contains a part from every registered contributor.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Combined candidate built from a clean frozen install; relevant CI jobs rerun on the merged revision
- Evidence read by the QA Engineer from raw reports
- Common checks of TICKETS.md section 3 also apply.


#### INT-04 — Integrate M5 administration and controls: admin realm, admin API and portal, IaC and pipelines authored so far  (HEAAA-139)

**Ticket INT-04** · release R1 · milestone M5 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-26 |
| Owner (one) | Integrator (`6c8729d5`) |
| Independent reviewer stages (in order) | QA Engineer (`a2336f9b`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: WORKFLOW Stage 3.

**Technical prerequisites.** HEAAA-133 (`INT-03`), HEAAA-104 (`BE-05`), HEAAA-118 (`BE-23`), HEAAA-120 (`BE-24`), HEAAA-121 (`FE-17`), HEAAA-132 (`FE-13`), HEAAA-134 (`FE-14`), HEAAA-135 (`SEC-02`), HEAAA-137 (`SEC-05`), HEAAA-89 (`DO-05`), HEAAA-97 (`DO-06`), HEAAA-103 (`DO-07`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `integration branch only (merge commits, conflict resolution of lockfile by re-resolution)`
- `docs/evidence/integration/<milestone>/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- C1, C4 and C6 run as tests on the combined revision; admin configuration, audit viewer and BTG review run end to end; pipelines are re-linted on the merged tree.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Combined candidate built from a clean frozen install; relevant CI jobs rerun on the merged revision
- Evidence read by the QA Engineer from raw reports
- Common checks of TICKETS.md section 3 also apply.


#### INT-05 — Integrate R1 release candidate and run the complete combined check set  (HEAAA-141)

**Ticket INT-05** · release R1 · milestone M6 · size M (2 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-26 |
| Owner (one) | Integrator (`6c8729d5`) |
| Independent reviewer stages (in order) | QA Engineer (`a2336f9b`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: WORKFLOW Stage 3 (BUILD_REVIEW input).

**Technical prerequisites.** HEAAA-139 (`INT-04`), HEAAA-136 (`FE-16`), HEAAA-111 (`DO-08`), HEAAA-113 (`DO-09`), HEAAA-138 (`DO-10`), HEAAA-115 (`SEC-06`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `integration branch only (merge commits, conflict resolution of lockfile by re-resolution)`
- `docs/evidence/integration/<milestone>/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Full required CI check set on the candidate revision with raw reports; candidate manifest (commit, lockfile hash, image digests where built, configuration) written; known blocked or pending items are listed with their condition IDs.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Combined candidate built from a clean frozen install; relevant CI jobs rerun on the merged revision
- Evidence read by the QA Engineer from raw reports
- Common checks of TICKETS.md section 3 also apply.


### QA automation (HEAAA-29)

#### QA-01 — Test errata revision: TC-API duplicate ID, TC-AU-04 step 2, POR-02..04, SA-TC-07..10 (document only)  (HEAAA-70)

**Ticket QA-01** · release R1 · milestone M1 · size S (1 effort points) · status at creation: **Blocked until prerequisites are done**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-29 |
| Owner (one) | QA Engineer (`a2336f9b`) |
| Independent reviewer stages (in order) | Solution Architect Reviewer (`338c0bb5`) → Product Owner Reviewer (`ba4f7e4a`) |
| Conditions | C-15 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: TEST-CASES draft 5; HEAAA-62 and HEAAA-63 review findings; design-align section 2.

**Technical prerequisites.** HEAAA-64 (`F-00`)

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-68 (`F-02`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `docs/TEST-CASES.md`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Duplicate `TC-API-10` renumbered (new case `TC-API-11`) with every reference updated and a duplicate-ID check; TC-AU-04 step 2 uses `transaction_timeout = 61s` and expects refusal; POR-02..04 and the open SA-TC items are closed or carried by name; no new scope.
- Cases that need a missing decision keep their BLOCKED marker.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- Diff-only review by the Solution Architect Reviewer and the Product Owner Reviewer
- Common checks of TICKETS.md section 3 also apply.

**Note.** Changes an approved G2 document; the human QA owner re-accepts the new revision. This is a bounded errata revision, not a new review round on the old one (cumulative ledger is NOT reset).


#### QA-02 — Automation harness: Playwright, Schemathesis, synthetic data generators, test accounts for `ENV-INT/ci`  (HEAAA-109)

**Ticket QA-02** · release R1 · milestone M3 · size L (3 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-29 |
| Owner (one) | QA Engineer (`a2336f9b`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) → Backend Reviewer (`472e0e86`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: TEST-CASES 0.2, 0.3, 2, 3; DEVOPS-PLAN 5.1, 5.3, 14.

**Technical prerequisites.** HEAAA-95 (`INT-01`), HEAAA-70 (`QA-01`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-91 (`FE-03`) (slot)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `tests/e2e/harness/**`
- `tests/api/harness/**`
- `tests/data/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Role accounts and synthetic data of TEST-CASES 2 and 3 are generated deterministically; no real personal data; credentials come from the environment, never the repository.
- Results are written as JUnit XML plus trace archives with tool versions, candidate commit and environment name.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- harness self-tests
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Created in Backlog. The Orchestrator promotes when a worker slot is free after INT-02; QA authoring is a third writer and is not part of the initial two-worker batch.


#### QA-03 — Automated cases: identity, authorization and security (TC-ID, TC-AZ, TC-SEC, TC-SEC-C7)  (HEAAA-144)

**Ticket QA-03** · release R1 · milestone M5 · size L (3 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-29 |
| Owner (one) | QA Engineer (`a2336f9b`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: TEST-CASES 4, 5, 6; RA-R1-01, RA-R1-17, RA-R1-32.

**Technical prerequisites.** HEAAA-109 (`QA-02`), HEAAA-139 (`INT-04`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-143 (`QA-05`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `tests/api/identity/**`
- `tests/api/authorization/**`
- `tests/api/security/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- Every case marked AUTO and not BLOCKED is a script that fails for the right reason; HUMAN and OPS cases are not scripted and stay Pending-human.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- run on `ENV-INT/ci`
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Created in Backlog. The Orchestrator promotes when a worker slot is free after INT-02; QA authoring is a third writer and is not part of the initial two-worker batch.


#### QA-04 — Automated cases: booking, calendar, notifications, pre-consultation, safety mechanics, clinical  (HEAAA-140)

**Ticket QA-04** · release R1 · milestone M4 · size XL (5 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-29 |
| Owner (one) | QA Engineer (`a2336f9b`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Frontend Reviewer (`b0c4372e`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: TEST-CASES 7, 8; RA-R1-02..10, RA-R1-22..24, RA-R1-29, RA-R1-30.

**Technical prerequisites.** HEAAA-109 (`QA-02`), HEAAA-133 (`INT-03`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** none

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `tests/api/booking/**`
- `tests/api/clinical/**`
- `tests/e2e/journeys/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- TC-BK, TC-CAL, TC-NT, TC-PC, TC-SAF, TC-CL automated parts; TC-SAF acceptance stays BLOCKED on D-12a; mechanics run.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- run on `ENV-INT/ci`
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Created in Backlog. The Orchestrator promotes when a worker slot is free after INT-02; QA authoring is a third writer and is not part of the initial two-worker batch.


#### QA-05 — Automated cases: telehealth, audit, documents, privacy, admin, brand site, messaging, merge, API conventions  (HEAAA-143)

**Ticket QA-05** · release R1 · milestone M5 · size XL (5 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-29 |
| Owner (one) | QA Engineer (`a2336f9b`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) → Frontend Reviewer (`b0c4372e`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: TEST-CASES 9, 10; RA-R1-11..16, RA-R1-19..21, RA-R1-25..27, RA-R1-31.

**Technical prerequisites.** HEAAA-109 (`QA-02`), HEAAA-139 (`INT-04`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-140 (`QA-04`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `tests/api/platform/**`
- `tests/e2e/admin/**`
- `tests/e2e/site/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- TC-TH, TC-AU, TC-DOC, TC-PR, TC-AD, TC-BS, TC-PP, TC-MSG, TC-MG, TC-API automated parts; vendor-dependent cases stay BLOCKED naming the missing sandbox (never mocked as pass).

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- run on `ENV-INT/ci`
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Created in Backlog. The Orchestrator promotes when a worker slot is free after INT-02; QA authoring is a third writer and is not part of the initial two-worker batch.


#### QA-06 — Automated accessibility and browser matrix (TC-A11Y, TC-XB automated parts)  (HEAAA-145)

**Ticket QA-06** · release R1 · milestone M5 · size M (2 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-29 |
| Owner (one) | QA Engineer (`a2336f9b`) |
| Independent reviewer stages (in order) | Frontend Reviewer (`b0c4372e`) |
| Conditions | none beyond G2 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: TEST-CASES 11.1; NFR-10, NFR-11.

**Technical prerequisites.** HEAAA-109 (`QA-02`), HEAAA-139 (`INT-04`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-144 (`QA-03`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `tests/e2e/a11y/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- axe on every key page of each portal and the brand site; Chromium, Firefox and WebKit builds; assistive-technology and real-device cases remain Pending-human.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- run on `ENV-INT/ci`
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Created in Backlog. The Orchestrator promotes when a worker slot is free after INT-02; QA authoring is a third writer and is not part of the initial two-worker batch.


#### QA-07 — Load, resilience and recovery scripts (TC-PERF, TC-REC automated parts)  (HEAAA-146)

**Ticket QA-07** · release R1 · milestone M6 · size M (2 effort points) · status at creation: **Backlog (held)**

| Field | Value |
| --- | --- |
| Lane (parent) | HEAAA-29 |
| Owner (one) | QA Engineer (`a2336f9b`) |
| Independent reviewer stages (in order) | Backend Reviewer (`472e0e86`) |
| Conditions | C-17 |
| Requirements / rows | see source column |

**Source and design revisions.** Frozen manifest in DELIVERY-PLAN section 2 (G2 candidate revisions; `design-align` rev `ea043d8d`). Sections used: TEST-CASES 11.2, 11.3; NFR-6..9.

**Technical prerequisites.** HEAAA-109 (`QA-02`), HEAAA-117 (`DO-11`)

**Gate prerequisites.** HEAAA-21

**Scheduling prerequisites (two-worker cap; removable by the Orchestrator when the cap is raised, never the technical ones).** HEAAA-145 (`QA-06`) (agent)

**Allowed paths (write).** Anything else is out of scope; a needed change elsewhere is a request to the Orchestrator, not an edit.
- `tests/load/**`

**Acceptance (each is observable; all must hold on the exact submitted revision).**
- k6 scenarios with thresholds that make the run exit non-zero; run only on `loadtest`; never scaled down to claim a pass.

**Required checks (record tool and version, candidate commit, command, raw report, result).**
- run on `ENV-LOAD`
- Common checks of TICKETS.md section 3 also apply.

**Held (Backlog).** Blocked until `loadtest` exists (C-17).


## 7. Not tickets: Backlog items

R2, R3, R4 and the enhancement list are in `DELIVERY-PLAN.md` section 14 with rationale and disposition. They have no tickets and are not authorised.
