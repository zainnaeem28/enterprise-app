# INT-03 integration round 6 (HEAAA-133 / HEAAA-344, resumed after the Round 5 corrections)

Candidate: `d79dbd5` (INT03-F11 `a4c94ab`, SAST tooling `c876917`, F12 `f4644b8`, F13 `d79dbd5`; each independently reviewed PASS: HEAAA-353, 357, 358, 360, 362). Raw: `raw/r7/` (`exit-codes.txt`, `candidate-commit.txt`, logs, `ui/`). (The `raw/r6/` folder holds the F12/SAST authors' own evidence.)

## Executed (candidate `d79dbd5`)
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile`, `lint`, `format:check`, `typecheck`, `build`, `test:boundary` | **pass** (all exit 0) |
| unit via `scripts/ci/run-unit.mjs` | pass: 1030 tests, 8 reports, none skipped or failed |
| `integration-db.sh` (N-1 skipped, see below) | pass first attempt: db-foundation 104, kernel 23, api 889, worker 84 (1100), none skipped |
| `deps.sh` (OSV) | pass: 2 non-blocking (minimatch 10.2.6 GHSA-g3hv-75wg-m249, yaml 2.8.1 GHSA-48c2-rrv3-qjmp) |
| `secrets.sh` (gitleaks 8.30.1) | **FAIL, 2 findings** (down from 115): both `stripe-access-token` in `docs/evidence/integration/M4/INT03-F12-decision-log.md` lines 3 and 11, the F12 decision log itself quoting the synthetic `sk_live_` test value that the new allowlist exempts only in its original test file (`raw/r7/scan-secrets.log`). New finding **INT03-F14** (low): the gate is red for a documentation file; fix is to reword the decision log or extend the allowlist by exact path, reviewed by Cybersecurity. I did not patch it (my own patch cannot be self-accepted). |
| SAST (Semgrep 1.184.0) | **not run**: the host filesystem is 100% full (`/` 48G, ~246M free); `install-tools.sh semgrep` fails with `ENOSPC` while unpacking the wheels (`raw/r7/install-semgrep.log`). Not a pass. The author's own r6 run is `raw/r6/scan-sast.log` (not re-verified here). Environmental blocker for DevOps/host owner, not a product finding. |
| N-1 migration | **not run**: `git tag -l 'r[0-9]*'` is empty (`raw/r7/release-tags.txt`). Recorded as a limitation, not a failure. |

## Round 5 findings re-checked on the combined candidate
- **INT03-F11 closed**: `apps/worker/dist/main.js` boots (`worker started`, `worker booted`); the crontab registers `privacy/expire_packages` and `reporting/refresh_ops`; the scheduled job `reporting/refresh_ops` ran and completed in the real worker (`ui/worker-process.log`); sign-in enqueued `identity.record_sign_in` jobs that the worker completed (jobs 9, 12, 13, 15).
- **INT03-F13 closed**: with the real API, `GET /patients/{id}/profile` and `/communication-preferences` return 200 and the Profile ("Your details") and Notification-preferences screens render (`ui/03-profile.png`, `04-profile-notifications.png`; r5 showed 404 and "We can't find this").
- **INT03-F12 partly closed**: 115 -> 2 (new F14 above).

## Real UI + API + worker journey demonstrated (patient portal)
Fresh migrated DB (torn down afterwards), real API process, real worker process, built patient app via `vite preview` (port 4674; 4574 was held by another session), local IdP, Chromium 156 headless. Log `ui/journey-run.txt`, screenshots `ui/*.png`.
- Landing, sign-in via OIDC redirect to session 200: pass. Appointments (200, empty), privacy page (200), messages list (200, empty, flag on) and the notification-preference and profile screens: pass.
- Observations (not blocking, for Frontend/Orchestrator triage): after sign-in the portal lands on `/continue?...returnTo=/account` and shows "This page is not part of the patient portal" (`02-sign-in.png`), and `GET /api/v1/me` returns 404.
- Messaging: `patient_messaging` flag enabled by SQL (disclosed, default off per D-5). The UI says "Writing a new message is not available yet"; no send was demonstrated (`09-FAILED-messages-send.png` is that expected absence).
- Privacy "Request a copy of my data": clicking the button produced no non-GET API call in my script (`privacy-journey-run.txt`); I did not determine why (script or UI). Not demonstrated.
- Disclosed SQL: the fixture (organisation, clinician, patient, principal) and the messaging flag.
- Browser note: Chromium aborted (SIGABRT, Skia fontconfig) until `FONTCONFIG_FILE` pointed at a local font config; an environment issue, not the application.

## Not demonstrated
Staff app journeys (clinical chart, notes, front door, messaging, referrals, reporting), the brand site, red-flag rule content (BLOCKED on D-12a), message send/receive, patient-merge through the UI, N-1, SAST, privacy export request. Nothing is submitted to QA, marked Integrated or approved at any gate.
