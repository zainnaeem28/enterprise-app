# COMPLETED-TICKETS — Release 1 build (BUILD_REVIEW package)

| Field | Value |
| --- | --- |
| Task | HEAAA-27 `[SDLC:build-package]` (Orchestrator) for gate HEAAA-28 |
| Candidate | `af278307f70c626e451389bd55b86aea9e4016ce` (product tree); evidence commit `3cb45ed6a64c9bac74e9f720bbad86760626a02a`, local branch `HEAAA-141-sdlc-ticket-int-05-integrate-r1-release-candidate-and-run-the-complete-combined-check-set` (not pushed; commits reachable on `origin` via `HEAAA-27-sdlc-build-package-prepare-milestone-build-evidence-and-real-screenshots`) |
| Source of the ticket list | `docs/TICKETS.md` index (Draft 3, G2 scope); status read from Paperclip on 2026-11-10 |
| Not | Human approval, QA acceptance, G3 or deployment approval |

## 1. Result

All **83 of 83** approved G2 tickets are `done` in Paperclip, with their independent reviews recorded. Build parents HEAAA-20, 21, 22, 23, 24, 25 and integration HEAAA-26 are `done`. `done` means each ticket's own author and independent-review stages passed on its own revision; it does not mean the feature passed acceptance. Acceptance runs after this gate (HEAAA-29..32).

## 2. Approved tickets

