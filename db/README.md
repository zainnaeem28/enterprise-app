# Database foundation (F-03)

PostgreSQL 17, one database, one schema per module (SHARED-BOUNDARIES 4.1). This ticket owns migrations
`0001`-`0099`, the role bootstrap, the migration runner and the catalog checks.

| Path                              | What                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/roles/0001_roles.sql`         | Cluster roles, the SET-only memberships, role-level timeouts. Run **before** the migrations as the administrator (CI superuser; RDS master user). Idempotent. No passwords. |
| `db/migrations/NNNN_name.sql`     | DDL only, run as `app_owner`. Each file starts with `-- migration-class: expand` or `contract`.                                                                             |
| `packages/kernel/src/db/migrate/` | Runner library: ordering, drift, DML ban, expand/contract rules, tracker. Tests: `*.test.ts` (no database needed).                                                          |
| `db/tools/check-migrations.mjs`   | Database-free lint of `db/migrations` (DML ban + expand/contract).                                                                                                          |
| `db/tools/migrate.mjs`            | CLI: `bootstrap`, `migrate`, `plan`. CI only.                                                                                                                               |
| `db/tools/catalog-check.mjs`      | Catalog checks M-1..M-5 and the role checks, JSON report, exit 1 on a violation. Lists in `catalog-lists.mjs`.                                                              |
| `db/tools/db-test.mjs`            | Real-database tests (migrations from empty, catalog checks, spike-style checks, TC-AU-04, runner against a real database).                                                  |
| `docker/compose.ci.yml`           | PostgreSQL 17 service for CI.                                                                                                                                               |

## Run

```sh
pnpm install --frozen-lockfile
pnpm --filter @ehr/kernel build
node --test packages/kernel/dist/db/migrate/*.test.js     # runner and rules, no database
node db/tools/check-migrations.mjs                        # lint db/migrations

docker compose -f docker/compose.ci.yml up -d --wait
export EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres
node --test db/tools/db-test.mjs                          # real PostgreSQL 17

# by hand, on an empty database `ehr`:
EHR_DB_ADMIN_URL=postgres://postgres@127.0.0.1:55432/ehr node db/tools/migrate.mjs bootstrap
EHR_DB_MIGRATE_URL=postgres://app_owner@127.0.0.1:55432/ehr node db/tools/migrate.mjs migrate
EHR_DB_ADMIN_URL=postgres://postgres@127.0.0.1:55432/ehr node db/tools/catalog-check.mjs
```

## Decisions a reviewer should know about

- **Roles are bootstrap, not migrations.** `app_owner` is not allowed to create roles or grant memberships, so a
  migration cannot create the roles. "Roles exist after migrations from empty" is read as bootstrap + migrations.
- **"No application role owns a table"** is checked for `app_api`, `app_worker`, `reporting_ro`, `audit_archiver`.
  `app_owner` is the migration role and owns every table by design (SHARED-BOUNDARIES 6.2); it has no BYPASSRLS, and
  FORCE makes ownership grant nothing.
- **Audit-writing roles** with role-level `transaction_timeout = 60s`: `app_api`, `app_worker`, `audit_archiver`
  (function-owner roles are NOLOGIN and use the caller's timeout).
- **Tracker** is `migration.schema_migration` (not in `kernel`, which has exactly the four tables of 22.1). No
  application role has any right on it.
- **Runner rules** beyond the ticket text: transaction control, `SET ROLE`, timeouts and `CREATE/ALTER ROLE` in a
  migration are refused (the runner owns the first three, `db/roles` the last); `DO`, `CALL`, `COPY`, `TRUNCATE`,
  `CREATE TABLE AS`, `SELECT INTO` and `BEGIN ATOMIC` bodies are refused with the DML ban.
- **Not in this ticket:** `kernel.append_only`, `kernel.refuse_update_when_terminal*` (21.5), `queue` schema, the scope
  setter and every module schema. `kernel.setting/uuid1/uuids` and `kernel.bump_row_version` are here because the four
  tables' policies and triggers need them.

## Open notes

- **F03-N1 (Architect).** `kernel.rate_counter` policy is "organisation only, every audience" (ARCHITECTURE 22.1), so at
  the database level it also matches audience `public`, while 21.3 says `public` cannot reach it. Implemented as written;
  recorded as an accepted exception in `catalog-lists.mjs` (`publicPolicies`). Adding `audience <> 'public'` needs an
  Architect decision.
- **F03-N2.** `kernel.idempotency_key` policies are limited to authenticated audiences, so they are not on the 21.3
  anonymous list (the spec's T-PRINCIPAL alone would also match anonymous when a principal setting is present).

## Requests to the Orchestrator (outside this ticket's allowed paths)

1. Add the `pg` client (MIT) as an exact-pinned dependency of the workspace root or `@ehr/kernel`, with the lockfile
   change and a `docs/DEPENDENCIES.md` row. `db/tools/pg.mjs` imports it dynamically; the runner library itself only
   needs the `SqlClient` interface.
2. Add `"test": "node --test dist/db/migrate/*.test.js"` to `packages/kernel/package.json`, and wire
   `check-migrations`, the `db-test` run and `catalog-check` into F-09 (`integration-db`, `migration-check`).
3. Pin the `postgres:17` image by digest in `docker/compose.ci.yml` (F-02/F-09).

## Unverified for staging (C-01)

Not provable on a single PostgreSQL 17 container; to be proven on RDS for PostgreSQL 17: role-level
`transaction_timeout` is accepted by `ALTER ROLE` and honoured on RDS (DEVOPS-PLAN 5.2); RDS minor version and
parameter support; `rds_superuser` (not superuser) running `db/roles` and the membership grants; that the RDS master
user owns nothing and appears in no application connection string; TC-AU-04 steps 1-4 rerun on `ENV-INT/staging`;
concurrency, lock-wait and `READ COMMITTED` re-read behaviour (not covered by the spike either).
