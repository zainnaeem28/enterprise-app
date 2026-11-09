# INT-03 integration round 7 (HEAAA-344, combined tip after the Round 6 corrections)

Candidate: tip of the HEAAA-344 branch (`raw/r8/candidate-commit.txt`) = F14 `af44f46` + merged `06d4051` (GET /api/v1/me), `15ca9f5` (capture.mjs TCP probe), `93f786e` (GCM authTagLength 16); each independently reviewed PASS (HEAAA-372..375). Merge was clean. Raw: `raw/r8/`.

| Check | Result |
|---|---|
| install, lint, format:check, typecheck, build, test:boundary | pass (exit 0) |
| unit (`run-unit.mjs`) | pass: 1030 tests, 8 reports, none skipped/failed |
| `integration-db.sh` (N-1 skipped) | first run: db-foundation 104, kernel 23, api 890 pass; **worker 4 failures** in the boot suite (`integration-db.log`; hook `execFileSync` failure, no stderr captured). One rerun of the worker suite alone: 84/84 pass (`integration-db-worker-rerun.log`). Treated as an intermittent failure on a shared test DB server, cause not identified; not proven flaky. Recommend a QA repeat. |
| `secrets.sh` (gitleaks, full history + tree) | **pass**, no leaks (INT03-F14 closed) |
| `sast.sh` (Semgrep) | **pass**: 1149 files, 4 non-blocking MEDIUM (npm/pnpm release-age/trust settings), none blocking (SAST gate now runs; PartialParsing no longer blocks) |
| N-1 migration | not run: no release tag (limitation, not failure) |

## Not demonstrated this round
Staff journeys, brand site, privacy export request, message send (not offered by the UI). Patient portal journey and screenshots are from round 6 (`raw/r7/ui/`); not re-run after the `/api/v1/me` and capture.mjs changes. Red-flag content stays blocked on D-12a. Nothing Integrated, nothing submitted to QA.
