# Dependencies (F-01)

Every top-level dependency, with licence and reason. A new top-level dependency is added here with its licence and reason and must pass OSV and licence scanning (DELIVERY-PLAN section 9). Versions are exact pins; the lockfile (`pnpm-lock.yaml`) is the single source of resolved versions.

## Toolchain

| Item | Version | Licence | Reason |
| --- | --- | --- | --- |
| Node.js | 24.22.2 (`.nvmrc`, `engines`) | MIT | Active LTS line available on the build host; exact version pinned for reproducible builds. Not yet verified against the AWS runtime image (DEVOPS-PLAN 3.2); revisit with the container tickets. |
| pnpm | 12.16.1 (`packageManager`, via Corepack) | MIT | Strict, content-addressed workspaces and `--frozen-lockfile`; one root lockfile (DEVOPS-PLAN 4.3). |

## Root dev dependencies

| Package | Version | Licence | Reason |
| --- | --- | --- | --- |
| typescript | 5.9.3 | Apache-2.0 | ARCHITECTURE 7: TypeScript front to back. 5.9 is inside the range supported by typescript-eslint 8.72 (`<6.1`); TypeScript 7 is not used because typescript-eslint does not declare support for it. |
| eslint | 10.14.0 | MIT | Lint (DEVOPS-PLAN 5.1) and the import-boundary rule. |
| @eslint/js | 10.0.1 | MIT | ESLint recommended rules. |
| typescript-eslint | 8.72.1 | MIT | TypeScript parser and rules for ESLint. |
| eslint-config-prettier | 10.1.8 | MIT | Turns off lint rules that conflict with Prettier. |
| globals | 17.14.0 | MIT | Node globals for `.mjs` tooling files. |
| prettier | 3.9.10 | MIT | Formatting check (DEVOPS-PLAN 5.1). |
| @types/node | 24.19.2 | MIT | Node typings matching the pinned major. |

## Kernel runtime dependencies (`packages/kernel`, F-04 unblock, HEAAA-150)

Checked 2026-11-05 against the npm registry and `pnpm audit --prod` on the committed lockfile. Evidence is what was executed; no OSV-Scanner binary is available on this host, so the DELIVERY-PLAN section 9 OSV job in CI remains the authoritative scan.

| Package | Version | Licence | Known-vulnerability check | Maintenance evidence | Reason |
| --- | --- | --- | --- | --- | --- |
| pg | 8.23.1 | MIT | `pnpm audit --prod`: no known vulnerabilities (pg and its 6 direct runtime dependencies, all MIT, `pg-int8` ISC). | node-postgres, maintained by brianc; 8.23.1 published 2026-09-30, minor releases roughly monthly through 2026 (8.18.0 2026-01-30 to 8.23.0 2026-08-08). | PostgreSQL driver for the kernel `Queryable`/`PoolLike` surface (`packages/kernel/src/db.ts`), the migration runner, and the `db/tools` scripts, which import it dynamically (also an exact-pinned root devDependency so `db/tools` resolves it from the repo root). |
| graphile-worker | 0.18.0 | MIT | `pnpm audit --prod`: no known vulnerabilities across its resolved tree (see below). | graphile/worker, maintained by Benjie Gillam; 0.17.0 2026-06-12, patch releases to 0.17.3 2026-07-08, 0.18.0 2026-09-08. | ARCHITECTURE 21.8 first candidate queue library: `add_job` is plain SQL, so enqueue runs inside the caller's transaction (outbox). **Still Unverified** against the G2 acceptance test SBR-17 (b)-(d) on `FORCE`d tables; that needs a real PostgreSQL 17 and is not executed here. If it fails the test, it is replaced (pg-boss is the alternative). |

Resolved transitive runtime packages of these two (16 in total, from `pnpm ls --prod`): `@graphile/logger` 0.3.0, `@types/debug` 4.1.13, `@types/pg` 8.23.1, `cosmiconfig` 8.3.6, `graphile-config` 0.0.1-beta.18, `json5` 2.2.3, `yargs` 17.7.3 (graphile-worker); `pg-cloudflare`, `pg-connection-string`, `pg-pool`, `pg-protocol`, `pg-types`, `pgpass` (pg). Licences read from the installed manifests: all MIT except `pg-int8` and `yargs-parser` (ISC); no copyleft.

Caveats for the reviewer: `graphile-config` is a pre-release (`0.0.1-beta.18`) pulled in by graphile-worker; it is pinned by the lockfile and not a direct dependency. `@types/pg` is a transitive dependency of graphile-worker and is not declared by the kernel.

## Not chosen here

- Framework and library choices (NestJS, Kysely/Drizzle, Next.js, React, test runner) are made by the tickets that first need them, inside their own app or package manifest.
- **k6 (AGPL-3.0) is not adopted or assumed.** C-22 (owner and counsel decision on use as an unmodified test tool) is open; no load-test dependency is added by F-01.
- `pharmacy` is not scaffolded (R2).

## Import-boundary rule

`eslint/rules/module-boundaries.mjs` is a small local rule rather than a third-party plugin, so the allowed edges in `eslint/module-graph.mjs` (SHARED-BOUNDARIES 3.2, BD-02) are explicit and reviewable. It applies to `apps/api/src/modules/<module>/`. `pnpm test:boundary` runs it on a failing fixture (an upward import that must be rejected) and a passing fixture. The tool choice remains open to G2/Architect review (SHARED-BOUNDARIES 3.2 names dependency-cruiser or eslint-plugin-boundaries as alternatives).
