# documents (BE-10)

Pre-signed upload, malware scan, OCR classification suggestion, staff classification and confirmation, legal holds, deletion requests
(BR-28, BR-29, RA-R1-13), the merge participant and the privacy export part. Migrations `1000`-`1003`. The jobs are in
`apps/worker/src/jobs/documents`.

| Piece                                                                                                                                                                  | Where                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Tables `documents.document`, `document_version`, `legal_hold` (append-only), `deletion_request`; random-key CHECK                                                      | `db/migrations/1000`                                                |
| Triggers: who may take which state step, scan and OCR writes are the worker's, holds append-only, decided requests kept, the merge write guard                         | `1001`                                                              |
| `FORCE` RLS, role-targeted policies (T-PAT-OWN, T-STAFF, T-SLICE(consents) for `consent` only, T-SLICE(incidents) for holds, T-ADMIN-BTG, T-SYS), column grants        | `1002`                                                              |
| Owner of the merge guard (`patient_scope_owner`)                                                                                                                       | `1003`                                                              |
| Service: `createUpload`, `completeUpload`, `downloadUrl`, `classify`, `confirm`, `setLegalHold`, `requestDeletion`, `decideDeletion`, `attachToPatient`, `list`, `get` | `service.ts`                                                        |
| Routes (29.2 patient, 29.3 staff) and resolvers                                                                                                                        | `controller.ts`                                                     |
| Merge participant and export part                                                                                                                                      | `merge.ts`                                                          |
| Job types, events                                                                                                                                                      | `jobs.ts` (worker mirror: `apps/worker/src/jobs/documents/jobs.ts`) |
| Presigner port (tests: `SignedUrlPresigner`)                                                                                                                           | `ports.ts`                                                          |
| Worker: `await-scan`, `ocr-suggest`, `retention-sweep`, ports, scanner and OCR adapters, sniffing and image rewrite, stubs                                             | `apps/worker/src/jobs/documents/`                                   |

## Tests (real PostgreSQL 17, superuser URL on a throwaway server, synthetic data; missing configuration fails)

```
EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres \
  node --test apps/api/dist/src/modules/documents/documents.dbtest.js        # 21 tests: TC-DOC-01..08, item 11, RLS, races, adapters
node --test apps/worker/dist/jobs/documents/sniff.test.js                    # 6 unit tests (no database)
node packages/kernel/dist/scope/check-static.js --skip with-scope.ts apps/api/src/modules/documents   # 38.2 item 4
```

`documents.dbtest.ts` drives the real HTTP routes through the guard, CSRF and idempotency, the worker's real jobs (loaded from the worker's
build) over an in-memory object store and a controllable stub scanner and OCR vendor, and the real merge executor.

**What the tests do NOT prove.** A stub scanner that calls an EICAR-style string "infected" proves that the job reacts to an infected
verdict. It is not evidence that the real scanner flags it, that the real result tag has the assumed name or values, or how long it takes
(C-01, C-10: no bucket, scanner or OCR vendor is provisioned; the tag name, its values and its timing are **Unverified until staging**,
ARCHITECTURE 25.10). The presigner is a stand-in too: the tests show the URL is bound to one key, method, size and moment _in our model of
a store_, not in S3.

## How the invariants hold

- **Nobody opens an upload before it is scanned clean.** A file is served only when the document is `clean` or `confirmed`, its current
  version has `scan_status = 'clean'` and sits in the `clean` bucket (`downloadUrl`). The database enforces the same from below: the
  document trigger moves `scanning -> clean` only for the worker and only when the version row already shows a clean scan in the clean
  bucket; `app_api` has no right to write any scan column, and a table CHECK ties the clean bucket to a clean scan with a hash. A hand-written
  `UPDATE` by any application role is refused (`PS001` / `42501`, tested).
