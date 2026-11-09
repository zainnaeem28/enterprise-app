# INT-04 integration round 2 (partial; NOT submitted to QA)

Cumulative integration round: **2 of 3**. Candidate (partial): `4ae7d44` (`raw/int04-r2/gates/candidate-commit.txt`). Base: HEAAA-139 tip `9a4fae1` (carries INT-04 r1 `8195772`, F10-A/B/C/D and the DO-02 merge). Raw output: `raw/int04-r2/gates/`.

## Merged this round (one at a time, all clean, reviewed revisions only)
| Finding | Ticket | Revision | Reviews |
|---|---|---|---|
| F01/F04a | HEAAA-409 | `d8b0532` | Backend PASS, Security PASS |
| F04b/F05a | HEAAA-418 | `ac94aec` | DevOps PASS |
| F05b | HEAAA-420 | `727ebdf` | Frontend PASS |
| F07 | HEAAA-424 | `24e8bab` | Security PASS, DevOps PASS |
| F08 | HEAAA-427 | `564f601` | DevOps PASS, Security PASS |
| F09 | HEAAA-430 | `7dd0b15` | DevOps PASS |
| F06 | HEAAA-422 | `df48866` (carries 052503a FE, 6317d73 A-6) | Backend PASS |

## Not merged, and why
- **F02 (HEAAA-412, `abbdd6b`)**: HEAAA-139 already carries the earlier worker commit `cbb51ec` (F10 work); `abbdd6b` conflicts with it (worker compose, job-registry, identity jobs, audit). The Backend review of `abbdd6b` is missing (HEAAA-413 is CHANGES REQUIRED on `6534771`; only Security re-reviewed `abbdd6b`, PASS). A conflict resolution needs independent review. Also `abbdd6b` adds a gitleaks `generic-api-key` hit at `apps/worker/src/jobs/identity/admin-event.dbtest.ts:123` (INT04-F13).
- **F03 (HEAAA-415, `060d6a0`)**: Frontend review CHANGES REQUIRED (INT04-F03-R1 Medium: AdminSignInLink not on /sign-in; R2 Low: axe evidence). No fix ticket exists; UI/UX PASS. The admin portal is not in the candidate, so no admin screenshots.
- **F02b (HEAAA-460/466)**: bootstrap_admins implementation not done (466 blocked).
- **F10 re-read (HEAAA-452/453)**: blocked; SEC-05 re-read not run.
- **F11**: review tasks HEAAA-434/435 done (renumbering reviewed).

## Executed gates (detail in `raw/int04-r2/gates/`)
| Gate | Result |
|---|---|
| frozen install (clean detached checkout) | pass |
| `pnpm -r run build` (clean checkout, includes vite builds) | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass (F04: 19 errors gone) |
| unit (run-unit.mjs; build prerequisite step failed only because the shared worktree `node_modules` is a symlink) | api 266, app-shell 72, kernel 141, patient 186, site 56, staff 249, ui 171, worker 112, boundary 1: 0 failed, 0 skipped |
| test:boundary | pass |
| release tests | pass 43/43 (F09 fixed) |
| workflow hygiene | pass |
| semgrep (`sast.sh`) | pass, 5 non-blocking (F08 fixed) |
| gitleaks full history | **FAIL, 6**: 5 in QA-04 branch history (outside this candidate, known), 1 in `abbdd6b` (INT04-F13, not merged) |
| prettier `format:check` | **FAIL, 1 file**: `infra/modules/database/README.md` (DO-02, merged `f68d26d`) (INT04-F12) |
| integration-db | **NOT COMPLETED**: the database suite ran extremely slowly while another integration-db run shared the one PostgreSQL 17 server (about 50 output lines in 10 minutes). Aborted by me. Partial output is kept only as `integration-db-partial-aborted.txt`. F06 is therefore not re-verified on the merged tree. |
| tofu/tflint, N-1, actionlint | not run (no tool / no release tag) |

## New findings (stable IDs; round 2)
- **INT04-F12** (Blocking, CI gate): `prettier --check` fails on `infra/modules/database/README.md` (DO-02). Owner: DevOps Engineer; DevOps Reviewer.
- **INT04-F13** (Blocking for the F02 merge): gitleaks `generic-api-key` at `apps/worker/src/jobs/identity/admin-event.dbtest.ts:123` (commit `abbdd6b`). Owner: Backend Engineer (use a non-key-shaped fixture, or a narrow reviewed allowlist); Security Reviewer.
- **INT04-F14** (Blocking): F02 needs a rebase onto HEAAA-139 tip (conflict with `cbb51ec`) and a Backend re-review of the resulting content. Owner: Backend Engineer; Backend Reviewer and Security Reviewer.
- **INT04-F15** (Blocking): F03 R1 and R2 have no fix ticket; admin portal not in the candidate. Owner: Frontend Engineer; Frontend Reviewer, UI/UX.
- **INT04-F16** (Environment, limitation): the HEAAA-139 worktree is used concurrently by other work (uncommitted edits to `db/roles/0001_roles.sql`, `packages/kernel/src/queue/harden.sql`, `db/migrations/2407_*`; a foreign merge attempt of `a8afc78` appeared and vanished during this run). Integration gates ran in clean detached checkouts. Those edits are not part of this candidate and were not committed by me. The integration branch needs one writer; the Orchestrator should give the F02b implementer its own worktree.

## State
Round 2 of 3 used. Nothing is integrated, submitted to QA, human-approved or deployed.
