# INT04-F06 decision log: consent-template admin create/publish contract vs INT-03 text rules

- Task: HEAAA-455 (decision), for fix HEAAA-422 under INT-04 (HEAAA-139).
- Owner: Solution Architect. Review: Solution Architect Reviewer (independent review child task).
- Base: branch `HEAAA-422-sdlc-fix-int04-f06-...`, parent commit `6990c84` (HEAAA-139 tip line).
- Architecture change: amendment **A-6**, written into `docs/ARCHITECTURE.md` in the same commit as this log (22.5 `organisation.consent_template` row, 29.4 consent row notes, paragraph after the 29.4 table).

## 1. Facts checked

| # | Source | What it says |
| --- | --- | --- |
| F1 | `docs/ARCHITECTURE.md` 22.5, `organisation.consent_template` row | R1 model: `title` (≤ 200, plain text), `body_text` (≤ 20,000, plain text), `body_document_id` "nullable, unused in R1"; CK `title` and `body_text` NOT NULL when `published` (HEAAA-296 D3a); patient audience reads `published` rows only |
| F2 | `db/migrations/2003_consent_template_text.sql`, `2004_..._validate.sql` | Add `title`, `body_text`; `body_document_id` DROP NOT NULL; CK `consent_template_title_len` (`char_length(btrim(title))` 1..200), `consent_template_body_text_len` (`char_length(body_text)` 1..20000), `consent_template_published_has_text` (`status <> 'published' OR num_nulls(title, body_text) = 0`), validated in 2004 |
| F3 | `apps/api/src/modules/organisation/admin/service.ts` `createConsentTemplate` (~L1020) | Accepts `{key, language, bodyDocumentId}` only (`bodyDocumentId` required); writes no text. `CONSENT_SELECT` returns no text |
| F4 | same file, `publishConsentTemplate` (~L1097) | No body; draft → published by plain `UPDATE`, so a BE-23 draft violates F2's CK; the DB error surfaces as `400 kernel.invalid_format` at `/` |
| F5 | `ARCHITECTURE.md` 29.4 consent row; `packages/contracts/openapi/organisation.yaml` | No body schema in the catalogue; OpenAPI request and response bodies are `OpaqueObject` (generated from the catalogue, like every 29.4 admin route); both routes already list `400 kernel.validation_failed` |
| F6 | `apps/staff/src/features/admin-config/Templates.tsx` (L148-158), `admin-config.test.tsx`, `e2e/admin-config.spec.ts` | The staff portal form sends `bodyDocumentId` (required UUID field) and has no title/text fields |
| F7 | `apps/api/src/modules/organisation/admin/fields.ts` | Field errors already used by the admin API: `kernel.required` (missing on create), `kernel.invalid_format` (wrong type or out of bounds), `kernel.unknown_field` (key not allowed), all inside `400 kernel.validation_failed` |
| F8 | INT-04 r1 `docs/evidence/integration/M5/INT-04-FINDINGS.md` row F06 | integration-db fails 1 of 980 on the combined tree only |

Conclusion on the conflict: the INT-03 constraint follows the approved model (F1, HEAAA-296 D3a); BE-23 was written against the pre-2003 schema and is stale. The constraint stays exactly as it is.

## 2. Decisions

### D-1. Which option

| Option | Description | For | Against |
| --- | --- | --- | --- |
| A | Create takes `{key, language, title, bodyText}`; publish unchanged (no body) | No new endpoint; matches the existing versioning model (a change is a new draft version, as for questionnaire templates); smallest change | Staff portal form must change (F6) |
| A′ (A with optional text) | Create may omit text; publish refuses a textless draft | — | No endpoint can add text later, so a textless draft can never be published: it is dead data and a confusing UI path |
| B | Add a draft-edit `PATCH` for `title`/`bodyText` | Lets an admin fix a typo without a new version | New route, new permission/If-Match/audit design, new catalogue row and OpenAPI path; drafts become mutable state needing concurrency rules; not needed by any PRD requirement |

**Choice: Option A, with `title` and `bodyText` required at create.** A correction before publishing is a new draft version (versions are cheap and per key and language). Option B can be added later as an additive change (28.5) if product asks for draft editing; nothing in A blocks it. Follows ARCHITECTURE 22.5 (F1), 28.5 (additive evolution), and the "simpler, reversible" rule.

Create request body (closed; any other key → `kernel.unknown_field`):

| Field | Rule (matches the DB CHECKs of F2) | Error path and code (inside `400 kernel.validation_failed`) |
| --- | --- | --- |
| `key` | Unchanged (required, ≤ 100, `KEY100`) | unchanged |
| `language` | Unchanged (required, 2..35) | unchanged |
| `title` | Required string; stored **trimmed** (`trim()`); trimmed length 1..200 **Unicode code points** (the DB counts `char_length`, not UTF-16 units); no U+0000 | missing → `/title` `kernel.required`; not a string, blank after trim, too long, or U+0000 → `/title` `kernel.invalid_format` |
| `bodyText` | Required string; stored as sent (not trimmed, line breaks kept); length 1..20,000 Unicode code points; at least one non-whitespace character; no U+0000 | missing → `/bodyText` `kernel.required`; otherwise invalid → `/bodyText` `kernel.invalid_format` |

