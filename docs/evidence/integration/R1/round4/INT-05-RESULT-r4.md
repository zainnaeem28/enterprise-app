# INT-05 result, round 4

Candidate: `af27830` (round 3 `e40739b` + F15 fix `d6ea96e` + seed.sh disk cleanup `af27830`). Raw reports: `gates/`. Screenshots: `shots/` (10 actual-application screenshots, `summary.json`). Synthetic data only, nothing deployed. This is not QA, G3 or deployment approval.

**Result: PASS on every check that can run here. No new finding. INT05-F15 is verified fixed.** The F15 fix and the seed.sh cleanup were merged before this task started (both independently reviewed: HEAAA-624, HEAAA-626), so there was nothing further to merge.

| Check (CI job) | Result | Raw report |
| --- | --- | --- |
| frozen install, lint, format, typecheck, boundary, build | pass | `install lint format typecheck boundary build` |
| workflow-hygiene (actionlint, SHA pins, fixture isolation) | pass | `actionlint hygiene fixture-isolation` |
| unit | pass: 1441 tests, none skipped or failed | `unit` |
| **sast** | **pass** (F15 fixed): 1683 files, 7 non-blocking findings, seed.sh parses | `sast` |
| secrets, full history and `SECRETS_RANGE=HEAD` | pass, no leaks | `secrets secrets-HEAD` |
| deps (OSV), sbom | pass | `deps sbom` |
| migration-check (PG 17.11) | pass | `migration-check` |
| migration-check seeded controls | pass: 19 of 19 caught for the stated reason, 0 not caught, on the bare candidate | `migration-seed` |
| integration-db (`INTEGRATION_SKIP_N_MINUS_1=true`) | pass: 120 + 23 + 1015 + 121 = 1279 tests, 0 failed, 0 skipped | `integration-db-summary` (full log not committed: test names trip gitleaks) |
| a11y-smoke 8 of 8, empty-suite guard, seeded controls | pass | `a11y-smoke a11y-guard a11y-seeded` |
| staff bundle gzip | pass: initial 96887 / 122880, largest lazy 15203 / 30720, total 175073 / 196608 | `staff-bundle-gzip` |
| patient unit, bundle, Playwright journey + axe | pass, 3 of 3 | `patient-unit patient-bundle patient-e2e patient-guard` |
| admin-run: self-tests, migrate, `admin-stack.mjs` | pass, 7 of 7 steps, 10 screenshots | `admin-selftest prepare-db admin-stack`, `shots/` |
| cms: typecheck, `test:db` (junit guard: 0 skipped), `next build` | pass (reproduced locally; CI job `cms` not run) | `cms-*` |
| `tofu fmt -check -recursive infra` | pass | `tofu-fmt` |

`gates/exit-codes.txt` lists every exit code including repeated attempts. Harness-only repeats, no product effect: first `actionlint` and `tofu` calls (PATH, 127); first `format` run counted ignored generated cms files; a scram-auth local Postgres dropped the password in the scripts' derived URLs (switched to trust auth as CI does); Chromium needed shared libraries and fonts (LD_LIBRARY_PATH and FONTCONFIG_FILE) so headings rendered; a leftover `ehr` database from the aborted run was dropped before `prepare-db`; the first cms `next build` was refused by the CMS production guard because my shell exported the Paperclip `DATABASE_URL` (the guard worked as designed), unset and rerun passed.

## Not run (unchanged from round 3)

Container image scan, `contract`, `e2e-smoke` (no Docker); Lighthouse; N-1 upgrade check and integration-db N-1 control (no release tag); tofu validate/test and observability (`infra/` unchanged); CI-side `check-needs.mjs`.

## Findings (round 4)

None new. Cumulative: round 1 F01..F10, round 2 F11..F14, round 3 F15; all closed by this run.

## Next permitted action

Orchestrator: route the frozen candidate `af27830` to the BUILD_REVIEW package and independent reviews. Not human approval.
