# INT03-F15: intermittent worker boot-suite failure

**Root cause (proven from `raw/r8/integration-db.log`, lines before the worker failure):** `db/tools/migrate.mjs bootstrap` ran `ALTER ROLE app_owner ...` and PostgreSQL answered `error: tuple concurrently updated` (XX000, `heapam.c simple_heap_update`). Roles are cluster-global, so two bootstraps against the same server (another database's bootstrap, a parallel job on the shared test server) race on the same `pg_authid` row. The boot hook's `execFileSync` then exited 1 and `node:test` cancelled the 4 tests under it. stderr was not captured only because the child's `stdio: 'inherit'` put it ahead of the suite output. It is not a timeout, port, disk or resource problem.

**Reproduction:** 8 parallel `bootstrap` runs against the test server (`/tmp/rep.mjs`), old code: failures 3, 2, 1, 1, 2 of 8 over 5 repeats.

**Fix:** `db/tools/migrate.mjs bootstrap` retries (up to 8, jittered backoff) only on `tuple concurrently updated`; the role files are idempotent. Any other error still fails at once.

**After the fix:** 8 parallel bootstraps, 5 repeats: 0 failures each. Worker suite (`run_db_suite worker`) 5 consecutive runs: 84/84 pass, 0 cancelled each; `runner.dbtest.js` alone 5 runs: 4/4 pass.

Limit: this shows the race is absorbed, not that no other cause exists; the one observed failure matches this signature exactly.