Both are plain text. The API stores them as given (no HTML parsing or sanitising); every renderer (staff portal, patient app) must render them as text, never as HTML (unchanged from F1 "plain text").

Responses (create, publish, list) return `id, key, version, language, title, bodyText, status, rowVersion`. List pages keep the existing limit (default 25, max 100), so a page carries at most about 2 MB of text; no change to `parsePage`.

### D-2. Does `bodyDocumentId` stay accepted?

**No.** It is removed from the create body and from responses. A request that sends it gets `400 kernel.validation_failed` with `/bodyDocumentId` `kernel.unknown_field` (the existing closed-body rule, F7). The column stays (expand-only migrations; F1 "unused in R1") and is never written by R1 code, so it is null on every new row.

Reason: the column has no use in R1, no FK to `documents`, and no reader; accepting a dangling document reference would suggest a feature that does not exist and give the patient read path two possible sources of wording. Re-adding it later is an additive change.

### D-3. Error when text is absent at publish

Only drafts created before migration 2003 can lack text (D-1 makes new drafts always carry it). For such a draft, publish returns **`400 kernel.validation_failed`** with `errors[]` naming each missing field: `{path: "/title", code: "kernel.required"}` and/or `{path: "/bodyText", code: "kernel.required"}`. The paths name the template's fields (publish has no body); the row stays `draft`, nothing is audited as published. The fix for the admin is to create a new version with text.

Mechanics: inside the existing transaction, after `SELECT … FOR UPDATE` and the `412` status check, the service reads `title` and `body_text` and refuses before the `UPDATE`. The CHECK constraint stays as the backstop; the API must never rely on mapping the raw `23514` error. No new error code, so section 30 and OpenAPI `x-error-codes` are unchanged (both routes already list `kernel.validation_failed`).

### D-4. Contract and OpenAPI

- **ARCHITECTURE:** amendment A-6 (this commit): 22.5 row note, 29.4 consent row notes, and an A-6 paragraph after the 29.4 table with the body, response and error rules above. Only `kernel.validation_failed` is named in the 29.4 notes column, so `scripts/contracts/check-routes.mjs` stays green (it requires every code named in a row's notes to be on the route).
- **OpenAPI:** no change required. 29.4 admin routes are generated with `OpaqueObject` bodies and the error codes do not change. The Backend Engineer runs `pnpm --filter @app/contracts verify` (or the package's `verify` script) on the implementation commit and attaches the output.
- **Module README:** `apps/api/src/modules/organisation/admin/README.md` L13 is updated by the Backend Engineer to name the consent body.

## 3. Implementation scope (for HEAAA-422)

Backend Engineer (HEAAA-422):
1. `createConsentTemplate`: fields per D-1, INSERT `title`, `body_text` (no `body_document_id`), audit `after` = `{key, version, language, status, title, bodyTextSha256}` (hex SHA-256 of the stored `bodyText`; the text itself is not copied into audit).
2. `publishConsentTemplate`: D-3 pre-check.
3. `CONSENT_SELECT`: add `title`, `body_text AS "bodyText"`; drop `bodyDocumentId`.
4. Tests (`admin.dbtest.ts`, unit tests): create with text then publish → 200 and `title`/`bodyText` echoed; versions per language unchanged; missing `title` → `/title kernel.required`; `bodyDocumentId` sent → `/bodyDocumentId kernel.unknown_field`; title of 201 code points and whitespace-only title → `kernel.invalid_format`; a 200-code-point title made of astral characters (400 UTF-16 units) is accepted; `bodyText` of 20,001 code points → `kernel.invalid_format`; a legacy draft inserted directly with null text (owner connection) → publish `400` with both paths, row still `draft`; the patient-audience read of `organisation.consent_template` sees the published text. The INT-03 CHECKs are not touched by any migration.
5. README update and contracts `verify` output.

Frontend (staff portal; F6) — the form must change in the same integration candidate or the staff create flow breaks: replace the `bodyDocumentId` field with `title` (≤ 200) and `bodyText` (multi-line, ≤ 20,000), show both in the list/detail for review before publish, render as text; update `admin-config.test.tsx` and `e2e/admin-config.spec.ts`. The Orchestrator assigns this (Frontend Engineer, Frontend Reviewer); it is blocked on the same review as the API change.

Reviews of the implementation: Backend Reviewer (API), Frontend Reviewer (portal). No security-control change (no permission, RLS, grant or constraint change), so no Security Reviewer stage is required by this decision.

## 4. What is not changed

The INT-03 constraints and migrations 2003/2004; the permission (`organisation.template.manage`), elevation on publish, `412` on a second publish; the questionnaire template routes; section 30.
