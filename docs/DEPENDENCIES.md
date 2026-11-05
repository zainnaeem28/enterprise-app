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

## Not chosen here

- Framework and library choices (NestJS, Kysely/Drizzle, Next.js, React, queue library, test runner) are made by the tickets that first need them, inside their own app or package manifest.
- **k6 (AGPL-3.0) is not adopted or assumed.** C-22 (owner and counsel decision on use as an unmodified test tool) is open; no load-test dependency is added by F-01.
- `pharmacy` is not scaffolded (R2).

## Import-boundary rule

`eslint/rules/module-boundaries.mjs` is a small local rule rather than a third-party plugin, so the allowed edges in `eslint/module-graph.mjs` (SHARED-BOUNDARIES 3.2, BD-02) are explicit and reviewable. It applies to `apps/api/src/modules/<module>/`. `pnpm test:boundary` runs it on a failing fixture (an upward import that must be rejected) and a passing fixture. The tool choice remains open to G2/Architect review (SHARED-BOUNDARIES 3.2 names dependency-cruiser or eslint-plugin-boundaries as alternatives).
