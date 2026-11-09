# Contract tooling (F-08)

`packages/contracts/openapi/` is the source of truth for the R1 API (ADR-018, CN-01): `openapi.yaml`
is the root index, `common.yaml` holds the shared headers, error envelope, pagination and banner,
and there is one file per module. After F-08's review the OpenAPI files, not
`docs/ARCHITECTURE.md` sections 28-31, are the contract; a change is made in the YAML and reviewed as
a contract change (CN-02). A module ticket edits only its own module file; `common.yaml` and the
root index belong to F-08.

Every operation carries:

- `x-access.<host>`: `permission` (or `who` / `caller`), `resolver`, `idempotencyKey`, `ifMatch`,
  `elevationRequired`, `pathAs` (the document's spelling of the path) and `catalogueRow`;
- `x-error-codes.<status>`: the section 30 codes the route can return;
- `x-provisional: true` on `/api/v1/auth/*` and `/api/v1/admin/auth/*` until ID-FREEZE.

Root `x-catalogue-interpretations` lists every place where the document had to be read, and
`x-catalogue-gap` marks routes whose catalogue row is incomplete. Both are findings for the Solution
Architect, not edits.

| Command (from `packages/contracts`) | What it does                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm run openapi:lint`             | Redocly `recommended` plus route-inventory rules, on the bundle and on each file |
| `pnpm run openapi:check-routes`     | Route count and conformance against `docs/ARCHITECTURE.md` 29.1-29.5 and 30      |
| `pnpm run generate`                 | Regenerates `src/generated/openapi.ts` (openapi-typescript, then Prettier)       |
| `pnpm run generate:check`           | Fails if the committed generated file is stale                                   |
| `pnpm run typecheck`                | `tsc` over the package, generated types included                                 |
| `pnpm run verify`                   | All of the above in order                                                        |

Reports are written to `packages/contracts/dist/contract-reports/` (not committed).

`route-expansions.mjs` expands the catalogue cells that use shorthand (`…/verify`) or list several
paths. It is keyed by the exact document text, so a changed row fails the check instead of being skipped.
