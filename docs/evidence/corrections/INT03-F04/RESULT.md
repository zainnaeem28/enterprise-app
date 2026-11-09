# INT03-F04 result (round 1)

Change: `apps/api/src/register-participants.ts` (one helper: identity, notifications, scheduling flow, telehealth, documents, clinical notes, messaging, privacy; reporting holds no patient_id table). Used by `main.ts` via `composition.ts` and every dbtest harness (chart, frontdoor, notes, messaging, privacy, patient/merge, telehealth). Negative controls use `without:` (merge: notifications missing fails `patient.merge_participant_missing`; export: telehealth missing fails `privacy.contributor_missing`). Merge test asserts found = repointed + resolved + kept for every table of every registered participant; the privacy export test asserts a part from every registered contributor. `register-participants.test.ts` (3 tests) pass.

Out-of-allowed-path change (needs reviewer/Orchestrator acceptance): `apps/api/src/modules/patient/merge/executor.ts` gains ONE line in `NOT_PARTICIPANT_TABLES` for `privacy.incident_patient`. Without it, any merge with the privacy module's tables present fails `patient.merge_participant_missing` (privacy README L4 requested exactly this line). Harnesses had been patching it locally; the default is what production uses.

Also: the privacy "module that appears later" test created `CREATE SCHEMA telehealth` (already exists in the shared DB); rewritten as a negative control with a registry lacking telehealth, then retried with the full registry. Assertions are not weakened.

Result of `INTEGRATION_SKIP_N_MINUS_1=true integration-db.sh` on this tree: api 879 tests, 5 failures, 1 skipped (before: 42 failures); db-foundation 3 failures (unchanged, F03/F05); kernel 23/0; worker 79/0. Every `merge_participant_missing` / `contributor_missing` failure cited in F04 passes. Remaining api failures, re-attributed (see raw/remaining-failing-after.txt):
- clinical "every clinical table forces RLS" and AN-1 row-visibility seeded rows: F03/F08 (table list / guard triggers, fixtures).
- organisation "repository catalog check": F05 (reporting_ro lists, M-3/M-4/M-5 catalog lists).
- reporting feed "no patient data" (`patient not found`, PM008 from patient.guard_open_patient): F08, not caused by registration; not triaged further.
- skipped: "TODO (BE-08/INT-02): the real accept path" - a pre-existing TODO skip in the clinical suite, not touched here; fails the junit gate until its owner resolves it.
Common checks: lint, typecheck, build, test:boundary pass; format:check fails only on 5 evidence files of F07. Raw: raw/. Node v24.22.2, pnpm 12.16.1, PostgreSQL 17 at EHR_TEST_ADMIN_URL.