| ID | Paperclip | Title | Parent | Owner | Size | Milestone | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | HEAAA-65 | Cybersecurity review of identity, trust-boundary and secret-handling design (SEC-1..3, O-2, O-5) | HEAAA-25 | Cybersecurity | M | M0 | done |
| ID-FREEZE | HEAAA-66 | Architecture erratum 8.2: freeze identity tables and fold carried notes (docs only) | HEAAA-25 | Solution Architect | S | M0 | done |
| F-00 | HEAAA-64 | Commit the approved design documents to the repository (byte-identical, with hash manifest) | HEAAA-20 | DevOps Engineer | S | M1 | done |
| F-01 | HEAAA-67 | Repository scaffold, pinned toolchain and frozen-lockfile install | HEAAA-20 | DevOps Engineer | M | M1 | done |
| F-02 | HEAAA-68 | Pull-request CI pipeline: required checks, SHA-pinned actions, least-privilege permissions | HEAAA-20 | DevOps Engineer | L | M1 | done |
| F-03 | HEAAA-69 | Database foundation: PostgreSQL 17 roles, grants, kernel schema, migration runner and rules | HEAAA-20 | Backend Engineer | L | M1 | done |
| F-04 | HEAAA-72 | Kernel library: transaction and scope setter, idempotency, outbox/queue, config, redacting logger, error mappi | HEAAA-20 | Backend Engineer | L | M1 | done |
| F-08 | HEAAA-71 | Transcribe the R1 API catalogue to OpenAPI 3.1 and generate shared types | HEAAA-20 | Backend Engineer | XL | M1 | done |
| F-05 | HEAAA-74 | API and worker platform layer: app shell, guard hook, release-contract check, limits, health | HEAAA-20 | Backend Engineer | L | M1 | done |
| F-06 | HEAAA-73 | Frontend slice: staff app shell calling the API same-origin through generated types | HEAAA-20 | Frontend Engineer | M | M1 | done |
| F-09 | HEAAA-79 | CI jobs that need application code: integration-db, migration-check, contract, a11y smoke, e2e smoke, bundle b | HEAAA-20 | DevOps Engineer | M | M1 | done |
| F-07 | HEAAA-81 | Foundation proof: clean frozen install, production builds, container image, UI-API-database journey on CI | HEAAA-20 | DevOps Engineer | M | M1 | done |
| BE-01 | HEAAA-76 | audit module: append-only events, anchors, BTG grants, denial path, export job | HEAAA-23 | Backend Engineer | L | M2 | done |
| BE-02 | HEAAA-80 | integration-core: vendor call wrapper, inbound log and dispatch, circuit state, write-only secret references | HEAAA-23 | Backend Engineer | L | M2 | done |
| BE-03 | HEAAA-78 | organisation: configuration data model, settings, directory views and `directory_ro` role | HEAAA-23 | Backend Engineer | XL | M2 | done |
| BE-04 | HEAAA-82 | identity core: staff (Google) and patient realms, sessions, roles, scope builder, authorization guard | HEAAA-23 | Backend Engineer | XL | M2 | done |
| BE-05 | HEAAA-104 | identity admin realm: API-run WebAuthn, elevation, enrolment, second-approver role changes, kill switch | HEAAA-23 | Backend Engineer | XL | M5 | done |
| BE-06 | HEAAA-84 | notifications core: PHI-free templates, send and dedupe, preferences, receipts, recipient resolution | HEAAA-23 | Backend Engineer | L | M2 | done |
| BE-07 | HEAAA-98 | staff alerts: durable alerts, escalation timers, SSE stream, acknowledge | HEAAA-23 | Backend Engineer | L | M3 | done |
| BE-08 | HEAAA-86 | patient core: registration, matching, care relationships, `staff_scope`, consents, preferences, proxy-grant us | HEAAA-23 | Backend Engineer | XL | M3 | done |
| BE-09 | HEAAA-88 | patient merge: request, approval, execute job, participant registry, write guards | HEAAA-23 | Backend Engineer | L | M3 | done |
| BE-10 | HEAAA-92 | documents: pre-signed upload, scan, OCR suggestion, classification, legal holds, export part | HEAAA-23 | Backend Engineer | L | M3 | done |
| BE-11 | HEAAA-90 | scheduling core: occupancy, holds, confirm, cancel, reschedule, overlap rule | HEAAA-23 | Backend Engineer | XL | M3 | done |
| BE-12 | HEAAA-94 | scheduling availability: templates, leave, blocked time, roster, slot search | HEAAA-23 | Backend Engineer | L | M3 | done |
| BE-13 | HEAAA-100 | scheduling flow: check-in, queue, arrivals, no-show, waitlist offers, pre-visit send | HEAAA-23 | Backend Engineer | L | M3 | done |
| BE-14 | HEAAA-106 | calendar-sync: Google busy-only two-way sync | HEAAA-23 | Backend Engineer | L | M3 | done |
| BE-15 | HEAAA-112 | telehealth: sessions, join tokens, device check, licensing check | HEAAA-23 | Backend Engineer | M | M3 | done |
| BE-16 | HEAAA-96 | clinical chart: problems, allergies, medications (coded), vitals and ranges, banner and chart summary | HEAAA-23 | Backend Engineer | XL | M4 | done |
| BE-17 | HEAAA-108 | clinical notes: encounters, SOAP notes, sign and lock, addenda, co-sign | HEAAA-23 | Backend Engineer | L | M4 | done |
| BE-18 | HEAAA-102 | clinical front-door: questionnaires, consents gate, vitals, triage, red-flag rule, referrals and follow-ups | HEAAA-23 | Backend Engineer | XL | M4 | done |
| BE-19 | HEAAA-116 | messaging: staff threads and tasks (patient messaging behind flag D-5) | HEAAA-23 | Backend Engineer | M | M4 | done |
| BE-20 | HEAAA-110 | privacy: requests, export assembly, legal-hold checks, incident register | HEAAA-23 | Backend Engineer | L | M4 | done |
| BE-21 | HEAAA-130 | reporting: operations read models and dashboard feed | HEAAA-23 | Backend Engineer | M | M4 | done |
| BE-22 | HEAAA-114 | integrations host and public directory routes | HEAAA-23 | Backend Engineer | M | M3 | done |
| BE-23 | HEAAA-118 | admin API: organisation configuration routes | HEAAA-23 | Backend Engineer | L | M5 | done |
| BE-24 | HEAAA-120 | admin API: users and roles, audit viewer and export, BTG review, privacy decisions, integration settings | HEAAA-23 | Backend Engineer | L | M5 | done |
| FE-01 | HEAAA-75 | Design system: tokens, shared components, accessibility tests | HEAAA-22 | Frontend Engineer | L | M2 | done |
| FE-02 | HEAAA-77 | App shell: API client, session and realm handling, idle warning, release prompts, error pages | HEAAA-22 | Frontend Engineer | L | M2 | done |
| FE-03 | HEAAA-91 | Patient portal: managed-login handoff, callback landing, auth error states | HEAAA-22 | Frontend Engineer | M | M3 | done |
| FE-04 | HEAAA-107 | Patient portal: book, reschedule, cancel, waitlist | HEAAA-22 | Frontend Engineer | L | M3 | done |
| FE-05 | HEAAA-127 | Patient portal: profile, proxies, notification preferences, privacy, messages (flagged) | HEAAA-22 | Frontend Engineer | L | M4 | done |
| FE-06 | HEAAA-105 | Shared documents UI: upload with scan state, classification, list and viewer | HEAAA-22 | Frontend Engineer | M | M4 | done |
| FE-07 | HEAAA-128 | Patient portal: pre-visit forms, consents, insurance upload, waiting room, device check and join | HEAAA-22 | Frontend Engineer | L | M4 | done |
| FE-08 | HEAAA-93 | Staff portal: Google sign-in, session shell, role navigation | HEAAA-22 | Frontend Engineer | M | M4 | done |
| FE-17 | HEAAA-121 | Staff portal: administrator sign-in, security-key elevation dialog, realm banner and realm switch | HEAAA-22 | Frontend Engineer | M | M5 | done |
| FE-09 | HEAAA-119 | Pre-consultation desk: arrivals board, check-in, forms review, triage panel, red-flag bar, queues, duplicate a | HEAAA-22 | Frontend Engineer | XL | M4 | done |
| FE-10 | HEAAA-125 | Doctor portal: schedule, patient list, chart summary, note editor, sign, addenda, co-sign, alert tray, BTG dia | HEAAA-22 | Frontend Engineer | XL | M4 | done |
| FE-11 | HEAAA-123 | Doctor portal: availability templates, leave and blocked time, Google Calendar connection | HEAAA-22 | Frontend Engineer | M | M4 | done |
| FE-12 | HEAAA-131 | Staff tasks and secure messages | HEAAA-22 | Frontend Engineer | M | M4 | done |
| FE-13 | HEAAA-132 | Admin portal: audit log, BTG review, users and roles with approvals, privacy requests | HEAAA-22 | Frontend Engineer | L | M5 | done |
| FE-14 | HEAAA-134 | Admin portal: clinics, services, policies, templates, integrations, flags, banners, vital ranges | HEAAA-22 | Frontend Engineer | L | M5 | done |
| FE-15 | HEAAA-129 | Brand site: pages, directory, booking hand-off, SEO, cookie consent | HEAAA-22 | Frontend Engineer | L | M4 | done |
| FE-16 | HEAAA-136 | CMS configuration: editor, marketing sign-in, branding of login and preview | HEAAA-22 | Frontend Engineer | M | M4 | done |
| DO-01 | HEAAA-83 | IaC baseline: state backend, accounts and OU structure files, network, KMS | HEAAA-24 | DevOps Engineer | L | M5 | done |
| DO-02 | HEAAA-99 | IaC data tier: RDS PostgreSQL 17 Multi-AZ, buckets, audit archive, backup vault, cross-region copy | HEAAA-24 | DevOps Engineer | L | M5 | done |
| DO-03 | HEAAA-85 | IaC compute and edge: ECS Fargate services, ALB, CloudFront and WAF, portal hosts | HEAAA-24 | DevOps Engineer | L | M5 | done |
| DO-04 | HEAAA-87 | IaC identity, secrets and CI trust: Cognito pools, secret store, OIDC roles denied by default, approval-by-app | HEAAA-24 | DevOps Engineer | L | M5 | done |
| DO-05 | HEAAA-89 | build-release workflow: build once, sign, SBOM, provenance, release manifest and release numbering | HEAAA-24 | DevOps Engineer | L | M5 | done |
| DO-06 | HEAAA-97 | Deploy workflows (authored, disabled): staging, production, marketing; migration task; smoke and observation j | HEAAA-24 | DevOps Engineer | XL | M5 | done |
| DO-07 | HEAAA-103 | Observability as code: telemetry, dashboards, alarms, synthetic checks, PHI scrubbing | HEAAA-24 | DevOps Engineer | L | M5 | done |
| DO-08 | HEAAA-111 | Backup, restore and DR automation: restore-test workflow, PITR procedure, DR rehearsal stack | HEAAA-24 | DevOps Engineer | L | M6 | done |
| DO-09 | HEAAA-113 | Operational workflows: infra, nightly, dependency updates | HEAAA-24 | DevOps Engineer | M | M6 | done |
| DO-10 | HEAAA-138 | Dual-control workflows: audit archive and first-admin bootstrap | HEAAA-24 | DevOps Engineer | M | M6 | done |
| DO-11 | HEAAA-117 | Load-test environment and k6 harness plumbing | HEAAA-24 | DevOps Engineer | L | M6 | done |
| SEC-02 | HEAAA-135 | Security assessment: identity, sessions, admin realm and secrets (code review) | HEAAA-25 | Cybersecurity | M | M5 | done |
| SEC-03 | HEAAA-101 | Security assessment: RLS, scope, merge and patient-data isolation (code and SQL review) | HEAAA-25 | Cybersecurity | M | M3 | done |
| SEC-04 | HEAAA-122 | Security assessment: documents, notifications and PHI-in-output controls | HEAAA-25 | Cybersecurity | M | M3 | done |
| SEC-05 | HEAAA-137 | Security assessment: alerts, audit, BTG and stream authorization | HEAAA-25 | Cybersecurity | M | M5 | done |
| SEC-06 | HEAAA-115 | Security assessment: IaC, CI trust and release controls | HEAAA-25 | Cybersecurity | M | M6 | done |
| SEC-07 | HEAAA-142 | Pre-candidate security assessment: scan results, residual risk and penetration-test scope | HEAAA-25 | Cybersecurity | M | M6 | done |
| SEC-08 | HEAAA-126 | Security assessment: clinical access, banner allergies, break-the-glass and the red-flag alert path | HEAAA-25 | Cybersecurity | M | M4 | done |
| INT-01 | HEAAA-95 | Integrate M2 platform: audit, integration-core, organisation, identity core, notifications; first real authent | HEAAA-26 | Integrator | M | M2 | done |
| INT-02 | HEAAA-124 | Integrate M3 booking slice: patient, merge, scheduling, calendar, telehealth, documents, patient booking UI, b | HEAAA-26 | Integrator | L | M3 | done |
| INT-03 | HEAAA-133 | Integrate M4 clinical and front desk: clinical, messaging, privacy, reporting, staff and patient portals, bran | HEAAA-26 | Integrator | L | M4 | done |
| INT-04 | HEAAA-139 | Integrate M5 administration and controls: admin realm, admin API and portal, IaC and pipelines authored so far | HEAAA-26 | Integrator | M | M5 | done |
| INT-05 | HEAAA-141 | Integrate R1 release candidate and run the complete combined check set | HEAAA-26 | Integrator | M | M6 | done |
| QA-01 | HEAAA-70 | Test errata revision: TC-API duplicate ID, TC-AU-04 step 2, POR-02..04, SA-TC-07..10 (document only) | HEAAA-29 | QA Engineer | S | M1 | done |
| QA-02 | HEAAA-109 | Automation harness: Playwright, Schemathesis, synthetic data generators, test accounts for `ENV-INT/ci` | HEAAA-29 | QA Engineer | L | M3 | done |
| QA-03 | HEAAA-144 | Automated cases: identity, authorization and security (TC-ID, TC-AZ, TC-SEC, TC-SEC-C7) | HEAAA-29 | QA Engineer | L | M5 | done |
| QA-04 | HEAAA-140 | Automated cases: booking, calendar, notifications, pre-consultation, safety mechanics, clinical | HEAAA-29 | QA Engineer | XL | M4 | done |
| QA-05 | HEAAA-143 | Automated cases: telehealth, audit, documents, privacy, admin, brand site, messaging, merge, API conventions | HEAAA-29 | QA Engineer | XL | M5 | done |
| QA-06 | HEAAA-145 | Automated accessibility and browser matrix (TC-A11Y, TC-XB automated parts) | HEAAA-29 | QA Engineer | M | M5 | done |
| QA-07 | HEAAA-146 | Load, resilience and recovery scripts (TC-PERF, TC-REC automated parts) | HEAAA-29 | QA Engineer | M | M6 | done |

