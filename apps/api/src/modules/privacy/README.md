# privacy (BE-20)

Privacy requests (access, export, correction, deletion), export assembly through the participant registry, the legal-hold check on a
deletion request, the incident register, the merge participant (RA-R1-14, J-21, A-16; SHARED-BOUNDARIES 6.7). Migrations `1900`-`1902`.
The jobs are in `apps/worker/src/jobs/privacy`.

| Piece                                                                                                                                               | Where                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Tables `privacy.request`, `export_package`, `incident`, `incident_patient`; a deletion request can only be `blocked_d8` or `refused` (CHECK)        | `db/migrations/1900`                                              |
| Triggers: the state machines, who may take which step, verification once, the merge write guard, no delete                                          | `1901`                                                            |
| `FORCE` RLS, role-targeted policies (T-PAT-OWN, T-STAFF create only, T-SLICE(`privacy_requests`), T-SLICE(`incidents`), T-SYS), column grants       | `1902`                                                            |
| `RequestService`: `createOwn`, `createForPatient`, `listOwn`, `getOwn`, `list`, `verifyIdentity`, `decide` (`approve`, `refuse`, `retry`, `fulfil`) | `requests.ts`                                                     |
| `PackageService.downloadUrl`: the patient's 60-second URL, audited `export`                                                                         | `packages.ts`                                                     |
| `IncidentService`: `list`, `create`, `update`                                                                                                       | `incidents.ts`                                                    |
| `assembleExport`: the body of `privacy.assemble_export`; consumes the kernel's export-contributor registry, writes no per-module code               | `assemble.ts`                                                     |
| Merge participant (`privacy.request`, `privacy.export_package`) and the owner's own export part                                                     | `merge.ts`                                                        |
| Routes (29.2, 29.3, 29.4) and resolvers `privacy-patient`, `privacy-request`                                                                        | `controller.ts`                                                   |
| Job types, events, crontab                                                                                                                          | `jobs.ts` (worker mirror: `apps/worker/src/jobs/privacy/jobs.ts`) |
| Worker: `check-legal-holds`, `expire-packages`, ports, adapters over the documents and merge tables                                                 | `apps/worker/src/jobs/privacy/`                                   |
| Wiring                                                                                                                                              | `runtime.ts` (`createPrivacy`), `index.ts` (composition notes)    |

## Retention settings: the key names DevOps (C-DO-RET) consumes (HEAAA-789, owner ruling 2026-11-11 C item 2, PRD C-20 †)

One typed, validated module: `retention.ts` (`RETENTION_KEYS`, `RETENTION_DEFAULTS`, `loadRetentionSettings(env)`, `exportRetentionSettings`). The values
are the owner's conservative product defaults, **not legal advice; † counsel must confirm before go-live**. Each is an integer overridable by the
environment variable named here; an unset variable means the default; a bad one stops start-up and is reported **by name, never by value**.
`node apps/api/dist/src/modules/privacy/retention-cli.js` prints the resolved values as JSON (`{settings: [{key, value, unit, consumer}]}`, no PHI, no
secrets) from the same environment, so DevOps provisions exactly what the application enforces.

