# INT03-F08c — A/B seed rows for the M4 tables in rls-matrix.dbtest

Base: `11eb194` (HEAAA-133 r2 evidence). Change: `apps/api/test/security/rls-matrix.dbtest.ts` only (seed block + `replicaWrite` helper). No migration, no assertion changed or removed, no RLS expectation relaxed.

## Before / after (raw: `raw/before.txt`, `raw/after.txt`)
Command: `cd apps/api && node --test dist/test/security/rls-matrix.dbtest.js` (Node v24.22.2, pnpm 12.16.1, PostgreSQL at `EHR_TEST_ADMIN_URL`, synthetic data).
- Before: tests 65, pass 64, fail 1 ("catalogue shape": 19 tables with A=0, B=0).
- After: tests 65, pass 65, fail 0. No policy failed once the rows existed, so there is no new finding.

## Tables newly covered (19, rows for patient A and patient B)
clinical.allergy, consent_exception, encounter, follow_up, medication_statement, note, note_addendum, note_cosign, problem, questionnaire_response, referral, triage_assessment, vital_sign; messaging.message, task, thread; privacy.export_package, incident_patient, request.

## Tables without patient_id (not skipped: counted whole-table in every caller's row, `all` cell)
Catalogue has 116 RLS tables: 50 patient-keyed (all now seeded for A and B), 66 without a patient column (organisation/identity/kernel/audit/integration/reporting/scheduling resources). Those added or relevant in M4: clinical.referral_inbox, clinical.terminology_concept, clinical.vital_range (reference/inbox data, no patient column), messaging.thread_participant (keyed by thread, no patient column), privacy.incident (an incident is org-level; its patients are in privacy.incident_patient), reporting.* (aggregate views over counts, no patient column).

## Fixture limitation (disclosed)
Rows are inserted by the superuser with normal triggers. Where a guard only admits a state through role-specific multi-step paths, the fixture writes that state with user triggers off for that statement (`session_replication_role = replica`): signed/co-signed note, note_cosign, note_addendum, the three messaging tables, and the privacy.request advance to `in_progress`. Constraints, FKs and RLS on every read still apply; the guards themselves are not exercised by this seed.

## Common checks (raw in `raw/`, all exit 0)
`pnpm install --frozen-lockfile`, `run lint`, `run format:check`, `run typecheck`, `run build`, `run test:boundary`.

Execution finished only: not reviewed, integrated, approved or deployed.