## 3. Correction and remediation tickets raised during the build (53 tasks, all `done`)

These are in-scope repairs of findings from integration (INT-01..05), security assessments (SEC-03 remediation) and reviews. None is new scope; each followed fix → independent re-review → rerun. Full finding detail is in the owning task and under `docs/evidence/corrections/` and `docs/evidence/integration/`.

| Paperclip | Title | Status |
| --- | --- | --- |
| HEAAA-162 | [SDLC:correction] INT-01 integration findings INT01-F1..F4: open correction tickets and assign owners | done |
| HEAAA-163 | [SDLC:correction] INT01-F1 apply catalog-lists.requested.patch to db/tools (db-foundation M-3/M-4) | done |
| HEAAA-164 | [SDLC:correction] INT01-F2 reconcile BE-03/BE-04 public directory view and policy list | done |
| HEAAA-165 | [SDLC:correction] INT01-F3 workspace unit tests write JUnit to $JUNIT_DIR for run-unit.mjs | done |
| HEAAA-166 | [SDLC:correction] INT01-F4 pnpm typecheck passes on a clean tree (CI lint-types order) | done |
| HEAAA-167 | [SDLC:correction] INT01 re-review of Integrator-resolved pnpm-lock.yaml (FE-02 merge) | done |
| HEAAA-169 | [SDLC:correction] INT-01 round 2 findings INT01-F5, F6: open correction tickets and assign owners | done |
| HEAAA-170 | [SDLC:correction] INT01-F5 prettier-format scripts/ci/run-unit.mjs (pnpm format:check) | done |
| HEAAA-171 | [SDLC:correction] INT01-F6 reconcile M-5 patient-guard and anonymous-policy lists (BE-04/BE-06 + db/tools) | done |
| HEAAA-183 | [Correction for BE-22 / F-BE22-1] Platform: keep raw request bytes for /webhooks/* JSON bodies | done |
| HEAAA-296 | [FE-07 F03 correction] Patient required-consents route (text, pending id) and mount patient-portal routes in App.tsx | done |
| HEAAA-306 | [SDLC:correction-request] INT-03 round 1: create correction tickets F01-F07 and block HEAAA-133 on them | done |
| HEAAA-307 | [SDLC:correction:INT03-F02] Fix typecheck/build: createFlowControllers limiter, requestConsent arity, consent-template language | done |
| HEAAA-308 | [SDLC:correction:INT03-F01] Mount M4 modules in the API composition root and register M4 jobs in the worker | done |
| HEAAA-309 | [SDLC:correction:INT03-F04] One shared registration of merge participants and privacy contributors for composition root and all dbtest harnesses | done |
| HEAAA-310 | [SDLC:correction:INT03-F03] Architect ruling: single patient merge write guard for M4 tables, and migration-version allocation rule | done |
| HEAAA-311 | [SDLC:correction:INT03-F05] Architect ruling: reporting_ro policies vs M-3/M-4-reporting catalog and BE-21 catalog-lists patch | done |
| HEAAA-312 | [SDLC:correction:INT03-F03] Implement the single merge write guard for M4 tables per the Architect ruling | done |
| HEAAA-313 | [SDLC:correction:INT03-F05] Apply reporting_ro catalog/policy fix per the Architect ruling | done |
| HEAAA-314 | [SDLC:correction:INT03-F06] Independent review of the Integrator migration renumbering (1600-1603 to 1604-1607, 2000-2001 to 2003-2004) | done |
| HEAAA-315 | [SDLC:correction:INT03-F07] Fix prettier format:check on five evidence files | done |
| HEAAA-317 | INT-03 r2: file correction tickets F08a-d, F06-02 and obtain A-4 / F06-01 decisions | done |
| HEAAA-318 | [SDLC:correction:INT03-F08a] Update the stale clinical RLS table list in chart.dbtest | done |
| HEAAA-319 | [SDLC:correction:INT03-F08b] Fix the reporting ops-feed no-patient-data test that uses an unregistered patient | done |
| HEAAA-320 | [SDLC:correction:INT03-F08c] Add patient A/B seed rows for the new M4 tables to the rls-matrix catalogue test | done |
| HEAAA-321 | [SDLC:correction:INT03-F08d] Fix the front-door accept path returning 404 (TODO-marked test) | done |
| HEAAA-322 | [SDLC:correction:INT03-F06-02] Correct two stale migration-number comments in catalog-lists.mjs (comment only) | done |
| HEAAA-326 | [SDLC:correction:INT03-F08d-mig] Implement approved caller_sees referral-visibility migration | done |
| HEAAA-334 | [SDLC:correction:INT03-F03B] Messaging definers: migrations 2203/2204 per accepted A-4 | done |
| HEAAA-339 | [SDLC:correction:INT03-F09a] Fix stale referral fixture in scheduling binding.dbtest (F08d contract) | done |
| HEAAA-401 | [SDLC:correction:INT03-F21-O1] Revise decision-log for SAR-O1-01..04 (staff list patientBanner; reject equal staff/patient hosts) | done |
| HEAAA-408 | [SDLC:correction-request] INT-04 round 1: create correction tickets for INT04-F01..F11 and block HEAAA-139 on them | done |
| HEAAA-436 | [SDLC:correction-request] INT04-F10: create SEC05-F02..F04 owner tasks, SEC-05 re-read, and amend HEAAA-412/HEAAA-139 | done |
| HEAAA-483 | [SDLC:correction-request] INT04-F12..F15: create correction tickets for round 3 | done |
| HEAAA-590 | [SDLC:correction-request] INT-05 round 1: create correction tickets for INT05-F01..F10 and block HEAAA-141 on them | done |
| HEAAA-591 | [SDLC:correction:INT-05-R1] INT05-F01/F02 root pnpm policy and dependency overrides (allowBuilds, dompurify, happy-dom) | done |
| HEAAA-592 | [SDLC:correction:INT-05-R1] INT05-F03/F04 lint errors and prettier format failures | done |
| HEAAA-593 | [SDLC:correction:INT-05-R1] INT05-F05 gitleaks full-history generic-api-key findings (15) | done |
| HEAAA-594 | [SDLC:correction:INT-05-R1] INT05-F06 decision: btree_gist object ownership versus the X-admin-owns-nothing check | done |
| HEAAA-595 | [SDLC:correction:INT-05-R1] INT05-F07 staff a11y-smoke fails 8/8 after redirect to /sign-in | done |
| HEAAA-596 | [SDLC:correction:INT-05-R1] INT05-F08 staff bundle exceeds gzip ceiling (162327 > 122880) | done |
| HEAAA-597 | [SDLC:correction:INT-05-R1] INT05-F09 patient-e2e-a11y journey fails: ECONNREFUSED 127.0.0.1:3000 (triage) | done |
| HEAAA-598 | [SDLC:correction:INT-05-R1] INT05-F10 FE-16 open requests: apps/cms CI job, DEPENDENCIES.md rows, next build | done |
| HEAAA-599 | [SDLC:correction:INT-05-R1] INT05-F10 decision: LGPL-3.0 @img/sharp-libvips-linux-x64 licence policy | done |
| HEAAA-600 | [SDLC:correction:INT-05-R1] INT05-F06 implement the btree_gist ownership/check fix per the Architect decision | done |
| HEAAA-603 | [SDLC:correction:INT-05-R1] INT05-F10 implement sharp exclusion per HEAAA-599 decision (pnpm-workspace.yaml, apps/cms next.config) | done |
| HEAAA-610 | [SDLC:correction-request] INT-05 round 2: findings INT05-F11, F12, F13 (blocking), F14 (watch), note N1 | done |
| HEAAA-611 | [SDLC:correction:INT-05-R2] INT05-F11 (blocking) | done |
| HEAAA-613 | [SDLC:correction:INT-05-R2] INT05-F12 (blocking) | done |
| HEAAA-615 | [SDLC:correction:INT-05-R2] INT05-F13 (blocking) | done |
| HEAAA-617 | [SDLC:correction:INT-05-R2] INT05-F14 (watch) | done |
| HEAAA-619 | [SDLC:correction:INT-05-R2] INT05-N1 (note) | done |
| HEAAA-621 | [SDLC:correction-request] INT-05 round 3: finding INT05-F15 (blocking) and ESCALATION (third unresolved round) | done |

## 4. Integration sequence

INT-01 HEAAA-95 (M2 platform) → INT-02 HEAAA-124 (M3 booking slice) → INT-03 HEAAA-133 (M4 clinical and front desk) → INT-04 HEAAA-139 (M5 administration and controls) → INT-05 HEAAA-141 (R1 release candidate). Each was independently reviewed and is `done`.

## 5. Items not complete

* Gate tasks and later phases (HEAAA-28..37) are not started or are waiting by design.
* Container image build/scan, contract test, e2e smoke, Lighthouse, N-1 upgrade, observability OpenTofu validate and CI-side `check-needs` did not run (see VERIFICATION-RESULTS.md). The tickets that introduced those jobs are `done` as code; their execution on the candidate is pending.
* Ticket `Backlog` status shown in `docs/TICKETS.md` is the stale planning copy; Paperclip is canonical.
