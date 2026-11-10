# Database jobs: `integration-db` and `migration-check` (F-09, HEAAA-79)

Source: DEVOPS-PLAN 4.2, 5.1, 5.2, 8.1; TEST-CASES 0.3 (`ENV-INT/ci`). Both jobs run in `.github/workflows/ci.yml` on a
PostgreSQL 17 service container (trust authentication, loopback, synthetic data, image pinned by digest) and write raw
reports to `reports/<job>/` (uploaded as an artifact).

| Entry point               | Does                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration-db.sh`       | Runs the database-backed suites of every workspace (`db-foundation`, `kernel`, `api`, `worker`; JUnit via `node --test`), then `n-minus-1.sh`. A missing, empty, failing or skipped suite fails (`check-junit.mjs`).                                                                                        |
| `n-minus-1.sh`            | Upgrade path and N-1: checks out the previous release tag in a worktree, migrates a database with **its** tooling and migrations, then applies the candidate's. Then replaces the tag's `db/migrations` and `db/roles` with the candidate's and runs the **tag's own** database suites against that schema, with the candidate's `catalog-lists.mjs`/`catalog-check.mjs`. Tests listed in `n-minus-1-pins.tsv` pin the previous catalog size; their failure is accepted only as exactly that assertion and reported as "not a pass" in `n-minus-1-pins.txt` (HEAAA-739). |
| `migration-check.sh`      | Migration lint (DML ban, expand/contract), then all catalog rules after migrating **from empty** and **from the previous release tag**, then the secret-reference lint.                                                                                                                                     |
| `verify-catalog.mjs`      | Requires every rule of DEVOPS-PLAN 5.2 to be **present** in the report and passing; a deleted check fails like a violation.                                                                                                                                                                                 |
| `extra-checks.mjs`        | Rules `db/tools/catalog-check.mjs` does not run: no `BYPASSRLS` (non-superuser), the administrator (RDS master user stand-in) owns nothing, no membership in a superuser role.                                                                                                                              |
| `lint-config-secrets.mjs` | RDS master user in an application connection string, DB-user setting or secret reference of tracked configuration (`infra/**`, task definitions, `*.json                                                                                                                                                    | yml | tf  | env`). |
| `seed.sh <job>`           | Seeded-violation control: one defect per scenario in a throwaway copy; the job entry point must fail **and name the rule**. Runs as the last step of each job, so a gate that cannot fail turns the job red.                                                                                                |

## Rule map (DEVOPS-PLAN 5.2 -> check id)

| Rule                                                                                     | Check                                                                                                      |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| RLS enabled and FORCEd                                                                   | `M-1`, `M-1-kernel`                                                                                        |
| policy `TO PUBLIC`                                                                       | `M-2`, `M-3`                                                                                               |
| view without `security_invoker`                                                          | `M-4-views`                                                                                                |
| `patient_id` table without merge write guard                                             | `M-5-patient-guard`                                                                                        |
| definer not in inventory / no fixed `search_path` / owner can log in                     | `M-5-definer`, `R-attributes`                                                                              |
| audit-writing role without role-level `transaction_timeout`; `app_owner` INSERT on audit | `R-timeouts`, `R-app-owner-no-audit-insert`                                                                |
| DML in a migration; expand/contract; non-concurrent index                                | `check-migrations.mjs` (runner rules `DML`, `EXPAND_DESTRUCTIVE`, `EXPAND_LOCKING`, `CONTRACT_*`)          |
| previous release's suite against the new schema                                          | `n-minus-1.sh`                                                                                             |
| `BYPASSRLS`, application role owns a table                                               | `R-attributes`, `X-bypassrls`, `R-no-owned-tables`                                                         |
| RDS master user owns objects / appears in config                                         | `X-admin-owns-nothing`, `X-extensions-allowlisted`, `X-no-superuser-membership`, `lint-config-secrets.mjs` |

## Previous release tag

Tags are `r<release_number>` (`RELEASE_TAG_GLOB`, default `r[0-9]*`): the newest one that is an ancestor of `HEAD` and not
`HEAD`. **If none exists (before the first release) the upgrade path and the N-1 suite do not run**; the job prints a notice
and writes `previous-release.json` with `"status":"none"`. That is **not a pass of those checks**. Set the repository
variable `REQUIRE_PREVIOUS_RELEASE_TAG=true` once the first release tag exists; the jobs then fail when no tag is found.

### Rehearsal baselines (before the first production release)

Until the first production release, the newest `r<N>` tag is a **rehearsal baseline**, not a release: no manifest, image or
G3 exists for it. Rehearsal baselines:

| Tag    | Decision ticket |
| ------ | --------------- |
| `r133` | HEAAA-658       |
| `r206` | HEAAA-676       |

- **P-1 (before the first production release).** When a reviewed, deliberate change (with its own decision ticket) makes the
  rehearsal baseline's suites fail, the Solution Architect may decide to add a newer rehearsal tag, reviewed by the Solution
  Architect Reviewer. Existing tags are never moved or deleted. Accidental regressions are never handled this way: they are
  fixed in the candidate.
- **P-2 (after the first production release).** The baseline is the deployed release and is never advanced to make CI
  green. An N-1 failure is fixed with expand/contract in the candidate. A per-test expected-incompatibility list may only be
  introduced by a separate architecture decision for a change that cannot be made compatible, with a rollout plan that
  guarantees no N-1 task runs against the new schema.

When the first real release is tagged, set `REQUIRE_PREVIOUS_RELEASE_TAG=true`; rehearsal tags then stop being the newest.

## Limits

- PostgreSQL in CI is a container, not RDS. Role-level `transaction_timeout` visible to the audit trigger on RDS stays
  **Unverified** until staging (DEVOPS-PLAN 5.2).
- `X-admin-owns-nothing` does not count member objects of `btree_gist` and `pg_trgm` when they are owned by the bootstrap
  superuser (OID 10) and the extension is owned by `app_owner` (PostgreSQL does this for trusted extensions; HEAAA-594).
  `X-extensions-allowlisted` fails on any other extension. Ownership by `rdsadmin` on RDS stays **Unverified** until staging.
- `lock_timeout` guards are applied by the runner (F-03); this job does not add a separate check for them.
- The secret-reference lint is pattern-based over tracked files. It cannot see a task definition that is generated at
  deploy time; the deploy workflow must lint the rendered definition (later ticket).
- `MIGRATION_CHECK_SEED_SQL` exists only for the seeded-violation control.
