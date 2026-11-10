# INT-05 result, round 3

Candidate: product tree `e40739b` on branch `HEAAA-141-sdlc-ticket-int-05-...` (round 2 candidate `320ec2a` plus the five reviewed fixes below). Raw reports: `gates/`. Screenshots: `shots/`. Synthetic data only, nothing deployed. This is not QA, G3 or deployment approval.

**Result: FAIL. 1 blocking finding is open (INT05-F15, new, introduced by the INT05-F13 fix). Round 2 findings F11, F12, F13, F14 and note N1 are verified fixed.**

## Merged (one at a time, each independently reviewed, all clean merges, no conflicts)

| Finding | Correction | Commit | Review |
| --- | --- | --- | --- |
| F11 prettier on 8 files | HEAAA-611 | `f509e895` | HEAAA-612 PASS |
| F12 cms job `postgres@` string | HEAAA-613 | `217f0b6` | HEAAA-614 PASS |
| F13 seed.sh 0900 collision | HEAAA-615 | `019a719` | HEAAA-616 PASS |
| F14 flaky staff offline test | HEAAA-617 | `0e02364` | HEAAA-618 PASS |
| N1 gitleaks allowlist for DO-11 fixtures | HEAAA-619 | `8bb4cf9` | HEAAA-620 PASS |

`pnpm-lock.yaml` is unchanged by these merges (sha256 identical to round 2), so no re-resolution was needed. Frozen install exits 0.

## Executed

| Check (CI job) | Result | Raw report |
| --- | --- | --- |
| frozen install, lint, typecheck, boundary, build | pass | `gates/install.txt`, `lint.txt`, `typecheck.txt`, `boundary.txt`, `build.txt` |
| `format:check` | pass (F11 fixed). First run listed 591 files because ignored generated output from earlier rounds (`apps/cms/.next` etc.) was present; rerun on a clean tree passes | `gates/format.txt` |
| workflow-hygiene (actionlint, SHA pins, fixture isolation) | pass | `gates/actionlint.txt`, `hygiene.txt`, `fixture-isolation.txt` |
| unit | pass: 1441 tests, none skipped or failed (F14 not seen) | `gates/unit.txt` |
| **sast** | **fail (INT05-F15)** | `gates/sast.txt` |
| secrets, full history (475 commits, includes the DO-11 refs) | pass, no findings (N1 fixed) | `gates/secrets.txt` |
| secrets, `SECRETS_RANGE=HEAD` | pass | `gates/secrets-HEAD.txt` |
| deps (OSV), sbom | pass | `gates/deps.txt`, `sbom.txt` |
| migration-check (PG 17.11, UTF8) | pass: 29 catalog checks, 0 problems; secret-reference lint 245 files, 0 problems (F12 fixed) | `gates/migration-check.txt` |
| migration-check seeded controls | pass: 19 of 19 caught for the stated reason (F13 fixed) | `gates/migration-seed.txt` |
| integration-db (`INTEGRATION_SKIP_N_MINUS_1=true`) | pass: 120 + 23 + 1015 + 121 = 1279 tests, 0 failed, 0 skipped | `gates/integration-db-summary.txt` (full log not committed: test names trip gitleaks) |
| a11y-smoke 8 of 8, empty-suite guard, seeded controls | pass | `gates/a11y-smoke.txt`, `a11y-guard.txt`, `a11y-seeded.txt` |
| staff bundle gzip | pass: initial 96887 / 122880, largest lazy 15203 / 30720, total 175073 / 196608 | `gates/staff-bundle-gzip.txt` |
| patient bundle, Playwright journey and axe | pass, 3 of 3 | `gates/patient-bundle.txt`, `patient-e2e.txt`, `patient-guard.txt` |
| admin-run: self-tests, migrate, `admin-stack.mjs` | pass, 7 of 7 steps, 10 actual-application screenshots | `gates/admin-stack.txt`, `shots/` |
| cms job steps: typecheck, `test:db` (7 tests, 0 skipped), `next build` | pass (reproduced locally; CI job `cms` not run) | `gates/cms-*.txt` |
| `tofu fmt -check -recursive infra` | pass | `gates/tofu-fmt.txt` |

`exit-codes.txt` lists every command's exit code, including first attempts that were repeated and why (secrets: stale ignored `reports/` from round 2 matched by the working-tree scan, removed, then rerun).

Harness notes (no product effect): the first database attempt used a cluster created without UTF8, which made one api test (200 emoji title) fail on a byte-length check; the cluster was recreated with `-E UTF8` and the suite passes. `admin-stack` needs `CI=true`.

## Not run (unchanged from round 2)

Container image scan, `contract` and `e2e-smoke` (no Docker); Lighthouse; N-1 upgrade check and the integration-db N-1 seeded control (no release tag); tofu validate/test and observability (`infra/` unchanged since round 1); CI-side `check-needs.mjs`.

## Findings (round 3)

| ID | Severity | Finding | Suggested owner |
| --- | --- | --- | --- |
| INT05-F15 | blocking | The INT05-F13 fix (`019a719`, `scripts/ci/migration-check/seed.sh:58`) uses `$((10#$last + 1))`. Semgrep's bash parser rejects `10#` (`PartialParsing ... Syntax error at line scripts/ci/migration-check/seed.sh:58: '10#' was unexpected`), and `scripts/ci/check-semgrep.mjs` fails the `sast` job on any parse error. `sast` passed in round 2 and fails now; the only changed scan input is `seed.sh`. Fix: compute the next version without `10#` (for example `awk -v v="$last" 'BEGIN{printf "%04d", v+1}'`), keep the rest of the F13 behaviour, and confirm `scripts/ci/sast.sh` exits 0 and `seed.sh migration-check` still catches 19 of 19. | DevOps |

## Round count

Cumulative round 3 for INT-05 (round 1: F01..F10; round 2: F11..F14; round 3: F15). Third unresolved round: **escalation required**; the correction loop stops here. The `review-ledger` is updated.

## Next permitted action

Orchestrator: escalate. A real human decision is needed to grant one further bounded cycle for INT05-F15 (one-line fix plus independent review). Not submitted to QA: the candidate does not pass.
