# INT-04 result, round 7 (F28 merge)

Candidate = r6 tip `e7acb0c` + `5340d68` (HEAAA-522 F28 fix: `scripts/ci/admin-run.mjs` sends `x-client-release` on the in-page `/api/v1/auth/session` fetch; Security Reviewer HEAAA-523 PASS, Release Reviewer HEAAA-524 PASS). Only that file differs from r6. Merge commit: see the git log of this branch (`INT04 r7: merge F28 fix (5340d68)`).

## Environment (clean frozen checkout, `/tmp/int7/repo`)
PostgreSQL 17.11 (embedded-postgres 17.11 binaries, trust auth, loopback, port 55477; port 55432 on this host was already held by another process and was not touched), Node 24.22.2, pnpm 12.16.1 `--frozen-lockfile`, Chromium 156 headless shell with `FONTCONFIG_FILE=/tmp/ci-tools/fonts.conf` and `LD_LIBRARY_PATH=/tmp/ci-tools/root/usr/lib/x86_64-linux-gnu` (libglib etc.). Ports API/staff/TLS 3017/4183/4453. Synthetic data only.

## Executed
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile`, `pnpm build` | pass |
| `admin-run.mjs --selftest`, `admin-stack.mjs --selftest` | pass |
| `prepare-db.sh ehr` (all migrations to 2407) | pass |
| `admin-stack.mjs` (CI=true EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1) | **FAIL** (exit 1), new finding INT04-F29 |
| enrolment over `https://staff.ci.test` | pass |
| WebAuthn sign-in in the browser (API `sign-in/options` 200, `verify` 200) | pass |
| **F28**: in-page `GET /api/v1/auth/session` | **CLOSED**: 200 (was 400 in r6); tls-front.log `GET /api/v1/auth/session 200` x3 |
| session realm assertion | **FAIL**: `session is not in the admin realm` |
| admin configuration, audit viewer, BTG review | NOT RUN (fatal step stopped the driver) |

Not run: unit, integration-db, gitleaks, semgrep (unchanged since r6 except one driver file).

## Result: `admin-stack.mjs` FAILS at the next assertion (INT04-F29)
Final lines: `FAIL administrator sign-in in the browser with the security key: session is not in the admin realm` / `admin run FAILED`.

**INT04-F29** (`scripts/ci/admin-run.mjs` line ~394, same sign-in step): the driver asserts `session.realm === 'admin'`. The API issues admin sessions with `realm = 'admin_pool'`, `audience = 'staff'` (`apps/api/src/modules/identity/admin/session.ts`: `VALUES (..., 'admin_pool', 'staff', ...)`; `ceremony.ts` uses `realm: 'admin_pool'`; staff e2e specs also use `admin_pool`). The sign-in itself succeeded; the driver's expected constant is wrong. Suggested fix (driver only, `scripts/ci/**`): compare to `'admin_pool'` (optionally also assert `audience === 'staff'`). Per the task rule it was NOT patched here; fix-request goes to the Orchestrator and needs the usual Security + Release review before r8.

Observation (not a finding): `api.log` has one `client_release_refused code=missing` warning at 20:26:04.757, logged during API start-up before any browser request; no route was refused afterwards (tls-front shows no 400).

## Raw output
`docs/evidence/integration/M5/r7/`: `admin-stack.txt` (stdout/stderr of the run), `summary.json`, `api.log`, `worker.log`, `tls-front.log`, screenshots `01-admin-sign-in-form.png`, `02-failed-...png`.
