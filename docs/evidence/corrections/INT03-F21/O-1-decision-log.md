# INT03-F21-O1 decision-log: staff and patient routes on the four shared documents paths (Solution Architect)

Task: HEAAA-396 (parent HEAAA-391, INT03-F21). Source: branch `HEAAA-344-sdlc-integrate-int-03-r4-bounded-round-4-re-merge-f09a-then-journeys-screenshots-n-1-scans`, tip 16c4a47.

Revision 2 (HEAAA-401, source tip 9646e54): addresses SA Review round 1 on HEAAA-398 (SAR-O1-01 staff list `patientBanner`; SAR-O1-02 equal hosts rejected; SAR-O1-03 host sources; SAR-O1-04 download-url resolver). Changes are listed under "Revision 2 changes" at the end.

## Question

`apps/api/src/modules/documents/README.md` D4 / O-1: ARCHITECTURE 29.2 (patient, `my.`) and 29.3 (staff, `staff.`) list the same four paths:

| Path | 29.2 (patient) | 29.3 (staff) |
| --- | --- | --- |
| `POST /api/v1/patients/{patientId}/document-uploads` | `patient`, path, Idem | `documents.upload`, path, Idem |
| `POST /api/v1/document-uploads/{documentId}/complete` | `patient`, document, Idem | `documents.upload`, document, Idem |
| `GET /api/v1/patients/{patientId}/documents` | `patient`, path | `documents.read`, path, audited |
| `POST /api/v1/documents/{documentId}/download-url` | `patient`, document, audited `download` | `documents.read`, document, audited `download` |

Only the patient handlers are mounted. A route has one declaration, the guard derives the realm from the declared permission (`expectedRealm`, `apps/api/src/modules/identity/guard-policy.ts`), so a staff session on these paths gets `403 auth.forbidden` (realm mismatch). The staff chart Documents panel (`apps/staff/src/features/documents`) calls these paths and fails. How are the staff variants served?

## Facts checked (this revision)

- ARCHITECTURE 29 already puts the patient routes on host `my.` and the staff routes on host `staff.`; 27.2: "the patient routes only exist on `my.`". The contract is one path per host, not one path for both.
- The API knows both hosts as configuration: `EHR_STAFF_HOST`, `EHR_PATIENT_HOST` (`apps/api/src/identity-env.ts`, validated as host names without a port), already mapped to realms for sign-in (`composition.ts`: `hosts: { [staffHost]: 'google', [patientHost]: 'patient_pool' }`). Every local launch since M3 sets two distinct hosts (`localhost` / `127.0.0.1`).
- NestJS 12.3.3 (`@nestjs/core/router/router-explorer.js`, `applyHostFilter`): a controller declared `@Controller({ path, host })` runs its handler, guards included, only when `request.hostname` matches; otherwise it calls `next()` and Express tries the next route with the same path. So two host-bound controllers on one path are both served, each with its own `@Route` declaration, independent of registration order.
- The session cookie is `__Host-sid` (host-only), so a browser session belongs to the host that issued it; the guard compares the session's stored realm with the route's expected realm before any permission check.
- `DocumentsService` is realm-neutral and tested for staff scopes (README D4); `docBody(d, staff)` already returns the staff-only fields.

## Options

| | Option | For | Against |
| --- | --- | --- | --- |
| **A** | **Host-bound controllers**: the patient controller bound to `EHR_PATIENT_HOST`, a new staff controller bound to `EHR_STAFF_HOST`, same paths, each with its own declaration | Implements 29.2/29.3 exactly as written; no path, client or OpenAPI path change; guard, permission catalogue and realm rule unchanged; framework feature, no custom routing; the same pattern can later serve messaging O-2 | Hosts are needed when the controllers are built (factory argument); route inventory must learn that two entries on one path are legitimate only when host-bound to different hosts |
| B | Staff path prefix (e.g. `/api/v1/staff/patients/{id}/documents`) | No platform change at all | Changes the 29.3 contract and the staff client; the only prefixed staff routes in the API (every other staff route is unprefixed on `staff.`); one-off pattern that every future shared path would copy |
| C | One handler with a per-realm declaration (`permission` map; guard picks by session realm) | One handler per path | Changes the security-critical guard and the inventory's meaning; picking the declaration from the session makes the realm check a selector rather than a gate; widest review surface |
| D | Leave unmounted; show only the chart-summary documents list | No work | Fails 29.3 (staff upload, download) and the F21 journey; not acceptable for R1 |

## Decision: Option A

Reason: it is the contract ARCHITECTURE 29.2/29.3 already states (no contract change), it keeps the guard and its realm check as the security boundary unchanged, it touches the fewest files, and it is reversible (remove the host binding). Between A and B, A is not more expensive and avoids a contract and client change. Standards followed: ARCHITECTURE 27.1 (guard order, deny by default), 27.2 (patient routes only on `my.`), 29.2/29.3 (endpoint catalogue), 38.2 item 9 (route inventory), CN-04 (hidden resource is 404).

