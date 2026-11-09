# INT-04 round 4 (bounded cycle HEAAA-494): result

Candidate: branch HEAAA-139 tip `ed9902c` (F17 `c4c3568`, F18 `6a76ca9`, F19 `4827dd4` merged, all reviewed PASS). Clean detached checkout, frozen install. Raw: `raw/int04-r4/gates/`.

| Gate | Result |
|---|---|
| frozen install, build, typecheck, lint, test:boundary | pass |
| `pnpm format:check` | **FAIL**: `scripts/ci/browser-smoke.mjs` (F19, `4827dd4`) not Prettier-formatted (INT04-F20) |
| unit (run-unit.mjs) | 1311 tests, 0 failed, 0 skipped |
| release + deploy tests (`node --test scripts/release/test/*.test.mjs scripts/deploy/test/*.test.mjs`) | 83/83 |
| workflow hygiene, semgrep (sast.sh) | pass |
| integration-db (CI PostgreSQL 17, N-1 skipped) | pass: db-foundation 120/120 (closes F17), kernel 23/23, api 1006/1006, worker 121/121 |
| gitleaks full history | 6 hits, none in the candidate's history (commits `abbdd6b` HEAAA-412 old branch tip, `0de3e06`, `cfc7f66` QA-04 branch). F18 closed: the r2 evidence hit is gone. |
| tofu fmt/validate, tflint | not re-run by me; F19 author's raw logs `raw/f19/` (reviewed PASS) |
| N-1 | not possible: no release tag exists (F19 note) |
| real admin-path screenshots | **not produced** (INT04-F21) |

## New findings
- **INT04-F20 (Blocking for the format gate; owner Frontend/DevOps author of F19; reviewer Release Reviewer)**: run `prettier --write scripts/ci/browser-smoke.mjs`. One file, formatting only.
- **INT04-F21 (Blocking for acceptance "admin configuration, audit viewer and BTG run end to end"; owner Cybersecurity + Frontend; reviewer Security Reviewer)**: the admin realm sign-in requires WebAuthn with attestation chaining to approved FIDO roots and approved AAGUIDs (`apps/api/src/admin-env.ts`, no test value accepted by design). No fixture exists that lets the real API, database and built staff app run the admin sign-in in a headless browser, so I cannot produce admin screenshots against the real stack. The screenshots committed under `apps/staff/src/app/evidence/screenshots` are from a contract mock. Needed: a reviewed CI-only fixture (for example a synthetic attestation root generated per run and a Chromium virtual authenticator, or a documented session-seeding script confined to the `ci` environment) that does not weaken production config. Without it, the admin path is verified only by integration-db (api 1006, worker 121) and mocked UI.

## State
Not submitted to QA. Not integrated, human-approved or deployed.
