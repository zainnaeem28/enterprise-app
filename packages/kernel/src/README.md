# Kernel library (F-04)

Unit tests run without a database (`pnpm --filter @ehr/kernel test`, which builds and runs the compiled `dist/**/*.test.js` with `node --test`): error mapping,
redacting logger, config, scope settings and `withScope`, static lock-order and sign-in call-site checks, idempotency hashing and control flow, queue payload
rules and fan-out, participant registries with fixtures.

PostgreSQL 17 tests are in `scope/scope.dbtest.ts` (RLS under `withScope`, transaction-local settings, concurrent duplicate idempotency keys) and
`queue/queue.dbtest.ts` (enqueue commits and rolls back with the caller's transaction, the queue library on `FORCE`d tables, `app_api` refusals, dead jobs, back-off,
fan-out, repeatable install). They run against migrations from empty in the `kernel` suite of `scripts/ci/migration-check/integration-db.sh` (needs
`EHR_TEST_ADMIN_URL`; `docs/RUN-GUIDE.md` section 8). The queue migration is `db/migrations/0100_queue_schema.sql`. `pg` and `graphile-worker` are exact-pinned
dependencies with rows in `docs/DEPENDENCIES.md`.

These database tests were not run for this README pass (no database was started); the claims above about what they cover come from reading the test files.