### Contract for the Backend Engineer (implementation task)

1. **Factory and host preconditions.** `createDocumentsControllers(d)` gains `hosts: { staff: string; patient: string }` and `banner: Pick<BannerService, 'bannerFor'>` (the same dependency the chart and front-door controllers receive); `composition.ts` passes `env.staffHost` / `env.patientHost` and the composed `BannerService`. Fail fast, never "bind to no host" or "bind both to one host":
   - `loadIdentityEnv` adds the problem `EHR_STAFF_HOST and EHR_PATIENT_HOST must differ` when the two values are equal after lower-casing (they are already lower-cased and port-free), so the process refuses to start.
   - `createDocumentsControllers` throws when either host is empty **or** when `hosts.staff.toLowerCase() === hosts.patient.toLowerCase()`. This second check covers test harnesses and any caller that builds the controllers without `loadIdentityEnv`. Equal hosts would make both controllers match the same requests, so registration order would pick one declaration and the other realm would get `403` on every shared path (the shadowing item 2 forbids), and the sign-in host map in `composition.ts` would collapse to one realm.
2. **Patient controller** (existing 29.2 handlers, unchanged bodies): `@Controller({ path: 'api/v1', host: hosts.patient })`. Every documents handler whose path is shared must be host-bound; an unbound duplicate path is forbidden (it would shadow the other host by registration order).
3. **Staff controller**: the existing `DocumentsStaffController` (controller.ts, today holding the staff-only routes) becomes `@Controller({ path: 'api/v1', host: hosts.staff })` and gains the four handlers:

   | Route | Declaration | Behaviour |
   | --- | --- | --- |
   | `POST /patients/{patientId}/document-uploads` | `{ permission: 'documents.upload', resolver: 'documents-patient' }` | Idempotency template `POST /patients/{patientId}/document-uploads` (as patient); `201 {documentId, uploadUrl, uploadHeaders, expiresAt}`; `422 documents.type_not_allowed`, `documents.too_large`; classification rules as the service enforces for staff |
   | `POST /document-uploads/{documentId}/complete` | `{ permission: 'documents.upload', resolver: 'document' }` | Idem; `202 {status: 'scanning'}` |
   | `GET /patients/{patientId}/documents` | `{ permission: 'documents.read', resolver: 'documents-patient' }` | `200 {items, nextCursor, patientBanner}`: `items` are `docBody(d, true)`; `patientBanner` (28.2, BR-34) is read with `banner.bannerFor(tx, ctx, meta, patientId)` **inside the same `withScope` transaction** as the list, as the chart routes do (`withBanner`, `clinical/chart/controller.ts`); `bannerFor` returning `undefined` is `404 kernel.not_found` (CN-04). **Audited** as a read of the patient's document list (IDs and action only, no file names) per 29.3; the banner read adds its own audit row only where `bannerFor` already writes one (allergy part filled) |
   | `POST /documents/{documentId}/download-url` | `{ permission: 'documents.read', resolver: 'document' }` | `{url, expiresAt}` (60 s), audited `download`; `409 documents.not_available` when not clean/confirmed. **Resolver deviation (deliberate):** ARCHITECTURE 29.3 row for this route and `documents.yaml` `x-access.staff.resolver` say `path`, but the path has no `patientId`; the patient is found from the document, so the resolver is `document` (as the patient host and `…/complete` already use). Do not "fix" the code back to `path`; the 29.3 / `documents.yaml` cell is corrected with the contract change below |

   The patient host's `GET /patients/{patientId}/documents` response is unchanged: `{items, nextCursor}`, no `patientBanner` (28.2 applies to staff responses only).

   The staff-only routes already in that controller (classification, confirm, legal holds, deletion requests/decide) are thereby host-bound too, so 27.2 holds for every documents route: patient routes only on `my.`, staff routes only on `staff.`.
4. **Guard: no change.** Realm still comes from the declared permission (`documents.*` -> `google`, `patient` -> `patient_pool`); location, patient scope (`patient.staff_sees`, BTG) and RLS apply as today. Host selects which declaration runs; it never grants anything.
5. **Route inventory** (`apps/api/src/platform/inventory.ts`): record the controller's host (`HOST_METADATA`) in each entry; add a failure when the same `METHOD path` appears more than once unless every occurrence is host-bound and the hosts are pairwise different.
6. **README / controller header**: close D4 and O-1 with a pointer to this decision; remove "not mounted" text.

### Security analysis

