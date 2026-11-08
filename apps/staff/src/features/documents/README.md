# Staff documents (FE-06, HEAAA-105)

Shared documents UI for J-19 (SH-01 upload with progress, scan state, classification and confirm; SH-02 list and viewer).
The reusable part is `packages/app-shell/src/documents/` (`DocumentsPanel`, typed `createDocumentsApi`, resumable `runTransfer`);
this folder mounts it for staff with the session's `documents.read` / `documents.upload` / `documents.classify` permissions.
The server authorizes every call; permissions only decide what is drawn.

| Acceptance                           | Where it holds                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload with progress and scan states | `transfer.ts` (create → PUT with XHR progress → complete, `Idempotency-Key` per step, retry from the failed step), list polling while `awaiting_upload`/`scanning`; unit tests "creates, transfers with progress…", "refreshes by itself…"; Playwright test 1 |
| A file cannot be opened before clean | No Open control unless `clean`/`confirmed`; the server answers 409 `documents.not_available` and the screen shows it; unit tests "opens a clean file…", "shows the link… not available"; Playwright tests 1 and 2                                             |
| Quarantined file shown with reason   | `quarantined` shows "Blocked" plus the reason text; unit test and Playwright test 2                                                                                                                                                                           |
| Classification confirm by staff      | `classify` (If-Match) then `confirm` (If-Match); the OCR suggestion is labelled a suggestion; stale version refreshes the list; unit tests "classification confirm (staff)"; Playwright test 1                                                                |

## Limitations and open points (not hidden)

- **Contract mocks only.** Every test mocks the documents API and the object store. No real API, database, scanner or bucket was used
  (C-01, C-10: none provisioned). The real journey is for integration.
- **Quarantine reason is generic.** `GET /documents` returns `status: quarantined` and no reason field (BE-10 `docBody`), so the screen
  states the reasons the server can have (safety scan or file check) without distinguishing them. A specific reason needs an additive API field.
- **No file names in the list.** The server discards file names, so rows show type, date and size; the name is shown only while a file is transferring.
- **Request bodies are `OpaqueObject` in `documents.yaml`.** Bodies follow the API controller (`contentType`, `sizeBytes`, `fileName`,
  `classification`; `{classification}`), not a generated type.
- **Import path.** `packages/app-shell/src/index.ts` is outside this ticket's allowed paths, so the staff feature imports
  `../../../../../packages/app-shell/src/documents/index.js` directly. Request to Orchestrator: add `export * from './documents/index.js'` and switch the import.
- **Not wired into the staff app.** Routing and session permissions are outside the allowed paths; `e2e/harness` mounts `DocumentsPage` for the browser tests.
- **Mid-transfer progress** is covered by the unit test (controlled `PutObject`); the browser mock completes instantly.
- Colour contrast is checked by axe in Chromium (Playwright), not in jsdom.
- No size limit is enforced client side (server answers `documents.too_large`).

## Checks (raw output in `evidence/raw`, screenshots in `evidence/screenshots`)

Run from the repo root unless noted; Playwright needs Chromium: `pnpm exec playwright install chromium-headless-shell`.

```
pnpm exec eslint packages/app-shell/src/documents apps/staff/src/features/documents
pnpm exec prettier --check packages/app-shell/src/documents apps/staff/src/features/documents
(cd packages/app-shell && pnpm exec tsc -p tsconfig.json --noEmit && NODE_ENV=test pnpm exec vitest run)
(cd apps/staff && pnpm exec tsc -p tsconfig.json --noEmit && NODE_ENV=test pnpm exec vitest run)
(cd apps/staff && pnpm exec playwright test -c src/features/documents/e2e/playwright.config.ts)
```
