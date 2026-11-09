# admin routes (BE-24)

Owner: Backend Engineer. Design: ARCHITECTURE 29.4 (audit and integration rows), 25.8, 25.9, 30, 31; PRD RA-R1-12, RA-R1-31, RA-R1-32.
Contract: `packages/contracts/openapi/audit.yaml` and `integration-core.yaml` (`staff.` realm `admin_pool`).

## What is here, and what is not

| Route                                                         | Permission                                | Elevation   | Notes                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/audit-events/search`                             | `audit.event.read`                        | no          | <= 31 days, one `view` row per query                                                                                                |
| `POST /admin/audit-exports`, `POST …/{id}/download-url`       | `audit.export.create`                     | yes         | async job, size limit setting, `export` row with reason; download only for the requester, only while `ready`, audited as `download` |
| `GET /admin/audit-exports/{id}`                               | `audit.export.create`                     | no          | status only, never content                                                                                                          |
| `GET /admin/btg-grants`, `POST /admin/btg-grants/{id}/review` | `audit.btg.review`                        | review: yes | `403 audit.self_review` (audited as a denial), once (`409`); the contract does not mark the review as elevated, the acceptance does |
| `GET /admin/integrations`, `PATCH /admin/integrations/{id}`   | `integration.connection.read` / `.manage` | PATCH yes   | `If-Match` (428/412), before/after audited, credential-looking setting keys refused                                                 |
| `PUT /admin/integrations/{id}/secrets/{name}`                 | `integration.secret.write`                | yes         | write-only; answers `{versionId}`; optional `Idempotency-Key` (UUID) makes a retry write no second version                          |
| `POST …/inbound-secret-requests`, `…/{requestId}/approve`     | `integration.secret.write` / `.approve`   | yes         | 25.9 dual control; the worker applies (never this route)                                                                            |
| `POST /admin/integrations/{id}/test`                          | `integration.connection.manage`           | yes         | `{health, checkedAt}` from the injected `ConnectionTester`; audited                                                                 |

Already built by their own tickets and mounted next to these by the composition root (not repeated here): users and roles, role-change
request / different-approver approval, kill switch, enrolment (identity admin, BE-05); privacy requests and incidents (BE-20); organisation
configuration (BE-23). Their C4 / C6 tests run on this revision (`evidence/identity-admin-privileged.txt`).

## Guarantees

- Authorization is the guard's (realm, permission, live elevation grant); handlers repeat none of it. Table policies are the second line.
- Bodies are exact objects; errors carry codes and field paths only, never a value (secret values travel in these bodies).
- A secret value reaches the secret store and nothing else: tests scan every response, audit row, table and queue payload for it.
- Every accepted change is audited in the same transaction (a failed audit write rolls it back); refusals that matter use `recordDenied`.

## Notes for the Orchestrator / Architect

- **N-BE24-1 (module graph).** `eslint/module-graph.mjs` has no `admin-routes` entry, so `boundaries/module-boundaries` rejects this directory's
  imports. With a one-line temporary edit (`L6: ['admin-routes']`, a layer above reporting that nothing imports) eslint is clean. The file is outside
  this ticket's paths: **request to add it**.
- **N-BE24-2 (wiring).** Not mounted (`composition.ts` is outside the paths). The Integrator adds `createAdminRoutesControllers({audit, integrations, scopeOf, sessionIdOf})`
  with `AuditAdminService({db, audit, elevationIdOf, signer})` and `IntegrationAdminService({db, audit, connections, secrets, tester})`:
  `elevationIdOf(tx, sessionId)` returns the live `identity.elevation_grant` id of the caller's session (see `testkit.ts`);
  `signer` signs the object-store download (without it the download is `503`); `tester` runs the worker's health probe for one connection and stores
  the result (the API role cannot write the health columns); without it "test" is `503` and changes nothing.
- **N-BE24-3 (audit tables read here).** The audit module publishes no list of BTG grants or export status; `audit-routes.ts` reads `audit.btg_grant`,
  `audit.btg_review` and `audit.export_job` (read only, same policies). Ask the audit owner for `listBtgGrants` / `exportStatus` if cross-module SQL is not wanted.
  The integration list likewise reads `integration_core.secret_ref` metadata (names, class, version ID).
- **N-BE24-4 (approver naming).** 29.4 says the inbound-secret request body names the approver; the stored canonical request has no approver (INT-N3), so an
  `approverPersonId` field is **refused** (unknown field) rather than silently ignored. Architect to reconcile.
- **N-BE24-5 (inbound apply).** INT-N4/N5 still stand: without the sealed-payload enqueuer (kernel amendment) the request is `503`, and the default evidence verifier refuses.
- **N-BE24-6 (BE-20 migrations).** The BE-20 branch (HEAAA-110) and the BE-05/BE-23 branch both number migrations 1600..1603 (`DUPLICATE_VERSION`), so the two cannot be
  combined without renumbering. This ticket does not need BE-20's code and was built on BE-23/BE-05/BE-02/BE-01; the collision is an integration item.
- **N-BE24-7 (TC-AD-14).** The worker-side refusal is proven by BE-02's suite (`evidence/integration-core.txt`); here the approval route is shown to apply nothing.

## Tests

- `admin-routes.test.ts`: parsing and error translation (no database).
- `admin-routes.dbtest.ts`: HTTP through the real guard on PostgreSQL 17 with the real migrations (TC-AD-11..15 API parts, C4 export/review/secret rules):
  `EHR_TEST_ADMIN_URL=... node --test dist/src/modules/admin-routes/admin-routes.dbtest.js`.
- `evidence/`: raw runs on this revision of this suite, the audit suite, integration-core and the identity privileged suite (C4 role changes, self-approval, kill switch).
