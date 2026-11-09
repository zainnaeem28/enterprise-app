# INT03-F01 — M4 modules mounted in the API composition root; M4 jobs and crontab registered in the worker

Base: HEAAA-307 reviewed tip `4c9b638` (INT03-F02), which contains HEAAA-133 evidence commit `1cd3cbc`. Tools: node 24.22.2, pnpm 12.16.1, PostgreSQL 17 (`ehr-test-db`). Synthetic data only. Raw outputs in `raw/`.

## What changed
- `apps/api/src/composition.ts`: builds and mounts clinical chart, front door and notes, messaging, privacy and reporting (controllers appended after the INT-02 surface; the guard, `Route` declarations and the D-5 flag inside messaging are the modules' own). Defines their job types (and `notifications.escalate_alert`, which the alert service enqueues) in the API-path registry, registers the front-door and messaging event handlers, passes the flow its `previsit` port (late-bound, the front door needs the flow). `Composition` now also returns `registry`. The list-cursor key is derived from `EHR_RATE_KEY` with a fixed label (no new variable). The privacy package store is a refusing presigner (bucket/KMS: C-01) unless `packageStore` is injected.
- `apps/api/src/worker-ports.ts` (outside the listed paths, same file INT-02 R8-N2 used for the worker ports; needed because the worker cannot import the API): adds the clinical, messaging, reporting and `assembleExport` ports.
- `apps/worker/src`: job lists for the front door/notes (`jobs/clinical`), `jobs/messaging`, `jobs/reporting`; `job-registry.ts` (all M4 types, `WORKER_CRONTAB`); `compose.ts` (handlers for every M4 type); `runner.ts`/`main.ts` pass the crontab to graphile-worker and refuse to start if an entry names a task without a handler.
- Not touched: module internals, merge-participant/privacy-contributor registration (INT03-F04).

## Checks (commit of this branch tip)
| Check | Result | Raw |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | pass | raw/install.txt |
| `pnpm run lint` | pass | raw/lint.txt |
| `pnpm run typecheck` | pass | raw/typecheck.txt |
| `pnpm run build` | pass | raw/build.txt |
| `pnpm run test:boundary` | pass | raw/boundary.txt |
| `pnpm run format:check` | FAIL, 5 files, all `apps/staff/src/features/{auth,documents,preconsult}/evidence/*`: INT03-F07's, not changed here; every file of this ticket is clean | raw/format.txt |
| API unit `composition.test.ts` (5 tests) | pass | raw/api-composition-test.txt |
| Negative control: composition with messaging + reporting controllers removed | the wiring test and the HTTP probe FAIL (404 not 401) | raw/negative-control-composition-test.txt |
| Worker `m4-registration.test.ts` (handler for every M4 type, crontab entries have handlers, worker lists equal the API's, negative control, refusing ports) | pass | raw/worker-m4-registration-test.txt |
| Whole API unit suite / whole worker unit suite | 198 / 90 pass | (run output in the task comment) |
| API composition real-DB test (`loadIdentityEnv` -> `buildComposition` -> `createApp`, M4 routes 401 unauthenticated on staff and patient hosts; signed-in patient `GET /privacy-requests` 200) | 3 pass | raw/api-composition-dbtest.txt |
| Worker real-DB `compose.dbtest` (a queued job of each registered type incl. M4 is picked up by its handler) | pass | raw/worker-compose-dbtest.txt |
| Route/OpenAPI inventory (`m4-inventory.mjs`) | 59 OpenAPI operations of clinical/messaging/privacy/reporting, 56 mounted, 3 missing (below) | raw/m4-inventory.txt |

## Limitations and open points (requests, not done here)
1. `GET/POST /patients/{id}/immunisations` and `PATCH .../immunisations/{id}` are in `clinical.yaml` but no BE-16..21 module implements them; not mounted. Needs an Architect/Orchestrator ruling (descope or ticket).
2. Red-flag rule content stays BLOCKED on D-12a: only mechanics are mounted. `retargetUnacknowledged` works from the roster; timing comes from the alert setting.
3. (Superseded by round 2, below.)
4. The crontab wiring covers M4 entries (privacy expiry, reporting refresh). INT-02 crontabs (`PATIENT_CRONTAB`, `SCHEDULING_FLOW_CRONTAB`) are still unwired; adding them is one line in `WORKER_CRONTAB` but is INT-02 scope.
5. Real infrastructure is refusing until delivered: terminology source (C-09), package writer/store (C-01), object store, etc. A job picked up before then fails with `PortNotConfiguredError` and retries.
6. `privacy.assemble_export` coverage depends on INT03-F04 (participant/contributor registration); not verified here.
7. The privacy and messaging real-database suites were not re-run (module code unchanged).

## Round 2 (review r1: F01-R1, F01-R2)
- **F01-R1 fixed.** `apps/worker/src/jobs/notifications/alert-jobs.ts` defines `notifications.escalate_alert` (same definition as the API's `ALERT_JOBS`) and a handler that opens a patients-scope (patient alert) or org-scope (no patient) system transaction and calls the API's `escalateAlert` through the new `alerts` port (`worker-ports.ts`). `WORKER_JOBS` includes it. `apps/api/src/composition.ts` now exports `API_PATH_JOBS`.
- **Test:** worker `m4-registration.test.ts` (12 pass, raw/worker-m4-registration-test-r2.txt): every API-path job type that is API-publishable exists in `WORKER_JOBS` with an identical definition.
- **F01-R2 proof:** worker `compose.dbtest` (2 pass, raw/worker-compose-dbtest-r2.txt): with `queue_api.task_type` synced from the worker registry, every API-publishable type (incl. all M4 types and `notifications.escalate_alert`) is accepted by `queue_api.enqueue` as `app_api`; control: a type absent from the table is refused ("not allowed").
- Also re-run: typecheck, lint, build pass; API composition unit 5/5; worker unit 92/92; prettier clean on touched files.
- **Found, not fixed (INT-02, not M4):** `patient.execute_merge` is published by the API (`MERGE_JOBS`, class `job`) but has no worker registration/handler, so a merge execute enqueue would be refused. The tests pin this as the single known exception. Request to Orchestrator: ticket for the worker registration (relates to INT03-F04).
