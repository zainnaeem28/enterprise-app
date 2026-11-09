# INT-04 result, round 5 (F22 merge)

Candidate merge tip `a88d2fa` = r4b tip `429f0aa` + F22 `146a9e5` (HEAAA-507: F22a `fcb8316`, F22b `146a9e5`; Security Reviewer HEAAA-510 PASS, Release Reviewer HEAAA-511 PASS). Merge clean, no conflicts. Clean worktree, `pnpm install --frozen-lockfile`, PostgreSQL 17 at `ehr-test-db`. Raw logs: `raw/int04-r5/gates/`.

## Executed on the clean merged tree
| Check | Result |
|---|---|
| install (frozen), build | pass |
| typecheck, workflow hygiene (incl. fixture-isolation guard + selftest), unit (1334, 0 failed, 0 skipped) | pass |
| `admin-run.mjs --selftest`, `admin-stack.mjs --selftest` | pass |
| `pnpm format:check` | pass (clean tree) |
| `pnpm lint` | **FAIL**: `scripts/ci/admin-stack.mjs:163 no-useless-assignment` (INT04-F23) |
| `node scripts/ci/admin-stack.mjs` (the real-stack admin run) | **FAIL** (INT04-F24..F27); no admin configuration, audit viewer or BTG step ran; no admin screenshots |

## Findings (new)
- **INT04-F23** lint error in `admin-stack.mjs:163` (`let code = 1;` never read). The CI `lint-types` job would fail.
- **INT04-F24** `admin-stack.mjs` seeding: `person()` inserts `identity.person` and `identity.principal` as two auto-committed statements on a plain client; the deferred constraint trigger `person_requires_principal` (0501) aborts with "a person must have at least one principal". They must share one transaction. (Probe: BEGIN/COMMIT around them passes.) Also the seed is not re-runnable on the same database (`principal_realm_subject_uq`); fine for a throwaway CI database, noted.
- **INT04-F25** `admin-stack.mjs` resolves vite with `createRequire(...).resolve('vite/bin/vite.js')`, which fails (`ERR_PACKAGE_PATH_NOT_EXPORTED`, vite `exports`). Probe: the plain path `apps/staff/node_modules/vite/bin/vite.js` works.
- **INT04-F26** `admin-run.mjs` enrolment `post()` omits the mandatory `x-client-release` header; the API answers 400 (`client_release_refused: missing`). Probe: `r1.000000000000` is accepted.
- **INT04-F27** (design) the admin realm is composed with `expectedOrigins`/`allowedOrigins` = `https://<EHR_STAFF_HOST>` and `rpId` = the host (`apps/api/src/composition.ts:247-256`); `EHR_ALLOWED_ORIGINS` is not used for it. The stack serves the staff app on `http://127.0.0.1:4173`, so the enrolment request is refused with 403 `auth.csrf_failed` and WebAuthn could never match the origin. The run needs an `https://<host>` origin with no port: for example a self-signed TLS front for the staff preview plus Chromium `--host-resolver-rules` and a certificate exception, with the driver's HTTP calls using that origin and Host, or a reviewed CI-only origin override in the composition guarded like the other fixture variables. This is a decision for the Solution Architect and Security Reviewer, not for the Integrator.

The probe fixes for F24..F26 were applied only in a scratch worktree (`raw/int04-r5/gates/probe-local-patch.diff`), were not committed, and are not reviewed code. They show the three small defects are real and fixable; F27 remains unproven.

## State
Not submitted to QA. F21 still partly open (no real-stack admin run). Nothing integrated, human-approved or deployed. Integration rounds: 5 (the D1 extension covered F22 only).