| Environment variable (the contract)                       | Default | Unit   | Consumer | Governs                                                                                   |
| --------------------------------------------------------- | ------- | ------ | -------- | ----------------------------------------------------------------------------------------- |
| `EHR_RETENTION_MEDICAL_RECORD_YEARS_AFTER_LAST_ENCOUNTER` | 10      | years  | app      | medical record: years after the last encounter                                            |
| `EHR_RETENTION_AGE_OF_MAJORITY_YEARS`                     | 18      | years  | app      | younger than this at the last encounter = minor for the minors rule                       |
| `EHR_RETENTION_MINOR_UNTIL_AGE_YEARS`                     | 21      | years  | app      | minors: kept until this age, or the next key after the last encounter, whichever is later |
| `EHR_RETENTION_MINOR_YEARS_AFTER_LAST_ENCOUNTER`          | 10      | years  | app      | minors: years after the last encounter                                                    |
| `EHR_RETENTION_AUDIT_TRAIL_YEARS`                         | 7       | years  | devops   | audit trail (archive Object Lock; the application never deletes audit rows)               |
| `EHR_RETENTION_AUDIT_ANCHOR_YEARS`                        | 7       | years  | devops   | audit anchors (archive Object Lock)                                                       |
| `EHR_RETENTION_HIPAA_DOCUMENTATION_YEARS`                 | 6       | years  | app      | HIPAA documentation: privacy requests, incidents, deletion records                        |
| `EHR_RETENTION_BACKUP_DAILY_DAYS`                         | 35      | days   | devops   | daily backups                                                                             |
| `EHR_RETENTION_BACKUP_MONTHLY_MONTHS`                     | 12      | months | devops   | monthly backups                                                                           |
| `EHR_RETENTION_APPLICATION_LOG_DAYS`                      | 90      | days   | devops   | application logs, searchable period                                                       |
| `EHR_RETENTION_APPLICATION_LOG_ARCHIVE_YEARS`             | 1       | years  | devops   | application logs, archived period after the searchable period                             |
| `EHR_RETENTION_NETWORK_FLOW_LOG_YEARS`                    | 1       | years  | devops   | network flow logs                                                                         |
| `EHR_RETENTION_EXPORT_PACKAGE_DAYS`                       | 7       | days   | app      | privacy export packages: days after creation until removal                                |

Interpretation recorded for counsel (†): "application logs 90 days archived 1 year" is read as 90 days searchable, then one further year in the
archive; "minors" means younger than `EHR_RETENTION_AGE_OF_MAJORITY_YEARS` (18) at the last encounter; with no encounter the registration date stands
in for it; adding years to 29 February lands on 1 March (the record is kept a day longer, never shorter).
Keys are additive-only: renaming or removing one breaks DevOps and needs a coordinated change.

## What the purge removes, and what it keeps (HEAAA-881, decision HEAAA-880 D-880-1..6; migrations 2601, 2603-2606)

At the **deletion request** only ruling C item 1 is deleted (sign-in disabled, preferences, tokens, marketing and cookie consents, drafts,
unaccepted uploads). Everything else is kept and named in the patient statement's "kept" list with the same `keptUntil` date. When the
medical-record retention ends, `privacy.purge_medical_record` removes the rest **in the same gated transaction** (same job check, same legal-hold
and document-retention deferral: a hold leaves every class untouched, no partial purge), children first, for the patient's merge closure:

| Class                                                                                                                          | At the end of retention                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `clinical.*`, `patient.consent`, `documents.*`                                                                                 | deleted (2601; objects removed by `documents.retention_sweep`)                                                                                  |
| `patient.patient_contact`, `insurance_coverage`, `care_relationship`, `care_team_member`, `duplicate_flag`, `staff_scope`      | deleted                                                                                                                                         |
| `patient.merge_request`, `patient_merge`, `merge_residue`, `match_check` (rows naming the closure)                             | deleted                                                                                                                                         |
| `scheduling.slot_reservation`, `check_in`, `queue_entry`, `waitlist_entry`, `waitlist_offer`, `no_show_flag`, `slot_occupancy` | deleted; a waitlist offer of another patient for a slot this patient held goes with that slot                                                   |
| `telehealth.video_session`, `participant`, `join_token`, `location_confirmation`                                               | deleted                                                                                                                                         |
| `messaging.thread`, `thread_participant`, `message`, `task`                                                                    | deleted                                                                                                                                         |
| `notifications.notification`, `delivery_receipt`, `in_app_read`, `staff_alert`, `staff_alert_event`                            | deleted                                                                                                                                         |
| `identity.proxy_grant`, `identity.patient_link`                                                                                | deleted (proxy access at the request itself is a separate decision, D-880-4)                                                                    |
| `identity.principal`, `identity.person` of the patient realm                                                                   | de-identified (subject `purged:<id>`, no e-mail, person `Deleted account`) only when linked solely to these patients and not a proxy for others |
| `patient.patient`                                                                                                              | **tombstone**: id, organisation, MRN (never reissued), origin, `created_at`, `status = 'purged'`, `purged_at`; every personal column null       |
| `audit.*`                                                                                                                      | not touched: archive-governed, 7 years                                                                                                          |
| `privacy.request`, `export_package`, `incident_patient`, `deletion_record`, `retention_run`                                    | kept as HIPAA documentation, 6 years; `purge_hipaa_documentation` then deletes the tombstone once no `privacy.*` row refers to it               |

