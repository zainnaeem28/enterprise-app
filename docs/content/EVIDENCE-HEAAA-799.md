# Evidence: HEAAA-799 (site ContentSource on apps/cms, seed copy)

Code head tested: `56f8ea0` on branch `HEAAA-799-c-fe-cms-site-contentsource-on-apps-cms-and-reviewed-seed-copy-ruling-c-item-5` (from `origin/dev` `ff5476e`). The commit that adds this file changes docs only. Run on the server, no hosted CI (owner ruling B). Local PostgreSQL 17 (embedded binaries), throwaway CMS-role database. Not independently reviewed yet; no human approval is claimed.

| `ci` job | Result | Command / note |
| --- | --- | --- |
| lint-types | pass | `pnpm lint` (0 errors, 46 pre-existing warnings), `pnpm typecheck` exit 0. `pnpm format:check` lists 4 files outside this change (infra/*, scripts/ci/migration-check/*); the files of this change are clean |
| unit | pass | `node scripts/ci/run-unit.mjs`: 1482 tests, none skipped or failed (site 73, ui 172, staff 282, worker 139 ...) |
| build | pass | `pnpm build` exit 0 |
| cms (db suite + next build) | pass | `pnpm --filter @ehr/cms test:db` 14 tests, 0 skipped (seed idempotence; anonymous REST read; the site's real `createCmsContent` reading the real CMS REST handler over the cms schema); `build:next` exit 0; `migrate` on an empty database then `pnpm seed` twice: `seeded`, then `already-seeded` |
| secrets | pass | `SECRETS_RANGE=origin/dev..HEAD scripts/ci/secrets.sh`: no leaks in the branch commits or the working tree (a first tree scan counted 18 generic-api-key hits inside the gitignored `apps/cms/.next` build output; deleted, rescan clean) |
| deps | pass | `scripts/ci/deps.sh`: 1 non-blocking low (deepmerge, no fix, already known) |
| a11y/e2e (site Playwright + axe) | partial | `pnpm --filter @ehr/site test:a11y`: 8 passed, 1 failed (`TC-BS-01`: `<h1>` reported hidden). The identical failure occurs on unmodified `origin/dev` in this harness, so it is not caused by this change; cause not investigated |
| sast | not run | semgrep cannot be installed here (no pip). Not run: no hosted CI (owner ruling B) |
| integration-db, migration-check, N-1 upgrade, contract, bundle-budget, a11y-smoke (staff) | not run | not affected: this change touches only `apps/site`, `apps/cms`, `docs/content`; no main-database migration or API contract. Not run: no hosted CI (owner ruling B) |
| Lighthouse | not run | not run locally |

Migrations: the CMS has its own Payload migration `apps/cms/migrations/20261111_112842_site_content_and_organisation` (new tables only). No migration in the 2600-2699 main-database range.
