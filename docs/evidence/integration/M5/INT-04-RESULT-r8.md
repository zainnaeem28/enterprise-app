# INT-04 result, round 8 (F29 merge)

Candidate = r7 tip `568f35d` + `d2760b2` (HEAAA-531 F29 fix: `scripts/ci/admin-run.mjs` expects realm `admin_pool` and audience `staff`; Security Reviewer HEAAA-532 PASS, Release Reviewer HEAAA-533 PASS). Only that file differs from r7. Merge commit: `INT04 r8: merge reviewed F29 fix d2760b2 (HEAAA-531)`.

## Environment (clean checkout, `/tmp/int04r8/repo`)
PostgreSQL 17.11 (embedded-postgres binaries, trust auth, loopback, port 55488), Node 24.22.2, pnpm 12.16.1 `--frozen-lockfile`, Chromium 156 headless shell (fonts/libs from `/tmp/ci-tools`). Ports API/staff/TLS 3018/4184/4454. Synthetic data only.

## Executed
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile`, `pnpm build` | pass |
| `admin-run.mjs --selftest`, `admin-stack.mjs --selftest` | pass |
| `prepare-db.sh ehr` (migrations to 2407) | pass |
| `admin-stack.mjs` (CI=true EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1) | **FAIL** (exit 1) |
| enrolment, WebAuthn sign-in, session realm/audience assertions (**F29**) | **CLOSED**: pass |
| admin configuration: create service + persisted after reload | **FAIL** (15 s locator timeout) |
| audit viewer: last 24 h show entries | **FAIL** (timeout) |
| break-the-glass review: record decision + stored after reload | **FAIL** (timeout) |

Not run: lint, unit, integration-db, gitleaks, semgrep (unchanged since r7 except one driver file).

## New finding INT04-F30 (staff app shows the staff shell for an admin session)
After sign-in the page shows the *staff* realm bar ("Staff portal", "Sign out to switch to administrator") and "No staff screens are assigned to your account yet" (screenshot `02-signed-in-landing.png`), so every `/admin/...` screen the driver opens has none of its expected headings (all five later steps time out on the first locator; tls-front.log shows only `/admin/*` SPA loads and `/api/v1/auth/session`, no admin API calls).

Likely cause (read from source, not yet proven by a fix): `packages/app-shell/src/realm/realm.ts` `realmKind()` checks `session.audience` first and maps `staff` to `'staff'`; the API issues admin sessions with audience `staff` and realm `admin_pool` (the very values F29 asserts). `apps/staff/src/app/StaffApp.tsx` renders the admin shell only when `realmKind(session) === 'admin'`, so the realm is never consulted. Unit tests only cover `audience: 'admin_pool'`, a value the API does not issue. Product code (`packages/app-shell` and/or the session contract) -- outside Integrator scope; not patched. Needs an Architect/Frontend decision: which field identifies the admin realm (realm first, or audience) and a test using the real API values.

## Result
`admin-stack.mjs` FAILS. Admin configuration, audit viewer and break-the-glass review did run (and failed) for the first time; no admin-screen screenshots exist yet. INT-04 is not submitted to QA.

## Raw output
`docs/evidence/integration/M5/r8/`: `admin-stack.txt`, `summary.json`, `api.log`, `worker.log`, `tls-front.log`, `staff-preview.log`, `prepare-db.txt`, screenshots `01`-`07`.
