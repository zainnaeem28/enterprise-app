# INT-03 integration round 5 (HEAAA-133 / HEAAA-344, resumed after INT03-F10)

Candidate: `e6c893c` (F10 correction HEAAA-349, independent review HEAAA-350 PASS, round 1/3) on `4a03369`. Raw: `raw/r5/` (`exit-codes.txt`, `candidate-commit.txt`).

## Executed (candidate `e6c893c`)
| Check | Result |
|---|---|
| `pnpm run lint`, `format:check`, `typecheck`, `build`, `test:boundary` | **pass** (INT03-F10 closed) |
| unit via `scripts/ci/run-unit.mjs` | pass: 1024 tests, 8 reports, none skipped or failed |
| `integration-db.sh` (N-1 skipped) | pass first attempt: db-foundation 104, kernel 23, api 884, worker 79 (1090), none skipped |
| Fresh DB: bootstrap + migrate from empty through 2301 | pass |
| `deps.sh` (OSV) | pass: 2 non-blocking (minimatch 10.2.6 GHSA-g3hv-75wg-m249, sev 6.9; yaml 2.8.1 GHSA-48c2-rrv3-qjmp, sev 4.3) |
| `secrets.sh` (gitleaks 8.30.1) | **FAIL**: 115 findings, full history; 109 in `main..HEAD` (`raw/r5/scan-secrets*.log`, redacted `gitleaks-fullhistory-redacted.json`). All 15 distinct files sampled are synthetic: test keys/tokens (`CSRF_KEY`, `RATE_KEY`, `CURSOR_KEY`, `tok-12345678`, `RT-0123456789`, `sk_live_SUPERSECRET` in an error-redaction test), notification template keys, and M3 evidence logs (82 hits, `raw/r12/ui/journey-run.txt`). I classified by line sample only; I did not review each of the 115. The gate is red regardless: needs a gitleaks allowlist or rule decision by Cybersecurity (finding INT03-F12). The working-tree scan did not run (git step exits first). |
| SAST (Semgrep 1.184.0) | **not run**: not in `tools.lock`; host has no pip or venv (`raw/r5/install-semgrep.log`). Not a pass. |
| N-1 migration | **not run**: no `r<N>` release tag exists (`git tag -l 'r[0-9]*'` empty). Fresh migrate from empty only. Not a pass. |

## New blocking findings (both returned to Orchestrator for diagnosis; no further blind round)
**INT03-F11 (blocker): the real worker process does not start.** `node apps/worker/dist/main.js` prints `worker failed to start: Error` (name only). Cause: `WORKER_CRONTAB` (`apps/worker/src/job-registry.ts:39`) is `50 3 * * * privacy.expire_packages` / `* * * * * reporting.refresh_ops`; graphile-worker 0.18.0 `parseCrontab` rejects a dotted task identifier (`Invalid command specification in line 1 of crontab`; verified: the same line with `privacy_expire_packages` parses). Reproduction: `raw/r5/ui/worker-boot-diagnosis.mjs`. Impact: no job runs in the deployed worker, including privacy package expiry, the reporting refresh and every notification/waitlist job. `m4-registration.test.ts` checks that a crontab task has a handler but never parses the crontab with graphile-worker, and `integration-db` starts the worker through `composeWorker` pieces, not `main.ts`. Correction options for Backend: parse the crontab in a test, and give the cron entries identifiers graphile accepts (or register undotted aliases). Not patched here: I cannot accept my own patch.

**INT03-F13 (blocker for patient-portal consumers): patient-module routes are not served.** `apps/api/src/composition.ts` builds `patient` with `createPatient` but its `controllers` (profile, communication preferences, family/proxy grants, registration, staff lookup, merge) are not in the `controllers` array (lines 270-287). With a signed-in self patient (`scope: full`), `GET /api/v1/patients/{id}/profile` and `/communication-preferences` return 404 `kernel.not_found`, and the patient portal Profile and Notification-preference screens render "We can't find this" (`raw/r5/ui/03-profile.png`, `04-profile-notifications.png`). The same routes are unaudited 404s (the guard did not run), unlike a guard denial. I did not determine whether the omission is deliberate; `composition.ts:107-111` lists the mounted surface without them, but the front-door and registration flows depend on them. Needs the Solution Architect or Backend to decide: mount, or remove the portal screens and the dependent flows from M4 scope.

(INT03-F12 is the gitleaks gate above.)

## Real UI + API journey actually demonstrated (patient portal only)
Fresh migrated DB (`ehr_int02_r12_ui`, M3 fixture setup unchanged, torn down afterwards), real API process, built patient app via `vite preview`, local IdP, Chromium 156 headless. Ports 3510/4574/9199 (the default 3000/4274 were held by another session on this host; the first attempt served that session's stale bundle and was discarded). Screenshots `raw/r5/ui/*.png`, log `raw/r5/ui/journey-run.txt`.
- Sign-in via OIDC redirect to session 200: pass. Appointments list: pass (200, empty). Privacy page (`GET /privacy-requests` 200, download and delete options): pass.
- Messages: 404 until the organisation flag `patient_messaging` (default off, D-5) is on. I enabled it by SQL (disclosed). Then the list loads (200, empty). `/messages/new` shows "Writing a new message is not available yet" (the UI does not offer writing; no send was demonstrated).
- Profile and notification preferences: fail, see INT03-F13.
- Disclosed SQL: the whole fixture (organisation, clinician, patient, principal) and the messaging flag.

## Not demonstrated
Worker journeys (INT03-F11), staff app journeys (clinical chart, notes, front door, messaging, referrals, reporting), the brand site, application screenshots of those screens, any message send/receive, N-1, SAST, working-tree secret scan. Red-flag rule content stays BLOCKED on D-12a. Nothing is submitted to QA, marked Integrated or approved at any gate.
