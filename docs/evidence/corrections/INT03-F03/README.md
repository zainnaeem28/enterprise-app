# INT03-F03 (HEAAA-312): single merge write guard for the M4 tables, Part A

Status: **implemented, NOT verified against PostgreSQL.** No PostgreSQL 17 was available to the Backend run (no `psql`, `postgres`, `docker`; the only reachable server is the Paperclip control-plane database, which must not be used for tests; installing an embedded PostgreSQL was denied by the run's permission classifier). Nothing below claims I-1…I-11 pass. Not reviewed, not integrated, not human-approved.

Base: `1cd3cbc` (HEAAA-133 evidence commit, candidate `c48db50`). Design: HEAAA-310 `ruling` revision `d9504db5-1908-43fb-8226-82f8b923fddf`, Part A only. Part B (2203, 2204, A-4) waits for the human decision and is **not** written.

## Change
- `db/migrations/2200_merge_guard_single_m4.sql` (expand), `2201_drop_merge_guard_copies_m4.sql` (contract), `2202_revoke_guard_drop_usage_m4.sql` (expand), exactly as ruling A1–A3 (18 DROP/CREATE TRIGGER pairs, names kept).
- `db/tools/catalog-lists.mjs`: `privacy.incident_patient` added to `patientGuardExempt`; two stale comments corrected. `patientGuardFunctions`, `definerInventory` unchanged.
- `db/tools/db-test.mjs`: `guarded` 15 → 33, T2 (33 tables, ten refused functions absent, six schemas), new T5, T6, negative control run on `patient.patient_contact` and `clinical.note`. No assertion weakened.
- READMEs per ruling A6 (four lines, one new `messaging/README.md`). Note: A6 paths are not in the ticket's allowed-path list but are directed by the ruling; flagged for the reviewer.

## Checks actually run (Node v24.22.2, pnpm 12.16.1, base 1cd3cbc plus this change), raw in `raw/`
| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm run lint` | pass (exit 0) |
| `pnpm run test:boundary` | pass |
| `node db/tools/check-migrations.mjs` | pass: 88 migrations |
| `pnpm run format:check` | FAIL, 5 files under `apps/staff/**/evidence` = pre-existing INT03-F07, not in this change |
| `pnpm run typecheck`, `pnpm run build` | FAIL, 2 errors in `apps/api` (`composition.ts:187`, `identity-label.dbtest.ts:63`) = pre-existing INT03-F02, not in this change |

## Not run (needs PostgreSQL 17)
`integration-db.sh` db-foundation suite, `node --test db/tools/db-test.mjs`, kernel rules/plan tests against a DB, clinical/privacy/messaging api DB suites; the before/after failing list. Expected per ruling: `M-5-patient-guard` and the SEC03-F13 baseline pass; `M-5-definer` still lists the three `messaging.is_*` functions until Part B (I-9). These are predictions, not results.