- Host is client-influenced (`Host`; `X-Forwarded-Host` from a trusted proxy address, `trust proxy` = loopback/linklocal/uniquelocal).
- **Two host sources (SAR-O1-03).** Route selection (NestJS `applyHostFilter`) uses Express `req.hostname`, which honours `X-Forwarded-Host` when the immediate peer is a trusted proxy. Sign-in (`hostOf`, `platform/http.ts`) and the `client-release` check use the raw `Host` header (lower-cased, port stripped). The two can differ when a trusted proxy sets `X-Forwarded-Host` to a value other than `Host`. This is fail-closed: a mismatch can only route to the other host's declaration, and that one requires the other realm (next point, required test 4). Later host-bound work must not assume one host source; it uses `req.hostname` for routing decisions and must not treat `hostOf` as equal to it. Steering a request to the other host's handler cannot widen access: the guard then requires the other realm, and the session's realm is server-side (`__Host-sid` lookup), so the request is `403 auth.forbidden`, audited `forbidden`. A host matching neither binding gets `404` (no route). Fail closed in every case.
- CSRF/Origin check, idempotency, RLS (T-PAT-OWN / T-STAFF), the 60 s download URL and "no file names anywhere" are unchanged.
- Staff responses add `suggestedClassification`, `retentionUntil`, `onLegalHold` only on the staff host (unchanged `docBody`).

### Required tests (real PostgreSQL, as `documents.dbtest.ts`)

1. Staff session on the staff host with `documents.read` / `documents.upload` and the patient in scope: list `200` with `items`, `nextCursor` and a `patientBanner` whose `patientId` equals the path patient (staff fields present on items), upload `201`, complete `202`, download `200` after a clean scan; list and download audited.
2. Staff without the permission -> `403`; patient out of staff scope -> `404` (CN-04); no session -> `401`.
3. Patient session on the patient host: existing TC-DOC tests unchanged and green; the patient list response has no `patientBanner`.
4. Cross-host: staff session sent with the patient host (via `Host` and via `X-Forwarded-Host` from a trusted address) -> `403`; patient session on the staff host -> `403`; unknown host -> `404`.
5. Inventory and host preconditions: the shared paths pass when host-bound to different hosts; a fixture with an unbound duplicate fails. `loadIdentityEnv` with `EHR_STAFF_HOST` equal to `EHR_PATIENT_HOST` (including a case that differs only in letter case, e.g. `Staff.example.test` / `staff.example.test`) reports the problem; `createDocumentsControllers` with equal hosts (same case and different case) throws, and with an empty host throws.
6. Browser: re-run the F16 staff chart Documents panel journey; panel shows the list (no `403`).

## Scope and follow-ups

- **Contract change routed (SAR-O1-01, SAR-O1-04).** `packages/contracts/openapi/documents.yaml` already marks `GET /patients/{patientId}/documents` `x-banner: true`, but `GetPatientsByPatientIdDocumentsResponse` has only `items` and `nextCursor`. The staff response needs an optional `patientBanner` (`$ref: common.yaml#/components/schemas/PatientBanner`), described as present on `staff.` only, and `x-access.staff.resolver` for `POST /documents/{documentId}/download-url` becomes `document`; the ARCHITECTURE 29.3 resolver cell for that row is corrected in the same change. **Deferral recorded:** owner Solution Architect (owner of the API contracts, ARCHITECTURE 29 and its OpenAPI transcription), tracked as HEAAA-402 with Solution Architect Reviewer review. Reason: this decision task covers the decision-log only, a contract file change needs its own reviewed revision, and routing it to the Orchestrator is refused by Paperclip (delegation cycle: the Orchestrator created HEAAA-344 in this chain). The implementation must not wait on it: the field is additive and optional, and the API conforms to ARCHITECTURE 28.2 as written.
- No other ARCHITECTURE contract change; 27.1 gains one clarifying sentence (same commit) that a path listed for both hosts is served by one host-bound handler per host.
- Messaging README O-2 (`POST /threads/{id}/messages` for the patient host) can use the same pattern when patient messaging is enabled; not in scope now (F17: patient messaging deferred under D-5).

## Review

Independent technical review: Solution Architect Reviewer. Security review of the host/realm analysis: Security Reviewer. Implementation is blocked on both PASS.

## Revision 2 changes (SA Review round 1, HEAAA-398)

| Finding | Change |
| --- | --- |
| SAR-O1-01 (major) | Staff list row returns `{items, nextCursor, patientBanner}`, banner read in the same transaction via injected `bannerFor` (`withBanner` pattern), `undefined` -> `404`; factory gains `banner`; required tests 1 and 3 assert presence on staff and absence on patient; `documents.yaml` response schema change deferred with owner (Solution Architect) and reason, tracked as HEAAA-402. |
| SAR-O1-02 (major) | `loadIdentityEnv` rejects equal hosts (after lower-casing); `createDocumentsControllers` throws on empty or equal hosts; required test 5 covers both, including a letter-case variant. |
| SAR-O1-03 (advisory) | Security analysis states `req.hostname` (routing, honours `X-Forwarded-Host` from trusted proxies) versus raw `Host` (`hostOf`, sign-in, client-release). |
| SAR-O1-04 (advisory) | Download-url row records the deliberate `resolver: 'document'` deviation from 29.3 / `documents.yaml` `path`; the contract cell is corrected with HEAAA-402. |