- **Quarantine.** An infected file ends `quarantined` (version `infected`), stays in the quarantine bucket, is never copied, and
  `documents.quarantined` is published in the same transaction (the uploader's notice is the notifications module's handler); the sweep removes
  it after 30 days. A file whose bytes are not the declared type, whose size is not the declared size, or whose structure is broken is
  quarantined the same way (the version's `scan_status` is `infected` because the CHECK has no `rejected`).
- **Scanner outage (TC-DOC-08).** A scanner that cannot be asked is `error`, never `clean`: the version shows `error`, operations are
  alerted once, the document stays `scanning`, and the job retries every 60 s. No verdict for 30 minutes: `error`, alert, retry every 5
  minutes up to 24 hours. There is no path from `error` to a served file except a clean verdict.
- **No PHI in keys, URLs, audit rows or logs.** Keys are `q|c/<32 hex>` (CHECK); a URL carries a key, an expiry and a signature only; file
  names are validated and discarded (never stored, logged, or put in a key); the audit row holds IDs, an action and a status; a hold's reason
  is only in its own row. Tested with canaries.
- **Short-lived URLs.** Upload 5 minutes, bound to one key, type and length; download 60 seconds, audited as `download`.
- **Classification is staff-confirmed.** A patient names a class for their own upload (four of the eight). Only staff change the class
  (`clean` documents only) and only staff confirm (trigger: `google` realm, `confirmed_by` = the caller). The OCR suggestion is a separate
  column, staff-visible only, and decides nothing. A patient sees their own uploads, and documents of the released classes once clean or
  confirmed (T-PAT-OWN); a proxy sees none (D-7).
- **Deletion (BR-29, AC-31).** `requestDeletion` records the request; a legal hold or an open retention period is recorded as
  `refused_legal_hold` / `refused_retention` with the reason, committed, and answered `409 documents.legal_hold` / `documents.retention`.
  `decideDeletion` re-checks under the document's lock; `deleted` needs a request decided `deleted` first. The document trigger refuses
  `deleted` while the latest hold row says `placed` (a hold wins over retention) or while the retention date is unset or in the future. The
  hold insert and the decision take the same advisory key, so they serialise (10 racing pairs in the tests never delete a held document).
  Retention comes from the `document_retention_years` setting, which has **no default**: unset means no date and every request is refused
  `refused_retention` (fail closed until D-8 and the legal period are decided).
- **Merge (22.16, 38.2 item 11).** Documents and versions are R in every state; pending requests R, decided K; holds K. A version that is
  `scanning` at merge time is re-pointed; `await_scan` and `ocr_suggest` declare `on_merged = resolve`, find nothing under the merged ID,
  ask for the survivor and finish there. A new hold after a merge carries the survivor's ID.
- **Lock order (25.2).** `lockPatients` is the first locking statement of every write; the document row is locked after it.

## Departures from the design, for the reviewers (each small and additive)

- **D1. Merge write guard.** As BE-11's D1: `patient.guard_open_patient` cannot be attached from this range, so `1001` carries
  `documents.guard_open_patient`, the same refusal and the same `FOR KEY SHARE` lock, and `1003` moves it to `patient_scope_owner` (the role
  that already reads the root). It needs the inventory entry in `catalog-lists.requested.patch` (this ticket may not edit `db/tools`).
- **D2. Extra columns:** `document_version.declared_content_type`, `scan_requested_at`, `object_removed_at`; `legal_hold.seq`;
  `deletion_request.decided_by` (listed at the top of `1000`).
- **D3. `documents.invalid_transition`** (409) is used for a step the state does not allow and for a repeated hold in the same state; it is
  not in the error registry (30) yet (O-3).
- **D4. Staff and patient on one path (O-1, closed).** The four shared paths are served by one host-bound controller per host: the patient
  controller on `EHR_PATIENT_HOST`, the staff controller on `EHR_STAFF_HOST`, each with its own declaration; every staff-only route is on the
  staff host too. Host selects the declaration only; the guard's realm check is the gate. Decision: `docs/evidence/corrections/INT03-F21/O-1-decision-log.md`.
  The staff list is audited (`view`, patient and action only).
- **D5. Deletion-request permission.** The contract row reads `documents.upload / .deletion.decide`; the request route needs
  `documents.upload` and the decision `documents.deletion.decide`. The `medical_records` role holds the second but not the first (BE-04's
  catalogue), so a records officer cannot open a request themselves; a front desk member opens it and records decides. TC-DOC-04's actor
  (CMP-1) may need a role change (O-7).
- **D6. Image "re-encode" is a container rewrite** (JPEG APPn and COM segments, PNG ancillary chunks removed; broken structure refused),
  not a pixel re-encode, which needs an image library (O-5).
- **D7. Scanner adapter kind.** `malware_scan` is a connection kind (22.3) but not in `ADAPTER_KINDS` / `ADAPTER_OPERATIONS` of BE-02, so
  the gateway cannot wrap it. `TagScannerAdapter` has the `VendorAdapter` shape and the scan job calls it directly under the adapter's
  timeout; adding `malware_scan: ['scan_result']` to BE-02's lists is a contract change (O-4). The OCR adapter is a real `VendorAdapter<'ocr'>`
  registered with the BE-02 registry and called through `callVendor`.

## Open items for the Orchestrator and other owners

- **O-1.** Closed (INT03-F21-O1, host-bound controllers; see D4).
- **O-2.** Closed: `documents.guard_open_patient` is superseded by the merge guard of migrations 2200-2202 (HEAAA-310 ruling); the document tables are in `db/tools/catalog-lists.mjs`.
- **O-3.** Still open: `documents.invalid_transition` is in `errors.ts` but not in the ARCHITECTURE 30 error registry or the `x-error-codes` of `documents.yaml` (checked by search).
- **O-4.** Closed: `malware_scan` is in `integration-core/kinds.ts`.
- **O-5.** Decided, not built: `sharp`/libvips is excluded from install for its LGPL licence (`docs/DEPENDENCIES.md`, INT05-F10); the "re-encode" stays a container rewrite (D6).
- **O-6.** Still open: `testkit.ts` carries the file-level `boundaries/module-boundaries` disable; the lint rule is not exempted for `testkit.ts` and `*.dbtest.ts`.
- **O-7.** Not re-verified in this pass: role catalogue `documents.upload` for `medical_records` (D5).
- **O-8.** `document_retention_years` is read by `service.ts` but is not in `organisation/settings-catalogue.ts`; when it has no value the service uses the retention default of owner ruling C item 2 (`privacy/retention.ts`). D-8 is decided by delegation (counsel confirmation pending †).
- **O-9.** Worker composition is mostly done (`DOCUMENTS_JOBS` and `createDocumentsTasks` are registered in `apps/worker`), but `DOCUMENTS_CRONTAB` is not part of the worker's `WORKER_CRONTAB`, so `documents.retention_sweep` is not scheduled (`docs/GO-LIVE.md` known gaps). The real object store, scan-tag client, OCR client and presigner are still ports that refuse until C-01 and C-10 (`docs/RUN-GUIDE.md` section 9).
- **O-10.** Review state, rounds and findings are in the `review-ledger` document of HEAAA-92.