The tombstone is written only by `privacy_retention_owner` (trigger `patient.guard_merged_root`, CHECK `patient_purged_shape`; the NOT NULL of
the five required columns is relaxed in 2603 and restored for every non-purged row by the CHECK, 2604-2606). The purge report holds counts only.

**Coverage check (D-880-5).** `db/tools/catalog-lists.mjs` (`patientPurgeTables`, `patientPurgeExempt`, `patientPurgeExemptSchemas`) and the
catalog check `M-6-patient-purge` (`db/tools/catalog-check.mjs`): a table with a patient id that is neither purged nor exempt fails the check, so a
table added later cannot be missed. Exempt: `audit.*`, `privacy.*`, and the tombstone `patient.patient`.

**Not decided here.** Whether active proxy access ends at the deletion request (D-880-4, Cybersecurity) and whether the period applies to patients
who never requested deletion (Product Manager) are separate tickets. Not legal advice; † counsel confirms before go-live.

## Tests (real PostgreSQL 17, superuser URL on a throwaway server, synthetic data; missing configuration fails)

```
EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres \
  node --test apps/api/dist/src/modules/privacy/privacy.dbtest.js     # 21 tests
node --test apps/worker/dist/jobs/privacy/jobs.test.js                # 2 unit tests (no database)
node packages/kernel/dist/scope/check-static.js --skip with-scope.ts apps/api/src/modules/privacy apps/worker/src/jobs/privacy   # 38.2 item 4
```

`privacy.dbtest.ts` drives the real HTTP routes through the guard, CSRF and idempotency, the worker's real jobs (loaded from the worker's
build), the real audit service and queue, and the **real export contributors of identity, notifications, documents, scheduling and clinical**
over an in-memory package store.

| Test                                                                                                                    | Covers                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-PR-02                                                                                                                | request, compliance sees it, identity check, approval, chunked assembly, a part per contributor, each part audited, accounting of disclosures, delivery through the portal, no PHI in URL, audit rows or queue payloads                                                |
| TC-PR-03 (+ legal-hold check)                                                                                           | a deletion request is recorded as `blocked_d8`, routed to compliance, never approved, nothing created or deleted; the DB refuses any other state even below the triggers; the system's hold count appears on the request                                               |
| TC-PR-04                                                                                                                | another patient's request and package are 404 by route and invisible and unwritable by SQL                                                                                                                                                                             |
| TC-PR-05                                                                                                                | processing before the identity check is refused; refusal needs a reason (10..2000) and is final                                                                                                                                                                        |
| coverage (two tests)                                                                                                    | a module with patient data and no contributor FAILS the job before anything is read; a module that appears later fails until it registers, then its part is in the package                                                                                             |
| chunks, failure handling, merge during assembly                                                                         | a transaction per contributor with progress committed between; transient errors retry, permanent ones and the last attempt fail the package; a store outage and the size limit leave nothing behind; a merge mid-assembly restarts for the survivor and the merged IDs |
| merge participant                                                                                                       | R requests and packages move, K stay, found = re-pointed + kept                                                                                                                                                                                                        |
| staff create, validation, pagination, slice (both layers), hand-written changes, expiry, idempotency, incident register | the rest of the acceptance and of 3. Common checks                                                                                                                                                                                                                     |

**What the tests do NOT prove.**

- The package store is in memory. Nothing here shows encryption at rest, the KMS key, the bucket, or a real presigned URL (C-01: none exist).
  The writer port requires server-side encryption; the real adapter is delivered at staging.
