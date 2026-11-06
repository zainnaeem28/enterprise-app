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

## API and worker dependencies (`apps/api`, `apps/worker`, F-05 unblock, HEAAA-154)

Checked 2026-11-05 against the npm registry (`npm view`: latest dist-tag and licence) and `pnpm audit --prod` on the regenerated lockfile (result: "No known vulnerabilities found"). No OSV-Scanner binary is available on this host; the DELIVERY-PLAN section 9 OSV job in CI remains the authoritative scan. All versions are exact pins; `pnpm install --frozen-lockfile` is clean.

| Package | Version | Licence | Known-vulnerability check | Maintenance evidence | Reason |
| --- | --- | --- | --- | --- | --- |
| @nestjs/common | 12.3.3 | MIT | `pnpm audit --prod`: none. | Latest dist-tag 12.3.3 published 2026-11-04; 12.3.0 to 12.3.2 on 2026-10-27. | ARCHITECTURE 7 framework; first needed by F-05 (app shell, guard hook, limits, health). `apps/api` only. |
| @nestjs/core | 12.3.3 | MIT | `pnpm audit --prod`: none. | As above (same release train). | Nest DI container and application factory. `apps/api` only. |
| @nestjs/platform-express | 12.3.3 | MIT | `pnpm audit --prod`: none. | As above. | HTTP adapter for the API. Brings `express`, `multer`, `busboy` (MIT) and `qs` (BSD-3-Clause). `apps/api` only; the worker has no Nest HTTP. |
| reflect-metadata | 0.2.2 | Apache-2.0 | `pnpm audit --prod`: none. | Latest dist-tag; last release 2024-03-29 (stable, feature-complete polyfill; peer requirement of `@nestjs/common`). | Decorator metadata for Nest DI (`emitDecoratorMetadata`). |
| rxjs | 7.8.2 | Apache-2.0 | `pnpm audit --prod`: none. | Latest 7.x release 2025-02-22 (registry modified 2026-10-09). | Peer requirement of `@nestjs/core`/`common` (`^7.1.0`). |

Workspace dependencies (no registry package): `apps/api` depends on `@ehr/kernel` and `@ehr/contracts`; `apps/worker` depends on `@ehr/kernel` only (graphile-worker arrives through the kernel).

Resolved production tree of `@ehr/api`: 95 packages (excluding workspace links), read from installed manifests: 83 MIT, 5 ISC (`iterare`, `inherits`, `setprototypeof`, `once`, `wrappy`), 2 BSD-3-Clause (`ieee754`, `qs`), 2 Apache-2.0 (`reflect-metadata`, `rxjs`), 1 0BSD (`tslib`), 2 declared as `licenses` arrays of MIT (`busboy`, `streamsearch`). No copyleft.

Caveats for the reviewer: Nest 12.3.x is 9 days old at pinning (12.3.0 on 2026-10-27); it is the latest line and the version named by the F-05 ticket. `apps/api` build now emits to `dist/src` and `dist/test` (`rootDir` is `.`); `pnpm --filter @ehr/api test` runs `node --test "dist/test/**/*.test.js"`. `check:routes` delegates to the existing contracts document-versus-OpenAPI check (`@ehr/contracts openapi:check-routes`); F-05 may repoint it at an implementation-route inventory script it owns. CI wiring of either is F-09.

## Not chosen here

- Framework and library choices (Kysely/Drizzle, Next.js, React, test runner) are made by the tickets that first need them, inside their own app or package manifest.
- **k6 (AGPL-3.0) is not adopted or assumed.** C-22 (owner and counsel decision on use as an unmodified test tool) is open; no load-test dependency is added by F-01.
- `pharmacy` is not scaffolded (R2).

## Import-boundary rule

`eslint/rules/module-boundaries.mjs` is a small local rule rather than a third-party plugin, so the allowed edges in `eslint/module-graph.mjs` (SHARED-BOUNDARIES 3.2, BD-02) are explicit and reviewable. It applies to `apps/api/src/modules/<module>/`. `pnpm test:boundary` runs it on a failing fixture (an upward import that must be rejected) and a passing fixture. The tool choice remains open to G2/Architect review (SHARED-BOUNDARIES 3.2 names dependency-cruiser or eslint-plugin-boundaries as alternatives).
