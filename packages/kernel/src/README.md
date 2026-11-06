# Kernel library (F-04), work in progress

Done and verified without a database (`node --test packages/kernel/dist/*/*.test.js`): error mapping, redacting
logger, config, scope settings and `withScope`, static lock-order and sign-in call-site checks, idempotency hashing and
control flow, queue payload rules and fan-out, participant registries with fixtures.

**Not done, needs PostgreSQL 17 (none is available to this agent):** real-database tests of RLS under `withScope`,
concurrent duplicate idempotency keys, rollback of an enqueued job, the queue-library acceptance test on `FORCE`d
tables (SBR-17), migrations `0100`-`0149` (queue schema, grants, policies).

**Needs the Orchestrator (outside the allowed paths):** `pg` and the queue library (Graphile Worker, ARCHITECTURE 21.8)
as exact-pinned dependencies of `@ehr/kernel` with a `docs/DEPENDENCIES.md` row; a `test` script in
`packages/kernel/package.json`.