- `messaging` and `telehealth` do not exist yet. Their export contributors, and `patient.exportPart`, are **fixtures** in the tests and say so. They prove
  that the assembler iterates what is registered and fails what is not, nothing about those modules.
- The export contains each contributor's metadata as the contributor returns it. The documents contributor returns metadata only (its design), so
  **file contents are not in the package** (L2).

## How the invariants hold

- **Every contributor, or the job fails.** `assembleExport` takes the contributors from the kernel registry (and the downward calls it is handed), computes
  the modules that hold patient data from the catalog (every schema with a `patient_id` column, as the merge executor does), and if one has no contributor
  it fails the package `privacy.contributor_missing` before reading anything. Only `audit` (covered by `audit.disclosuresFor`) and `privacy` (the owner's own
  part) are exempt, listed in `OWNER_COVERED`.
- **Chunks.** Each contributor's part is produced in its own short transaction under a patients-scope system scope for the patient's ID and every merged
  ID (the closure); progress (`part_counts`) and one `export` audit event per part are written in a second short transaction. The accounting of disclosures
  is last, one page per transaction. The package is one gzip'd JSON document with a manifest (per-part counts and SHA-256) written under a random key
  `p/<32 hex>`; the package row is `ready` and the request `fulfilled` in one transaction.
- **A merge while assembling.** The package follows the patient (R). If the job's scope no longer reaches it, the job looks again and restarts for the
  survivor's closure (three times at most). A fulfilled request (K) stays on the merged ID while its ready package (R) moves; they are joined by `request_id`.
- **Deletion (D-8).** Stored `blocked_d8`; identity can be verified and compliance can refuse it with a reason; `approve` is `409 privacy.blocked_on_decision`.
  The table's CHECK forbids a deletion request in any other state, and no code path here deletes, anonymises or schedules a deletion. The legal-hold check
  is a system job (`privacy.check_legal_holds`) because a patient session cannot read holds; it counts documents whose latest hold row is `placed` and writes
  the count on the request. A hold decides nothing; D-8 does.
- **Compliance never sees content (6.7).** The `privacy_requests` slice reaches requests and package metadata, not packages' content; there is no download
  route for the admin realm (403); the API returns no object key. (`export_package.object_key` is in a column the slice can read; it is a random key with
  no PHI and no use without a presigned URL, and no route returns it.)
- **Identity first.** `approve` needs `identity_verified`; verification is once, by a compliance user, under their own person ID (trigger). The worker alone
  completes an export request.
- **Download.** Only the patient the package belongs to (own record, never a proxy; D-7) gets a 60-second URL, audited `export` with the reason
  `patient_download`; the first call makes the package `released`; after `expires_at` the route refuses at once and the daily job removes the object.
- **Incidents.** Forward-only status, final when closed (trigger), patients and audit events only added. IDs only.

## Departures from the design, for the reviewers (each small and additive)

- **D1. Merge write guard.** As BE-10's D1: `patient.guard_open_patient` cannot be attached from this range, so `1901` carries `privacy.guard_open_patient`,
  the same refusal and the same `FOR KEY SHARE` lock, and moves it to `patient_scope_owner`. Needs the inventory entries in `catalog-lists.requested.patch`.
- `privacy.guard_open_patient` (own copy of the merge guard) is superseded by the HEAAA-310 ruling: migrations 2200–2202 attach `patient.guard_open_patient` and drop the copy.
- **D2. Extra columns:** `request.verified_at`, `decided_at`, `legal_hold_documents`, `legal_hold_checked_at`; `export_package.failure_code` (a code only); the
  organisation, creation and version columns every table carries. A request has at most one package that is not `failed` (partial unique index), so a failed
  assembly can be started again (`decide: retry`).
- **D3. Decide vocabulary.** The contract types the body as an opaque object: `{decision: approve | refuse | retry | fulfil, reason?}`. Export and access
  requests become `fulfilled` when their package is `ready` (by the job); correction requests by compliance (`fulfil`) once the task `messaging` made is done.
