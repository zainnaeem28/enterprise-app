# QA-07: load, resilience and recovery scripts (TC-PERF, TC-REC automated parts)

k6 scenarios (unmodified k6, see `harness/`) with thresholds that make a run exit non-zero (k6 exit 99). Built on the DO-11 plumbing
(`harness/run-k6.sh`, pinned k6 `v2.3.0`).

## Status of the evidence: authored and mechanically self-tested only

`loadtest` (`ENV-LOAD`) is **not provisioned** and its cost is not approved (C-17, DEP-14). **No NFR-6..9 result exists.** Every load
case is `Blocked` until a run on `loadtest` is recorded. The only runs made so far are against `selftest/fixture-api.mjs`
(`FIXTURE_SELFTEST=1`, localhost only, 6 s phases) and prove mechanics (guard, threshold -> exit code); their reports are stamped
`FIXTURE_SELFTEST (not evidence)` and describe nothing about the system.

## Rules the scripts enforce

* `lib/common.js` `guard()` aborts the run (exit 107) unless `ENV_NAME=loadtest`, `BASE_URL` is https and its host is in
  `LOADTEST_HOSTS`, and `CANDIDATE_COMMIT` is set. The fixture self-test is the only exception and accepts localhost only.
* **No scaling knob.** Rates are `ARCHITECTURE 9.1` per-class peak values x 1 / 2 / 3, phases 10 min (1x), 30 min (2x), 5 min (3x);
  `perf-08` soaks 4 h at 1x then a 3x burst. Nothing reads a "scale" or "duration" variable outside the self-test.
* `dropped_iterations count==0`: if the generators cannot deliver the stated rate the run **fails**; it is never read as a pass.
* Per-phase thresholds: API p95 < 500 ms (NFR-6), slot search p95 < 1000 ms (NFR-8), `http_req_failed` < `ERROR_BUDGET`
  (default 0.1 %, **an assumption**: the agreed error budget is not fixed in the PRD), `checks` > 99.9 %.

## Cases

| Case | Script | Verdict by | Needs |
| --- | --- | --- | --- |
| TC-PERF-01 | `perf-01-mixed.js` | k6 thresholds; audit loss by `check-audit.mjs` | VOL-1 |
| TC-PERF-02 | `perf-02-slot-search.js` (`ALL_LOCATIONS=1` for the all-locations form) | k6 thresholds | VOL-1 |
| TC-PERF-03 | `perf-03-rls.js` | k6 thresholds (same targets as 01) | VOL-2; `ids.phiReadPaths` (one read path per PHI table) |
| TC-PERF-04 | `perf-04-audit.js` + `check-audit.mjs` | k6 + SQL reconciliation (all recorded, no unanchored row past 120 s) | VOL-1; read-only DB role |
| TC-PERF-05 | **not k6** - LCP is measured by Lighthouse CI on a production-like build (QA-06 tooling) | - | out of scope here |
| TC-PERF-06 | `perf-06-video-join.js` | k6 thresholds | `VENDOR_SANDBOX=1`; **refuses to run without it** (case is Blocked, vendor named) |
| TC-PERF-07 | `perf-07-booking-race.js` + `check-exactly-one.mjs` | exact winner count from the database | VOL-3; `ids.raceSlots`; run beside `perf-01` |
| TC-PERF-08 | `perf-08-soak.js` | k6 latency thresholds. Leak / queue-growth is **not** judged by k6: it needs the environment's memory, connection and queue-depth series (`check-soak` not written: those series' source is not defined yet) | VOL-1 |
| TC-REC-04 | `rec-continuity.js` (`REC_CASE=TC-REC-04`) + `check-recovery.mjs` | zero failed requests; no lost or duplicate acknowledged write | DevOps performs migration + rollback (OPS part) |
| TC-REC-07 | `rec-continuity.js` (`REC_CASE=TC-REC-07`) + `check-recovery.mjs` | longest error window <= 120 s, recovery observed, no lost or duplicate write | DevOps stops the primary (OPS part) |
| TC-REC-06, TC-REC-09 | **not scripted here**: they need fault-injection switches per external service and a worker-kill hook that the DevOps plan describes as environment configuration but that do not exist yet; no endpoint in the contract exposes them | - | gap, see below |
| TC-REC-01/02/03/05/08 | OPS / HUMAN cases, not this ticket | - | - |

## Inputs supplied by the environment (never committed)

`SESSIONS_FILE` (cookies and CSRF tokens minted by `harness/seed.sh` from the synthetic accounts; sign-in is an IdP redirect so
load sessions cannot be created by the script), `IDS_FILE` (service, locations, free slots sized for the run, encounters, patients,
race slots, video reservations, `noteRequest` template with `__MARKER__`, `phiReadPaths`, `chartViewPath`),
`LOADTEST_RO_DATABASE_URL` (read-only role for the `check-*.mjs` reconciliations, used through `psql`; only a single `SELECT` is accepted).

## Run

```
export K6_BIN=<pinned k6>   # harness/install-k6.sh
export ENV_NAME=loadtest BASE_URL=https://<loadtest api> LOADTEST_HOSTS=<that host> CANDIDATE_COMMIT=<sha> \
       SESSIONS_FILE=... IDS_FILE=... INFRA_SIZING_NOTE='<task sizes, DB class>'
tests/load/run-load.sh perf-01
```
Each run writes `reports/<case>-<time>/` : `raw.json` (k6 points), `summary-export.json`, `<case>.summary.json` (with candidate
commit, script revision, k6 version, environment, sizing note), `console.txt` (console output; `check-recovery.mjs --log` reads its ACK lines) and `k6.log`; the exit status is k6's.

## Contract gaps found while writing (to the backend / architecture owners)

* `POST /encounters/{id}/notes`, `POST /holds`, and the admin audit search have no request/response schema beyond the minimum
  (opaque objects); the hold body and note body come from `IDS_FILE`, and the audit/loss checks use SQL instead of the API.
* `audit.event` has no commit timestamp, so "commit lag below the 2-minute watermark" is judged as "no row older than 120 s without
  `anchor_id`" (`check-audit.mjs`). A true commit-lag metric from the anchoring job would be better.
* The error budget for NFR-6 and the TC-PERF-06 join-success target are not numbers anywhere in the PRD; the defaults here are labelled assumptions.
