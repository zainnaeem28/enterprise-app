# INT-04 result, round 9 (F30 merge)

Candidate = r8 tip `c2bbb20` + `cd57f3f` (HEAAA-542 F30 fix: `realmKind()` in `packages/app-shell/src/realm/realm.ts` selects the realm by `session.realm` only, `audience` is a consistency check; tests and fixtures use real API pairs). Reviews: Security HEAAA-543 PASS, Frontend HEAAA-544 PASS, both on exactly `cd57f3f`. Merge commit `81ba123` (the only change versus r8 is the 7 files of the F30 fix). Branch `HEAAA-139-int04-r9`.

## Environment (clean frozen checkout, `/tmp/int04r9/repo`, nothing reused from r8)
PostgreSQL 17.11 (embedded-postgres binaries, trust auth, loopback, port 55499), cluster **UTF8 / C.UTF-8**, Node 24.22.2, pnpm 12.16.1 `--frozen-lockfile`, Chromium 156 headless shell. Ports API/staff/TLS 3019/4185/4455. Synthetic data only.
Environment note: my first cluster was created with the default locale (SQL_ASCII, as in r8). That made one API integration test fail (`consent text ... code-point limits`: a 200-emoji title counted as 800 characters by `char_length`). That is an environment artefact, not a product defect; both the integration-db suite and the final admin-stack run below are on the UTF8 cluster. (The admin-stack result on the SQL_ASCII cluster was identical.)

## Executed
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile`, `pnpm build` | pass |
| `pnpm lint`, `pnpm format:check`, `pnpm test:boundary`, `pnpm typecheck` | pass |
| unit (`scripts/ci/run-unit.mjs`) | pass: 1352 tests (app-shell 87, staff 281), 0 failed |
| integration-db (`INTEGRATION_SKIP_N_MINUS_1=true`, PostgreSQL 17, UTF8) | pass: 1279 tests (db-foundation 120, kernel 23, api 1015, worker 121), 0 failed |
| semgrep (`scripts/ci/sast.sh`) | pass: 1588 files, 5 non-blocking findings (pnpm-workspace.yaml hardening, MEDIUM) |
| gitleaks, range `c2bbb20..HEAD` (the 3 new commits) | pass: no leaks |
| gitleaks, working tree / full history (`scripts/ci/secrets.sh`) | **FAIL**: 60 findings, all false positives in Integrator evidence (INT04-F33) |
| `admin-run.mjs --selftest`, `admin-stack.mjs --selftest` | pass |
| `prepare-db.sh ehr` (migrations to 2407) | pass |
| `admin-stack.mjs` (CI=true EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1) | **FAIL** (exit 1) |
| enrolment, WebAuthn sign-in, realm/audience assertions | pass |
| **F30**: admin session renders the administrator portal | **CLOSED**: screenshots show "Administrator portal", admin nav (Audit & compliance, Configuration), no staff shell |
| admin configuration: create service, saved, persisted after reload | **FAIL** (INT04-F31, test-driver locator; the app saved the service) |
| audit viewer: last 24 h show entries | **FAIL** (INT04-F32, UI default range; rows exist) |
| break-the-glass review: record decision + stored after reload | **pass** (first time) |

Not run: `deps.sh` (dependency audit, unchanged lock file since r7), actionlint/deploy policy (no change to those paths).

## New findings
**INT04-F31** (`scripts/ci/admin-run.mjs`, step "create a service and see it saved" and its reload twin): `page.getByRole('cell', { name: serviceName })` is a substring match and resolves to 3 elements (the Internal name cell, the Patients see cell, and, most likely, the action cell whose accessible name includes the button label `Edit: <service name>`). Playwright strict mode rejects it. The screenshot `04-failed-...png` shows the service in the table with "Saved. The change is recorded in the audit log." Driver-only fix: `exact: true` and/or `.first()` / scope to the Internal name column. Outside Integrator paths; not patched.

**INT04-F32** (`apps/staff/src/features/admin-compliance/AuditLog.tsx`, lines ~26-60, source read, root cause confirmed against the data): the default "To" is the page-open time formatted by `localInput()` to minute precision and kept in state (`now` ref). It is therefore the start of the current minute, and `to` is sent as that instant. Every audit row written during the current minute (all rows of a fresh CI database, and the viewer's own `view` rows) is after `to`, so the viewer shows "0 entries / No audit entries in this period" and "Apply filters" never changes that. Evidence: the database holds 23 `audit.event` rows (sign_in, enrol, elevation, config_change, btg_review, 13 `view`), the first at 20:44:38, while the viewer's To was 20:44 (screenshot `06-failed-...png`: "11/09/2026, 08:44 PM", "0 entries"). Real users have the same effect for events of the current minute. Needs a Frontend/Architect decision (for example default To = now rounded up to the next minute, or computed at submit); alternatively the driver sets To explicitly, which would not fix the product behaviour. Not patched.

**INT04-F33** (Integrator evidence, `docs/evidence/integration/M5/raw/int04-r4/gates/integration-db*.txt`): gitleaks `generic-api-key` matches 60 times on the migration list JSON line that the test runs print (`"2405_identity_admin_second_key_session.sql","2406_notifications_staff_scope_allows_patient.sql"`), entropy 4.0. `scripts/ci/secrets.sh` (full history / working tree) therefore fails on this branch; the 3 commits of this round are clean. Rewriting history is not allowed; options for the Orchestrator: a path or content allowlist in `gitleaks/gitleaks.toml`, or removing those lines from the working tree files (history would still match). r9 evidence omits those lines on purpose (`prepare-db.txt`, gate logs filtered).

## Result
`admin-stack.mjs` FAILS. F30 is closed; break-the-glass review now passes end to end. Two steps still fail (F31 driver, F32 product UI), so INT-04 is not submitted to QA. All other gates that were not run since r7 pass except the secret scan (F33).

## Raw output
`docs/evidence/integration/M5/r9/`: `admin-stack.txt`, `summary.json`, `api.log`, `worker.log`, `tls-front.log`, `staff-preview.log`, `prepare-db.txt`, screenshots `01`-`10`, `gates/` (lint, format-check, test-boundary, typecheck, unit, sast, integration-db, secrets, secrets-range, exit-codes).
