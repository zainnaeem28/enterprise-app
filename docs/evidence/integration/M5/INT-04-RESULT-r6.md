# INT-04 result, round 6 (F23-F27 merge)

Candidate merge tip = r5 tip `64afd11` + `882d243` (HEAAA-516 `03d0129` F23-F25/F27 stack side, HEAAA-517 `882d243` F26/F27 driver; Security Reviewer HEAAA-518 PASS, Release Reviewer HEAAA-519 PASS). Merge clean, no conflicts, no content differing from the reviewed commit. Clean worktree, `pnpm install --frozen-lockfile`, PostgreSQL 17.11 at `ehr-test-db` (fresh database per attempt). Raw logs: `raw/int04-r6/gates/`, stack logs and screenshots: `raw/int04-r6/stack-run/`.

## Executed
| Check | Result |
|---|---|
| install (frozen), build | pass |
| `pnpm lint` | pass (F23 closed) |
| `pnpm format:check`, `pnpm typecheck` | pass |
| `admin-stack.mjs --selftest`, `admin-run.mjs --selftest` | pass |
| seed (F24, one transaction), vite from `apps/staff/node_modules/vite/bin/vite.js` (F25), API, worker, staff preview, TLS front | pass: stack came up |
| enrolment over `https://staff.ci.test` with `x-client-release` (F26, F27) | **pass**: `ok enrol the admin principal with the fixture key (token spent, second key registered)`; the former 403 `auth.csrf_failed` is gone |
| administrator WebAuthn sign-in in the browser (F27) | **pass at the API**: tls-front log shows `POST /admin/auth/sign-in/options 200` and `/verify 200`, `GET /admin/audit 200` |
| admin configuration, audit viewer, BTG review, screenshots | **NOT RUN** (driver stopped at the sign-in step's own check) |

Not run in this round: unit, integration-db, gitleaks, semgrep (unchanged paths; only `scripts/ci/**` changed since r5).

## Result: `admin-stack.mjs` FAILS (new finding INT04-F28)
Final line: `FAIL administrator sign-in in the browser with the security key: session answered 400`.

- **INT04-F28** (`scripts/ci/admin-run.mjs`, sign-in step, `page.evaluate(... fetch('/api/v1/auth/session'))` around line 385): the driver's own in-page `fetch` sends no `x-client-release`, so the API answers 400 `client_release_refused: missing` (api.log, tls-front.log `GET /api/v1/auth/session 400`). F26 was applied to the enrolment `post()` only; the reviewers and the author stated that "the driver makes no other API calls", but this in-page call is one. The staff app's own session calls returned 200 (it sends the header). Sign-in itself succeeded; the failure is the driver's check after it. Fix: add the same header (`cfg.clientRelease`) to that fetch (and any later in-page API fetch in the driver). Owner: DevOps/Frontend via the Orchestrator; I did not patch it (unreviewed, outside allowed paths).

## Environment note (not a product defect, not counted as a finding)
The first two attempts (`admin-stack.txt`, `admin-stack-debug.txt`) died with `FATAL skia SkFontMgr_FontConfigInterface.cpp:163 Not implemented` because this host has no fontconfig/fonts (`/etc/fonts` absent), so headless Chromium crashes on first text render. The third attempt used `FONTCONFIG_FILE=/tmp/ci-tools/fonts.conf` (DejaVu fonts, host setup only; nothing in the repo changed) and is the reported result (`admin-stack-fontfix.txt`). GitHub's ubuntu runner ships fonts, so the CI job is not expected to be affected; unproven here.

## State
F23, F24, F25, F26 (enrolment) and F27 are proven fixed by the real run. F28 is new. Not submitted to QA. F21 still open (no admin configuration/audit/BTG run, no admin screenshots). Nothing integrated, human-approved or deployed. Integration rounds: 6; the D1 extension covered F23-F27 only, so F28 needs a new Orchestrator decision.
