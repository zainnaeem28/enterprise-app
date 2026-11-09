# INT03-F21-O1 decision-log: staff and patient routes on the four shared documents paths (Solution Architect)

Task: HEAAA-396 (parent HEAAA-391, INT03-F21). Source: branch `HEAAA-344-sdlc-integrate-int-03-r4-bounded-round-4-re-merge-f09a-then-journeys-screenshots-n-1-scans`, tip 16c4a47.

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

1. **Factory.** `createDocumentsControllers(d)` gains `hosts: { staff: string; patient: string }`; `composition.ts` passes `env.staffHost` / `env.patientHost`. An empty host (unset in a test harness) fails fast at composition (throw), never "bind to no host".
2. **Patient controller** (existing 29.2 handlers, unchanged bodies): `@Controller({ path: 'api/v1', host: hosts.patient })`. Every documents handler whose path is shared must be host-bound; an unbound duplicate path is forbidden (it would shadow the other host by registration order).
3. **Staff controller**: the existing `DocumentsStaffController` (controller.ts, today holding the staff-only routes) becomes `@Controller({ path: 'api/v1', host: hosts.staff })` and gains the four handlers:

   | Route | Declaration | Behaviour |
   | --- | --- | --- |
   | `POST /patients/{patientId}/document-uploads` | `{ permission: 'documents.upload', resolver: 'documents-patient' }` | Idempotency template `POST /patients/{patientId}/document-uploads` (as patient); `201 {documentId, uploadUrl, uploadHeaders, expiresAt}`; `422 documents.type_not_allowed`, `documents.too_large`; classification rules as the service enforces for staff |
   | `POST /document-uploads/{documentId}/complete` | `{ permission: 'documents.upload', resolver: 'document' }` | Idem; `202 {status: 'scanning'}` |
   | `GET /patients/{patientId}/documents` | `{ permission: 'documents.read', resolver: 'documents-patient' }` | `200` list with `docBody(d, true)`; **audited** as a read of the patient's document list (IDs and action only, no file names) per 29.3 |
   | `POST /documents/{documentId}/download-url` | `{ permission: 'documents.read', resolver: 'document' }` | `{url, expiresAt}` (60 s), audited `download`; `409 documents.not_available` when not clean/confirmed |

   The staff-only routes already in that controller (classification, confirm, legal holds, deletion requests/decide) are thereby host-bound too, so 27.2 holds for every documents route: patient routes only on `my.`, staff routes only on `staff.`.
4. **Guard: no change.** Realm still comes from the declared permission (`documents.*` -> `google`, `patient` -> `patient_pool`); location, patient scope (`patient.staff_sees`, BTG) and RLS apply as today. Host selects which declaration runs; it never grants anything.
5. **Route inventory** (`apps/api/src/platform/inventory.ts`): record the controller's host (`HOST_METADATA`) in each entry; add a failure when the same `METHOD path` appears more than once unless every occurrence is host-bound and the hosts are pairwise different.
6. **README / controller header**: close D4 and O-1 with a pointer to this decision; remove "not mounted" text.

### Security analysis

- Host is client-influenced (`Host`; `X-Forwarded-Host` from a trusted proxy address, `trust proxy` = loopback/linklocal/uniquelocal). Steering a request to the other host's handler cannot widen access: the guard then requires the other realm, and the session's realm is server-side (`__Host-sid` lookup), so the request is `403 auth.forbidden`, audited `forbidden`. A host matching neither binding gets `404` (no route). Fail closed in every case.
- CSRF/Origin check, idempotency, RLS (T-PAT-OWN / T-STAFF), the 60 s download URL and "no file names anywhere" are unchanged.
- Staff responses add `suggestedClassification`, `retentionUntil`, `onLegalHold` only on the staff host (unchanged `docBody`).

### Required tests (real PostgreSQL, as `documents.dbtest.ts`)

1. Staff session on the staff host with `documents.read` / `documents.upload` and the patient in scope: list `200` (staff fields present), upload `201`, complete `202`, download `200` after a clean scan; list and download audited.
2. Staff without the permission -> `403`; patient out of staff scope -> `404` (CN-04); no session -> `401`.
3. Patient session on the patient host: existing TC-DOC tests unchanged and green.
4. Cross-host: staff session sent with the patient host (via `Host` and via `X-Forwarded-Host` from a trusted address) -> `403`; patient session on the staff host -> `403`; unknown host -> `404`.
5. Inventory: the shared paths pass when host-bound to different hosts; a fixture with an unbound duplicate fails.
6. Browser: re-run the F16 staff chart Documents panel journey; panel shows the list (no `403`).

## Scope and follow-ups

- No ARCHITECTURE contract change; 27.1 gains one clarifying sentence (same commit) that a path listed for both hosts is served by one host-bound handler per host.
- Messaging README O-2 (`POST /threads/{id}/messages` for the patient host) can use the same pattern when patient messaging is enabled; not in scope now (F17: patient messaging deferred under D-5).

## Review

Independent technical review: Solution Architect Reviewer. Security review of the host/realm analysis: Security Reviewer. Implementation is blocked on both PASS.
