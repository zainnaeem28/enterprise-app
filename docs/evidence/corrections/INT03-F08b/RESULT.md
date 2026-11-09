# INT03-F08b result
Base 11eb194. Change: `reporting.dbtest.ts` ops-feed "no patient data" test now registers a real patient (id = CANARY_PATIENT, synthetic, via `patient.patient` insert) before the alert insert. Assertions unchanged (no canary in feed body for admin/compliance; no patient/person/... columns in `reporting`). Guard untouched.
Tools: node v24.22.2, pnpm 12.16.1, PostgreSQL 17 (EHR_TEST_ADMIN_URL).
Before: raw/reporting-dbtest-before.txt (1 failure, `patient not found`). After: raw/reporting-dbtest-after.txt (29 pass, 0 fail).
Also exit 0: install --frozen-lockfile, lint, format:check, typecheck, build, test:boundary (raw/*.txt).
Limitations: only reporting.dbtest run, not the full integration-db suite. Not reviewed, integrated, approved or deployed.