- **D4. `PATCH /admin/incidents`** carries the incident `id` in the body (the catalogue lists PATCH on the collection and names no identifier; contract
  `x-catalogue-gap`); `If-Match` carries the row version.
- **D5. Admin writes do not call `lockPatients`.** `patient.lock_patients` refuses an `admin_pool` caller (it does not see the patient). The merge write guard
  takes the same `KEY SHARE` lock when the row is written; the order (request row, then patient root) is the reverse of the merge's, so a deadlock with a
  merge is possible and rare; the two admin writes run under the scope wrapper's retry (the whole transaction is rolled back first).
- **D6. `privacy.invalid_transition`** (409) is used for a step the state does not allow (PS001 maps there, ARCHITECTURE 30); it is not in the error registry
  yet (the same open item as `documents.invalid_transition`, O-3 there).

## Limitations and requests (outside this ticket's paths: to the Orchestrator)

1. **L1. Test cases.** `docs/TEST-CASES.md` defines TC-PR-01..05. TC-PR-01 (notification preferences) is the patient module's (TC-NT-08). There is no
   TC-PR-06..08 to run; the ticket's "TC-PR-01..08" cannot be satisfied literally.
2. **L2. File contents** of documents are not in the package: the documents contributor returns metadata and the version list (its design says the assembler
   fetches files through download URLs), and the documents store is not provisioned (C-01). Adding the files needs a container format (zip) and a read port
   on the documents store.
3. **L3. `patient.exportPart` does not exist.** The patient module registers a merge participant only. The owner calls it downwards
   (`AssembleDeps.downward`); until it exists the coverage rule makes every real export fail `privacy.contributor_missing` (correct by the ticket, and the
   tests use a fixture). A ticket for `patient.exportPart` is needed before an export can succeed in a real environment. `messaging` and
   `telehealth` (BE-15) must register theirs; their tables will make the same rule fail an export until they do.
4. **L4. Integration changes needed outside the allowed paths** (all in `catalog-lists.requested.patch`, applied with `git apply`):
   - `db/tools/catalog-lists.mjs`: `privacy.guard_open_patient` in `definerInventory` and `patientGuardFunctions`; `privacy.incident_patient` in `patientGuardExempt`;
   - `apps/api/src/modules/patient/merge/executor.ts`: `privacy.incident_patient` in `NOT_PARTICIPANT_TABLES`;
   - `apps/api/src/modules/organisation/settings-catalogue.ts`: `privacy_request_due_days` (30) and `privacy_export_expiry_days` (14), planning values read with
     these defaults today;
   - every harness that runs `executeMerge` (`*/testkit.ts` of documents, notes, flow, chart, front door...) must add `registerPrivacyParticipants(regs)` and the
     `privacy.incident_patient` entry, or the merge refuses with `patient.merge_participant_missing` once migrations `1900-1902` exist. Verified: with these two
     lines in the notes kit its 21 tests pass again; without them one fails (`item 11`). 10 tests in `patient/merge/merge.dbtest` and 2 in `documents.dbtest` fail
     on this base **with and without** this ticket's migrations (not caused here).
   - the composition root: `createPrivacy`, `registerPrivacyParticipants`, `PRIVACY_JOBS` in both job registries, `createPrivacyTasks` in the worker with
     `assembleExport` as `assemble`, `PRIVACY_CRONTAB`, and a handler for `privacy.correction_requested` in `messaging` and for `privacy.export_ready` in
     `notifications` (no PHI in either: IDs only). None of those modules' handlers exists yet.
5. **L5. Notices.** `privacy.export_ready` is published; nobody handles it yet, so the patient is told nothing until `notifications` registers a handler.
   The portal shows the status from `GET /privacy-requests/{id}`.
6. **L6. Settings** `privacy_request_due_days` / `privacy_export_expiry_days` are planning values (30 and 14 days), not decisions: the legal response period and the
   package lifetime are open inputs for G2.
