# audit module (BE-01)

Owner: Backend Engineer. Migrations `0200`-`0203`, API side here, jobs in `apps/worker/src/jobs/audit`.
Design: ARCHITECTURE 6 (audit store), 21.5, 22.2, 24, 25, 33.1; SHARED-BOUNDARIES 8.1.

## What it does

| Interface                           | Behaviour                                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record(tx, envelope)`              | Inserts in the caller's transaction. Actor, realm, audience, organisation come from `tx.scope`, never from the caller. No `RETURNING` (a SELECT policy would be needed); the event id is generated here (UUIDv7). |
| `recordDenied(db, scope, envelope)` | New short transaction on the same scope after the business rollback. On failure: no throw, logged by class, `onDenialWriteFailure` hook (operations alert).                                                       |
| `activeBtgGrants(tx, principalId)`  | Own, unrevoked, unexpired grants (T-PRINCIPAL).                                                                                                                                                                   |
| `openBtg` / `reviewBtg`             | Grant + `btg_open` audit row + `audit.btg_opened`; review by a different person (403 `audit.self_review`, plus trigger), once.                                                                                    |
| `searchEvents`                      | Compliance viewer: <= 31 days, audited as `view`.                                                                                                                                                                 |
| `requestExport`                     | Size limit (`audit_export_max_rows`, default 1,000,000, 422 `audit.export_too_large`), job row, `export` audit row with reason, enqueues `audit.export` chunk 0.                                                  |
| `disclosuresFor(tx, patientIds)`    | Keyset-paged events about patients, for the privacy export.                                                                                                                                                       |

Worker: `audit.anchor` (every minute), `audit.archive_anchors` (every minute; copies each anchor to the Object Lock archive and writes `audit.anchor_archive_receipt`, migration 0204), `audit.verify_anchors` (daily; the archive is the authority: `db_differs_from_archive`, `not_archived`, `archive_extra_version`; INT04-F10 D-2), `audit.export` (chunked). `AUDIT_CRONTAB` holds the
schedules; the F-05 runner does not pass a crontab yet (integration step).

## Database rules (migrations 0200-0203)

- `audit.event`: monthly range partitions on `occurred_at` (Nov 2026 .. Dec 2027 plus a default partition), PK `(event_id, occurred_at)`.
- `audit.require_bounded_tx` (`PA001`): refuses `transaction_timeout` 0 or above 60 s. `app_owner` has no INSERT grant (`42501` before any trigger).
- No role can UPDATE or DELETE an audit row: no grant (`42501`) and `audit.refuse_change` (also TRUNCATE, also on every partition) for roles that bypass grants.
- Anchors: Merkle root over `audit.row_digest(row)` (SHA-256 of canonical JSON of every column except `anchor_id`), ordered by `(occurred_at, event_id)`, range `[from_ts, to_ts)`, chained by `prev_hash`; watermark now - 2 min.
- RLS (FORCE) on all five tables; no policy can match `anonymous` or `public`.

## Deviations and open notes (for Architect / Orchestrator)

- **AUD-N1 anonymous writes.** ARCHITECTURE 21.3 lists every policy that may match `anonymous` and audit is not on it, so an audit insert under audience `anonymous` or `public` is refused. Events of an unauthenticated request (failed sign-in) cannot be written until the Architect adds an exception or identity raises the audience after verification.
- **AUD-N2 `kernel.append_only`.** Design names a kernel function; kernel migrations are outside this ticket's range, so `audit.refuse_change` has the same behaviour (SQLSTATE `42501`).
- **AUD-N3 `anchor_id` is never populated.** The column exists as designed; setting it would be an UPDATE of an audit row. Rows are identified by the anchor's time range.
- **AUD-N4 late rows.** The anchor job counts growth of the previous window as `late_rows`; the verifier reports the grown window as a mismatch (it cannot tell a late commit from tampering). The 60 s bound makes a late row impossible by design.
- **AUD-N5 `btg_grant.patient_id` has no FK yet** (`patient` schema does not exist); the patient ticket adds the constraint. `btg_review.grant_id` has no FK either: an FK check runs as the table owner, which holds no privilege on audit tables; the review trigger and the immutable grant key do the job.
- **AUD-N6 `export_job` has three extra columns** (`last_occurred_at`, `last_event_id`, `chunks_done`): the cursor of the chunked job (queue payloads carry IDs only).
- **AUD-N7 partitions.** Months after Dec 2027 need an operations migration; `audit.verify_anchors` reports `partitionHorizonDays` and warns under 60. Archive/detach/drop (`audit_archiver`, dual control) is DO-09b; nothing here lets any role drop a partition except the owner `app_owner`, which cannot be restricted by grants.
- **AUD-N8 `catalog-lists.mjs`.** `audit.event` is exempt from the merge guard by design (22.2, "K, exempt"); `audit.btg_grant` is "K". Both have `patient_id` and no `patient.guard_open_patient` yet, so catalog check `M-5-patient-guard` fails until `db/tools/catalog-lists.mjs` (F-03) lists them in `patientGuardExempt`. Not edited here (outside allowed paths).
- `POST /patients/{id}/break-glass` is served by the clinical chart module (`chart/break-glass-controller.ts`; the audit module cannot import identity).
- **Not built:** object-store sink for exports and anchors (infrastructure), HTTP routes of 31 (`/admin/audit-events/search`, `/admin/audit-exports`, `/admin/btg-grants`), the `audit_anchor_mismatch` alert row (notifications handler of `audit.anchor_mismatch`), the ready notice of an export, retention (TC-AU-09, `BLOCKED` until G2 value).

## Tests

`pnpm --filter @ehr/api build && node --test apps/api/dist/src/modules/audit/*.test.js` (no database);
`EHR_TEST_ADMIN_URL=... node --test apps/api/dist/src/modules/audit/audit.dbtest.js` and
`... apps/worker/dist/jobs/audit/audit.dbtest.js` (PostgreSQL 17, superuser URL, throwaway server).
